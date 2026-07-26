"""
后端服务：把打标、选图、生成、双端互联、模型训练串成一条闭环。

运行（在 photo-wall 目录下）：
    python3 -m uvicorn backend.server:app --reload --port 8000

访问：
    手机端 App   http://localhost:8000/app
    家庭屏展示端 http://localhost:8000/screen

四条链路：
    相册授权  POST /api/authorize   (扫描 photos/ 或上传，自动打标)
    画面生成  POST /api/generate    (模型选图 -> 渲染 -> WebSocket 推给屏)
    双端互联  WS   /ws/display       (屏订阅；App 生成即实时上屏)
    模型训练  POST /api/label+/train (人工打标 -> 训练偏好模型 -> 下次选图更准)
"""

from __future__ import annotations

import datetime
import glob
import io
import ipaddress
import json
import os
import random
import sys
import time
from typing import Any, Optional

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

# 让 backend 能导入上级目录的 engine.py
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
import engine  # noqa: E402

from . import dedup, eink_push, faces, selector, stickers, store, tagger, templates_mgr, trainer  # noqa: E402
from .routers import content  # noqa: E402  内容创作端点（贴纸/模板/Studio）由 B 维护

PHOTOS_DIR = os.path.join(_ROOT, "photos")
OUTPUT_DIR = os.path.join(_ROOT, "output")
TEMPLATES_DIR = os.path.join(_ROOT, "templates")
WEBAPP_DIR = os.path.join(_ROOT, "webapp")
DISPLAY_DIR = os.path.join(_ROOT, "display")
EINK_UI_DIR = os.path.join(_ROOT, "eink")
os.makedirs(PHOTOS_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(stickers.STICKERS_DIR, exist_ok=True)
# 启动时扫描 stickers/ 目录，把直接丢进去的贴纸并入库
try:
    stickers.ingest_folder()
except Exception:
    pass

app = FastAPI(title="手帐照片墙")


# ---------- 双端互联：管理已连接的展示屏 ----------

class DisplayHub:
    def __init__(self) -> None:
        self.clients: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.clients:
            self.clients.remove(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


hub = DisplayHub()


# ---------- 工具 ----------

def _list_photo_files() -> list[str]:
    files: list[str] = []
    for ext in ("*.jpg", "*.jpeg", "*.png", "*.heic", "*.heif",
                "*.JPG", "*.JPEG", "*.PNG", "*.HEIC", "*.HEIF"):
        files.extend(glob.glob(os.path.join(PHOTOS_DIR, ext)))
    return sorted(files)


def _tag_all() -> list[dict]:
    """扫描相册目录并对每张照片打标，存入 store。"""
    photos = [tagger.tag_photo(p) for p in _list_photo_files()]
    store.save("photos", photos)
    return photos


def _slot_count(template_id: str) -> int:
    tpl = engine.load_template(os.path.join(TEMPLATES_DIR, f"{template_id}.json"))
    return len(tpl.get("slots", []))


# 按「命中照片数」挑一个刚好装得下的模板（槽位数 <= 命中数里最大的那个）。
# 这样选了照片很少的相簿（比如某个人只有 4 张）时，会缩到 4 槽模板只放这 4 张，
# 而不是硬套 10 槽再用无关照片凑满——避免「人物相簿里混进车/传单」。
_FIT_TEMPLATES = [
    (24, "grid_24"), (20, "grid_20"), (15, "grid_15"),
    (10, "grid_10"), (5, "grid_5"), (4, "travel_grid"), (3, "daily_polaroid"),
]


def _fit_template(count: int) -> str:
    for slots, name in _FIT_TEMPLATES:
        if slots <= count:
            return name
    return "daily_polaroid"  # 不足 3 张也用最小模板（渲染几张放几张）


# ---------- API 模型 ----------

class GenerateReq(BaseModel):
    template: str = "daily_polaroid"
    title: str = "我的一天"
    date: str = ""
    filters: list[str] = []  # 用户吩咐的筛选维度标签（色彩/主题/情绪等）


class LabelSample(BaseModel):
    tag: str
    score: float  # 0=差, 1=好


class LabelReq(BaseModel):
    wall_id: str = ""
    samples: list[LabelSample]


# ---------- 链路1：相册授权 ----------

@app.post("/api/authorize")
def authorize() -> dict:
    """模拟相册授权：扫描 photos/ 目录并全部打标。"""
    photos = _tag_all()
    return {"authorized": True, "count": len(photos), "photos": photos}


@app.post("/api/upload")
async def upload(
    files: list[UploadFile],
    auto: int = 0,
    template: str = "daily_polaroid",
    title: str = "我的一天",
    date: str = "",
    filters: str = "",
) -> dict:
    """专属 App：上传照片到相册目录。auto=1 时上传后自动识别→筛选→套模板→上屏。
    照片会累积进整个相册库（跨批次），精选从整库里挑最好看的，不再只看本批。
    filters：逗号分隔的筛选维度标签（如 "warm,food"），按用户吩咐的维度优先选图。"""
    saved_paths: list[str] = []
    for f in files:
        dest = os.path.join(PHOTOS_DIR, os.path.basename(f.filename or f"up_{int(time.time())}.jpg"))
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved_paths.append(dest)
    # 记录「见过的文件名」（含之后可能被去重/废片剔除的），供 App 做增量上传：
    # 只上传后端从没见过的新照片，已识别的不再重传，大幅加快后续同步。
    seen = set(store.load("seen_names", []))
    for p in saved_paths:
        seen.add(os.path.basename(p))
    store.save("seen_names", sorted(seen))
    # 对本次上传的照片打标
    tagged = [tagger.tag_photo(p) for p in saved_paths]
    # 并入已有相册库（按 path 去重更新，让"整个相册"随每次上传累积增长）
    existing = store.load("photos", [])
    by_path: dict[str, dict] = {p.get("path"): p for p in existing}
    for t in tagged:
        by_path[t.get("path")] = t  # 同一张重传则用最新打标覆盖
    merged = list(by_path.values())
    # 全库去重：跨批次去掉重复/连拍/高度相似，每簇只留画质最好的一张
    uploaded, removed = dedup.deduplicate(merged)
    # 当前相册库更新为「整库去重后的精选」，展示端/生成端都以此为准
    store.save("photos", uploaded)
    resp: dict = {
        "saved": len(saved_paths),
        "count": len(uploaded),
        "removed_duplicates": removed,
        "photos": uploaded,
    }
    if auto:
        filter_list = [f for f in filters.split(",") if f.strip()] if filters else None
        resp["wall"] = await _make_wall(template, title, date, photos=uploaded, filters=filter_list)
    return resp


@app.get("/api/photos")
def get_photos() -> dict:
    return {"photos": store.load("photos", [])}


@app.get("/api/known_photos")
def known_photos() -> dict:
    """返回后端已见过的照片文件名（含被去重/废片剔除的），供 App 做增量上传：
    App 只上传不在此集合里的新照片，已识别的不再重传，第一次识别后同步几乎瞬间完成。"""
    return {"names": store.load("seen_names", [])}


# ---------- 链路2：画面生成 ----------

def _inject_time_surprise(chosen: list[dict], pool: list[dict], slot_n: int) -> list[dict]:
    """给整墙加「时间维度的惊喜」：不局限于近期照片，偶尔翻出老照片换进来。
      · 历史上的今天：拍摄月-日与今天相同、且已是 20 天前的老照片（最惊喜，优先注入）。
      · 更久以前：老照片随机挑（制造惊喜而非每屏都换，故按概率触发）。
        门槛自适应——相册够深(有≥60天的照片)就用真·60天做「长维度」惊喜；
        相册还浅时退而用「比一半照片更老的那批」，让「不局限于近期」立刻生效，
        随着相册加深会自然过渡到真正的历史老照片。
    只在「全貌/精选」(无筛选)时用；替换掉当前墙里分数最低的槽位，保留高分主体。"""
    chosen_names = {c.get("filename") for c in chosen}
    now = datetime.datetime.now()
    today_md = (now.month, now.day)
    day = 86400.0

    dated: list[tuple[dict, datetime.datetime, float]] = []
    for p in pool:
        if p.get("filename") in chosen_names:
            continue
        ts = p.get("taken_at")
        if not ts:
            continue
        try:
            d = datetime.datetime.fromtimestamp(float(ts))
        except Exception:
            continue
        dated.append((p, d, (now - d).total_seconds()))
    if not dated:
        return chosen

    ages = [a for (_, _, a) in dated]
    # 自适应「老照片」门槛
    if max(ages) >= 60 * day:
        old_cut = 60 * day                      # 库够深：真·长维度（60 天前）
    else:
        old_cut = sorted(ages)[len(ages) // 2]  # 库还浅：比一半照片更老的那批（中位数）

    on_this_day = [p for (p, d, a) in dated if (d.month, d.day) == today_md and a >= 20 * day]
    throwback = [p for (p, d, a) in dated if a >= old_cut and (d.month, d.day) != today_md]

    if not on_this_day and not throwback:
        return chosen

    n_swap = 2 if slot_n >= 10 else 1
    surprises: list[tuple[dict, str]] = []  # (照片, 标签)
    # 「历史上的今天」很难得，一旦有就必定注入一张
    if on_this_day:
        surprises.append((random.choice(on_this_day), "那年今日"))
    # 其余名额用更久以前的老照片补：有「历史上的今天」时顺带补满，否则按概率触发惊喜
    if len(surprises) < n_swap and throwback and (bool(on_this_day) or random.random() < 0.5):
        k = min(n_swap - len(surprises), len(throwback))
        for tb in random.sample(throwback, k):
            surprises.append((tb, "旧时光"))

    if not surprises:
        return chosen

    # 替换当前墙里分数最低的若干槽位（让最弱的位置让给惊喜，保住高分主体照片）
    order = sorted(range(len(chosen)), key=lambda i: chosen[i].get("final_score", 0.0))
    result = list(chosen)
    for (s, label), idx in zip(surprises, order):
        result[idx] = {**s, "final_score": float(s.get("final_score", 0.0)),
                       "surprise": True, "surprise_label": label}
    return result


async def _make_wall(template_id: str, title: str, date: str, photos: list[dict] | None = None,
                     filters: list[str] | None = None) -> dict | None:
    """核心流水线：选图→套模板渲染→存盘→推送上屏。
    photos 传入时只用这批照片（例如手机相册本次上传的近期照片）；
    不传则用相册库全部。相册为空返回 None。
    filters：用户吩咐的筛选维度（色彩/主题/情绪标签），优先只从命中的照片里选；
    命中太少（不足以填满模板）时自动回退到全部照片，保证屏幕不空。"""
    if photos is None:
        photos = store.load("photos", [])
        if not photos:
            photos = _tag_all()
    if not photos:
        return None

    # 去重兜底：任何生成路径都保证不出现重复/连拍照片
    photos, _ = dedup.deduplicate(photos)
    if not photos:
        return None

    slot_n = _slot_count(template_id)

    # 按用户吩咐的维度/相簿筛选。
    # 只要有命中，就「只用命中的照片」——绝不用无关照片凑满，避免人物相簿里混进
    # 车/传单等无关内容。命中数不够填满当前模板时，自动缩到刚好装得下的小模板，
    # 这样一墙全是对的照片且看起来也满。完全没命中才回退到全部（保证屏幕不空）。
    applied_filters: list[str] = list(filters or [])
    filter_fallback = False
    if applied_filters:
        matched = selector.filter_photos(photos, applied_filters)
        if matched:
            photos = matched
            if len(matched) < slot_n:
                template_id = _fit_template(len(matched))
                slot_n = _slot_count(template_id)
        else:
            filter_fallback = True

    # 轮换序号：同一「模板+筛选」组合每生成一次自增，用于旋转子分类叉乘的取图，
    # 让同一主题反复刷新每次都出不同照片组合，避免时间久了同质化。
    seq_key = f"{template_id}|{','.join(applied_filters)}"
    seqs = store.load("wall_seq", {})
    rotate = int(seqs.get(seq_key, 0))
    seqs[seq_key] = rotate + 1
    store.save("wall_seq", seqs)

    # 最近上过屏的照片：让「换一批」优先选没露过脸的，连续几屏差异更明显。
    # 只在「精选/全貌」这类大池子里避重；筛选到很小的相簿(照片本来就少)时不避重，
    # 免得反复没图可选。窗口取两屏左右，避免把整库都压成「最近」。
    recent_shown: list[str] = store.load("recent_shown", [])
    avoid = set(recent_shown) if len(photos) > slot_n * 2 else set()

    chosen = selector.select_for_template(photos, slot_n, rotate=rotate, avoid=avoid)

    # 时间维度惊喜：不局限于近期，偶尔翻出「历史上的今天/更久以前」的老照片换进来。
    # 只在「全貌/精选」(无筛选)时注入；筛选到具体相簿(人物/主题…)时保持纯净不掺入。
    if not applied_filters and slot_n >= 2 and len(photos) > slot_n:
        chosen = _inject_time_surprise(chosen, photos, slot_n)

    photo_paths = [c["path"] for c in chosen]

    # 更新「最近上过屏」窗口（保留最近约两屏的量），供下次避重
    new_recent = [c.get("filename") for c in chosen if c.get("filename")] + recent_shown
    store.save("recent_shown", new_recent[: max(slot_n * 2, 20)])

    template = engine.load_template(os.path.join(TEMPLATES_DIR, f"{template_id}.json"))
    # 时间惊喜照片：在其槽位角上加「那年今日 / 旧时光」小标签，更有仪式感
    badges = {i: c["surprise_label"] for i, c in enumerate(chosen) if c.get("surprise_label")}
    # 贴纸维度：按主题随机挑贴纸并算落点，贴到画面上（没贴纸/不匹配时为空）
    canvas_cfg = template.get("canvas", {})
    try:
        sticker_plan = stickers.plan_for_wall(
            template, chosen, applied_filters,
            int(canvas_cfg.get("width", 0)), int(canvas_cfg.get("height", 0)))
    except Exception:
        sticker_plan = []
    img = engine.render(template, photo_paths, {"title": title, "date": date},
                        badges=badges, stickers=sticker_plan)

    wall_id = f"{template_id}_{int(time.time())}"
    out_name = f"{wall_id}.png"
    img.save(os.path.join(OUTPUT_DIR, out_name))

    # 本次画面涉及的元素维度（去重）—— 打标就打这些
    elements = sorted({t for c in chosen for t in c.get("tags", [])})
    wall = {
        "wall_id": wall_id,
        "template": template_id,
        "title": title,
        "date": date,
        "image_url": f"/output/{out_name}",
        "elements": elements,
        "filters": applied_filters,
        "filter_fallback": filter_fallback,
        "chosen": [{"filename": c["filename"], "final_score": c["final_score"],
                    **({"surprise_label": c["surprise_label"]} if c.get("surprise_label") else {})}
                   for c in chosen],
        "stickers": len(sticker_plan),
    }
    store.save("last_wall", wall)

    # 双端互联：实时推给所有展示屏
    await hub.broadcast({"type": "wall", **wall})
    return wall


@app.post("/api/generate")
async def generate(req: GenerateReq) -> dict:
    wall = await _make_wall(req.template, req.title, req.date, filters=req.filters or None)
    if wall is None:
        return JSONResponse({"error": "相册为空，请先授权/上传照片"}, status_code=400)
    return wall


# 智能推荐用的筛选词表（和 App 的 FILTER_GROUPS 对齐），按大类归类。
_SUGGEST_VOCAB: dict[str, list[str]] = {
    "color": ["warm", "cool", "vibrant", "monochrome", "red", "blue", "green", "pink"],
    "theme": ["person", "group", "pet", "food", "nature", "city", "travel", "sport"],
    "mood": ["high_key", "low_key", "high_contrast", "sharp"],
}


@app.get("/api/suggest_filters")
def suggest_filters() -> dict:
    """
    「更懂你的相册」：扫描当前相册库，统计每个筛选维度的照片数，
    只把「真实存在、且占比够高」的标签推荐出来，并按数量排序。
    App 拿到后直接高亮推荐，用户不用在一大堆标签里自己猜。
    """
    photos = store.load("photos", [])
    total = len(photos)
    if not total:
        return {"total": 0, "suggestions": {}, "top": []}

    # 每个 tag 命中多少张
    from collections import Counter
    counts: Counter = Counter()
    for p in photos:
        for t in set(p.get("tags", [])):
            counts[t] += 1

    suggestions: dict[str, list[dict]] = {}
    for cat, vocab in _SUGGEST_VOCAB.items():
        items = []
        for tag in vocab:
            c = counts.get(tag, 0)
            # 至少命中 2 张、且占比 >= 15% 才值得推荐（避免噪音标签）
            if c >= 2 and c / total >= 0.15:
                items.append({"tag": tag, "count": c, "ratio": round(c / total, 2)})
        items.sort(key=lambda x: x["count"], reverse=True)
        suggestions[cat] = items[:4]

    # 全局最值得一提的几个（跨类，按数量），给 App 做「一键智能筛选」入口
    flat = [it for items in suggestions.values() for it in items]
    flat.sort(key=lambda x: x["count"], reverse=True)
    top = [it["tag"] for it in flat[:5]]

    return {"total": total, "suggestions": suggestions, "top": top}


# ---------- 人物聚合（人脸识别聚类） ----------

@app.post("/api/cluster_people")
def cluster_people() -> dict:
    """
    对当前相册做人物聚合：检测+编码人脸→聚类成「人」→给每张照片打上
    person_1/person_2… 标签并写回相册库。之后就能像普通维度一样按人物筛选
    （/api/generate 传 filters=["person_1"] 即「只看这个人的照片墙」）。
    人脸库未安装时安全返回 available=False。
    """
    if not faces.available():
        return {"available": False, "people": [], "photos_with_face": 0}

    photos = store.load("photos", [])
    if not photos:
        return {"available": True, "people": [], "photos_with_face": 0}

    result = faces.cluster_album(photos)
    photo_persons = result["photo_persons"]

    # 把 person 标签合并进每张照片（先清掉旧的 person_* 再写新的，支持重算）
    for p in photos:
        base = [t for t in p.get("tags", []) if not t.startswith("person_")]
        persons = photo_persons.get(p.get("path"), [])
        p["tags"] = sorted(set(base) | set(persons))
    store.save("photos", photos)
    store.save("people", result["people"])

    return {
        "available": True,
        "people": result["people"],
        "faces_total": result["faces_total"],
        "photos_with_face": result["photos_with_face"],
    }


@app.get("/api/people")
def get_people() -> dict:
    """返回上次聚合出的人物列表（供 App 展示成「按人物筛选」的选项）。"""
    return {"people": store.load("people", []), "available": faces.available()}


@app.post("/api/retag")
def retag() -> dict:
    """
    用当前打标规则重新给「库里已有照片」打标（应用新的画质/美观/构图/废片判定），
    然后重新聚类人物把 person_* 标签补回。
    关键：只重打「库里已有路径」的照片（含 HEIC），不重新扫目录——避免把
    _list_photo_files 不识别的 HEIC 照片丢掉。路径已不存在的照片会被剔除。
    """
    photos = store.load("photos", [])
    if not photos:
        photos = _tag_all()
        return {"retagged": len(photos), "people": store.load("people", [])}

    retagged: list[dict] = []
    for p in photos:
        path = p.get("path")
        if not path or not os.path.exists(path):
            continue  # 源文件已删除则不再保留
        fresh = tagger.tag_photo(path)
        # 保留已有的人物标签（下面 cluster_people 会重算，但先带着不影响中间态）
        persons = [t for t in p.get("tags", []) if t.startswith("person_")]
        if persons:
            fresh["tags"] = sorted(set(fresh.get("tags", [])) | set(persons))
        retagged.append(fresh)

    store.save("photos", retagged)

    # 重新聚类人物（用新标签做 YOLO 交叉验证），把 person_* 重新写回
    people = []
    if faces.available():
        result = faces.cluster_album(retagged)
        photo_persons = result["photo_persons"]
        for p in retagged:
            base = [t for t in p.get("tags", []) if not t.startswith("person_")]
            base += photo_persons.get(p.get("path"), [])
            p["tags"] = sorted(set(base))
        store.save("photos", retagged)
        store.save("people", result["people"])
        people = result["people"]

    return {"retagged": len(retagged), "people": people}


# ---------- 智能相簿（借鉴苹果 Photos：AI 主动端出少数语义相簿，替代底层标签堆） ----------

# 主题标签 -> 中文名（只保留相册里真实存在的）
_SUBJECT_LABELS = {
    "food": "美食",
    "nature": "风景",
    "city": "城市",
    "travel": "旅行",
    "sport": "运动",
    "indoor": "居家",
}

# 色彩主题（每张照片都有冷/暖，另按鲜艳/黑白补充）
_COLOR_LABELS = {
    "warm": "暖色调",
    "cool": "冷色调",
    "vibrant": "鲜艳",
    "monochrome": "黑白",
}

# 情绪/氛围主题（tagger 由真实信号推导的 mood_* 标签）
_MOOD_LABELS = {
    "mood_fresh": "清新治愈",
    "mood_vivid": "活力满满",
    "mood_vintage": "文艺复古",
    "mood_calm": "静谧氛围",
}


def _best_cover(photos: list[dict], match=None) -> str | None:
    """在（可选命中某条件的）照片里挑美观分最高的当封面。"""
    pool = [p for p in photos if (match is None or match(p))]
    if not pool:
        return None
    pool.sort(key=lambda p: p.get("aesthetic", p.get("quality", 0)), reverse=True)
    return pool[0].get("path")


# 每个相簿分组默认绑定的模板（点相簿即用最合适的排版，用户仍可在下拉框改）。
_GROUP_TEMPLATE = {
    "精选": "grid_15",
    "人物": "daily_polaroid",
    "宠物": "grid_5",
    "情绪": "monthly_collage",
    "色彩": "travel_grid",
}
# 主题里按具体标签细分模板
_SUBJECT_TEMPLATE = {
    "food": "grid_10",
    "city": "travel_grid",
    "nature": "travel_grid",
    "travel": "travel_grid",
    "sport": "grid_10",
    "indoor": "grid_5",
}


def _album_template(group: str, tag: str | None = None) -> str:
    if group == "主题" and tag in _SUBJECT_TEMPLATE:
        return _SUBJECT_TEMPLATE[tag]
    return _GROUP_TEMPLATE.get(group, "grid_10")


@app.get("/api/smart_albums")
def smart_albums() -> dict:
    """
    智能相簿：不再让用户勾一堆底层标签（暖色/冷色/红/蓝…），
    而是像苹果相册一样，AI 主动端出少数几个语义相簿——人物 / 宠物 / 主题 / 精选，
    每个相簿只有在相册里真实存在时才出现。前端单选点一下即出对应照片墙。
    每个相簿自带 filter（发给 /api/generate 就能出这个相簿的墙）。
    """
    photos = store.load("photos", [])
    total = len(photos)
    # 只统计非废片（junk 已在打标时把 quality 清零 + 打 junk 标签）
    good = [p for p in photos if "junk" not in p.get("tags", []) and p.get("quality", 0) > 0]
    good_total = len(good)

    from collections import Counter
    counts: Counter = Counter()
    for p in good:
        for t in set(p.get("tags", [])):
            counts[t] += 1

    albums: list[dict] = []

    # 1) 人物（人脸聚类结果）——只展示「高频出现」的人（借鉴苹果：路人/单张不建相簿）。
    #    count 按非废片重新计，封面也避开废片、选最美观的一张。
    people = store.load("people", [])
    person_albums = []
    for person in people:
        pid = person.get("id")
        gc = counts.get(pid, 0)  # 该人在「非废片」里出现的张数
        if gc >= 2:
            person_albums.append((pid, gc))
    person_albums.sort(key=lambda x: x[1], reverse=True)
    for i, (pid, gc) in enumerate(person_albums):
        albums.append({
            "id": f"people_{pid}",
            "group": "人物",
            "label": f"人物{i + 1}",
            "count": gc,
            "cover": _best_cover(good, lambda p, pid=pid: pid in p.get("tags", [])),
            "filter": [pid],
            "template": _album_template("人物"),
        })

    # 2) 宠物——有就给一个相簿
    if counts.get("pet", 0) >= 1:
        albums.append({
            "id": "pet",
            "group": "宠物",
            "label": "宠物",
            "count": counts["pet"],
            "cover": _best_cover(good, lambda p: "pet" in p.get("tags", [])),
            "filter": ["pet"],
            "template": _album_template("宠物"),
        })

    # 3) 主题——只保留真实存在（>=2 张）的主题
    for tag, label in _SUBJECT_LABELS.items():
        c = counts.get(tag, 0)
        if c >= 2:
            albums.append({
                "id": f"subject_{tag}",
                "group": "主题",
                "label": label,
                "count": c,
                "cover": _best_cover(good, lambda p, t=tag: t in p.get("tags", [])),
                "filter": [tag],
                "template": _album_template("主题", tag),
            })

    # 4) 情绪/氛围——由真实信号推导的 mood_*，够量才建簿（放主体后面，属"感觉"维度）
    for tag, label in _MOOD_LABELS.items():
        c = counts.get(tag, 0)
        if c >= 3:
            albums.append({
                "id": f"mood_{tag}",
                "group": "情绪",
                "label": label,
                "count": c,
                "cover": _best_cover(good, lambda p, t=tag: t in p.get("tags", [])),
                "filter": [tag],
                "template": _album_template("情绪"),
            })

    # 5) 色彩——冷暖/鲜艳/黑白，够量才建簿（阈值高些，避免半个相册都进来）
    for tag, label in _COLOR_LABELS.items():
        c = counts.get(tag, 0)
        if c >= 4:
            albums.append({
                "id": f"color_{tag}",
                "group": "色彩",
                "label": label,
                "count": c,
                "cover": _best_cover(good, lambda p, t=tag: t in p.get("tags", [])),
                "filter": [tag],
                "template": _album_template("色彩"),
            })

    # 6) 精选——不加筛选，纯靠画质/美观排序（废片已剔除），"给我最好看的一屏"
    if good_total >= 1:
        albums.append({
            "id": "best",
            "group": "精选",
            "label": "精选",
            "count": good_total,
            "cover": _best_cover(good),
            "filter": [],
            "template": _album_template("精选"),
        })

    return {
        "total": total,
        "good_total": good_total,
        "junk_total": total - good_total,
        "albums": albums,
    }


# ---------- 链路4：模型训练 ----------

@app.post("/api/label")
def label(req: LabelReq) -> dict:
    """人工打标：对本次画面涉及的元素维度评分，并立即训练偏好模型。"""
    labels = store.load("labels", [])
    for s in req.samples:
        labels.append({"wall_id": req.wall_id, "tag": s.tag, "score": s.score, "ts": time.time()})
    store.save("labels", labels)

    model = trainer.train([{"tag": s.tag, "score": s.score} for s in req.samples])
    return {"labeled": len(req.samples), "total_labels": len(labels), "model": model}


@app.post("/api/train")
def train_all() -> dict:
    """用累计的全部标签重新训练（长期训练）。"""
    labels = store.load("labels", [])
    if not labels:
        return {"trained": 0, "model": trainer.load_model()}
    model = trainer.train([{"tag": l["tag"], "score": l["score"]} for l in labels])
    return {"trained": len(labels), "model": model}


@app.get("/api/model")
def get_model() -> dict:
    return trainer.load_model()


# ---------- 双端互联 WebSocket ----------

@app.websocket("/ws/display")
async def ws_display(ws: WebSocket) -> None:
    await hub.connect(ws)
    last = store.load("last_wall", None)
    if last:
        await ws.send_json({"type": "wall", **last})
    try:
        while True:
            await ws.receive_text()  # 保持连接
    except WebSocketDisconnect:
        hub.disconnect(ws)


# ---------- 静态资源 ----------

@app.get("/output/{name}")
def serve_output(name: str) -> FileResponse:
    return FileResponse(os.path.join(OUTPUT_DIR, name))


@app.get("/api/frame_id")
def frame_id() -> Response:
    """极轻量的画面版本号：屏幕先问这个，变了才去拉整张 JPEG，避免重复重绘导致闪屏。"""
    last = store.load("last_wall", None)
    fid = last.get("wall_id", "") if last else ""
    return Response(content=fid, media_type="text/plain")


@app.get("/api/frame.jpg")
def frame(w: int = 320, h: int = 480) -> Response:
    """
    给单片机（ESP32 等）用的出图接口：把当前画面缩放/裁到指定分辨率的 JPEG。
    单片机内存小，直接下 1080x1440 会崩，所以按屏幕尺寸出小图。
    示例：GET /api/frame.jpg?w=320&h=480
    """
    w = max(16, min(w, 1080))
    h = max(16, min(h, 1920))
    last = store.load("last_wall", None)
    if not last:
        # 没有画面时返回一张纯色占位图
        img = Image.new("RGB", (w, h), "#201c17")
    else:
        src_path = os.path.join(OUTPUT_DIR, os.path.basename(last["image_url"]))
        if not os.path.exists(src_path):
            img = Image.new("RGB", (w, h), "#201c17")
        else:
            src = Image.open(src_path).convert("RGB")
            # 等比缩放（contain），保持画面 16:9 比例不变形，
            # 目标画布若不是同比例则用画面背景色补边（letterbox）。
            from PIL import ImageOps
            pad_color = src.getpixel((0, 0))  # 取左上角像素作为模板背景色，补边更自然
            fitted = ImageOps.contain(src, (w, h), method=Image.LANCZOS)
            img = Image.new("RGB", (w, h), pad_color)
            img.paste(fitted, ((w - fitted.width) // 2, (h - fitted.height) // 2))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


def _spectra6_palette() -> Image.Image:
    """创建 E Ink Spectra 6 的六色调色板：黑、白、红、黄、绿、蓝。
    面板不是连续 RGB 彩屏；后端先收敛颜色，固件只需按厂商色码送屏即可。
    """
    palette = Image.new("P", (1, 1))
    colors = [
        (0, 0, 0),        # black
        (255, 255, 255),  # white
        (220, 30, 30),    # red
        (242, 201, 32),   # yellow
        (35, 142, 70),    # green
        (35, 92, 184),    # blue
    ]
    raw = [value for color in colors for value in color]
    palette.putpalette(raw + [0] * (768 - len(raw)))
    return palette


@app.get("/api/frame_eink.png")
def frame_eink() -> Response:
    """给 13.3 寸 E Ink Spectra 6 用的原生画面。

    固定输出 1600×1200 横屏 PNG，并用 Floyd-Steinberg 抖动压到 E6 的六种可显示
    颜色。它和 /api/frame.jpg 完全独立，保留旧 LCD 的 800×480 JPEG 传输路径。
    """
    w, h = 1600, 1200
    last = store.load("last_wall", None)
    if not last:
        img = Image.new("RGB", (w, h), "#FFFFFF")
    else:
        src_path = os.path.join(OUTPUT_DIR, os.path.basename(last["image_url"]))
        if not os.path.exists(src_path):
            img = Image.new("RGB", (w, h), "#FFFFFF")
        else:
            src = Image.open(src_path).convert("RGB")
            from PIL import ImageOps
            # 先保持原图比例，避免把现有 16:9 模板拉伸；4:3 墨水屏多出的区域用模板背景补齐。
            pad_color = src.getpixel((0, 0))
            fitted = ImageOps.contain(src, (w, h), method=Image.LANCZOS)
            img = Image.new("RGB", (w, h), pad_color)
            img.paste(fitted, ((w - fitted.width) // 2, (h - fitted.height) // 2))

    # Spectra 6 是有限色面板；抖动能让照片的明暗/细节在六色中保留得更自然。
    eink = img.quantize(palette=_spectra6_palette(), dither=Image.Dither.FLOYDSTEINBERG)
    buf = io.BytesIO()
    eink.save(buf, format="PNG", optimize=True)
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/api/eink/upload")
async def eink_upload(
    file: UploadFile,
    host: str = "192.168.1.200",
    dither: bool = True,
    fit: str = "contain",
    rotation: int = 0,
) -> dict:
    """上传单张照片，并通过微雪官方 Wi-Fi Loader 协议直接刷新 13.3E6。"""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "墨水屏地址必须是局域网 IP"})
    if not address.is_private:
        return JSONResponse(status_code=400, content={"error": "只允许局域网墨水屏地址"})
    if fit not in ("contain", "cover") or rotation not in (0, 90, 180, 270):
        return JSONResponse(status_code=400, content={"error": "图片适配参数无效"})

    image_bytes = await file.read()
    if not image_bytes or len(image_bytes) > 30 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": "请选择不超过 30MB 的图片"})
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.verify()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "无法识别该图片格式"})

    preview_name = "eink_live_preview.png"
    try:
        return eink_push.start_upload(
            image_bytes,
            host=host,
            dither=dither,
            fit=fit,
            rotation=rotation,
            preview_path=os.path.join(OUTPUT_DIR, preview_name),
            preview_url=f"/output/{preview_name}",
        )
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})


@app.get("/api/eink/status")
def eink_status() -> dict:
    """查询当前照片转换、传输与全刷进度。"""
    return eink_push.status()


@app.get("/photos/{name}")
def serve_photo(name: str) -> FileResponse:
    return FileResponse(os.path.join(PHOTOS_DIR, name))


@app.get("/api/thumb/{name}")
def thumb(name: str, s: int = 160) -> Response:
    """把相册原图（含 HEIC，浏览器不能直接渲染）转成方形小 JPEG，供网页相簿封面用。"""
    s = max(48, min(s, 512))
    path = os.path.join(PHOTOS_DIR, os.path.basename(name))
    if not os.path.exists(path):
        img = Image.new("RGB", (s, s), "#e9e1d2")
    else:
        try:
            from PIL import ImageOps
            src = Image.open(path).convert("RGB")
            img = ImageOps.fit(src, (s, s), method=Image.LANCZOS)
        except Exception:
            img = Image.new("RGB", (s, s), "#e9e1d2")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


# 内容创作端点（贴纸/模板/Studio 预览）已拆到 backend/routers/content.py，由负责人 B 维护。
# 路径与行为不变；A 改本文件、B 改 content.py，日常互不冲突。
app.include_router(content.router)


app.mount("/eink", StaticFiles(directory=EINK_UI_DIR, html=True), name="eink")
app.mount("/studio", StaticFiles(directory=os.path.join(_ROOT, "studio"), html=True), name="studio")
app.mount("/app", StaticFiles(directory=WEBAPP_DIR, html=True), name="app")
app.mount("/screen", StaticFiles(directory=DISPLAY_DIR, html=True), name="screen")


@app.get("/")
def index() -> dict:
    return {
        "service": "手帐照片墙",
        "app": "/app",
        "screen": "/screen",
        "endpoints": ["/api/authorize", "/api/generate", "/api/label", "/api/train", "/ws/display"],
    }

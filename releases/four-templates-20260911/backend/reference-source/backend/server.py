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
import hashlib
import hmac
import io
import ipaddress
import json
import os
import random
import re
import secrets
import shutil
import sys
import threading
import time
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi import Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from . import template_catalog
from pydantic import BaseModel, Field

# 让 backend 能导入上级目录的 engine.py
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
import engine  # noqa: E402

from . import clip, curation, dedup, display_history, eink_push, faces, pet_collage, selection_policy, selector, stickers, store, tagger, template_packages, templates_mgr, trainer  # noqa: E402
from .routers import content, family, test_devices  # noqa: E402  按功能拆分路由，降低多人协作冲突

_DATA_DIR = os.environ.get("PHOTOWALL_DATA_DIR", _ROOT)
PHOTOS_DIR = os.path.join(_DATA_DIR, "photos")
OUTPUT_DIR = os.path.join(_DATA_DIR, "output")
TEMPLATES_DIR = os.path.join(_ROOT, "templates")
WEBAPP_DIR = os.path.join(_ROOT, "webapp")
DISPLAY_DIR = os.path.join(_ROOT, "display")
DISPLAY_19_DIR = os.path.join(_ROOT, "display-19")
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.environ.get(
        "PHOTOWALL_CORS_ORIGINS", "http://localhost:8081,http://127.0.0.1:8081"
    ).split(",") if origin.strip()],
    allow_origin_regex=os.environ.get(
        "PHOTOWALL_CORS_ORIGIN_REGEX",
        r"^http://(?:(?:localhost|127\.0\.0\.1|[A-Za-z0-9.-]+\.local)|(?:10(?:\.\d{1,3}){3})|(?:192\.168(?:\.\d{1,3}){2})|(?:172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}))(?::\d+)?$",
    ),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- 双端互联：管理已连接的展示屏 ----------

class DisplayHub:
    def __init__(self) -> None:
        self.clients: list[WebSocket] = []
        self.device_ids: dict[WebSocket, str] = {}

    async def connect(self, ws: WebSocket, device_id: str = "") -> None:
        await ws.accept()
        self.clients.append(ws)
        if device_id:
            self.device_ids[ws] = device_id

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.clients:
            self.clients.remove(ws)
        self.device_ids.pop(ws, None)

    async def broadcast(self, message: dict[str, Any], legacy_only: bool = False) -> None:
        dead = []
        for ws in self.clients:
            if legacy_only and self.device_ids.get(ws):
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def send_device(self, device_id: str, message: dict[str, Any]) -> bool:
        delivered = False
        dead = []
        for ws in self.clients:
            if self.device_ids.get(ws) != device_id:
                continue
            try:
                await ws.send_json(message)
                delivered = True
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
        return delivered


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
    photos = curation.prepare(clip.enrich([tagger.tag_photo(p) for p in _list_photo_files()]))
    store.save("photos", photos)
    return photos


def _account_scope(account_token: str) -> str:
    """Use an opaque stable namespace; never put account tokens in file names."""
    if not account_token:
        return "legacy"
    user_scope = family.account_scope(account_token)
    if user_scope:
        return user_scope
    return hashlib.sha256(account_token.encode()).hexdigest()[:24]


def _scoped_store_name(name: str, scope: str) -> str:
    return name if scope == "legacy" else f"{name}_{scope}"


def _scoped_photos_dir(scope: str) -> str:
    directory = PHOTOS_DIR if scope == "legacy" else os.path.join(PHOTOS_DIR, scope)
    os.makedirs(directory, exist_ok=True)
    return directory


def _require_standard_template(template_id: str) -> None:
    if template_id == "denim_pet":
        raise HTTPException(status_code=409, detail="宠物牛仔拼贴需通过宠物分析与抠图流程生成")
    if template_id not in (*template_catalog.STANDARD_IDS, "auto"):
        raise HTTPException(status_code=410, detail="模板已停用或不存在，请刷新现行四款模板清单")


def _slot_count(template_id: str) -> int:
    _require_standard_template(template_id)
    if template_packages.is_package(template_id):
        return template_packages.required_photo_count(template_id)
    tpl = engine.load_template(os.path.join(TEMPLATES_DIR, f"{template_id}.json"))
    return len(tpl.get("slots", []))


# 自动适配仅能使用现行普通照片模板；宠物拼贴走独立抠图流程。
_FIT_TEMPLATES = [
    (8, "template_1"),
]
_PORTRAIT_FIT_TEMPLATES = _FIT_TEMPLATES


def _fit_template(count: int, portrait: bool = False) -> str:
    templates = _PORTRAIT_FIT_TEMPLATES if portrait else _FIT_TEMPLATES
    for slots, name in templates:
        if slots <= count:
            return name
    raise HTTPException(status_code=422, detail="现行照片模板至少需要 8 张合格照片，请增加照片后重试")


def _auto_layout_template(photos: list[dict], filters: list[str] | None = None) -> str:
    """Choose a layout internally for the model-led App flow.

    The App deliberately sends ``template=auto``: template names are an
    implementation detail, not a user decision.  Content ranking still uses
    the account's trained preference model further down the pipeline; this
    function only picks a conservative canvas/slot count before rendering.
    """
    return _fit_template(len(photos), portrait=True)


# ---------- API 模型 ----------

class GenerateReq(BaseModel):
    template: str = "auto"
    title: str = "我的一天"
    date: str = ""
    filters: list[str] = []  # 用户吩咐的筛选维度标签（色彩/主题/情绪等）
    exclude_filters: list[str] = []  # 用户明确关闭的人物/主题，命中任一标签即排除
    device_id: str = ""
    preference_revision_id: str = ""


class PreferenceRevisionReq(BaseModel):
    device_id: str = Field(min_length=4, max_length=64)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    parent_id: str = Field(default="", max_length=96)
    source: str = Field(default="preferences", max_length=32)


class PreferenceRevisionActivateReq(BaseModel):
    device_id: str = Field(min_length=4, max_length=64)
    revision_id: str = Field(min_length=4, max_length=96)


class PetCollageJobReq(BaseModel):
    filenames: list[str] = Field(default_factory=list, max_length=5000)


class PublishWallReq(BaseModel):
    wall_id: str = ""


class LabelSample(BaseModel):
    tag: str
    score: float  # 0=差, 1=好


class LabelReq(BaseModel):
    wall_id: str = ""
    samples: list[LabelSample]


class DeviceBootstrapReq(BaseModel):
    device_id: str
    pairing_code: str
    setup_token: str = ""
    ip: str = ""
    firmware_version: str = ""
    device_token: str = ""
    device_family: str = "esp32_e6"


class DeviceClaimReq(BaseModel):
    pairing_code: str
    name: str = "客厅照片墙"


class DeviceAutoClaimReq(BaseModel):
    device_id: str
    setup_token: str
    name: str = "客厅照片墙"


class DeviceReprovisionReq(BaseModel):
    setup_token: str = ""


class DeviceStatusReq(BaseModel):
    state: str
    revision: str = ""
    progress: float = 0.0
    error: str = ""
    ip: str = ""


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
    template: str = "auto",
    title: str = "我的一天",
    date: str = "",
    filters: str = "",
    x_account_token: str = Header(default=""),
) -> dict:
    """专属 App：上传照片到相册目录。auto=1 时上传后自动识别→筛选→套模板→上屏。
    照片会累积进整个相册库（跨批次），精选从整库里挑最好看的，不再只看本批。
    filters：逗号分隔的筛选维度标签（如 "warm,food"），按用户吩咐的维度优先选图。"""
    if auto:
        _require_standard_template(template)
    scope = _account_scope(x_account_token)
    photo_dir = _scoped_photos_dir(scope)
    saved_paths: list[str] = []
    for f in files:
        dest = os.path.join(photo_dir, os.path.basename(f.filename or f"up_{int(time.time())}.jpg"))
        with open(dest, "wb") as out:
            out.write(await f.read())
        saved_paths.append(dest)
    # 记录「见过的文件名」（含之后可能被去重/废片剔除的），供 App 做增量上传：
    # 只上传后端从没见过的新照片，已识别的不再重传，大幅加快后续同步。
    seen_key = _scoped_store_name("seen_names", scope)
    photos_key = _scoped_store_name("photos", scope)
    seen = set(store.load(seen_key, []))
    for p in saved_paths:
        seen.add(os.path.basename(p))
    store.save(seen_key, sorted(seen))
    # 对本次上传的照片打标
    tagged = clip.enrich([tagger.tag_photo(p) for p in saved_paths])
    rejected = [
        {"filename": photo.get("filename", ""),
         "junk_reason": photo.get("junk_reason") or "quality"}
        for photo in tagged if photo.get("quality", 0) <= 0
    ]
    # 并入已有相册库（按 path 去重更新，让"整个相册"随每次上传累积增长）
    existing = store.load(photos_key, [])
    by_path: dict[str, dict] = {p.get("path"): p for p in existing}
    for t in tagged:
        by_path[t.get("path")] = t  # 同一张重传则用最新打标覆盖
    merged = curation.prepare(list(by_path.values()))
    # 全库去重：跨批次去掉重复/连拍/高度相似，每簇只留画质最好的一张
    uploaded, removed = dedup.deduplicate(merged)
    # 当前相册库更新为「整库去重后的精选」，展示端/生成端都以此为准
    store.save(photos_key, uploaded)
    resp: dict = {
        "saved": len(saved_paths),
        "count": len(uploaded),
        "removed_duplicates": removed,
        "rejected": rejected,
        "photos": uploaded,
    }
    if auto:
        filter_list = [f for f in filters.split(",") if f.strip()] if filters else None
        resp["wall"] = await _make_wall(template, title, date, photos=uploaded, filters=filter_list, scope=scope)
    return resp


@app.get("/api/photos")
def get_photos(x_account_token: str = Header(default="")) -> dict:
    return {"photos": store.load(_scoped_store_name("photos", _account_scope(x_account_token)), [])}


@app.get("/api/known_photos")
def known_photos(x_account_token: str = Header(default="")) -> dict:
    """返回后端已见过的照片文件名（含被去重/废片剔除的），供 App 做增量上传：
    App 只上传不在此集合里的新照片，已识别的不再重传，第一次识别后同步几乎瞬间完成。"""
    scope = _account_scope(x_account_token)
    return {"names": store.load(_scoped_store_name("seen_names", scope), [])}


# ---------- 链路2：画面生成 ----------

def _inject_time_surprise(chosen: list[dict], pool: list[dict], slot_n: int,
                          model: dict | None = None) -> list[dict]:
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
    # 惊喜老照片来自原始相册库，没经过 rank_photos，本身没有 final_score；
    # 这里统一补算真实综合分，避免它们在墙上显示成 0.0，也保证按分排序/训练拿到真实分。
    scored = selector.rank_photos([s for s, _ in surprises], model=model)
    score_by_path = {p.get("path"): p.get("final_score", 0.0) for p in scored}
    result = list(chosen)
    for (s, label), idx in zip(surprises, order):
        result[idx] = {**s,
                       "final_score": float(score_by_path.get(s.get("path"), s.get("final_score", 0.0))),
                       "surprise": True, "surprise_label": label}
    return result


async def _make_wall(template_id: str, title: str, date: str, photos: list[dict] | None = None,
                     filters: list[str] | None = None, exclude_filters: list[str] | None = None,
                     scope: str = "legacy", preference_revision_id: str = "") -> dict | None:
    """核心流水线：选图→套模板渲染→存盘→推送上屏。
    photos 传入时只用这批照片（例如手机相册本次上传的近期照片）；
    不传则用相册库全部。相册为空返回 None。
    filters：用户吩咐的筛选维度（色彩/主题/情绪标签），优先只从命中的照片里选；
    exclude_filters：用户关闭的人物/主题，命中任一项就严格排除，不会回退。"""
    _require_standard_template(template_id)
    if template_id == "template_3":
        reason = template_packages.cutout_unavailable_reason()
        if reason:
            raise HTTPException(status_code=503, detail=reason)
    if photos is None:
        photos = store.load(_scoped_store_name("photos", scope), [])
        # Only the legacy, unscoped API may scan the shared root photo folder.
        # An authenticated account with an empty library must stay empty instead
        # of falling back to photos that belong to the legacy/public namespace.
        if not photos and scope == "legacy":
            photos = _tag_all()
    if not photos:
        return None

    # 通用策展特征与模板无关；主题模板仅在选择阶段解析不同策略。
    photos = curation.prepare(photos)

    # 去重兜底：任何生成路径都保证不出现重复/连拍照片
    photos, _ = dedup.deduplicate(photos)
    if not photos:
        return None

    # “不展示”是隐私约束，优先级高于主题筛选：一张照片只要命中任一关闭的
    # 人物或主题标签，就不能因为同时命中另一个开启主题而重新进入候选池。
    excluded = {item.strip().lower() for item in (exclude_filters or []) if item and item.strip()}
    if excluded:
        photos = [
            photo for photo in photos
            if excluded.isdisjoint({str(tag).lower() for tag in photo.get("tags", [])})
        ]
        if not photos:
            return None

    auto_layout = template_id == "auto"
    if auto_layout:
        template_id = _auto_layout_template(photos, filters)

    slot_n = _slot_count(template_id)
    requested_template = None if template_packages.is_package(template_id) else engine.load_template(
        os.path.join(TEMPLATES_DIR, f"{template_id}.json")
    )
    requested_canvas = requested_template.get("canvas", {}) if requested_template else {"width": 2000, "height": 2668}
    portrait_template = int(requested_canvas.get("height", 0)) > int(requested_canvas.get("width", 0))

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
            if len(matched) < slot_n and template_id != "template_1":
                template_id = _fit_template(len(matched), portrait=portrait_template)
                slot_n = _slot_count(template_id)
        else:
            filter_fallback = True

    if template_packages.is_package(template_id) and len(photos) < slot_n:
        template_id = _fit_template(len(photos), portrait=True)
        slot_n = _slot_count(template_id)

    # 轮换序号：同一「模板+筛选」组合每生成一次自增，用于旋转子分类叉乘的取图，
    # 让同一主题反复刷新每次都出不同照片组合，避免时间久了同质化。
    seq_key = f"{template_id}|{','.join(applied_filters)}|!{','.join(sorted(excluded))}"
    seqs_key = _scoped_store_name("wall_seq", scope)
    seqs = store.load(seqs_key, {})
    rotate = int(seqs.get(seq_key, 0))
    seqs[seq_key] = rotate + 1
    store.save(seqs_key, seqs)

    # 最近上过屏的照片：让「换一批」优先选没露过脸的，连续几屏差异更明显。
    # 只在「精选/全貌」这类大池子里避重；筛选到很小的相簿(照片本来就少)时不避重，
    # 免得反复没图可选。窗口取两屏左右，避免把整库都压成「最近」。
    recent_key = _scoped_store_name("recent_shown", scope)
    recent_shown: list[str] = store.load(recent_key, [])
    avoid = set(recent_shown) if len(photos) > slot_n * 2 else set()
    preference_model = trainer.load_model(_scoped_store_name("model", scope))

    policy = selection_policy.resolve(template_id)
    chosen = selector.select_for_template(
        photos, slot_n, model=preference_model, rotate=rotate, avoid=avoid,
        policy=policy,
    )

    # 时间维度惊喜：不局限于近期，偶尔翻出「历史上的今天/更久以前」的老照片换进来。
    # 只在「全貌/精选」(无筛选)时注入；筛选到具体相簿(人物/主题…)时保持纯净不掺入。
    if not applied_filters and slot_n >= 2 and len(photos) > slot_n:
        chosen = _inject_time_surprise(chosen, photos, slot_n, model=preference_model)

    photo_paths = [c["path"] for c in chosen]

    # 更新「最近上过屏」窗口（保留最近约两屏的量），供下次避重
    new_recent = [c.get("filename") for c in chosen if c.get("filename")] + recent_shown
    store.save(recent_key, new_recent[: max(slot_n * 2, 20)])

    packaged_template = template_packages.is_package(template_id)
    template = None if packaged_template else engine.load_template(os.path.join(TEMPLATES_DIR, f"{template_id}.json"))
    # 时间惊喜照片：在其槽位角上加「那年今日 / 旧时光」小标签，更有仪式感
    badges = {i: c["surprise_label"] for i, c in enumerate(chosen) if c.get("surprise_label")}
    # 贴纸维度：按主题随机挑贴纸并算落点，贴到画面上（没贴纸/不匹配时为空）
    sticker_plan = []
    if packaged_template:
        img = template_packages.render(
            template_id,
            photo_paths,
            {"title": title, "date": date, "nickname": title},
        )
    else:
        canvas_cfg = template.get("canvas", {})
        try:
            sticker_plan = stickers.plan_for_wall(
                template, chosen, applied_filters,
                int(canvas_cfg.get("width", 0)), int(canvas_cfg.get("height", 0)))
        except Exception:
            sticker_plan = []
        img = engine.render(template, photo_paths, {"title": title, "date": date},
                            badges=badges, stickers=sticker_plan)

    wall_id = f"{scope}_{template_id}_{time.time_ns()}"
    out_name = f"{wall_id}.png"
    img.save(os.path.join(OUTPUT_DIR, out_name))

    # 本次画面涉及的元素维度（去重）—— 打标就打这些
    elements = sorted({t for c in chosen for t in c.get("tags", [])})
    wall = {
        "wall_id": wall_id,
        "template": template_id,
        "selection_mode": "platform-model" if auto_layout else "explicit-template",
        "title": title,
        "date": date,
        "image_url": f"/output/{out_name}",
        "elements": elements,
        "filters": applied_filters,
        "excluded_filters": sorted(excluded),
        "preference_revision_id": preference_revision_id,
        "filter_fallback": filter_fallback,
        "chosen": [{"filename": c["filename"], "final_score": c["final_score"],
                    **({"surprise_label": c["surprise_label"]} if c.get("surprise_label") else {})}
                   for c in chosen],
        "stickers": len(sticker_plan),
    }
    store.save(_scoped_store_name("last_wall", scope), wall)

    # 保留旧 19 寸屏的实时广播；已注册设备只在 App 明确发布时定向接收。
    await hub.broadcast({"type": "wall", **wall}, legacy_only=True)
    return wall


@app.post("/api/generate")
async def generate(req: GenerateReq, x_account_token: str = Header(default="")) -> dict:
    active_revision_id = ""
    if req.device_id:
        _, error = _preference_profile_for_request(req.device_id, x_account_token)
        if error:
            return error
        profile = _load_preference_profile(req.device_id)
        active_revision_id = str(profile.get("activeRevisionId") or "")
        if req.preference_revision_id and req.preference_revision_id != active_revision_id:
            return JSONResponse(
                status_code=409,
                content={"error": "偏好已更新，请按当前版本重新生成预览", "active_revision_id": active_revision_id},
            )
    wall = await _make_wall(
        req.template, req.title, req.date, filters=req.filters or None,
        exclude_filters=req.exclude_filters or None,
        scope=_account_scope(x_account_token),
        preference_revision_id=active_revision_id,
    )
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
def suggest_filters(x_account_token: str = Header(default="")) -> dict:
    """
    「更懂你的相册」：扫描当前相册库，统计每个筛选维度的照片数，
    只把「真实存在、且占比够高」的标签推荐出来，并按数量排序。
    App 拿到后直接高亮推荐，用户不用在一大堆标签里自己猜。
    """
    scope = _account_scope(x_account_token)
    photos = store.load(_scoped_store_name("photos", scope), [])
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
def cluster_people(x_account_token: str = Header(default="")) -> dict:
    """
    对当前相册做人物聚合：检测+编码人脸→聚类成「人」→给每张照片打上
    person_1/person_2… 标签并写回相册库。之后就能像普通维度一样按人物筛选
    （/api/generate 传 filters=["person_1"] 即「只看这个人的照片墙」）。
    人脸库未安装时安全返回 available=False。
    """
    if not faces.available():
        return {"available": False, "people": [], "photos_with_face": 0}

    scope = _account_scope(x_account_token)
    photos_key = _scoped_store_name("photos", scope)
    people_key = _scoped_store_name("people", scope)
    photos = store.load(photos_key, [])
    if not photos:
        return {"available": True, "people": [], "photos_with_face": 0}

    result = faces.cluster_album(photos)
    photo_persons = result["photo_persons"]

    # 把 person 标签合并进每张照片（先清掉旧的 person_* 再写新的，支持重算）
    for p in photos:
        base = [t for t in p.get("tags", []) if not t.startswith("person_")]
        persons = photo_persons.get(p.get("path"), [])
        p["tags"] = sorted(set(base) | set(persons))
    store.save(photos_key, photos)
    store.save(people_key, result["people"])

    return {
        "available": True,
        "people": result["people"],
        "faces_total": result["faces_total"],
        "photos_with_face": result["photos_with_face"],
    }


@app.get("/api/people")
def get_people(x_account_token: str = Header(default="")) -> dict:
    """返回上次聚合出的人物列表（供 App 展示成「按人物筛选」的选项）。"""
    scope = _account_scope(x_account_token)
    return {
        "people": store.load(_scoped_store_name("people", scope), []),
        "available": faces.available(),
    }


@app.post("/api/retag")
def retag(x_account_token: str = Header(default="")) -> dict:
    """
    用当前打标规则重新给「库里已有照片」打标（应用新的画质/美观/构图/废片判定），
    然后重新聚类人物把 person_* 标签补回。
    关键：只重打「库里已有路径」的照片（含 HEIC），不重新扫目录——避免把
    _list_photo_files 不识别的 HEIC 照片丢掉。路径已不存在的照片会被剔除。
    """
    scope = _account_scope(x_account_token)
    photos_key = _scoped_store_name("photos", scope)
    people_key = _scoped_store_name("people", scope)
    photos = store.load(photos_key, [])
    if not photos:
        if scope == "legacy":
            photos = _tag_all()
            return {"retagged": len(photos), "people": store.load("people", [])}
        return {"retagged": 0, "people": []}

    retagged: list[dict] = []
    for p in photos:
        path = p.get("path")
        if not path or not os.path.exists(path):
            continue  # 源文件已删除则不再保留
        fresh = curation.prepare(clip.enrich([tagger.tag_photo(path)]))[0]
        # 保留已有的人物标签（下面 cluster_people 会重算，但先带着不影响中间态）
        persons = [t for t in p.get("tags", []) if t.startswith("person_")]
        if persons:
            fresh["tags"] = sorted(set(fresh.get("tags", [])) | set(persons))
        retagged.append(fresh)

    store.save(photos_key, retagged)

    # 重新聚类人物（用新标签做 YOLO 交叉验证），把 person_* 重新写回
    people = []
    if faces.available():
        result = faces.cluster_album(retagged)
        photo_persons = result["photo_persons"]
        for p in retagged:
            base = [t for t in p.get("tags", []) if not t.startswith("person_")]
            base += photo_persons.get(p.get("path"), [])
            p["tags"] = sorted(set(base))
        store.save(photos_key, retagged)
        store.save(people_key, result["people"])
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
    "精选": "template_1",
    "人物": "template_1",
    "宠物": "template_1",
    "情绪": "template_1",
    "色彩": "template_1",
}
# 主题里按具体标签细分模板
_SUBJECT_TEMPLATE = {
    "food": "template_1",
    "city": "template_1",
    "nature": "template_1",
    "travel": "template_1",
    "sport": "template_1",
    "indoor": "template_1",
}


def _album_template(group: str, tag: str | None = None) -> str:
    if group == "主题" and tag in _SUBJECT_TEMPLATE:
        return _SUBJECT_TEMPLATE[tag]
    return _GROUP_TEMPLATE.get(group, "template_1")


@app.get("/api/smart_albums")
def smart_albums(x_account_token: str = Header(default="")) -> dict:
    """
    智能相簿：不再让用户勾一堆底层标签（暖色/冷色/红/蓝…），
    而是像苹果相册一样，AI 主动端出少数几个语义相簿——人物 / 宠物 / 主题 / 精选，
    每个相簿只有在相册里真实存在时才出现。前端单选点一下即出对应照片墙。
    每个相簿自带 filter（发给 /api/generate 就能出这个相簿的墙）。
    """
    scope = _account_scope(x_account_token)
    photos = store.load(_scoped_store_name("photos", scope), [])
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
    people = store.load(_scoped_store_name("people", scope), [])
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
def label(req: LabelReq, x_account_token: str = Header(default="")) -> dict:
    """人工打标：对本次画面涉及的元素维度评分，并立即训练偏好模型。"""
    scope = _account_scope(x_account_token)
    labels_key = _scoped_store_name("labels", scope)
    model_key = _scoped_store_name("model", scope)
    labels = store.load(labels_key, [])
    for s in req.samples:
        labels.append({"wall_id": req.wall_id, "tag": s.tag, "score": s.score, "ts": time.time()})
    store.save(labels_key, labels)

    model = trainer.train(
        [{"tag": s.tag, "score": s.score} for s in req.samples],
        storage_key=model_key,
    )
    return {"labeled": len(req.samples), "total_labels": len(labels), "model": model}


@app.post("/api/train")
def train_all(x_account_token: str = Header(default="")) -> dict:
    """用累计的全部标签重新训练（长期训练）。"""
    scope = _account_scope(x_account_token)
    labels_key = _scoped_store_name("labels", scope)
    model_key = _scoped_store_name("model", scope)
    labels = store.load(labels_key, [])
    if not labels:
        return {"trained": 0, "model": trainer.load_model(model_key)}
    model = trainer.train(
        [{"tag": l["tag"], "score": l["score"]} for l in labels],
        storage_key=model_key,
    )
    return {"trained": len(labels), "model": model}


# ---------- 设备级内容偏好版本 ----------

@app.get("/api/preferences")
def get_preference_profile(
    device_id: str,
    x_account_token: str = Header(default=""),
) -> Response:
    _, error = _preference_profile_for_request(device_id, x_account_token)
    if error:
        return error
    return JSONResponse(_load_preference_profile(device_id))


@app.post("/api/preferences/revisions")
def create_preference_revision(
    req: PreferenceRevisionReq,
    x_account_token: str = Header(default=""),
) -> Response:
    _, error = _preference_profile_for_request(req.device_id, x_account_token, require_publish=True)
    if error:
        return error
    if not isinstance(req.snapshot, dict):
        return JSONResponse(status_code=400, content={"error": "偏好快照格式无效"})
    with _PREFERENCE_POLICY_LOCK:
        profile = _load_preference_profile(req.device_id)
        parent_id = str(req.parent_id or profile.get("activeRevisionId") or "")
        if parent_id and not any(item.get("id") == parent_id for item in profile["revisions"]):
            return JSONResponse(status_code=409, content={"error": "偏好草稿基于的版本已不存在，请重新读取后保存"})
        if parent_id and parent_id != profile.get("activeRevisionId"):
            return JSONResponse(status_code=409, content={"error": "当前偏好已被另一位成员更新，请读取最新版本后再保存"})
        revision = {
            "id": f"pref_{time.time_ns()}_{secrets.token_hex(3)}",
            "parentId": parent_id or None,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source": str(req.source or "preferences"),
            "snapshot": req.snapshot,
        }
        profile["revisions"] = [*profile["revisions"], revision]
        profile["activeRevisionId"] = revision["id"]
        profile["onboardingCompleted"] = True
        _save_preference_profile(req.device_id, profile)
    return JSONResponse(profile)


@app.post("/api/preferences/activate")
def activate_preference_revision(
    req: PreferenceRevisionActivateReq,
    x_account_token: str = Header(default=""),
) -> Response:
    _, error = _preference_profile_for_request(req.device_id, x_account_token, require_publish=True)
    if error:
        return error
    with _PREFERENCE_POLICY_LOCK:
        profile = _load_preference_profile(req.device_id)
        if not any(item.get("id") == req.revision_id for item in profile["revisions"]):
            return JSONResponse(status_code=404, content={"error": "没有找到这个偏好版本"})
        profile["activeRevisionId"] = req.revision_id
        profile["onboardingCompleted"] = True
        _save_preference_profile(req.device_id, profile)
    return JSONResponse(profile)


@app.get("/api/model")
def get_model(x_account_token: str = Header(default="")) -> dict:
    scope = _account_scope(x_account_token)
    return trainer.load_model(_scoped_store_name("model", scope))


# ---------- 双端互联 WebSocket ----------

@app.websocket("/ws/display")
async def ws_display(ws: WebSocket) -> None:
    device_id = str(ws.query_params.get("device_id", "")).strip()
    managed_device = None
    if device_id:
        managed_device = _devices().get(device_id)
        if not managed_device or managed_device.get("device_family") != "walnutpi_19in":
            await ws.close(code=1008)
            return
    await hub.connect(ws, device_id if managed_device else "")
    last_wall_store = "last_wall"
    if managed_device:
        account_token = str(managed_device.get("account_token", ""))
        if account_token:
            last_wall_store = _scoped_store_name("last_wall", _account_scope(account_token))
    last = store.load(last_wall_store, None)
    if last:
        await ws.send_json({"type": "wall", **last})
    try:
        while True:
            await ws.receive_text()
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
    enhancement: str = "standard",
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
    if enhancement not in ("none", "standard", "strong"):
        return JSONResponse(status_code=400, content={"error": "显色增强参数无效"})

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
            enhancement=enhancement,
            preview_path=os.path.join(OUTPUT_DIR, preview_name),
            preview_url=f"/output/{preview_name}",
        )
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})


@app.post("/api/eink/prepare")
async def eink_prepare(
    file: UploadFile,
    dither: bool = True,
    fit: str = "contain",
    rotation: int = 0,
    enhancement: str = "standard",
) -> Response:
    """把照片转换为手机可下载并直传屏幕的 PWE6 六色帧，不连接局域网设备。"""
    if fit not in ("contain", "cover") or rotation not in (0, 90, 180, 270):
        return JSONResponse(status_code=400, content={"error": "图片适配参数无效"})
    if enhancement not in ("none", "standard", "strong"):
        return JSONResponse(status_code=400, content={"error": "显色增强参数无效"})

    image_bytes = await file.read()
    if not image_bytes or len(image_bytes) > 30 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": "请选择不超过 30MB 的图片"})
    try:
        preview, panel_codes = eink_push.prepare_image(
            image_bytes,
            dither=dither,
            fit=fit,
            rotation=rotation,
            enhancement=enhancement,
        )
    except Exception:
        return JSONResponse(status_code=400, content={"error": "无法识别或转换该图片"})

    preview.save(os.path.join(OUTPUT_DIR, "eink_direct_preview.png"), format="PNG", optimize=True)
    frame = eink_push.build_panel_frame(panel_codes)
    return Response(
        content=frame,
        media_type="application/vnd.photowall.pwe6",
        headers={
            "Content-Disposition": 'attachment; filename="display.pwe6"',
            "X-Panel-Width": str(eink_push.WIDTH),
            "X-Panel-Height": str(eink_push.HEIGHT),
            "Cache-Control": "no-store",
        },
    )


@app.get("/api/eink/status")
def eink_status() -> dict:
    """查询当前照片转换、传输与全刷进度。"""
    return eink_push.status()


# ---------- 无 Mac 设备链路：App 发布，屏幕主动拉取 ----------

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_PAIRING_CODE_RE = re.compile(r"^\d{6}$")
DEVICE_FRAMES_DIR = os.path.join(OUTPUT_DIR, "device_frames")
os.makedirs(DEVICE_FRAMES_DIR, exist_ok=True)


def _devices() -> dict[str, dict[str, Any]]:
    data = store.load("eink_devices", {})
    return data if isinstance(data, dict) else {}


def _public_device(device: dict[str, Any]) -> dict[str, Any]:
    private_keys = {
        "device_token",
        "account_token",
        "pending_wall",
        "reprovision_setup_token_digest",
        "reprovision_setup_token_expires_at",
    }
    return {key: value for key, value in device.items() if key not in private_keys}


def _device_auth(device: dict[str, Any], token: str) -> bool:
    expected = str(device.get("device_token", ""))
    return bool(expected and token and secrets.compare_digest(expected, token))


def _legacy_account_auth(device: dict[str, Any], token: str) -> bool:
    expected = str(device.get("account_token", ""))
    return bool(expected and token and secrets.compare_digest(expected, token))


def _account_auth(device: dict[str, Any], token: str) -> bool:
    return _legacy_account_auth(device, token) or family.can_access_device(token, device)


def _device_admin_auth(device: dict[str, Any], token: str) -> bool:
    return _legacy_account_auth(device, token) or family.can_manage_device(token, device)


def _device_publish_auth(device: dict[str, Any], token: str) -> bool:
    return _legacy_account_auth(device, token) or family.can_publish_to_device(token, device)


_PREFERENCE_POLICY_LOCK = threading.Lock()


def _empty_preference_profile() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "onboardingCompleted": False,
        "activeRevisionId": None,
        "revisions": [],
    }


def _preference_profile_key(device_id: str) -> str:
    # The policy belongs to the shared display, not a single contributor's
    # account. This lets all authorized family members inspect the same active
    # rule set while retaining immutable revisions for rollback.
    digest = hashlib.sha256(device_id.encode()).hexdigest()[:24]
    return f"device_preference_profile_{digest}"


def _load_preference_profile(device_id: str) -> dict[str, Any]:
    value = store.load(_preference_profile_key(device_id), _empty_preference_profile())
    if not isinstance(value, dict):
        return _empty_preference_profile()
    revisions = value.get("revisions")
    return {
        **_empty_preference_profile(),
        **value,
        "revisions": [item for item in revisions if isinstance(item, dict) and item.get("id") and item.get("snapshot")]
        if isinstance(revisions, list) else [],
    }


def _save_preference_profile(device_id: str, profile: dict[str, Any]) -> None:
    store.save(_preference_profile_key(device_id), profile)


def _preference_profile_for_request(device_id: str, token: str, *, require_publish: bool = False) -> tuple[dict[str, Any] | None, Response | None]:
    device = _devices().get(device_id)
    authorized = _device_publish_auth(device, token) if require_publish and device else _account_auth(device, token) if device else False
    if not device or not authorized:
        return None, JSONResponse(status_code=401, content={"error": "设备授权无效"})
    return device, None


def _bound_account(token: str) -> bool:
    return bool(token) and any(
        device.get("claimed") and _account_auth(device, token)
        for device in _devices().values()
    )


@app.post("/api/pet-collage/jobs")
def create_pet_collage_job(
    req: PetCollageJobReq,
    background_tasks: BackgroundTasks,
    x_account_token: str = Header(default=""),
) -> Response:
    if not _bound_account(x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    scope = _account_scope(x_account_token)
    photos = store.load(_scoped_store_name("photos", scope), [])
    if req.filenames:
        allowed = set(req.filenames)
        photos = [photo for photo in photos if str(photo.get("filename", "")) in allowed]
    try:
        job = pet_collage.start_job(scope, photos)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"error": str(error)})
    background_tasks.add_task(pet_collage.analyze_job, scope, str(job["job_id"]))
    return JSONResponse(status_code=202, content=job)


@app.get("/api/pet-collage/jobs/{job_id}")
def get_pet_collage_job(
    job_id: str,
    x_account_token: str = Header(default=""),
) -> Response:
    if not _bound_account(x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    job = pet_collage.get_job(_account_scope(x_account_token), job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "拼贴任务不存在或已过期"})
    return JSONResponse(pet_collage.public_job(job))


@app.post("/api/pet-collage/jobs/{job_id}/cutouts")
async def upload_pet_collage_cutout(
    job_id: str,
    background_tasks: BackgroundTasks,
    filename: str = Form(...),
    file: UploadFile = File(...),
    x_account_token: str = Header(default=""),
) -> Response:
    if not _bound_account(x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    data = await file.read(pet_collage.MAX_CUTOUT_BYTES + 1)
    scope = _account_scope(x_account_token)
    try:
        job, complete = pet_collage.add_cutout(scope, job_id, filename, data)
    except FileNotFoundError as error:
        return JSONResponse(status_code=404, content={"error": str(error)})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"error": str(error)})
    if complete:
        background_tasks.add_task(pet_collage.compose_job, scope, job_id)
    return JSONResponse(status_code=202, content=job)


def _queue_reprovision(device: dict[str, Any], preserve_binding: bool) -> None:
    """Ask the authenticated display to restart in BLE provisioning mode.

    A Wi-Fi change keeps the account binding. Removing a display revokes the
    account immediately, while retaining the device credential only long enough
    for the display to receive and acknowledge the reset command.
    """
    device["pending_command"] = {
        "type": "reprovision",
        "preserve_binding": bool(preserve_binding),
        "created_at": time.time(),
    }
    device["state"] = "reprovision_pending"
    device["progress"] = 0.0
    device["error"] = ""
    device.pop("reprovision_setup_token_digest", None)
    device.pop("reprovision_setup_token_expires_at", None)
    if not preserve_binding:
        device["claimed"] = False
        device["account_token"] = ""
        device.pop("setup_token_digest", None)
        device.pop("setup_token_expires_at", None)


def _july_calendar_plan(photos: list[dict], model: dict | None = None) -> tuple[dict[str, Any], int]:
    """Build a deterministic July 2026 calendar plan from the existing album.

    The normal selector remains the only photo-ranking authority.  Calendar
    rendering is deliberately a downstream layout step, so it cannot change
    daily-wall preference scores or require a Qwen credential.
    """
    by_day: dict[int, list[dict]] = {day: [] for day in range(1, 32)}
    for photo in photos:
        try:
            taken = datetime.datetime.fromtimestamp(float(photo.get("taken_at")))
        except (TypeError, ValueError, OSError, OverflowError):
            continue
        if (taken.year, taken.month) == (2026, 7) and 1 <= taken.day <= 31:
            by_day[taken.day].append(photo)

    selected_count = 0
    days: list[dict[str, Any]] = []
    for day in range(1, 32):
        candidates = by_day[day]
        if not candidates:
            days.append({
                "day": day,
                "sources": [],
                "treatment": "blank",
                "reason": "当天没有已同步的相机照片，保留留白。",
                "placements": [],
            })
            continue

        chosen = selector.rank_photos(candidates, model=model)[0]
        selected_count += 1
        days.append({
            "day": day,
            "sources": [chosen["path"]],
            "treatment": "proportional_full_image",
            "reason": "按现有质量、美观度和偏好综合评分选出的当天代表照片。",
            "selection": {
                "filename": chosen.get("filename", ""),
                "final_score": chosen.get("final_score", 0.0),
            },
            "placements": [{
                "kind": "photo",
                "fit": "cover",
                "box": [0.01, 0.01, 0.98, 0.98],
                "focal": [0.5, 0.5],
                "rotation": 0,
            }],
        })

    return {
        "schema_version": "1.0",
        "calendar": {
            "year": 2026,
            "month": 7,
            "week_start": "sunday",
            "template": "calendar_template_v1",
        },
        "decision": {
            "backend": "photowall_selector_v1",
            "api_used": False,
            "cutout_style": {"white_outline": False, "shadow": False},
        },
        "days": days,
    }, selected_count


def _queue_device_image(device: dict[str, Any], image_bytes: bytes, *, title: str = "照片墙画面") -> tuple[str, str]:
    """Convert an image to PWE6 and make it the device's next cloud-pulled frame."""
    preview, panel_codes = eink_push.prepare_image(
        image_bytes,
        dither=True,
        fit="contain",
        rotation=0,
        enhancement="none",
    )
    revision = str(time.time_ns())
    device_id = str(device["device_id"])
    device_dir = os.path.join(DEVICE_FRAMES_DIR, device_id)
    os.makedirs(device_dir, exist_ok=True)
    frame_path = os.path.join(device_dir, f"{revision}.pwe6")
    preview_path = os.path.join(device_dir, f"{revision}.png")
    with open(frame_path, "wb") as output:
        output.write(eink_push.build_panel_frame(panel_codes))
    preview.save(preview_path, format="PNG", optimize=True)
    device.update({
        "revision": revision,
        "frame_path": frame_path,
        "preview_url": f"/output/device_frames/{device_id}/{revision}.png",
        "published_at": time.time(),
        "state": "queued",
        "progress": 0.0,
        "error": "",
    })
    display_history.stage(device, revision, title=title, image_url=device["preview_url"])
    return revision, preview_path


def _materialize_calendar_sources(plan: dict[str, Any], run_dir: str) -> None:
    """Copy selected originals into date-prefixed proxies required by calendar QA."""
    proxy_dir = os.path.join(run_dir, "proxies")
    os.makedirs(proxy_dir, exist_ok=True)
    for day in plan["days"]:
        sources = list(day.get("sources", []))
        if not sources:
            continue
        source = sources[0]
        if not os.path.isfile(source):
            raise OSError(f"找不到日历候选照片：{source}")
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(source))
        proxy_path = os.path.join(proxy_dir, f"2026-07-{int(day['day']):02d}__{safe_name}")
        shutil.copy2(source, proxy_path)
        day["sources"] = [proxy_path]


@app.post("/api/devices/bootstrap")
def device_bootstrap(req: DeviceBootstrapReq) -> Response:
    """设备连上 Wi-Fi 后首次登记；后续启动使用已保存的 device token 报到。"""
    if not _DEVICE_ID_RE.fullmatch(req.device_id) or not _PAIRING_CODE_RE.fullmatch(req.pairing_code):
        return JSONResponse(status_code=400, content={"error": "设备编号或配对码格式无效"})
    device_family = str(req.device_family or "esp32_e6").strip().lower()
    if device_family not in ("esp32_e6", "walnutpi_19in"):
        return JSONResponse(status_code=400, content={"error": "设备类型无效"})

    devices_data = _devices()
    existing = devices_data.get(req.device_id)
    if existing and existing.get("device_token") and not _device_auth(existing, req.device_token):
        pending = existing.get("pending_command")
        setup_token = req.setup_token.strip()
        reset_is_pending = (
            not req.device_token and
            not existing.get("claimed") and
            isinstance(pending, dict) and
            pending.get("type") == "reprovision" and
            not pending.get("preserve_binding")
        )
        retained_reset_is_authorized = (
            not req.device_token and
            len(setup_token) >= 24 and
            existing.get("claimed") and
            isinstance(pending, dict) and
            pending.get("type") == "reprovision" and
            pending.get("preserve_binding") and
            float(existing.get("reprovision_setup_token_expires_at", 0)) >= time.time() and
            secrets.compare_digest(
                str(existing.get("reprovision_setup_token_digest", "")),
                hashlib.sha256(setup_token.encode()).hexdigest(),
            )
        )
        if reset_is_pending:
            existing = None
        elif retained_reset_is_authorized:
            existing["device_token"] = secrets.token_urlsafe(32)
        else:
            return JSONResponse(status_code=401, content={"error": "设备凭据无效，请恢复出厂后重新配网"})

    now = time.time()
    device = existing or {
        "device_id": req.device_id,
        "device_token": secrets.token_urlsafe(32),
        "account_token": "",
        "claimed": False,
        "name": "19 寸实时展示屏" if device_family == "walnutpi_19in" else "PhotoWall E6",
        "created_at": now,
        "revision": "",
        "displayed_revision": "",
    }
    device.update({
        "device_family": device_family,
        "ip": req.ip,
        "firmware_version": req.firmware_version,
        "last_seen": now,
        "state": "online",
        "error": "",
    })
    if device_family != "walnutpi_19in" or not device.get("claimed"):
        device["pairing_code"] = req.pairing_code
    setup_token = req.setup_token.strip()
    pending = device.get("pending_command")
    if (
        setup_token and
        device.get("claimed") and
        isinstance(pending, dict) and
        pending.get("type") == "reprovision" and
        pending.get("preserve_binding")
    ):
        # A retained device credential plus a fresh setup token proves that the
        # display completed its replacement Wi-Fi setup, even if the earlier
        # acknowledgement was lost on the old network.
        device.pop("pending_command", None)
        device.pop("reprovision_setup_token_digest", None)
        device.pop("reprovision_setup_token_expires_at", None)
    if not device.get("claimed") and setup_token:
        token_digest = hashlib.sha256(setup_token.encode()).hexdigest()
        if device.get("setup_token_digest") != token_digest:
            device["setup_token_digest"] = token_digest
            device["setup_token_expires_at"] = now + 600
    devices_data[req.device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({
        "device_id": req.device_id,
        "device_token": device["device_token"],
        "claimed": bool(device.get("claimed")),
        "poll_seconds": 15,
    })


@app.post("/api/devices/claim")
def device_claim(req: DeviceClaimReq) -> Response:
    """App 使用屏幕/机身上的六位码绑定最近在线的设备。"""
    if not _PAIRING_CODE_RE.fullmatch(req.pairing_code):
        return JSONResponse(status_code=400, content={"error": "请输入六位配对码"})
    devices_data = _devices()
    matches = [d for d in devices_data.values() if d.get("pairing_code") == req.pairing_code]
    if not matches:
        return JSONResponse(status_code=404, content={"error": "设备尚未联网，请完成配网后重试"})
    device = max(matches, key=lambda item: float(item.get("last_seen", 0)))
    if time.time() - float(device.get("last_seen", 0)) > 300:
        return JSONResponse(status_code=409, content={"error": "设备已离线，请确认配网状态"})
    if not device.get("account_token"):
        device["account_token"] = secrets.token_urlsafe(32)
    device["claimed"] = True
    device["name"] = req.name.strip()[:40] or "客厅照片墙"
    if device.get("device_family") == "walnutpi_19in":
        device.pop("pairing_code", None)
    devices_data[device["device_id"]] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "account_token": device["account_token"]})


@app.post("/api/devices/auto-claim")
def device_auto_claim(req: DeviceAutoClaimReq) -> Response:
    """Bind a display using the single-use token read from its local setup AP."""
    setup_token = req.setup_token.strip()
    if not _DEVICE_ID_RE.fullmatch(req.device_id) or len(setup_token) < 24:
        return JSONResponse(status_code=400, content={"error": "设备自动绑定信息无效"})

    devices_data = _devices()
    device = devices_data.get(req.device_id)
    if not device:
        return JSONResponse(status_code=404, content={"error": "设备尚未联网，请完成 Wi-Fi 配置后重试"})
    if time.time() - float(device.get("last_seen", 0)) > 300:
        return JSONResponse(status_code=409, content={"error": "设备已离线，请重新连接设备热点后重试"})
    expected_digest = str(device.get("setup_token_digest", ""))
    expires_at = float(device.get("setup_token_expires_at", 0))
    supplied_digest = hashlib.sha256(setup_token.encode()).hexdigest()
    if not expected_digest or time.time() > expires_at or not hmac.compare_digest(expected_digest, supplied_digest):
        return JSONResponse(status_code=403, content={"error": "自动绑定已过期，请重新开始设备配网"})

    if not device.get("account_token"):
        device["account_token"] = secrets.token_urlsafe(32)
    device["claimed"] = True
    device["name"] = req.name.strip()[:40] or "客厅照片墙"
    device.pop("setup_token_digest", None)
    device.pop("setup_token_expires_at", None)
    devices_data[req.device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "account_token": device["account_token"]})


@app.get("/api/devices")
def device_list(x_account_token: str = Header(default="")) -> Response:
    devices_data = _devices()
    visible = []
    for device in devices_data.values():
        if not _account_auth(device, x_account_token):
            continue
        public = _public_device(device)
        public["can_manage"] = _device_admin_auth(device, x_account_token)
        public["can_publish"] = _device_publish_auth(device, x_account_token)
        visible.append(public)
    return JSONResponse({"devices": visible})


@app.get("/api/devices/{device_id}/display-history")
def device_display_history(
    device_id: str,
    x_account_token: str = Header(default=""),
) -> Response:
    """Only device-confirmed publications from this device's current binding."""
    device = _devices().get(device_id)
    if not device or not _account_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    return JSONResponse({"records": display_history.records_for(device)})


@app.post("/api/devices/{device_id}/reprovision")
def device_reprovision(
    device_id: str,
    req: DeviceReprovisionReq | None = None,
    x_account_token: str = Header(default=""),
) -> Response:
    """Keep the binding but make the display re-enter BLE Wi-Fi setup."""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_admin_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    if device.get("device_family") == "walnutpi_19in":
        return JSONResponse(status_code=400, content={"error": "19 寸屏无需重新配网"})
    _queue_reprovision(device, preserve_binding=True)
    setup_token = req.setup_token.strip() if req else ""
    if setup_token:
        if len(setup_token) < 24:
            return JSONResponse(status_code=400, content={"error": "设备配网凭据无效"})
        device["reprovision_setup_token_digest"] = hashlib.sha256(setup_token.encode()).hexdigest()
        device["reprovision_setup_token_expires_at"] = time.time() + 600
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse(
        status_code=202,
        content={"device": _public_device(device), "reprovision_required": True},
    )


@app.delete("/api/devices/{device_id}")
def device_delete(
    device_id: str,
    x_account_token: str = Header(default=""),
) -> Response:
    """Revoke the App binding and ask the display to erase its setup."""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_admin_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    screen19 = device.get("device_family") == "walnutpi_19in"
    if screen19:
        device["claimed"] = False
        device["account_token"] = ""
        device["state"] = "online"
        device["progress"] = 0.0
        device.pop("pending_wall", None)
    else:
        _queue_reprovision(device, preserve_binding=False)
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse(
        status_code=202,
        content={"device_id": device_id, "removed": True, "reprovision_required": not screen19},
    )


@app.post("/api/devices/{device_id}/publish")
async def device_publish(
    device_id: str,
    file: UploadFile,
    dither: bool = True,
    fit: str = "contain",
    rotation: int = 0,
    enhancement: str = "standard",
    x_account_token: str = Header(default=""),
) -> Response:
    """App 上传照片，云端转换为 PWE6 并设置为设备下一待显示版本。"""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_publish_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    if device.get("device_family") == "walnutpi_19in":
        return JSONResponse(status_code=400, content={"error": "19 寸屏请使用模板发布"})
    if fit not in ("contain", "cover") or rotation not in (0, 90, 180, 270):
        return JSONResponse(status_code=400, content={"error": "图片适配参数无效"})
    if enhancement not in ("none", "standard", "strong"):
        return JSONResponse(status_code=400, content={"error": "显色增强参数无效"})

    image_bytes = await file.read()
    if not image_bytes or len(image_bytes) > 30 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": "请选择不超过 30MB 的图片"})
    try:
        preview, panel_codes = eink_push.prepare_image(
            image_bytes, dither=dither, fit=fit, rotation=rotation, enhancement=enhancement)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "无法识别或转换该图片"})

    revision = str(time.time_ns())
    device_dir = os.path.join(DEVICE_FRAMES_DIR, device_id)
    os.makedirs(device_dir, exist_ok=True)
    frame_path = os.path.join(device_dir, f"{revision}.pwe6")
    preview_path = os.path.join(device_dir, f"{revision}.png")
    frame_data = eink_push.build_panel_frame(panel_codes)
    with open(frame_path, "wb") as output:
        output.write(frame_data)
    preview.save(preview_path, format="PNG", optimize=True)

    device.update({
        "revision": revision,
        "frame_path": frame_path,
        "preview_url": f"/output/device_frames/{device_id}/{revision}.png",
        "published_at": time.time(),
        "state": "queued",
        "progress": 0.0,
        "error": "",
    })
    display_history.stage(device, revision, title="照片墙画面", image_url=device["preview_url"])
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "revision": revision})


@app.post("/api/devices/{device_id}/publish-last-wall")
async def device_publish_last_wall(
    device_id: str,
    req: Optional[PublishWallReq] = None,
    x_account_token: str = Header(default=""),
) -> Response:
    """Queue the most recently generated cloud template after App confirmation."""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_publish_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    scope = _account_scope(x_account_token)
    wall = store.load(_scoped_store_name("last_wall", scope), {})
    requested_wall_id = str(req.wall_id if req else "")
    if requested_wall_id and requested_wall_id != str(wall.get("wall_id", "")):
        return JSONResponse(
            status_code=409,
            content={"error": "当前预览已被新画面替换，请重新生成后再发布"},
        )
    wall_preference_revision = str(wall.get("preference_revision_id") or "")
    if wall_preference_revision:
        active_preference_revision = str(_load_preference_profile(device_id).get("activeRevisionId") or "")
        if active_preference_revision != wall_preference_revision:
            return JSONResponse(
                status_code=409,
                content={"error": "偏好已更新，旧预览不能再发布；请按当前版本重新生成"},
            )
    image_url = str(wall.get("image_url", ""))
    if not image_url.startswith("/output/"):
        return JSONResponse(status_code=404, content={"error": "没有可发布的模板预览，请先生成画面"})
    image_path = os.path.join(OUTPUT_DIR, os.path.basename(image_url))
    if not os.path.isfile(image_path):
        return JSONResponse(status_code=404, content={"error": "模板预览已过期，请重新生成"})
    if device.get("device_family") == "walnutpi_19in":
        revision = str(wall.get("wall_id", ""))
        device.pop("frame_path", None)
        device.pop("preview_url", None)
        device.pop("pending_wall", None)
        device.update({
            "revision": revision,
            "published_at": time.time(),
            "state": "queued",
            "progress": 100.0,
            "error": "",
        })
        display_history.stage(device, revision, title=wall.get("title", "照片墙画面"), image_url=image_url)
        devices_data[device_id] = device
        store.save("eink_devices", devices_data)
        await hub.send_device(device_id, {"type": "wall", **wall})
    else:
        with open(image_path, "rb") as image_file:
            revision, _ = _queue_device_image(device, image_file.read(), title=wall.get("title", "照片墙画面"))
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "revision": revision, "wall": wall})


@app.post("/api/devices/{device_id}/calendar/july-2026/publish")
async def device_publish_july_calendar(
    device_id: str,
    x_account_token: str = Header(default=""),
) -> Response:
    """Generate a QA-approved July 2026 calendar from the synced album and queue it.

    Only photos genuinely captured in July 2026 are eligible. This prevents an
    attractive but misleading calendar assembled from unrelated dates.
    """
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_publish_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    if device.get("device_family") == "walnutpi_19in":
        return JSONResponse(status_code=400, content={"error": "家庭日历当前仅支持 ESP32 墨水屏"})

    scope = _account_scope(x_account_token)
    photos_key = _scoped_store_name("photos", scope)
    photos = store.load(photos_key, [])
    photos, _ = dedup.deduplicate(photos)
    preference_model = trainer.load_model(_scoped_store_name("model", scope))
    plan, selected_count = _july_calendar_plan(photos, model=preference_model)
    if not selected_count:
        return JSONResponse(
            status_code=400,
            content={"error": "没有已同步的 2026 年 7 月相机照片，暂时无法生成七月日历"},
        )

    from calendar_engine import GenerationError, generate_july_calendar

    run_id = f"july-2026-{time.time_ns()}"
    run_dir = os.path.join(OUTPUT_DIR, "calendar_runs", device_id, run_id)
    os.makedirs(run_dir, exist_ok=True)
    plan_path = os.path.join(run_dir, "treatment_plan.json")

    try:
        _materialize_calendar_sources(plan, run_dir)
        with open(plan_path, "w", encoding="utf-8") as output:
            json.dump(plan, output, ensure_ascii=False, indent=2)
        result = generate_july_calendar(run_dir, final_name="calendar.png", preview_name="preview.jpg")
        image_bytes = result.calendar_path.read_bytes()
        revision, _ = _queue_device_image(device, image_bytes, title="2026 年 7 月日历")
    except (GenerationError, OSError, ValueError) as exc:
        return JSONResponse(status_code=500, content={"error": f"七月日历生成失败：{exc}"})

    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({
        "device": _public_device(device),
        "revision": revision,
        "calendar": {
            "year": 2026,
            "month": 7,
            "selected_day_count": selected_count,
            "qa": result.qa_report.get("status"),
        },
    })


@app.get("/api/devices/{device_id}/next")
def device_next(device_id: str, revision: str = "", token: str = "") -> Response:
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_auth(device, token):
        return JSONResponse(status_code=401, content={"error": "设备凭据无效"})
    pending = device.get("pending_command")
    device["last_seen"] = time.time()
    if not isinstance(pending, dict):
        device["state"] = "online" if not device.get("revision") else device.get("state", "online")
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    if isinstance(pending, dict) and pending.get("type") == "reprovision":
        return JSONResponse({
            "command": "reprovision",
            "preserve_binding": bool(pending.get("preserve_binding")),
        })
    target = str(device.get("revision", ""))
    if not target or target == revision:
        return Response(status_code=204)
    return JSONResponse({
        "revision": target,
        "size": eink_push.FRAME_HEADER.size + (eink_push.WIDTH * eink_push.HEIGHT // 2),
        "frame_url": f"/api/devices/{device_id}/frame/{target}?token={token}",
    })


@app.get("/api/devices/{device_id}/frame/{revision}")
def device_frame(device_id: str, revision: str, token: str = "") -> Response:
    device = _devices().get(device_id)
    if not device or not _device_auth(device, token) or str(device.get("revision")) != revision:
        return JSONResponse(status_code=401, content={"error": "画面授权无效"})
    frame_path = str(device.get("frame_path", ""))
    if not frame_path or not os.path.isfile(frame_path):
        return JSONResponse(status_code=404, content={"error": "画面文件不存在"})
    return FileResponse(frame_path, media_type="application/vnd.photowall.pwe6", filename="display.pwe6")


@app.post("/api/devices/{device_id}/status")
def device_status(device_id: str, req: DeviceStatusReq, token: str = "") -> Response:
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_auth(device, token):
        return JSONResponse(status_code=401, content={"error": "设备凭据无效"})
    pending = device.get("pending_command")
    if req.state == "unbound":
        if not isinstance(pending, dict) or pending.get("type") != "reprovision" or pending.get("preserve_binding"):
            return JSONResponse(status_code=409, content={"error": "设备没有待执行的删除命令"})
        devices_data.pop(device_id, None)
        store.save("eink_devices", devices_data)
        return JSONResponse({"ok": True, "removed": True})
    if req.state == "reprovisioning":
        if not isinstance(pending, dict) or pending.get("type") != "reprovision" or not pending.get("preserve_binding"):
            return JSONResponse(status_code=409, content={"error": "设备没有待执行的重新配网命令"})
        device.pop("pending_command", None)
    device.update({
        "state": req.state[:24],
        "progress": max(0.0, min(float(req.progress), 100.0)),
        "error": req.error[:240],
        "last_seen": time.time(),
        "ip": req.ip or device.get("ip", ""),
    })
    if req.state == "displayed" and req.revision == str(device.get("revision", "")):
        device["displayed_revision"] = req.revision
        if not req.error:
            display_history.confirm(device, req.revision)
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"ok": True})


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
app.include_router(family.router)
app.include_router(test_devices.router)


app.mount("/eink", StaticFiles(directory=EINK_UI_DIR, html=True), name="eink")
app.mount("/studio", StaticFiles(directory=os.path.join(_ROOT, "studio"), html=True), name="studio")
app.mount("/app", StaticFiles(directory=WEBAPP_DIR, html=True), name="app")
app.mount("/screen", StaticFiles(directory=DISPLAY_DIR, html=True), name="screen")
app.mount("/screen19", StaticFiles(directory=DISPLAY_19_DIR, html=True), name="screen19")


@app.get("/healthz")
def healthz() -> JSONResponse:
    storage_ready = all(
        os.path.isdir(directory) and os.access(directory, os.R_OK | os.W_OK)
        for directory in (PHOTOS_DIR, OUTPUT_DIR, store._BASE)
    )
    payload = {
        "status": "ok" if storage_ready else "degraded",
        "storage_ready": storage_ready,
    }
    return JSONResponse(content=payload, status_code=200 if storage_ready else 503)


@app.get("/")
def index() -> dict:
    return {
        "service": "手帐照片墙",
        "app": "/app",
        "screen": "/screen",
        "endpoints": ["/api/authorize", "/api/generate", "/api/label", "/api/train", "/ws/display"],
    }

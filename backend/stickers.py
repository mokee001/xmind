"""
贴纸维度：用户上传抠图贴纸 -> 达标校验 -> 打「主题」标签 -> 生成照片墙时随机挑选、
按分布规则贴到画面上（优先挂在与贴纸主题相符的照片旁，避开人脸/主体中心）。

贴纸库独立于照片库：
- 文件放在 photo-wall/stickers/（可直接丢 PNG/WEBP 进去，也可经 App /api/upload_sticker 上传）。
- 元数据存在 store "stickers"：[{filename, path, themes:[...], qualified, reason, w, h, alpha_ratio}]。

「达标」判定（借鉴贴纸的本质=透明抠图，而不是一整张图片）：
- 必须有透明通道且透明占比合理（是抠图，不是不透明方图，也不是几乎全透明）。
- 尺寸不过小/过大，长宽比不极端。
"""

from __future__ import annotations

import glob
import os
import random

from PIL import Image

from . import store

# 让 WEBP/含透明的 HEIC 也能读（装了 pillow-heif 才对 HEIC 生效；WEBP 是 Pillow 原生）
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:
    pass

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STICKERS_DIR = os.path.join(_ROOT, "stickers")

# 主题词表：把中文/别名映射到与「照片标签」一致的维度，贴纸才能和照片墙主题对上。
# "any"/"通用" 表示任何主题都可出现（兜底贴纸）。
THEME_ALIASES = {
    "any": "any", "通用": "any", "general": "any", "全部": "any",
    "food": "food", "美食": "food", "食物": "food", "吃": "food",
    "people": "people", "人物": "people", "人": "people", "portrait": "people", "自拍": "people",
    "pet": "pet", "宠物": "pet", "cat": "pet", "猫": "pet", "dog": "pet", "狗": "pet",
    "travel": "travel", "旅行": "travel", "旅游": "travel",
    "nature": "nature", "风景": "nature", "自然": "nature", "花": "flower", "flower": "flower",
    "city": "city", "城市": "city", "night": "night", "夜": "night",
    "beach": "beach", "海": "beach", "sport": "sport", "运动": "sport",
    "indoor": "indoor", "居家": "indoor", "室内": "indoor",
    "mood_fresh": "mood_fresh", "清新": "mood_fresh", "治愈": "mood_fresh",
    "mood_vivid": "mood_vivid", "活力": "mood_vivid",
    "mood_vintage": "mood_vintage", "复古": "mood_vintage", "文艺": "mood_vintage",
    "mood_calm": "mood_calm", "静谧": "mood_calm", "安静": "mood_calm",
    "warm": "warm", "暖": "warm", "cool": "cool", "冷": "cool",
}


def _norm_themes(themes) -> list[str]:
    """把用户/文件名给的主题词统一成标准 tag；无法识别的原样保留（小写），空则 ["any"]。"""
    out: list[str] = []
    for t in themes or []:
        key = str(t).strip().lower()
        if not key:
            continue
        out.append(THEME_ALIASES.get(key, THEME_ALIASES.get(str(t).strip(), key)))
    # 去重保序
    seen: set[str] = set()
    uniq = [x for x in out if not (x in seen or seen.add(x))]
    return uniq or ["any"]


def _infer_themes(path: str) -> list[str]:
    """从「子文件夹名 + 文件名」里推断主题（如 stickers/美食/x.png 或 food_star.png）。"""
    rel = os.path.relpath(path, STICKERS_DIR)
    parts = rel.replace("\\", "/").split("/")
    tokens: list[str] = []
    for seg in parts[:-1]:                      # 子文件夹名
        tokens.append(seg)
    stem = os.path.splitext(parts[-1])[0]       # 文件名（去扩展名）
    for chunk in stem.replace("-", "_").split("_"):
        tokens.append(chunk)
    themes = [THEME_ALIASES[t.lower()] for t in tokens if t.lower() in THEME_ALIASES]
    return _norm_themes(themes) if themes else ["any"]


def qualify(path: str) -> tuple[bool, str, dict]:
    """判定一张贴纸是否「达标」。返回 (是否达标, 原因, 元数据)。"""
    try:
        img = Image.open(path)
        img.load()
    except Exception:
        return False, "无法读取图片", {}

    has_alpha = img.mode in ("RGBA", "LA", "PA") or ("transparency" in img.info)
    if not has_alpha:
        return False, "不是透明抠图（贴纸需要 PNG/WEBP 透明背景，不能是整张不透明图片）", {}

    rgba = img.convert("RGBA")
    w, h = rgba.size
    if min(w, h) < 64:
        return False, "尺寸太小（短边需 ≥ 64px）", {}
    if max(w, h) > 3000:
        return False, "尺寸太大（长边需 ≤ 3000px）", {}
    ar = w / h if h else 1.0
    if ar < 0.2 or ar > 5.0:
        return False, "长宽比过于极端（需在 1:5 ~ 5:1 之间）", {}

    # 透明占比（缩略图上估算即可）：抠图应有一定透明区，但不能几乎全透明
    thumb = rgba.copy()
    thumb.thumbnail((120, 120))
    alpha = list(thumb.split()[3].getdata())
    total = len(alpha) or 1
    ratio = sum(1 for a in alpha if a < 16) / total
    if ratio < 0.05:
        return False, "几乎没有透明区域（更像整张图片，而不是抠图贴纸）", {}
    if ratio > 0.97:
        return False, "几乎全透明（内容太少）", {}

    return True, "", {"w": w, "h": h, "alpha_ratio": round(ratio, 3)}


def _make_entry(path: str, themes: list[str]) -> dict:
    ok, reason, meta = qualify(path)
    return {
        "filename": os.path.basename(path),
        "path": path,
        "themes": _norm_themes(themes),
        "qualified": ok,
        "reason": reason,
        "w": meta.get("w", 0),
        "h": meta.get("h", 0),
        "alpha_ratio": meta.get("alpha_ratio", 0.0),
    }


def load_all() -> list[dict]:
    return store.load("stickers", [])


def ingest_folder() -> list[dict]:
    """扫描 stickers/ 目录，把新贴纸达标校验后并入库；已在库里的保留其（用户填的）主题。"""
    os.makedirs(STICKERS_DIR, exist_ok=True)
    existing = {s.get("path"): s for s in load_all()}
    files: list[str] = []
    for ext in ("*.png", "*.PNG", "*.webp", "*.WEBP"):
        files.extend(glob.glob(os.path.join(STICKERS_DIR, "**", ext), recursive=True))
    result: list[dict] = []
    for path in sorted(set(files)):
        if not os.path.exists(path):
            continue
        if path in existing:                    # 保留已有条目（含用户上传时填的主题）
            result.append(existing[path])
        else:
            result.append(_make_entry(path, _infer_themes(path)))
    store.save("stickers", result)
    return result


def add_uploaded(path: str, themes: list[str] | None) -> dict:
    """App 上传贴纸后调用：达标校验 + 主题 -> 并入库（同路径覆盖）。"""
    entry = _make_entry(path, themes or _infer_themes(path))
    others = [s for s in load_all() if s.get("path") != path]
    store.save("stickers", others + [entry])
    return entry


# ---------- 挑选 + 分布规则 ----------

def _plan_placements(template: dict, chosen: list[dict], stickers: list[dict],
                     W: int, H: int) -> list[dict]:
    """给选中的贴纸算落点。分布规则：
      · 优先「挂」在与贴纸主题相符的那张照片的某个角上（美食贴纸贴到美食照片旁）；
      · 否则落在随机照片的角/画面四周留白；
      · 贴在照片角上（不是正中）以避开人脸/主体；随机旋转 ±20°、随机大小；
      · 贴纸之间避免明显重叠（多次尝试换位）。
    返回 [{path, cx, cy, w, rotation}]，cx/cy 为贴纸中心。"""
    slots = template.get("slots", [])
    n_slot = min(len(slots), len(chosen))
    placed: list[tuple[float, float, float, float]] = []
    out: list[dict] = []

    for st in stickers:
        themes = set(st.get("themes", []))
        # 与主题相符的照片槽位
        cand = [i for i in range(n_slot)
                if themes & {str(t).lower() for t in chosen[i].get("tags", [])}]
        target_w = int(W * random.uniform(0.12, 0.20))
        ratio = (st.get("h", 1) / st.get("w", 1)) if st.get("w") else 1.0
        rw, rh = target_w, int(target_w * ratio)

        for _ in range(8):
            if cand and random.random() < 0.8:
                i = random.choice(cand)
            elif n_slot and random.random() < 0.6:
                i = random.randrange(n_slot)
            else:
                i = None

            if i is not None:
                s = slots[i]
                corners = [
                    (s["x"], s["y"]), (s["x"] + s["w"], s["y"]),
                    (s["x"], s["y"] + s["h"]), (s["x"] + s["w"], s["y"] + s["h"]),
                ]
                bx, by = random.choice(corners)
                cx = bx + random.randint(-target_w // 4, target_w // 4)
                cy = by + random.randint(-target_w // 4, target_w // 4)
            else:
                cx = int(W * random.choice([random.uniform(0.07, 0.14), random.uniform(0.86, 0.93)]))
                cy = int(H * random.choice([random.uniform(0.08, 0.16), random.uniform(0.84, 0.92)]))

            # 夹进画布内（留 5px 边）
            cx = max(rw // 2 + 5, min(W - rw // 2 - 5, cx))
            cy = max(rh // 2 + 5, min(H - rh // 2 - 5, cy))

            ok = True
            for (px, py, pw, ph) in placed:
                if abs(cx - px) < (rw + pw) * 0.35 and abs(cy - py) < (rh + ph) * 0.35:
                    ok = False
                    break
            if ok:
                placed.append((cx, cy, rw, rh))
                out.append({"path": st["path"], "cx": cx, "cy": cy,
                            "w": rw, "rotation": round(random.uniform(-20, 20), 1)})
                break
    return out


def plan_for_wall(template: dict, chosen: list[dict], applied_filters: list[str],
                  W: int, H: int, min_count: int = 0) -> list[dict]:
    """一屏照片墙的贴纸方案：按主题匹配挑贴纸 + 随机数量（克制）+ 分布落点。
    没有达标/匹配的贴纸就返回空（这屏不贴），完全不影响照片墙本身。
    min_count：至少贴几张（预览平台用，保证能看到贴纸效果）。"""
    pool = [s for s in load_all() if s.get("qualified")]
    if not pool:
        return []

    wall_tags = {str(f).lower() for f in (applied_filters or [])}
    for c in chosen:
        for t in c.get("tags", []):
            wall_tags.add(str(t).lower())

    matched = [s for s in pool if ("any" in s.get("themes", [])) or (set(s.get("themes", [])) & wall_tags)]
    if not matched:
        matched = [s for s in pool if "any" in s.get("themes", [])]
    if not matched:
        return []

    slot_n = len(template.get("slots", []))
    max_n = 3 if slot_n >= 10 else 2
    # 克制的出现频率：多数屏 0~1 张，偶尔 2~3 张给点惊喜
    n = random.choices([0, 1, 2, 3], weights=[35, 35, 22, 8])[0]
    n = max(n, min_count)
    n = min(n, max_n, len(matched))
    if n <= 0:
        return []

    picked = random.sample(matched, n)
    return _plan_placements(template, chosen, picked, W, H)


def plan_any(template: dict, chosen: list[dict], W: int, H: int, n: int = 1) -> list[dict]:
    """预览专用：忽略主题，随机挑 n 张达标贴纸并算落点，保证预览能直观展示
    「贴纸×模板」的组合效果。正式成墙用 plan_for_wall（按主题严格匹配）。"""
    pool = [s for s in load_all() if s.get("qualified")]
    if not pool:
        return []
    n = min(n, len(pool))
    picked = random.sample(pool, n)
    return _plan_placements(template, chosen, picked, W, H)

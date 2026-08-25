"""
模板维度：用户上传「照片墙模板」JSON -> 达标校验 -> 存入 templates/ 目录，
之后生成/预览时自动可选，并与贴纸维度自动匹配组合出多样有惊喜感的效果。

「达标」判定（模板 = 一份可被 engine 正确渲染的排版方案）：
  · schema 合法：有 id / canvas(width,height) / slots(≥1)。
  · 画布尺寸合理，槽位是矩形且落在画布内（允许极小溢出容差）。
  · 装饰类型都在 engine 支持的集合内。
  · 真跑一次 engine.render（用占位图）不报错——能画出来才算达标。

模板 JSON 结构（与 engine 对齐）：
{
  "id": "my_template",
  "name": "显示名",
  "description": "...",
  "canvas": {"width":1280,"height":720,"background":{...}},
  "slots": [{"x","y","w","h", radius?, border?, shadow?}, ...],
  "decorations": [ {"type": ...}, ... ]
}
"""

from __future__ import annotations

import glob
import json
import os
import re

from PIL import Image

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(_ROOT, "templates")
_PLACEHOLDER_DIR = os.path.join(_ROOT, "output", "_ph")

# engine._draw_decoration 支持的装饰类型（校验用）
_DECO_TYPES = {
    "tape", "title", "date", "text", "rect", "line", "arrow",
    "circle", "ellipse", "dots",
}

# 内置模板 id（这些是随项目手写的，不允许被上传覆盖破坏）
_BUILTIN = {
    "daily_polaroid", "travel_grid", "monthly_collage",
    "grid_5", "grid_10", "grid_15", "grid_20", "grid_24",
    "editorial_magazine", "minimal_gallery", "film_strip", "collage_pop",
    "scrapbook_echoes", "corkboard_recap", "july_dumps",
}

_SLUG_RE = re.compile(r"[^a-z0-9_\-]+")


def _slug(text: str) -> str:
    s = _SLUG_RE.sub("_", str(text).strip().lower()).strip("_")
    return s or "template"


# ---------- 占位图（试渲染 / 无相册时预览用） ----------

def placeholder_photos(n: int) -> list[str]:
    """生成 n 张彩色渐变占位图，返回路径。用于模板试渲染和无照片时的预览。"""
    os.makedirs(_PLACEHOLDER_DIR, exist_ok=True)
    palette = [
        ("#F4B183", "#E06666"), ("#9FC5E8", "#3D85C6"), ("#B6D7A8", "#6AA84F"),
        ("#FFE599", "#F1C232"), ("#D5A6BD", "#A64D79"), ("#B4A7D6", "#674EA7"),
        ("#A2C4C9", "#45818E"), ("#F9CB9C", "#E69138"),
    ]
    paths: list[str] = []
    for i in range(max(1, n)):
        path = os.path.join(_PLACEHOLDER_DIR, f"ph_{i}.png")
        if not os.path.exists(path):
            c1, c2 = palette[i % len(palette)]
            img = _gradient_tile(800, 800, c1, c2)
            img.save(path)
        paths.append(path)
    return paths


def _gradient_tile(w: int, h: int, c1: str, c2: str) -> Image.Image:
    a = tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5))
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        col = tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))
        for x in range(w):
            px[x, y] = col
    return img


# ---------- 达标校验 ----------

def _validate_schema(data: dict) -> tuple[bool, str, dict]:
    if not isinstance(data, dict):
        return False, "模板必须是一个 JSON 对象", {}

    canvas = data.get("canvas")
    if not isinstance(canvas, dict):
        return False, "缺少 canvas（画布）配置", {}
    try:
        W = int(canvas.get("width"))
        H = int(canvas.get("height"))
    except (TypeError, ValueError):
        return False, "canvas.width / canvas.height 必须是数字", {}
    if not (320 <= W <= 4000 and 320 <= H <= 4000):
        return False, "画布尺寸需在 320~4000 之间", {}

    bg = canvas.get("background")
    if bg is not None:
        if not isinstance(bg, dict):
            return False, "canvas.background 必须是对象", {}
        if bg.get("type") not in (None, "color", "gradient"):
            return False, f"背景类型 {bg.get('type')} 不支持（仅 color / gradient）", {}

    slots = data.get("slots")
    if not isinstance(slots, list) or not slots:
        return False, "缺少 slots（照片槽位），至少要有 1 个", {}
    if len(slots) > 60:
        return False, "槽位过多（最多 60 个）", {}

    tol = 4  # 允许极小溢出容差
    for idx, s in enumerate(slots):
        if not isinstance(s, dict):
            return False, f"第 {idx + 1} 个槽位不是对象", {}
        try:
            x, y, w, h = int(s["x"]), int(s["y"]), int(s["w"]), int(s["h"])
        except (KeyError, TypeError, ValueError):
            return False, f"第 {idx + 1} 个槽位缺少 x/y/w/h 或不是数字", {}
        if w <= 0 or h <= 0:
            return False, f"第 {idx + 1} 个槽位宽高必须为正", {}
        if x < -tol or y < -tol or x + w > W + tol or y + h > H + tol:
            return False, f"第 {idx + 1} 个槽位超出画布范围", {}

    decos = data.get("decorations", [])
    if decos is not None:
        if not isinstance(decos, list):
            return False, "decorations 必须是数组", {}
        for idx, d in enumerate(decos):
            if not isinstance(d, dict):
                return False, f"第 {idx + 1} 个装饰不是对象", {}
            dt = d.get("type")
            if dt not in _DECO_TYPES:
                return False, f"第 {idx + 1} 个装饰类型 “{dt}” 不支持", {}

    return True, "", {"width": W, "height": H, "slots": len(slots),
                      "decorations": len(decos or [])}


def _test_render(data: dict) -> tuple[bool, str]:
    """用占位图真跑一次渲染，能画出来才算达标。"""
    try:
        import engine  # engine 在项目根，server 已把根加进 sys.path
    except Exception as e:  # pragma: no cover
        return False, f"渲染引擎不可用：{e}"
    n = len(data.get("slots", []))
    try:
        img = engine.render(data, placeholder_photos(n),
                            {"title": "预览", "date": "2026-01-01"})
        if img.size[0] <= 0 or img.size[1] <= 0:
            return False, "渲染结果尺寸异常"
    except Exception as e:
        return False, f"试渲染失败：{e}"
    return True, ""


def qualify(data: dict) -> tuple[bool, str, dict]:
    """模板达标校验：schema 合法 + 试渲染通过。返回 (是否达标, 原因, 元数据)。"""
    ok, reason, meta = _validate_schema(data)
    if not ok:
        return False, reason, meta
    ok, reason = _test_render(data)
    if not ok:
        return False, reason, meta
    return True, "", meta


# ---------- 存取 ----------

def save_uploaded(data: dict) -> dict:
    """上传的模板：达标校验通过则写入 templates/<id>.json。返回条目信息。"""
    if not isinstance(data, dict):
        return {"qualified": False, "reason": "模板必须是 JSON 对象", "id": None}

    raw_id = data.get("id") or data.get("name") or "template"
    tid = _slug(raw_id)
    if tid in _BUILTIN:
        # 不覆盖内置模板，给上传的加后缀
        tid = f"{tid}_user"
    data["id"] = tid
    data.setdefault("name", str(raw_id))

    ok, reason, meta = qualify(data)
    entry = {
        "id": tid,
        "name": data.get("name", tid),
        "description": data.get("description", ""),
        "qualified": ok,
        "reason": reason,
        "builtin": False,
        **meta,
    }
    if not ok:
        return entry

    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    with open(os.path.join(TEMPLATES_DIR, f"{tid}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return entry


def _entry_from_file(path: str) -> dict:
    tid = os.path.splitext(os.path.basename(path))[0]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return {"id": tid, "name": tid, "qualified": False,
                "reason": f"读取失败：{e}", "builtin": tid in _BUILTIN,
                "slots": 0, "width": 0, "height": 0}
    ok, reason, meta = _validate_schema(data)
    return {
        "id": tid,
        "name": data.get("name", tid),
        "description": data.get("description", ""),
        "qualified": ok,
        "reason": reason,
        "builtin": tid in _BUILTIN,
        "width": meta.get("width", 0),
        "height": meta.get("height", 0),
        "slots": meta.get("slots", 0),
        "decorations": meta.get("decorations", 0),
    }


def list_templates() -> list[dict]:
    """扫描 templates/ 目录，返回每个模板的元数据（内置在前，均按槽位数排序）。"""
    files = sorted(glob.glob(os.path.join(TEMPLATES_DIR, "*.json")))
    entries = [_entry_from_file(p) for p in files]
    entries.sort(key=lambda e: (not e["builtin"], e.get("slots", 0), e["id"]))
    return entries


def load_template(tid: str) -> dict | None:
    path = os.path.join(TEMPLATES_DIR, f"{_slug(tid)}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def delete_template(tid: str) -> bool:
    """删除上传的模板（内置模板不允许删）。"""
    tid = _slug(tid)
    if tid in _BUILTIN:
        return False
    path = os.path.join(TEMPLATES_DIR, f"{tid}.json")
    if os.path.exists(path):
        os.remove(path)
        return True
    return False

"""
手帐照片墙 · 排版渲染引擎
把照片按模版(JSON)自动填充、加白边/阴影/旋转，并叠加装饰层，输出成品图。

设计原则：
- 模版是参数化布局(slots + decorations)，与照片解耦，一套模版适配任意照片。
- 引擎只做渲染，不做筛图；真实产品里筛图由云端 AI 完成，这里假设照片已选好。
"""

from __future__ import annotations

import json
import os
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps


# ---------- 字体 ----------

# macOS 常见中文字体候选，找到第一个可用的
_CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]

# 手写/花体候选：手帐拼贴风的标题与手写标注用。按「字体家族」分组，
# 模板里用 deco.font = "script"(花体) / "hand"(手写) / "marker"(粗记号笔)。
_STYLE_FONTS: dict[str, list[str]] = {
    "script": [
        "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
        "/System/Library/Fonts/Supplemental/Savoye LET.ttc",
    ],
    "hand": [
        "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
        "/System/Library/Fonts/Supplemental/Noteworthy.ttc",
    ],
    "marker": [
        "/System/Library/Fonts/Supplemental/Chalkduster.ttf",
        "/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf",
    ],
}


def _load_font(size: int, style: str = "cjk") -> ImageFont.FreeTypeFont:
    # 先按指定的手写/花体家族找（英文标注、标题用），找不到再退回中文黑体
    for path in _STYLE_FONTS.get(style, []):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    for path in _CJK_FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ---------- 基础工具 ----------

def _hex_rgb(c: str) -> tuple[int, int, int]:
    c = (c or "#000000").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _rgba(c: str, a: int = 255) -> tuple[int, int, int, int]:
    r, g, b = _hex_rgb(c)
    return r, g, b, a


def _make_background(cfg: dict[str, Any], W: int, H: int) -> Image.Image:
    """背景：支持纯色 color 和线性渐变 gradient(from/to/angle)。"""
    bg = cfg.get("background", {"type": "color", "value": "#FFFFFF"})
    if bg.get("type") == "gradient":
        return _linear_gradient(W, H, bg.get("from", "#FFFFFF"),
                                bg.get("to", "#DDDDDD"), bg.get("angle", 90))
    return Image.new("RGBA", (W, H), bg.get("value", "#FFFFFF"))


def _linear_gradient(W: int, H: int, c1: str, c2: str, angle: float) -> Image.Image:
    """两色线性渐变。angle=0 水平(左→右)、90 垂直(上→下)、45 对角。"""
    r1, g1, b1 = _hex_rgb(c1)
    r2, g2, b2 = _hex_rgb(c2)
    try:
        import math

        import numpy as np
        a = math.radians(angle)
        dx, dy = math.cos(a), math.sin(a)
        xs = np.linspace(0.0, 1.0, W)[None, :]
        ys = np.linspace(0.0, 1.0, H)[:, None]
        proj = xs * dx + ys * dy
        proj = (proj - proj.min()) / (proj.max() - proj.min() + 1e-9)
        r = r1 + (r2 - r1) * proj
        g = g1 + (g2 - g1) * proj
        b = b1 + (b2 - b1) * proj
        a_ch = np.full_like(proj, 255.0)
        arr = np.dstack([r, g, b, a_ch]).astype("uint8")
        return Image.fromarray(arr, "RGBA")
    except Exception:
        # 无 numpy 时退化为垂直渐变
        base = Image.new("RGBA", (W, H))
        draw = ImageDraw.Draw(base)
        for y in range(H):
            t = y / max(1, H - 1)
            draw.line([(0, y), (W, y)],
                      fill=(int(r1 + (r2 - r1) * t), int(g1 + (g2 - g1) * t),
                            int(b1 + (b2 - b1) * t), 255))
        return base


def _round_corners(img: Image.Image, radius: int) -> Image.Image:
    """把图片裁成圆角（角外透明），配合阴影得到圆角照片。"""
    if radius <= 0:
        return img
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def _cover_crop(img: Image.Image, w: int, h: int) -> Image.Image:
    """按 cover 方式裁剪缩放，填满目标框且不变形。"""
    return ImageOps.fit(img, (w, h), method=Image.LANCZOS, centering=(0.5, 0.5))


def _add_border(img: Image.Image, border: dict[str, Any]) -> Image.Image:
    """加白边（支持四边不同宽度，用于拍立得下方留白）。"""
    if not border:
        return img
    color = border.get("color", "#FFFFFF")
    top = border.get("top", 0)
    right = border.get("right", 0)
    bottom = border.get("bottom", 0)
    left = border.get("left", 0)
    new_w = img.width + left + right
    new_h = img.height + top + bottom
    framed = Image.new("RGBA", (new_w, new_h), color)
    framed.paste(img, (left, top))
    return framed


def _paste_with_shadow(
    canvas: Image.Image,
    tile: Image.Image,
    cx: int,
    cy: int,
    rotation: float,
    shadow: bool,
) -> None:
    """把一张(已加边的)照片旋转后带阴影贴到画布中心点(cx, cy)。"""
    rotated = tile.rotate(rotation, expand=True, resample=Image.BICUBIC)

    if shadow:
        # 用照片的 alpha 生成模糊阴影
        shadow_layer = Image.new("RGBA", rotated.size, (0, 0, 0, 0))
        alpha = rotated.split()[3]
        black = Image.new("RGBA", rotated.size, (40, 35, 30, 130))
        shadow_layer.paste(black, (0, 0), alpha)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(14))
        sx = cx - rotated.width // 2 + 10
        sy = cy - rotated.height // 2 + 14
        canvas.alpha_composite(shadow_layer, (sx, sy))

    px = cx - rotated.width // 2
    py = cy - rotated.height // 2
    canvas.alpha_composite(rotated, (px, py))


# ---------- 装饰层 ----------

def _draw_tape(canvas: Image.Image, deco: dict[str, Any]) -> None:
    """和纸胶带：半透明矩形，轻微旋转。"""
    w, h = deco["w"], deco["h"]
    color = deco.get("color", "#E7B7A8")
    alpha = deco.get("alpha", 200)
    tape = Image.new("RGBA", (w, h), color)
    tape.putalpha(alpha)
    # 两端做一点撕纸感（简单斜切）
    rotated = tape.rotate(deco.get("rotation", 0), expand=True, resample=Image.BICUBIC)
    canvas.alpha_composite(rotated, (deco["x"], deco["y"]))


def _draw_text(canvas: Image.Image, deco: dict[str, Any], text: str) -> None:
    draw = ImageDraw.Draw(canvas)
    font = _load_font(deco.get("size", 60), deco.get("font", "cjk"))
    fill = _rgba(deco.get("color", "#333333"), deco.get("alpha", 255))
    x, y = deco["x"], deco["y"]
    align = deco.get("align")
    if align in ("center", "right") and "w" in deco:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        if align == "center":
            x = deco["x"] + (deco["w"] - tw) // 2
        else:
            x = deco["x"] + deco["w"] - tw
    if deco.get("letter_spacing"):
        gap = deco["letter_spacing"]
        cx = x
        for ch in text:
            draw.text((cx, y), ch, font=font, fill=fill)
            cx += draw.textlength(ch, font=font) + gap
    else:
        draw.text((x, y), text, font=font, fill=fill)


def _draw_rect(canvas: Image.Image, deco: dict[str, Any]) -> None:
    """色块/面板：支持圆角 radius、透明度 alpha、旋转 rotation、描边。"""
    w, h = int(deco["w"]), int(deco["h"])
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fill = _rgba(deco["color"], deco.get("alpha", 255)) if deco.get("color") else None
    outline = _rgba(deco["outline"], deco.get("alpha", 255)) if deco.get("outline") else None
    ow = deco.get("outline_width", 0)
    radius = deco.get("radius", 0)
    if radius > 0:
        d.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=fill,
                            outline=outline, width=ow)
    else:
        d.rectangle([0, 0, w - 1, h - 1], fill=fill, outline=outline, width=ow)
    rot = deco.get("rotation", 0)
    if rot:
        layer = layer.rotate(rot, expand=True, resample=Image.BICUBIC)
    canvas.alpha_composite(layer, (int(deco["x"]), int(deco["y"])))


def _draw_line(canvas: Image.Image, deco: dict[str, Any]) -> None:
    ImageDraw.Draw(canvas).line(
        [deco["x1"], deco["y1"], deco["x2"], deco["y2"]],
        fill=_rgba(deco.get("color", "#333333"), deco.get("alpha", 255)),
        width=deco.get("width", 4))


def _draw_arrow(canvas: Image.Image, deco: dict[str, Any]) -> None:
    """手绘风箭头：从 (x1,y1) 到 (x2,y2)，给了 (cx,cy) 控制点就画二次贝塞尔弯箭头，
    末端带箭头。手帐拼贴风里「标注 -> 照片」的连接线就用它。"""
    import math
    color = _rgba(deco.get("color", "#333333"), deco.get("alpha", 255))
    width = int(deco.get("width", 4))
    x1, y1 = float(deco["x1"]), float(deco["y1"])
    x2, y2 = float(deco["x2"]), float(deco["y2"])
    d = ImageDraw.Draw(canvas)
    if "cx" in deco and "cy" in deco:
        cx, cy = float(deco["cx"]), float(deco["cy"])
        steps = 26
        pts = []
        for i in range(steps + 1):
            t = i / steps
            bx = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t ** 2 * x2
            by = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t ** 2 * y2
            pts.append((bx, by))
        d.line(pts, fill=color, width=width, joint="curve")
        ex, ey = pts[-1]
        px, py = pts[-2]
    else:
        d.line([x1, y1, x2, y2], fill=color, width=width)
        ex, ey = x2, y2
        px, py = x1, y1
    ang = math.atan2(ey - py, ex - px)
    hl = deco.get("head", 20)
    for a in (ang - 0.45, ang + 0.45):
        hx = ex - hl * math.cos(a)
        hy = ey - hl * math.sin(a)
        d.line([ex, ey, hx, hy], fill=color, width=width)


def _draw_ellipse(canvas: Image.Image, deco: dict[str, Any]) -> None:
    """圆/椭圆：可填充或只描边(outline_width)，画在独立层以支持透明。"""
    w, h = int(deco["w"]), int(deco["h"])
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fill = _rgba(deco["color"], deco.get("alpha", 255)) if deco.get("color") else None
    outline = _rgba(deco["outline"], deco.get("alpha", 255)) if deco.get("outline") else None
    ow = deco.get("outline_width", 0)
    ImageDraw.Draw(layer).ellipse([0, 0, w - 1, h - 1], fill=fill, outline=outline, width=ow)
    canvas.alpha_composite(layer, (int(deco["x"]), int(deco["y"])))


def _draw_dots(canvas: Image.Image, deco: dict[str, Any]) -> None:
    """一排小方块/圆点（胶片齿孔、装饰点行）。direction h/v，shape square/circle。"""
    count = deco.get("count", 8)
    gap = deco.get("gap", 40)
    size = deco.get("size", 16)
    vertical = deco.get("direction", "h") == "v"
    fill = _rgba(deco.get("color", "#FFFFFF"), deco.get("alpha", 255))
    round_r = deco.get("round", size // 4)
    d = ImageDraw.Draw(canvas)
    x0, y0 = deco["x"], deco["y"]
    for i in range(count):
        x = x0 + (0 if vertical else i * gap)
        y = y0 + (i * gap if vertical else 0)
        box = [x, y, x + size, y + size]
        if deco.get("shape") == "circle":
            d.ellipse(box, fill=fill)
        else:
            d.rounded_rectangle(box, radius=round_r, fill=fill)


def _draw_decoration(canvas: Image.Image, deco: dict[str, Any], context: dict[str, str]) -> None:
    """装饰分发。支持 back/front 图层由调用方按 layer 字段分批。"""
    dtype = deco.get("type")
    if dtype == "tape":
        _draw_tape(canvas, deco)
    elif dtype == "title":
        _draw_text(canvas, deco, deco.get("text", "").replace("{{title}}", context.get("title", "")))
    elif dtype == "date":
        _draw_text(canvas, deco, context.get("date", ""))
    elif dtype == "text":
        text = (deco.get("text", "")
                .replace("{{title}}", context.get("title", ""))
                .replace("{{date}}", context.get("date", "")))
        _draw_text(canvas, deco, text)
    elif dtype == "rect":
        _draw_rect(canvas, deco)
    elif dtype == "line":
        _draw_line(canvas, deco)
    elif dtype == "arrow":
        _draw_arrow(canvas, deco)
    elif dtype in ("circle", "ellipse"):
        _draw_ellipse(canvas, deco)
    elif dtype == "dots":
        _draw_dots(canvas, deco)


def _draw_badge(tile: Image.Image, text: str) -> None:
    """在照片(已加白边的 tile)左上角画一枚圆角小标签（如「那年今日」「旧时光」），
    让「时间惊喜」照片上屏时更有仪式感。画在 tile 上会随照片一起旋转、贴合边角。"""
    if not text:
        return
    draw = ImageDraw.Draw(tile)
    fs = max(18, min(34, tile.width // 12))       # 标签字号随照片大小自适应
    font = _load_font(fs)
    pad_x = int(fs * 0.6)
    pad_y = int(fs * 0.35)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    bw = tw + pad_x * 2
    bh = th + pad_y * 2
    m = max(10, fs // 2)                            # 距左上角的留白
    x0, y0 = m, m
    # 暖色半透明胶囊底 + 轻微描边，保证在任何照片上都清晰
    draw.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=bh // 2,
                           fill=(217, 140, 95, 235), outline=(255, 255, 255, 230), width=2)
    draw.text((x0 + pad_x - bbox[0], y0 + pad_y - bbox[1]), text, font=font, fill=(255, 255, 255, 255))


# ---------- 主渲染 ----------

def _paste_sticker(canvas: Image.Image, pl: dict[str, Any]) -> None:
    """把一张贴纸缩放->旋转->带柔和阴影贴到画布上，中心对齐 pl['cx']/pl['cy']。"""
    try:
        s = Image.open(pl["path"]).convert("RGBA")
    except (OSError, ValueError):
        return
    tw = max(1, int(pl.get("w", s.width)))
    th = max(1, int(s.height * (tw / s.width)))
    s = s.resize((tw, th), Image.LANCZOS)
    s = s.rotate(pl.get("rotation", 0), expand=True, resample=Image.BICUBIC)

    alpha = s.split()[3]
    shadow = Image.new("RGBA", s.size, (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", s.size, (40, 35, 30, 90)), (0, 0), alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(6))

    cx, cy = int(pl["cx"]), int(pl["cy"])
    px, py = cx - s.width // 2, cy - s.height // 2
    canvas.alpha_composite(shadow, (px + 4, py + 6))
    canvas.alpha_composite(s, (px, py))


def render(template: dict[str, Any], photos: list[str], context: dict[str, str],
           badges: dict[int, str] | None = None,
           stickers: list[dict[str, Any]] | None = None) -> Image.Image:
    """
    template: 模版 dict
    photos:   照片路径列表（按顺序填入 slots）
    context:  {"title": "...", "date": "2026-07-19"} 变量替换
    badges:   {槽位下标: 标签文案}，给指定槽位的照片角上加小标签（时间惊喜用）
    stickers: [{path, cx, cy, w, rotation}] 贴纸落点，贴在最上层（照片之上）
    """
    canvas_cfg = template["canvas"]
    W, H = canvas_cfg["width"], canvas_cfg["height"]

    base = _make_background(canvas_cfg, W, H)

    badges = badges or {}
    decos = template.get("decorations", [])

    # 背景装饰层（色块/形状垫在照片下面）
    for deco in decos:
        if deco.get("layer") == "back":
            _draw_decoration(base, deco, context)

    # 填充照片槽位
    slots = template.get("slots", [])
    for i, slot in enumerate(slots):
        if i >= len(photos):
            break
        try:
            img = Image.open(photos[i]).convert("RGBA")
        except (OSError, ValueError):
            continue
        tile = _cover_crop(img, slot["w"], slot["h"])
        tile = _add_border(tile, slot.get("border", {}))
        if slot.get("radius"):
            tile = _round_corners(tile, int(slot["radius"]))
        if i in badges:
            _draw_badge(tile, badges[i])
        cx = slot["x"] + tile.width // 2
        cy = slot["y"] + tile.height // 2
        _paste_with_shadow(base, tile, cx, cy, slot.get("rotation", 0), slot.get("shadow", False))

    # 前景装饰层（标题/胶带/线条/形状，压在照片上面）
    for deco in decos:
        if deco.get("layer") != "back":
            _draw_decoration(base, deco, context)

    # 贴纸层：贴在最上层，随机旋转/大小，带柔和阴影
    for pl in (stickers or []):
        _paste_sticker(base, pl)

    return base.convert("RGB")


def load_template(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

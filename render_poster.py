"""
render_poster.py — 拼贴海报合成脚本

流程:
1. 读 template.json (背景/照片位/装饰的坐标信息)
2. 从 selection.json 或 scores.json 里挑 5 张最合适的猫照片
3. 每张用 rembg 抠图 → 加白色描边
4. 按模板坐标/尺寸/旋转/z_index 合成到背景上
5. 输出 poster.png

用法:
    python render_poster.py --template templates/blue-mood/template.json
"""

import json
import argparse
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps, ImageEnhance
import pillow_heif
pillow_heif.register_heif_opener()

# rembg 首次运行会自动下载 birefnet-general 模型 (~440MB, 当前 SOTA 精度)
from rembg import remove as rembg_remove, new_session

REMBG_MODEL = "u2net"  # 回退到 u2net (稳定+快), 靠 alpha 阈值化解决毛边问题
_REMBG_SESSION = None

def get_rembg_session():
    global _REMBG_SESSION
    if _REMBG_SESSION is None:
        print(f"🔧 加载 rembg 模型: {REMBG_MODEL} (首次会下载 ~440MB)")
        _REMBG_SESSION = new_session(REMBG_MODEL)
    return _REMBG_SESSION

SCORES_FILE = "cache/scores.json"
SELECTION_FILE = "cache/selection.json"
OUTPUT = "output/poster.png"
ASSETS_CACHE = Path("assets/poster-cutouts")

# 抠图后加白色描边的宽度 (像素, 相对于抠图尺寸)
STROKE_WIDTH = 40
STROKE_COLOR = (255, 255, 255, 255)

# alpha 阈值化: 大于此值算实心, 小于视为透明
# 用来去除半透明毛边"雾"和"悬浮描边"
ALPHA_THRESHOLD = 128

# 抠图后色调统一 (更激进, 拉齐 5 张的调性)
CUTOUT_COLOR_FACTOR = 0.75       # 降饱和 (v1 是 0.85, 现在更强)
CUTOUT_BRIGHTNESS_FACTOR = 1.0   # 亮度保持
CUTOUT_CONTRAST_FACTOR = 1.08    # 微升对比

def cutout_with_stroke(src_path, dst_path, target_w, target_h, stroke_px=STROKE_WIDTH):
    """rembg 抠图 + 加白色描边 + resize 到目标尺寸"""
    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    # rembg 抠图 (用 birefnet-general 高精度模型)
    cutout = rembg_remove(img, session=get_rembg_session())

    # 提取 alpha 通道并阈值化 (去除半透明毛边"雾"和"悬浮描边")
    alpha = cutout.split()[-1]
    alpha = alpha.point(lambda p: 255 if p > ALPHA_THRESHOLD else 0)
    # 用阈值化后的 alpha 替换 cutout 的 alpha 通道
    r_ch, g_ch, b_ch, _ = cutout.split()
    cutout = Image.merge("RGBA", (r_ch, g_ch, b_ch, alpha))

    # 膨胀阈值化后的 alpha 生成"描边"区域 (贴实心边缘, 不再悬浮)
    stroke_mask = alpha.filter(ImageFilter.MaxFilter(stroke_px * 2 + 1))

    # 用白色填充描边区域
    stroke_layer = Image.new("RGBA", cutout.size, (0, 0, 0, 0))
    white_fill = Image.new("RGBA", cutout.size, STROKE_COLOR)
    stroke_layer.paste(white_fill, mask=stroke_mask)

    # 抠图叠加在描边上层
    stroke_layer.paste(cutout, mask=alpha)

    # 裁掉透明边缘, 减少无用尺寸
    bbox = stroke_layer.getbbox()
    if bbox:
        stroke_layer = stroke_layer.crop(bbox)

    # 色调统一 (让不同光线下的猫看起来是同一场光)
    # 只处理 RGB 通道, alpha 不动
    rgb = stroke_layer.convert("RGB")
    rgb = ImageEnhance.Color(rgb).enhance(CUTOUT_COLOR_FACTOR)
    rgb = ImageEnhance.Brightness(rgb).enhance(CUTOUT_BRIGHTNESS_FACTOR)
    rgb = ImageEnhance.Contrast(rgb).enhance(CUTOUT_CONTRAST_FACTOR)
    r, g, b = rgb.split()
    _, _, _, a = stroke_layer.split()
    stroke_layer = Image.merge("RGBA", (r, g, b, a))

    # 用 max 比例让主体填满 slot (允许照片超出 slot 边界)
    ratio = max(target_w / stroke_layer.width, target_h / stroke_layer.height)
    new_w = int(stroke_layer.width * ratio)
    new_h = int(stroke_layer.height * ratio)
    stroke_layer = stroke_layer.resize((new_w, new_h), Image.LANCZOS)

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    stroke_layer.save(dst_path, "PNG")
    return stroke_layer

POSTER_SELECTION_FILE = "cache/poster_selection.json"

def load_poster_selection():
    """从 select_for_poster.py 生成的 poster_selection.json 读取每个 slot 的照片"""
    if not Path(POSTER_SELECTION_FILE).exists():
        return None
    with open(POSTER_SELECTION_FILE) as f:
        return json.load(f)

def paste_rotated(canvas, layer, x, y, w, h, rotation):
    """把 layer 贴到 canvas, layer 已是最终尺寸, 只按中心点贴合。
    x/y/w/h 是 Figma bbox (对旋转元素是外接矩形), 用来算中心点。
    """
    # 旋转 layer (expand=True 让画布跟着旋转扩大)
    if abs(rotation) > 0.1:
        layer = layer.rotate(rotation, resample=Image.BICUBIC, expand=True)

    # 中心对齐: 让旋转后 layer 的中心跟 bbox 中心对齐
    center_x = x + w / 2
    center_y = y + h / 2
    paste_x = int(center_x - layer.width / 2)
    paste_y = int(center_y - layer.height / 2)
    canvas.paste(layer, (paste_x, paste_y), layer)


def paste_background(canvas, bg_path, canvas_w, canvas_h):
    """强制把 background PNG resize 到画布尺寸铺满 (不用 bbox 尺寸)"""
    bg = Image.open(bg_path).convert("RGBA")
    if bg.size != (canvas_w, canvas_h):
        bg = bg.resize((canvas_w, canvas_h), Image.LANCZOS)
    canvas.paste(bg, (0, 0), bg)


def compute_scale_factor(template, asset_dir):
    """通过一个未旋转的 sticker 计算 PNG-to-Figma 的缩放系数"""
    for s in template.get("stickers", []):
        if abs(s.get("rotation", 0)) < 0.5:
            asset_path = asset_dir / s["asset_file"]
            if asset_path.exists():
                png = Image.open(asset_path)
                figma_w = s.get("width", 0)
                if figma_w > 0:
                    scale = png.width / figma_w
                    return scale
    # fallback: 假设 2x 导出
    return 2.0


def load_sticker_at_true_size(asset_path, scale):
    """加载 sticker PNG 并 resize 到 Figma 里的真实尺寸"""
    img = Image.open(asset_path).convert("RGBA")
    true_w = int(img.width / scale)
    true_h = int(img.height / scale)
    return img.resize((true_w, true_h), Image.LANCZOS)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True,
                        help="template.json 路径")
    parser.add_argument("--output", default=OUTPUT)
    args = parser.parse_args()

    with open(args.template) as f:
        tpl = json.load(f)

    template_dir = Path(args.template).parent
    canvas_w = int(tpl["canvas"]["width"])
    canvas_h = int(tpl["canvas"]["height"])
    print(f"📐 画布: {canvas_w} × {canvas_h}")

    # 计算 PNG-to-Figma 缩放系数
    scale_factor = compute_scale_factor(tpl, template_dir)
    print(f"🔢 PNG 缩放系数: {scale_factor:.2f}x (从未旋转 sticker 反推)")

    # 创建画布
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 255))

    # 铺背景: 强制铺满画布
    bg_info = tpl.get("background")
    if bg_info:
        bg_path = template_dir / f"{bg_info['name']}.png"
        if bg_path.exists():
            paste_background(canvas, bg_path, canvas_w, canvas_h)
            print(f"🎨 已铺背景 (强制铺满 {canvas_w}×{canvas_h}): {bg_path.name}")
        else:
            print(f"⚠️  背景文件不存在: {bg_path}")

    # 收集所有需要 z_index 排序的元素 (装饰 + 照片位)
    all_layers = []

    # 装饰
    for s in tpl.get("stickers", []):
        s["_type"] = "sticker"
        all_layers.append(s)

    # 照片位: 从 poster_selection.json 里读取每个 slot 已分配的照片
    photo_slots = tpl.get("photo_slots", [])
    n_slots = len(photo_slots)
    print(f"📸 从 poster_selection.json 读取每个 slot 的照片...")

    poster_selection = load_poster_selection()
    if not poster_selection:
        print(f"❌ 找不到 {POSTER_SELECTION_FILE}")
        print(f"   请先跑: python select_for_poster.py --template {args.template}")
        return

    for slot in photo_slots:
        slot_id = slot["name"]
        if slot_id not in poster_selection:
            print(f"  ⚠️  {slot_id} 未在选片结果里,跳过")
            continue
        photo = poster_selection[slot_id]["photo"]
        slot["_type"] = "photo"
        slot["_photo"] = photo
        all_layers.append(slot)
        print(f"     · {slot_id}: {photo['filename']}")

    # 按 z_index 排序 (小的先贴, 大的后贴)
    all_layers.sort(key=lambda l: l["z_index"])

    # 逐层合成
    print()
    print(f"🖼️  开始合成...")
    ASSETS_CACHE.mkdir(parents=True, exist_ok=True)
    for layer in all_layers:
        if layer["_type"] == "sticker":
            asset_path = template_dir / layer["asset_file"]
            if not asset_path.exists():
                print(f"  ⚠️  素材文件不存在: {asset_path}, 跳过")
                continue
            # 关键改动: 用 PNG 真实尺寸 (除以 scale) 而不是 bbox 尺寸
            img = load_sticker_at_true_size(asset_path, scale_factor)
            paste_rotated(canvas, img,
                          layer["x"], layer["y"],
                          layer["width"], layer["height"],
                          layer.get("rotation", 0))
            print(f"  ✅ 装饰: {layer['name']}  真实尺寸={img.size}")
        else:
            photo = layer["_photo"]
            src = Path(photo["path"])
            cutout_dst = ASSETS_CACHE / f"cutout_{src.stem}.png"
            print(f"  🐈 抠图: {src.name}...")
            img = cutout_with_stroke(src, cutout_dst,
                                     int(layer["width"]),
                                     int(layer["height"]))
            paste_rotated(canvas, img,
                          layer["x"], layer["y"],
                          layer["width"], layer["height"],
                          layer.get("rotation", 0))
            print(f"  ✅ 照片: {layer['name']} ← {src.name}")

    # 输出
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, "PNG", quality=95)
    print()
    print(f"✨ 完成! 输出: {output_path}")
    print(f"   打开: open {output_path}")

if __name__ == "__main__":
    main()

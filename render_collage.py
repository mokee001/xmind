"""
render_collage.py — 拼贴海报合成脚本

流程:
1. 读 template.json (背景/照片位/装饰的坐标信息)
2. 从 selection.json 或 scores.json 里挑 5 张最合适的猫照片
3. 每张用 rembg 抠图 → 加白色描边
4. 按模板坐标/尺寸/旋转/z_index 合成到背景上
5. 输出 collage.png

用法:
    python render_collage.py --template templates/blue-mood/template.json
"""

import json
import argparse
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps, ImageEnhance
import pillow_heif
pillow_heif.register_heif_opener()

# 抠图: Apple Vision Framework (macOS 系统级 API, 通过内嵌 Swift 代码调用)
# 需要 macOS 14 Sonoma+ 和 Xcode Command Line Tools
from cutout_apple import cutout as apple_cutout

SCORES_FILE = "cache/scores.json"
SELECTION_FILE = "cache/selection.json"
# OUTPUT 和 assets_cache 按风格动态命名, 在 main() 里根据 style 生成实际路径

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

def cutout_with_stroke(src_path, dst_path, target_w, target_h,
                       stroke_px=STROKE_WIDTH, mirror=False):
    """Apple Vision 抠图 + 加白色描边 + resize 到目标尺寸

    mirror=True 时在抠图前对原图做水平翻转 (让原图的右侧截断转到左侧, 反之亦然),
    用于给 photo_1/3 (右侧忌截断) 或 photo_2/4 (左侧忌截断) 位置救助那些
    "反侧无截断" 的候选照片.
    """
    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    if mirror:
        img = ImageOps.mirror(img)  # 水平翻转 (左右镜像)
    # Apple Vision Framework 抠图 (调用 macOS 系统级 API)
    cutout = apple_cutout(img)

    # 加透明留白 (v2.5.2): 主体触到原图边缘时, 后面 MaxFilter 膨胀描边会被图像边界裁掉,
    # 导致描边在截断处形成一条硬边 (视觉上像被切断). 先给四周补 stroke_px+5 的透明像素,
    # 描边就有空间"包住"截断位置, 形成闭合轮廓. 后面 bbox 裁剪会自动去掉多余留白.
    pad = stroke_px + 5
    padded = Image.new("RGBA",
                       (cutout.width + 2 * pad, cutout.height + 2 * pad),
                       (0, 0, 0, 0))
    padded.paste(cutout, (pad, pad), cutout)
    cutout = padded

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

def extract_style_name(template_path):
    """从 template 路径提取风格名, 如 templates/denim/template.json → 'denim'"""
    parts = Path(template_path).parts
    if "templates" in parts:
        idx = parts.index("templates")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return "default"

def load_collage_selection(style):
    """从 cache/collage_{style}_selection.json 读取每个 slot 的照片"""
    path = Path(f"cache/collage_{style}_selection.json")
    if not path.exists():
        return None
    with open(path) as f:
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
    parser.add_argument("--output", default=None,
                        help="输出 PNG 路径, 默认 output/collage_{style}.png")
    args = parser.parse_args()

    with open(args.template) as f:
        tpl = json.load(f)

    template_dir = Path(args.template).parent
    canvas_w = int(tpl["canvas"]["width"])
    canvas_h = int(tpl["canvas"]["height"])
    style = extract_style_name(args.template)
    output_path = args.output or f"output/collage_{style}.png"
    assets_cache = Path(f"assets/collage_{style}-cutouts")
    print(f"📐 画布: {canvas_w} × {canvas_h}")
    print(f"🎨 风格: {style}")
    print(f"🐈 抠图: Apple Vision Framework (macOS 原生)")
    print(f"💾 输出到: {output_path}")

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

    # 照片位: 从 cache/collage_{style}_selection.json 里读取每个 slot 已分配的照片
    photo_slots = tpl.get("photo_slots", [])
    n_slots = len(photo_slots)
    selection_file = f"cache/collage_{style}_selection.json"
    print(f"📸 从 {selection_file} 读取每个 slot 的照片...")

    collage_selection = load_collage_selection(style)
    if not collage_selection:
        print(f"❌ 找不到 {selection_file}")
        print(f"   请先跑: python select_for_collage.py --template {args.template}")
        return

    for slot in photo_slots:
        slot_id = slot["name"]
        if slot_id not in collage_selection:
            print(f"  ⚠️  {slot_id} 未在选片结果里,跳过")
            continue
        photo = collage_selection[slot_id]["photo"]
        mirror = collage_selection[slot_id].get("mirror", False)
        slot["_type"] = "photo"
        slot["_photo"] = photo
        slot["_mirror"] = mirror
        all_layers.append(slot)
        mirror_tag = " ↔ 镜像" if mirror else ""
        print(f"     · {slot_id}: {photo['filename']}{mirror_tag}")

    # 按 z_index 排序 (小的先贴, 大的后贴)
    all_layers.sort(key=lambda l: l["z_index"])

    # 逐层合成
    print()
    print(f"🖼️  开始合成...")
    assets_cache.mkdir(parents=True, exist_ok=True)
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
            mirror = layer.get("_mirror", False)
            src = Path(photo["path"])
            # 镜像和非镜像用不同缓存文件, 避免缓存串
            suffix = "_mirror" if mirror else ""
            cutout_dst = assets_cache / f"cutout_{src.stem}{suffix}.png"
            mirror_tag = " ↔ 镜像" if mirror else ""
            print(f"  🐈 抠图: {src.name}{mirror_tag}...")
            img = cutout_with_stroke(src, cutout_dst,
                                     int(layer["width"]),
                                     int(layer["height"]),
                                     mirror=mirror)
            paste_rotated(canvas, img,
                          layer["x"], layer["y"],
                          layer["width"], layer["height"],
                          layer.get("rotation", 0))
            print(f"  ✅ 照片: {layer['name']} ← {src.name}{mirror_tag}")

    # 输出
    output_path_obj = Path(output_path)
    output_path_obj.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path_obj, "PNG", quality=95)
    print()
    print(f"✨ 完成! 输出: {output_path_obj}")
    print(f"   打开: open {output_path_obj}")

if __name__ == "__main__":
    main()

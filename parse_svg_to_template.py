"""
parse_svg_to_template.py
读 Figma 导出的 SVG, 提取每个图层的坐标/尺寸/旋转/z_index/name,
生成 template.json 用于后续 render_poster.py 合成。

用法:
    python parse_svg_to_template.py --svg templates/blue-mood/template.svg
"""

import json
import re
import math
import argparse
from pathlib import Path
from xml.etree import ElementTree as ET

SVG_NS = "{http://www.w3.org/2000/svg}"

def parse_transform(transform_str):
    """从 SVG transform 字符串里解析出 (tx, ty, rotation_deg)
    支持: translate(x,y) / rotate(a) / matrix(a,b,c,d,e,f)
    """
    if not transform_str:
        return 0.0, 0.0, 0.0

    tx, ty, rot = 0.0, 0.0, 0.0

    # matrix (Figma 最常用)
    m = re.search(r"matrix\(([^)]+)\)", transform_str)
    if m:
        vals = [float(v) for v in re.split(r"[\s,]+", m.group(1).strip())]
        if len(vals) == 6:
            a, b, c, d, e, f = vals
            tx = e
            ty = f
            rot = math.degrees(math.atan2(b, a))
            return tx, ty, rot

    # translate
    m = re.search(r"translate\(([^)]+)\)", transform_str)
    if m:
        vals = [float(v) for v in re.split(r"[\s,]+", m.group(1).strip())]
        if len(vals) >= 2:
            tx, ty = vals[0], vals[1]
        elif len(vals) == 1:
            tx = vals[0]

    # rotate
    m = re.search(r"rotate\(([^)]+)\)", transform_str)
    if m:
        vals = [float(v) for v in re.split(r"[\s,]+", m.group(1).strip())]
        if vals:
            rot = vals[0]

    return tx, ty, rot

def extract_named_elements(root):
    """深度遍历 SVG,收集所有带 id 的元素及其累积 transform"""
    results = []

    def walk(elem, parent_tx=0.0, parent_ty=0.0, parent_rot=0.0, depth=0):
        # 累积当前元素的 transform
        tx, ty, rot = parse_transform(elem.get("transform", ""))
        abs_tx = parent_tx + tx
        abs_ty = parent_ty + ty
        abs_rot = parent_rot + rot

        # 如果元素有 id, 记录
        elem_id = elem.get("id", "").strip()
        if elem_id:
            # 尺寸
            w = float(elem.get("width", 0) or 0)
            h = float(elem.get("height", 0) or 0)
            # 直接的 x/y 属性
            x = float(elem.get("x", 0) or 0) + abs_tx
            y = float(elem.get("y", 0) or 0) + abs_ty

            results.append({
                "id": elem_id,
                "x": round(x, 2),
                "y": round(y, 2),
                "width": round(w, 2),
                "height": round(h, 2),
                "rotation": round(abs_rot, 2),
                "depth": depth,
            })

        # 递归子元素
        for child in elem:
            walk(child, abs_tx, abs_ty, abs_rot, depth + 1)

    walk(root)
    return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True, help="Figma 导出的 SVG 文件")
    parser.add_argument("--output", default="templates/blue-mood/template.json",
                        help="生成的 template.json 路径")
    args = parser.parse_args()

    tree = ET.parse(args.svg)
    root = tree.getroot()

    # 画布尺寸
    canvas_w = float(root.get("width", 0) or 0)
    canvas_h = float(root.get("height", 0) or 0)
    if canvas_w == 0 or canvas_h == 0:
        viewbox = root.get("viewBox", "0 0 0 0").split()
        if len(viewbox) == 4:
            canvas_w = float(viewbox[2])
            canvas_h = float(viewbox[3])

    print(f"📐 画布尺寸: {canvas_w} × {canvas_h}")

    all_named = extract_named_elements(root)
    print(f"🔍 提取到 {len(all_named)} 个带 id 的图层")

    # 分类并按图层顺序赋 z_index (SVG 里越靠后越在上层)
    background = None
    photo_slots = []
    stickers = []

    for i, elem in enumerate(all_named):
        elem["z_index"] = i
        name = elem["id"]
        if name == "background":
            background = elem
        elif name.startswith("photo_"):
            elem["priority"] = "hero" if name == "photo_hero" else "high"
            elem["asset_file"] = None  # 照片位没有素材文件
            photo_slots.append(elem)
        elif name.startswith("sticker_"):
            elem["asset_file"] = f"{name}.png"
            stickers.append(elem)
        else:
            print(f"  ⚠️  未识别的图层名: {name}  (需要以 background / photo_ / sticker_ 开头)")

    template = {
        "canvas": {"width": canvas_w, "height": canvas_h},
        "background": background,
        "photo_slots": photo_slots,
        "stickers": stickers,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False, indent=2)

    print()
    print(f"✅ 已生成 {output_path}")
    print(f"   背景: {'✓ ' + background['id'] if background else '✗ 未找到 (需要 id=background)'}")
    print(f"   照片位: {len(photo_slots)}")
    for p in photo_slots:
        print(f"     · {p['id']}  ({p['priority']})  {p['width']:.0f}×{p['height']:.0f}")
    print(f"   装饰: {len(stickers)}")
    for s in stickers:
        print(f"     · {s['id']}  z={s['z_index']}")

if __name__ == "__main__":
    main()

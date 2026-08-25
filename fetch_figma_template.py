"""
fetch_figma_template.py
通过 Figma REST API 读取设计稿, 提取所有以 background / photo_ / sticker_ 命名的图层,
自动生成 template.json 供 render_poster.py 使用。

用法:
    # 一次性设置 (推荐: 写进 .env)
    export FIGMA_ACCESS_TOKEN=figd_xxxxxxxxxxxxx

    python fetch_figma_template.py --file-id ABCDEF1234
    python fetch_figma_template.py --file-id ABCDEF1234 --page "页面名"

准备:
    1. Figma 里所有相关图层按规范命名 (background / photo_hero / photo_1..4 / sticker_xxx)
    2. Access token 已生成 (figma.com → Settings → Personal access tokens)
    3. 装饰 PNG 素材已导出到 templates/blue-mood/, 文件名跟图层名一致
"""

import os
import json
import argparse
import urllib.request
import urllib.error
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

API_BASE = "https://api.figma.com/v1"


def fetch_figma_file(file_id, token):
    """调用 Figma API 拿到整个文件的 JSON"""
    url = f"{API_BASE}/files/{file_id}"
    req = urllib.request.Request(url, headers={"X-Figma-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Figma API 错误 {e.code}: {body}")


def find_target_frame(document, page_name=None):
    """在 Figma document 里找到主画布 (CANVAS/FRAME).
    如果指定了 page_name, 只在那一页找; 否则找第一个含 background 图层的 frame。
    """
    for page in document.get("children", []):
        if page_name and page.get("name") != page_name:
            continue
        # 页面本身就是 CANVAS,里面的 FRAME/COMPONENT 是主画布
        # 直接在 CANVAS 下找,或者进一层 FRAME
        for node in page.get("children", []):
            if node.get("type") in ("FRAME", "COMPONENT", "GROUP"):
                # 检查里面是否有目标图层
                if has_target_layers(node):
                    return node, page.get("name")
        # 也可能所有元素直接躺在 CANVAS 下
        if has_target_layers(page):
            return page, page.get("name")
    return None, None


def has_target_layers(node):
    """判断这个 node 里是否有以 background/photo_/sticker_ 开头的子图层"""
    def walk(n):
        name = n.get("name", "")
        if name == "background" or name.startswith("photo_") or name.startswith("sticker_"):
            return True
        for child in n.get("children", []):
            if walk(child):
                return True
        return False
    return walk(node)


def extract_rotation(node):
    """提取旋转角度 (度)

    Figma API 有两种旋转字段位置:
    1. 顶层 rotation 字段 (弧度制, 常见于 RECTANGLE/IMAGE/GROUP 等)
    2. relativeTransform matrix (常见于旧格式或嵌套 frame)

    Figma 的旋转方向: 逆时针为正 (跟 CSS/PIL 相反, 后者顺时针为正)
    所以取负值让下游渲染方向一致。
    """
    import math

    # 优先看顶层 rotation
    rot = node.get("rotation")
    if rot is not None:
        # rotation 是弧度制
        return round(-math.degrees(rot), 2)

    # fallback: relativeTransform matrix
    tf = node.get("relativeTransform")
    if tf and len(tf) >= 2 and len(tf[0]) >= 2:
        a = tf[0][0]
        b = tf[1][0]
        return round(-math.degrees(math.atan2(b, a)), 2)

    return 0.0


def collect_layers(node, frame_origin, depth=0, all_layers=None):
    """深度遍历,收集所有目标图层"""
    if all_layers is None:
        all_layers = []

    name = node.get("name", "")
    bbox = node.get("absoluteBoundingBox")

    if bbox and (name == "background" or name.startswith("photo_") or name.startswith("sticker_")):
        # 相对于 frame 原点的坐标
        x = bbox["x"] - frame_origin["x"]
        y = bbox["y"] - frame_origin["y"]
        all_layers.append({
            "name": name,
            "x": round(x, 2),
            "y": round(y, 2),
            "width": round(bbox["width"], 2),
            "height": round(bbox["height"], 2),
            "rotation": extract_rotation(node),
            "depth": depth,
        })

    # 递归子元素
    for child in node.get("children", []):
        collect_layers(child, frame_origin, depth + 1, all_layers)

    return all_layers


def collect_layers_with_order(root, frame_origin):
    """
    Figma 图层顺序: children 列表里越靠后的越在上层 (z_index 更大)
    深度遍历时按 children 顺序访问,得到的顺序就是 z_index 顺序。
    """
    ordered = []

    def walk(node, depth=0):
        name = node.get("name", "")
        bbox = node.get("absoluteBoundingBox")
        if bbox and (name == "background" or name.startswith("photo_") or name.startswith("sticker_")):
            x = bbox["x"] - frame_origin["x"]
            y = bbox["y"] - frame_origin["y"]
            ordered.append({
                "name": name,
                "x": round(x, 2),
                "y": round(y, 2),
                "width": round(bbox["width"], 2),
                "height": round(bbox["height"], 2),
                "rotation": extract_rotation(node),
                "depth": depth,
            })
        for child in node.get("children", []):
            walk(child, depth + 1)

    walk(root)
    return ordered


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file-id", required=True,
                        help="Figma 文件 ID (URL 里 /file/ 后面那串)")
    parser.add_argument("--page", default=None,
                        help="页面名 (可选, 默认取第一个含目标图层的页面)")
    parser.add_argument("--style", default="denim",
                        help="风格名, 输出到 templates/{style}/template.json (默认 denim)")
    parser.add_argument("--output", default=None,
                        help="显式指定输出路径, 覆盖 --style 推导的路径")
    parser.add_argument("--token", default=None,
                        help="Figma access token, 默认从环境变量 FIGMA_ACCESS_TOKEN 读")
    args = parser.parse_args()

    # 输出路径: --output 优先, 否则用 --style 推导
    if not args.output:
        args.output = f"templates/{args.style}/template.json"

    token = args.token or os.getenv("FIGMA_ACCESS_TOKEN")
    if not token:
        print("错误: 找不到 Figma token")
        print("请在 .env 里加一行: FIGMA_ACCESS_TOKEN=figd_xxx")
        print("或用 --token 参数传入")
        return

    print(f"🌐 请求 Figma API...")
    data = fetch_figma_file(args.file_id, token)
    print(f"   文件名: {data.get('name')}")
    print(f"   最后修改: {data.get('lastModified')}")
    print()

    document = data.get("document", {})
    frame, page_name = find_target_frame(document, args.page)
    if not frame:
        print("❌ 找不到含目标图层的 frame")
        print("请确认 Figma 里有以 background / photo_ / sticker_ 开头的图层")
        return

    print(f"🎨 找到主画布: {frame.get('name')} (页面: {page_name})")

    bbox = frame.get("absoluteBoundingBox", {})
    frame_origin = {"x": bbox.get("x", 0), "y": bbox.get("y", 0)}
    canvas_w = bbox.get("width", 0)
    canvas_h = bbox.get("height", 0)
    print(f"   画布尺寸: {canvas_w} × {canvas_h}")
    print()

    # 收集所有目标图层
    layers = collect_layers_with_order(frame, frame_origin)
    print(f"🔍 找到 {len(layers)} 个目标图层")

    # 分类
    background = None
    photo_slots = []
    stickers = []

    for i, layer in enumerate(layers):
        layer["z_index"] = i
        name = layer["name"]
        if name == "background":
            background = layer
        elif name.startswith("photo_"):
            layer["priority"] = "hero" if name == "photo_hero" else "high"
            layer["asset_file"] = None
            photo_slots.append(layer)
        elif name.startswith("sticker_"):
            layer["asset_file"] = f"{name}.png"
            stickers.append(layer)

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
    print(f"   背景: {'✓ ' + background['name'] if background else '✗ 未找到'}")
    print(f"   照片位: {len(photo_slots)}")
    for p in photo_slots:
        print(f"     · {p['name']}  ({p['priority']})  {p['width']:.0f}×{p['height']:.0f}  rot={p['rotation']}°")
    print(f"   装饰: {len(stickers)}")
    for s in stickers:
        print(f"     · {s['name']}  z={s['z_index']}  rot={s['rotation']}°")


if __name__ == "__main__":
    main()

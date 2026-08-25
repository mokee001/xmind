"""生成一批占位示例照片（没有真实照片时用来快速验证排版效果）。"""

import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "photos")

# 柔和的手帐配色
COLORS = [
    (233, 196, 176), (169, 196, 162), (201, 184, 218),
    (176, 201, 214), (230, 210, 160), (214, 176, 184),
    (160, 190, 180), (200, 170, 150),
]


def make_placeholder(index: int, color: tuple[int, int, int], size: int = 800) -> Image.Image:
    img = Image.new("RGB", (size, size), color)
    draw = ImageDraw.Draw(img)
    # 简单的对角渐变条纹，避免纯色看不出裁剪效果
    for x in range(0, size, 60):
        shade = tuple(max(0, c - 20) for c in color)
        draw.line([(x, 0), (x - size, size)], fill=shade, width=24)
    draw.text((size // 2 - 20, size // 2 - 20), str(index), fill=(255, 255, 255))
    return img


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for i, color in enumerate(COLORS, start=1):
        path = os.path.join(OUT_DIR, f"sample_{i:02d}.jpg")
        make_placeholder(i, color).save(path, quality=90)
        print("生成", path)
    print(f"\n共生成 {len(COLORS)} 张占位照片到 {OUT_DIR}")


if __name__ == "__main__":
    main()

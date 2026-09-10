from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List

from PIL import Image, ImageDraw, ImageFont, ImageOps


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
DATE_PATTERN = re.compile(r"^2026-07-(\d{2})__")
TILE_SIZE = (270, 225)
PHOTO_SIZE = (250, 170)
COLUMNS = 4


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def collect_images(folder: Path) -> Dict[int, List[Path]]:
    grouped: Dict[int, List[Path]] = defaultdict(list)
    for path in sorted(folder.iterdir()):
        match = DATE_PATTERN.match(path.name)
        if not match or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        grouped[int(match.group(1))].append(path)
    return dict(sorted(grouped.items()))


def split_groups(
    grouped: Dict[int, List[Path]],
    maximum_images: int = 32,
) -> Iterable[Dict[int, List[Path]]]:
    current: Dict[int, List[Path]] = {}
    current_count = 0
    for day, paths in grouped.items():
        if current and current_count + len(paths) > maximum_images:
            yield current
            current = {}
            current_count = 0
        current[day] = paths
        current_count += len(paths)
    if current:
        yield current


def render_sheet(grouped: Dict[int, List[Path]], output: Path) -> None:
    title_font = load_font(28)
    label_font = load_font(16)
    images = [(day, path) for day, paths in grouped.items() for path in paths]
    rows = (len(images) + COLUMNS - 1) // COLUMNS
    width = COLUMNS * TILE_SIZE[0]
    height = 60 + rows * TILE_SIZE[1]
    sheet = Image.new("RGB", (width, height), "#f5f5f5")
    draw = ImageDraw.Draw(sheet)
    days = sorted(grouped)
    draw.text(
        (18, 14),
        f"2026 年 7 月候选照片：{days[0]}–{days[-1]} 日",
        fill="#202020",
        font=title_font,
    )

    for index, (day, path) in enumerate(images):
        column = index % COLUMNS
        row = index // COLUMNS
        x = column * TILE_SIZE[0] + 10
        y = 60 + row * TILE_SIZE[1] + 8
        try:
            image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            thumbnail = ImageOps.contain(image, PHOTO_SIZE)
            photo = Image.new("RGB", PHOTO_SIZE, "white")
            photo.paste(
                thumbnail,
                (
                    (PHOTO_SIZE[0] - thumbnail.width) // 2,
                    (PHOTO_SIZE[1] - thumbnail.height) // 2,
                ),
            )
        except Exception:
            photo = Image.new("RGB", PHOTO_SIZE, "#dedede")
            ImageDraw.Draw(photo).text(
                (20, 70),
                "无法读取",
                fill="#a00000",
                font=title_font,
            )

        sheet.paste(photo, (x, y))
        draw.rectangle(
            (x, y, x + PHOTO_SIZE[0], y + PHOTO_SIZE[1]),
            outline="#707070",
            width=1,
        )
        draw.rectangle((x, y, x + 48, y + 27), fill="#111111")
        draw.text((x + 8, y + 3), f"{day:02d}", fill="white", font=label_font)
        draw.text(
            (x, y + PHOTO_SIZE[1] + 7),
            path.name,
            fill="#222222",
            font=label_font,
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=94)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("photo_folder", type=Path)
    parser.add_argument("output_folder", type=Path)
    args = parser.parse_args()

    grouped = collect_images(args.photo_folder)
    for index, group in enumerate(split_groups(grouped), start=1):
        render_sheet(group, args.output_folder / f"candidates_{index:02d}.jpg")


if __name__ == "__main__":
    main()

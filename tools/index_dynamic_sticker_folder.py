from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
FONT_PATH = Path("/System/Library/Fonts/STHeiti Light.ttc")


def load_image(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGBA")


def has_useful_alpha(image: Image.Image) -> bool:
    alpha = image.getchannel("A")
    minimum, maximum = alpha.getextrema()
    return minimum < 250 and maximum > 0


def build_catalog(source_dir: Path, output_dir: Path) -> tuple[Path, Path]:
    files = sorted(
        path
        for path in source_dir.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    tile_width = 320
    tile_height = 300
    columns = 4
    rows = (len(files) + columns - 1) // columns
    contact_sheet = Image.new(
        "RGB",
        (columns * tile_width, rows * tile_height),
        "#f1f1ef",
    )
    draw = ImageDraw.Draw(contact_sheet)
    font = ImageFont.truetype(str(FONT_PATH), 18)
    small_font = ImageFont.truetype(str(FONT_PATH), 15)
    entries = []

    for index, path in enumerate(files):
        image = load_image(path)
        alpha = has_useful_alpha(image)
        column = index % columns
        row = index // columns
        x = column * tile_width
        y = row * tile_height
        draw.rectangle(
            (x + 8, y + 8, x + tile_width - 8, y + tile_height - 8),
            fill="#ffffff",
            outline="#d8d8d4",
            width=2,
        )
        preview = ImageOps.contain(
            image,
            (tile_width - 36, 205),
            Image.Resampling.LANCZOS,
        )
        preview_canvas = Image.new("RGBA", preview.size, "#fafaf8")
        preview_canvas.alpha_composite(preview)
        contact_sheet.paste(
            preview_canvas.convert("RGB"),
            (
                x + (tile_width - preview.width) // 2,
                y + 18 + (205 - preview.height) // 2,
            ),
        )
        display_name = path.name
        if len(display_name) > 29:
            display_name = display_name[:26] + "..."
        draw.text((x + 18, y + 232), display_name, font=font, fill="#202020")
        draw.text(
            (x + 18, y + 262),
            f"{image.width}x{image.height} · "
            + ("透明" if alpha else "不透明"),
            font=small_font,
            fill="#707070",
        )
        entries.append(
            {
                "id": path.stem,
                "file": path.name,
                "path": str(path),
                "suffix": path.suffix.lower(),
                "width": image.width,
                "height": image.height,
                "has_useful_alpha": alpha,
                "review_status": "pending",
                "category": None,
                "keywords": [],
            }
        )

    contact_sheet_path = output_dir / "sticker_source_contact_sheet.jpg"
    contact_sheet.save(contact_sheet_path, quality=92, optimize=True)
    catalog_path = output_dir / "sticker_source_catalog.json"
    catalog_path.write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "source_directory": str(source_dir),
                "asset_count": len(entries),
                "assets": entries,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return catalog_path, contact_sheet_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    catalog_path, contact_sheet_path = build_catalog(
        args.source_dir.expanduser().resolve(),
        args.output_dir.expanduser().resolve(),
    )
    print(catalog_path)
    print(contact_sheet_path)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageOps


STICKER_CROPS = {
    "paper_pushpin": {
        "box": [1068, 476, 1124, 548],
        "category": "paper",
        "visual_count": 1,
    },
    "relationship_hearts": {
        "box": [1268, 436, 1382, 548],
        "category": "people_and_animals",
        "visual_count": 2,
    },
    "music_record": {
        "box": [734, 1058, 850, 1196],
        "category": "music_and_film",
        "visual_count": 1,
    },
    "scenery_shooting_star": {
        "box": [1272, 1060, 1392, 1162],
        "category": "scenery",
        "visual_count": 1,
    },
    "relationship_pearl_heart": {
        "box": [280, 1276, 558, 1504],
        "category": "people_and_animals",
        "visual_count": 1,
    },
    "abstract_outline_star": {
        "box": [150, 1396, 250, 1492],
        "category": "abstract",
        "visual_count": 1,
    },
}


def trim_alpha(image: Image.Image, padding: int = 4) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return image
    left, top, right, bottom = bbox
    return image.crop(
        (
            max(0, left - padding),
            max(0, top - padding),
            min(image.width, right + padding),
            min(image.height, bottom + padding),
        )
    )


def build_library(source_path: Path, output_dir: Path) -> Path:
    with Image.open(source_path) as source:
        layer = ImageOps.exif_transpose(source).convert("RGBA")

    output_dir.mkdir(parents=True, exist_ok=True)
    assets = []
    for sticker_id, metadata in STICKER_CROPS.items():
        asset = trim_alpha(layer.crop(tuple(metadata["box"])))
        asset_path = output_dir / f"{sticker_id}.png"
        asset.save(asset_path)
        assets.append(
            {
                "id": sticker_id,
                "file": asset_path.name,
                "category": metadata["category"],
                "visual_count": metadata["visual_count"],
                "source": source_path.name,
                "size": [asset.width, asset.height],
            }
        )

    manifest_path = output_dir / "sticker_library.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "source_layer": str(source_path),
                "assets": assets,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest_path = build_library(
        args.source.expanduser().resolve(),
        args.output_dir.expanduser().resolve(),
    )
    print(manifest_path)


if __name__ == "__main__":
    main()

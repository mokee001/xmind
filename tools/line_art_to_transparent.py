from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def convert(input_path: Path, output_path: Path) -> None:
    with Image.open(input_path) as source:
        rgb = source.convert("RGB")
    pixels = []
    for red, green, blue in rgb.getdata():
        luminance = round(0.2126 * red + 0.7152 * green + 0.0722 * blue)
        alpha = max(0, min(255, round((242 - luminance) * 2.8)))
        pixels.append((20, 20, 20, alpha))
    result = Image.new("RGBA", rgb.size)
    result.putdata(pixels)
    bbox = result.getchannel("A").getbbox()
    if bbox:
        result = result.crop(bbox)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    convert(args.input.expanduser(), args.output.expanduser())


if __name__ == "__main__":
    main()

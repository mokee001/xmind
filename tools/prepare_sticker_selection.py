from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def border_color(image: np.ndarray) -> np.ndarray:
    border = np.concatenate(
        [
            image[0, :, :],
            image[-1, :, :],
            image[:, 0, :],
            image[:, -1, :],
        ],
        axis=0,
    )
    return np.median(border.astype(np.float32), axis=0)


def remove_border_background(
    source_path: Path,
    output_path: Path,
    threshold: float,
    large_enclosed_background_ratio: float,
) -> dict[str, object]:
    source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if source is None:
        raise RuntimeError(f"cannot read sticker source: {source_path}")

    image = cv2.cvtColor(source, cv2.COLOR_BGR2RGB)
    background = border_color(image)
    distance = np.linalg.norm(
        image.astype(np.float32) - background.reshape(1, 1, 3),
        axis=2,
    )
    candidate = (distance <= threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        candidate,
        connectivity=8,
    )

    border_labels = set(labels[0, :])
    border_labels.update(labels[-1, :])
    border_labels.update(labels[:, 0])
    border_labels.update(labels[:, -1])
    background_mask = np.isin(
        labels,
        [label for label in border_labels if label != 0],
    )
    if large_enclosed_background_ratio > 0:
        minimum_area = candidate.size * large_enclosed_background_ratio
        for label in range(1, count):
            if label in border_labels:
                continue
            if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
                background_mask |= labels == label
    foreground = (~background_mask).astype(np.uint8) * 255
    foreground = cv2.GaussianBlur(foreground, (0, 0), 0.65)

    rgba = np.dstack([image, foreground])
    alpha_bbox = cv2.boundingRect((foreground > 2).astype(np.uint8))
    x, y, width, height = alpha_bbox
    padding = max(4, round(min(image.shape[:2]) * 0.01))
    left = max(0, x - padding)
    top = max(0, y - padding)
    right = min(image.shape[1], x + width + padding)
    bottom = min(image.shape[0], y + height + padding)
    cropped = rgba[top:bottom, left:right]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(cropped).save(output_path)
    return {
        "source_size": [int(image.shape[1]), int(image.shape[0])],
        "output_size": [int(cropped.shape[1]), int(cropped.shape[0])],
        "background_rgb": [round(float(value), 2) for value in background],
        "threshold": threshold,
        "large_enclosed_background_ratio": large_enclosed_background_ratio,
        "foreground_ratio": round(
            float(np.count_nonzero(foreground > 8)) / foreground.size,
            4,
        ),
        "connected_component_count": int(count - 1),
    }


def prepare_selection(selection_path: Path, output_dir: Path) -> Path:
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    prepared_assets = []
    for item in selection["assets"]:
        source_path = Path(item["source_path"]).expanduser().resolve()
        output_path = output_dir / item["output_file"]
        processing = remove_border_background(
            source_path,
            output_path,
            float(item.get("background_threshold", 38)),
            float(item.get("large_enclosed_background_ratio", 0)),
        )
        prepared_assets.append(
            {
                **item,
                "source_path": str(source_path),
                "prepared_path": str(output_path.resolve()),
                "processing": processing,
            }
        )

    manifest_path = output_dir / "selected_sticker_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "selection_source": str(selection_path),
                "assets": prepared_assets,
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
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest_path = prepare_selection(
        args.selection.expanduser().resolve(),
        args.output_dir.expanduser().resolve(),
    )
    print(manifest_path)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps


STATIC_SUFFIXES = {".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp"}
VIDEO_SUFFIXES = {".mov", ".mp4", ".m4v", ".avi"}
FILENAME_DATE_PATTERNS = (
    re.compile(r"(?P<year>20\d{2})[-_.]?(?P<month>\d{2})[-_.]?(?P<day>\d{2})"),
    re.compile(r"(?P<month>\d{2})[-_.](?P<day>\d{2})"),
)
SCREENSHOT_WORDS = ("screenshot", "screen shot", "screencapture", "截屏", "截图", "屏幕")
COMMON_SCREENSHOT_SIZES = {
    (750, 1334),
    (828, 1792),
    (1080, 1920),
    (1125, 2436),
    (1170, 2532),
    (1179, 2556),
    (1242, 2688),
    (1284, 2778),
    (1290, 2796),
    (1320, 2868),
}


def run_sips_metadata(path: Path) -> dict[str, str]:
    result = subprocess.run(
        [
            "/usr/bin/sips",
            "-g",
            "creation",
            "-g",
            "pixelWidth",
            "-g",
            "pixelHeight",
            "-g",
            "format",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    metadata: dict[str, str] = {}
    for line in result.stdout.splitlines()[1:]:
        if ":" in line:
            key, value = line.strip().split(":", 1)
            metadata[key.strip()] = value.strip()
    return metadata


def parse_capture_time(path: Path, metadata: dict[str, str]) -> tuple[datetime | None, str, str]:
    # Downloaded photos often inherit the download timestamp, so an explicit
    # date in the filename is the product-defined source of truth.
    for index, pattern in enumerate(FILENAME_DATE_PATTERNS):
        match = pattern.search(path.stem)
        if not match:
            continue
        values = match.groupdict()
        try:
            return (
                datetime(
                    int(values.get("year") or 2026),
                    int(values["month"]),
                    int(values["day"]),
                    12,
                    0,
                    index,
                ),
                "filename",
                "medium",
            )
        except ValueError:
            continue
    creation = metadata.get("creation", "")
    if creation and creation != "<nil>":
        try:
            return datetime.strptime(creation, "%Y:%m:%d %H:%M:%S"), "embedded_creation", "high"
        except ValueError:
            pass
    return None, "missing", "low"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def convert_proxy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0:
        with Image.open(destination) as existing:
            if existing.convert("L").getextrema()[1] > 8:
                return

    if source.suffix.lower() in {".heic", ".heif"}:
        result = subprocess.run(
            [
                "/opt/homebrew/bin/ffmpeg",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-frames:v",
                "1",
                str(destination),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not destination.exists():
            raise RuntimeError(result.stderr.strip() or "ffmpeg HEIC conversion failed")
        with Image.open(destination) as converted:
            proxy = ImageOps.exif_transpose(converted).convert("RGB")
            proxy.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            proxy.save(destination, format="JPEG", quality=88)
        return

    # Some Android JPEGs render correctly in Preview but become black when
    # converted by sips. Pillow preserves their decoded RGB pixels reliably.
    with Image.open(source) as original:
        proxy = ImageOps.exif_transpose(original).convert("RGB")
        proxy.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        proxy.save(destination, format="JPEG", quality=88)


def difference_hash(gray: np.ndarray) -> str:
    reduced = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = reduced[:, 1:] > reduced[:, :-1]
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hash_distance(left: str, right: str) -> int:
    return bin(int(left, 16) ^ int(right, 16)).count("1")


def screenshot_probability(path: Path, width: int, height: int) -> float:
    score = 0.0
    name = path.name.lower()
    if any(word in name for word in SCREENSHOT_WORDS):
        score += 0.75
    if (width, height) in COMMON_SCREENSHOT_SIZES or (height, width) in COMMON_SCREENSHOT_SIZES:
        score += 0.55
    long_side = max(width, height)
    short_side = max(1, min(width, height))
    if path.suffix.lower() == ".png" and long_side / short_side >= 1.75:
        score += 0.30
    return min(1.0, score)


def inspect_proxy(path: Path, source: Path, width: int, height: int) -> dict[str, Any]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("OpenCV could not read proxy")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mean = float(gray.mean())
    deviation = float(gray.std())
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    black_ratio = float(np.mean(gray <= 8))
    white_ratio = float(np.mean(gray >= 247))
    screenshot_score = screenshot_probability(source, width, height)
    qr_value = ""
    try:
        qr_value, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
    except cv2.error:
        pass

    if black_ratio >= 0.92 or white_ratio >= 0.96 or deviation <= 4:
        status = "REJECT"
        reasons = ["nearly_blank_or_extreme_exposure"]
    else:
        reasons: list[str] = []
        if blur < 35:
            reasons.append("possible_severe_blur")
        elif blur < 75:
            reasons.append("possible_blur")
        if mean < 28:
            reasons.append("possible_underexposure")
        elif mean > 235:
            reasons.append("possible_overexposure")
        if screenshot_score >= 0.5:
            reasons.append("possible_screenshot")
        if qr_value:
            reasons.append("qr_code_detected")
        status = "REVIEW" if reasons else "PASS"

    return {
        "technical_status": status,
        "technical_reasons": reasons,
        "quality": {
            "brightness_mean": round(mean, 2),
            "contrast_stddev": round(deviation, 2),
            "blur_variance": round(blur, 2),
            "black_ratio": round(black_ratio, 4),
            "white_ratio": round(white_ratio, 4),
        },
        "screenshot_probability": round(screenshot_score, 2),
        "qr_code_detected": bool(qr_value),
        "dhash": difference_hash(gray),
    }


def duplicate_groups(items: list[dict[str, Any]], maximum_distance: int) -> list[list[str]]:
    by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_day[item["calendar_date"]].append(item)
    groups: list[list[str]] = []
    for day_items in by_day.values():
        remaining = {item["image_id"]: item for item in day_items}
        while remaining:
            image_id, seed = remaining.popitem()
            matches = [
                candidate_id
                for candidate_id, candidate in remaining.items()
                if hash_distance(seed["dhash"], candidate["dhash"]) <= maximum_distance
            ]
            group = [image_id]
            for candidate_id in matches:
                group.append(candidate_id)
                remaining.pop(candidate_id)
            if len(group) > 1:
                groups.append(sorted(group))
    return groups


def burst_groups(items: list[dict[str, Any]]) -> list[list[str]]:
    by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_day[item["calendar_date"]].append(item)
    groups: list[list[str]] = []
    for day_items in by_day.values():
        ordered = sorted(day_items, key=lambda item: item["capture_at"])
        current: list[dict[str, Any]] = []
        for item in ordered:
            if not current:
                current = [item]
                continue
            previous_time = datetime.fromisoformat(current[-1]["capture_at"])
            current_time = datetime.fromisoformat(item["capture_at"])
            if (
                (current_time - previous_time).total_seconds() <= 90
                and hash_distance(current[-1]["dhash"], item["dhash"]) <= 20
            ):
                current.append(item)
            else:
                if len(current) > 1:
                    groups.append([entry["image_id"] for entry in current])
                current = [item]
        if len(current) > 1:
            groups.append([entry["image_id"] for entry in current])
    return groups


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_folder", type=Path)
    parser.add_argument("run_folder", type=Path)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--month", type=int, default=7)
    args = parser.parse_args()

    source_folder = args.source_folder.expanduser().resolve()
    run_folder = args.run_folder.expanduser().resolve()
    proxy_folder = run_folder / "proxies"
    proxy_folder.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in source_folder.iterdir() if path.is_file())
    excluded: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []

    for source in files:
        suffix = source.suffix.lower()
        if suffix in VIDEO_SUFFIXES:
            excluded.append({"source_path": str(source), "reason": "video_or_live_photo_motion", "suffix": suffix})
            continue
        if suffix not in STATIC_SUFFIXES:
            excluded.append({"source_path": str(source), "reason": "unsupported_file", "suffix": suffix})
            continue
        metadata = run_sips_metadata(source)
        capture_at, date_source, date_confidence = parse_capture_time(source, metadata)
        if capture_at is None:
            excluded.append({"source_path": str(source), "reason": "missing_capture_date", "suffix": suffix})
            continue
        if (capture_at.year, capture_at.month) != (args.year, args.month):
            excluded.append(
                {
                    "source_path": str(source),
                    "reason": "outside_target_month",
                    "capture_at": capture_at.isoformat(),
                    "suffix": suffix,
                }
            )
            continue
        candidates.append(
            {
                "source": source,
                "capture_at_value": capture_at,
                "date_source": date_source,
                "date_confidence": date_confidence,
                "width": int(metadata.get("pixelWidth", 0) or 0),
                "height": int(metadata.get("pixelHeight", 0) or 0),
                "format": metadata.get("format", suffix.lstrip(".")),
            }
        )

    candidates.sort(key=lambda item: (item["capture_at_value"], item["source"].name.lower()))
    day_counters: Counter[int] = Counter()
    imported: list[dict[str, Any]] = []
    conversion_failures: list[dict[str, str]] = []
    for candidate in candidates:
        source = candidate["source"]
        capture_at = candidate["capture_at_value"]
        day_counters[capture_at.day] += 1
        image_id = f"img_{capture_at.day:02d}_{day_counters[capture_at.day]:03d}"
        clean_stem = re.sub(r"[^A-Za-z0-9_-]+", "_", source.stem)[:48]
        proxy_path = proxy_folder / (
            f"{args.year:04d}-{args.month:02d}-{capture_at.day:02d}"
            f"__{day_counters[capture_at.day]:03d}_{clean_stem}.jpg"
        )
        try:
            convert_proxy(source, proxy_path)
            technical = inspect_proxy(
                proxy_path,
                source,
                candidate["width"],
                candidate["height"],
            )
        except Exception as error:
            conversion_failures.append({"source_path": str(source), "error": str(error)})
            continue
        imported.append(
            {
                "image_id": image_id,
                "source_path": str(source),
                "proxy_path": str(proxy_path),
                "source_filename": source.name,
                "capture_at": capture_at.isoformat(),
                "calendar_date": capture_at.date().isoformat(),
                "date_source": candidate["date_source"],
                "date_confidence": candidate["date_confidence"],
                "width": candidate["width"],
                "height": candidate["height"],
                "format": candidate["format"],
                "sha256": sha256(source),
                **technical,
            }
        )

    exact_by_hash: dict[str, list[str]] = defaultdict(list)
    for item in imported:
        exact_by_hash[item["sha256"]].append(item["image_id"])
    exact_groups = [ids for ids in exact_by_hash.values() if len(ids) > 1]
    exact_duplicate_ids = {duplicate_id for group in exact_groups for duplicate_id in group[1:]}
    for item in imported:
        item["exact_duplicate"] = item["image_id"] in exact_duplicate_ids

    near_groups = duplicate_groups(imported, 6)
    bursts = burst_groups(imported)
    summary = {
        "source_file_count": len(files),
        "imported_static_count": len(imported),
        "excluded_count": len(excluded),
        "conversion_failure_count": len(conversion_failures),
        "date_counts": dict(sorted(Counter(item["calendar_date"] for item in imported).items())),
        "technical_status_counts": dict(Counter(item["technical_status"] for item in imported)),
        "excluded_reason_counts": dict(Counter(item["reason"] for item in excluded)),
        "exact_duplicate_group_count": len(exact_groups),
        "near_duplicate_group_count": len(near_groups),
        "burst_group_count": len(bursts),
        "qr_detected_count": sum(item["qr_code_detected"] for item in imported),
        "possible_screenshot_count": sum(item["screenshot_probability"] >= 0.5 for item in imported),
    }
    write_json(
        run_folder / "manifest.json",
        {
            "schema_version": "1.0",
            "target": {"year": args.year, "month": args.month},
            "privacy": {
                "processing": "local_only",
                "external_api_used": False,
                "originals_modified": False,
            },
            "source_folder": str(source_folder),
            "run_folder": str(run_folder),
            "summary": summary,
            "duplicate_groups": {"exact": exact_groups, "near": near_groups, "burst": bursts},
            "images": imported,
            "excluded": excluded,
            "conversion_failures": conversion_failures,
        },
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

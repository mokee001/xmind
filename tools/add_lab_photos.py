"""Append originals to a versioned local lab dataset, with no photo uploads."""
from __future__ import annotations
import argparse
from collections import Counter
import datetime as dt
import os
from pathlib import Path
import re
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import LabError, TZ, atomic_json, file_hash, read_json
from selection_lab.datasets import BASE_CACHE, BASE_STATE

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
VERSION = "local-yolo-shared-date-v1"


def capture_date(path):
    """No filesystem-time fallback. Missing dates remain unknown."""
    with Image.open(path) as image:
        exif = image.getexif()
        sub = exif.get_ifd(34665)
        raw = sub.get(36867) or exif.get(36867)
        if raw:
            try:
                value = dt.datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
                offset = str(sub.get(36881) or "")
                zone = TZ
                source = "exif_original_assumed_utc8"
                if re.fullmatch(r"[+-]\d{2}:\d{2}", offset):
                    minutes = (int(offset[1:3])*60+int(offset[4:])) * (-1 if offset[0]=='-' else 1)
                    zone = dt.timezone(dt.timedelta(minutes=minutes)); source = "exif_original_offset"
                return value.replace(tzinfo=zone).timestamp(), source
            except (ValueError, TypeError):
                pass
    match = re.fullmatch(r"fxn (\d{4}-\d{2}-\d{2}) (\d{6})(?:\.(\d+))?", path.stem)
    if match:
        try:
            value = dt.datetime.strptime(match[1]+" "+match[2], "%Y-%m-%d %H%M%S")
            return value.replace(tzinfo=TZ).timestamp(), "filename_datetime"
        except ValueError:
            pass
    return None, "unknown"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-cache", type=Path, default=BASE_CACHE)
    parser.add_argument("--name", default="七月照片 + 共享相簿测试")
    args = parser.parse_args()
    folder, target = args.folder.resolve(), args.output.resolve()
    target.relative_to((BASE_STATE / "datasets").resolve())
    if not folder.is_dir():
        raise LabError("照片目录不存在")
    output = target / "cache/current-cache.json"
    config = {"folder":str(folder), "base_cache":str(args.base_cache.resolve()), "version":VERSION}
    previous = read_json(target / "import-settings.json", {})
    if previous and previous != config:
        raise LabError("该结果目录属于其他导入，请使用新目录")
    atomic_json(target / "import-settings.json", config)
    base = read_json(args.base_cache / "current-cache.json", {})
    cache = read_json(output, {})
    result, seen, duplicates = {}, {}, []
    for key, item in base.items():
        path = Path(key)
        if not path.is_file():
            raise LabError("旧候选原图缺失，未悄悄丢弃")
        sha = file_hash(path)
        if sha in seen:
            duplicates.append({"path":key,"kept":seen[sha],"sha256":sha}); continue
        seen[sha] = key; result[key] = item
    # Fail closed on detector errors: never auto-fall back to filename mocks.
    os.environ["PHOTOWALL_TAGGER"] = "yolo"
    os.environ["PHOTOWALL_YOLO_MODEL"] = str(ROOT / "yolov8s.pt")
    from backend import tagger, real_tagger
    if not (ROOT / "yolov8s.pt").is_file():
        raise LabError("本地 YOLO 模型缺失；未下载照片或使用占位识别")
    tagger._detect_semantic = real_tagger.detect
    files = sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS and not p.name.startswith('.'))
    dates, added, reused = Counter(), 0, 0
    for index, path in enumerate(files, 1):
        key, sha = str(path), file_hash(path)
        if sha in seen:
            duplicates.append({"path":key,"kept":seen[sha],"sha256":sha}); continue
        seen[sha] = key
        stat = path.stat(); stamp = f"{stat.st_size}:{stat.st_mtime_ns}:{VERSION}"
        item = cache.get(key)
        if not item or item.get("_stamp") != stamp:
            item = tagger.tag_photo(key)
            item["taken_at"], item["date_source"] = capture_date(path)
            item.update(_stamp=stamp, source_album=folder.name,
                feature_provenance={"semantic":"local YOLOv8s", "model_sha256":file_hash(ROOT / "yolov8s.pt"), "quality":"project Pillow pixel heuristics"})
        else:
            reused += 1
        result[key] = item; dates[item["date_source"]] += 1; added += 1
        if index % 20 == 0:
            atomic_json(output, result)
            print(f"本机基础识别 {index}/{len(files)}", flush=True)
    atomic_json(output, result)
    vectors = read_json(args.base_cache / "immich-cache.json", {})
    atomic_json(target / "cache/immich-cache.json", {key:value for key,value in vectors.items() if key in result})
    atomic_json(target / "cache/dataset.json", {"name":args.name,"sources":["七月照片",folder.name],
        "previous_count":len(base),"new_files":len(files),"added":added,"total":len(result),
        "exact_duplicates":len(duplicates),"date_sources":dict(dates)})
    atomic_json(target / "import-report.json", {"files":len(files),"added":added,"total":len(result),"reused":reused,
        "duplicates":duplicates,"date_sources":dict(dates),"source_folder":str(folder)})
    print(f"候选集就绪：原有 {len(base)}，新增 {added}，合计 {len(result)}；完全重复 {len(duplicates)}。",flush=True)


if __name__ == "__main__":
    main()

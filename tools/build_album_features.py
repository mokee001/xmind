#!/usr/bin/env python3
"""One-time local Vision index for the album collection preview; no uploads."""
from __future__ import annotations
import argparse
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import Lab, atomic_json, file_hash, read_json


def main():
    from selection_lab.datasets import paths, BASE_STATE
    parser=argparse.ArgumentParser()
    parser.add_argument("--cache-dir",type=Path)
    parser.add_argument("--state-dir",type=Path)
    args=parser.parse_args()
    lab = Lab(*paths(args.cache_dir,args.state_dir))
    output = lab.state_dir / "album-features.json"
    source = ROOT / "tools/album_vision_features.swift"
    extractor = {"engine": "Apple Vision on macOS", "classification_revision": 1,
                 "face_detection_revision": 3, "human_detection_revision": 2,
                 "preprocess": "classification-640-face-human-1600-oriented",
                 "os": platform.mac_ver()[0], "source_sha256": file_hash(source)}
    cached = read_json(output, {})
    if cached.get("dataset_id") != lab.dataset_id or cached.get("extractor") != extractor:
        cached = {"schema_version": 1, "dataset_id": lab.dataset_id, "extractor": extractor, "assets": {}}
    previous=read_json(BASE_STATE / "album-features.json", {})
    if previous.get("extractor")==extractor:
        for p in lab.features:
            item=previous.get("assets",{}).get(p["id"],{})
            if item.get("sha256")==p["sha256"] and not item.get("error"):
                cached["assets"].setdefault(p["id"],item)
    todo = [p for p in lab.features if cached["assets"].get(p["id"], {}).get("sha256") != p["sha256"]
            or cached["assets"].get(p["id"], {}).get("error")]
    if not todo:
        atomic_json(output,cached)
        print("Vision cache is current", flush=True)
        return
    swift = shutil.which("swift")
    if not swift:
        raise SystemExit("需要本机 Xcode/Swift 才能生成 Vision 特征；未回退到模拟标签")
    print(f"Local Vision: {len(todo)} assets. No network requests.", flush=True)
    # Invoke the extractor in bounded batches, retaining completed results.
    for start in range(0, len(todo), 24):
        batch = todo[start:start + 24]
        result = subprocess.run([swift, str(source)], input=json.dumps([
            {"id": p["id"], "path": p["path"]} for p in batch]), text=True,
            capture_output=True, timeout=240, check=True)
        observations = json.loads(result.stdout)
        for item in observations:
            original = lab.assets[item["id"]]
            cached["assets"][item["id"]] = {**item, "sha256": original["sha256"]}
        atomic_json(output, cached)
        print(f"Vision: {min(start+len(batch), len(todo))}/{len(todo)} cached", flush=True)
    print(output, flush=True)


if __name__ == "__main__":
    main()

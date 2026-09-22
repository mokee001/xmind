#!/usr/bin/env python3
"""Generate and verify the independent local memory feed from cached photos."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_lab.core import Lab, file_hash, atomic_json
from selection_lab.datasets import paths
from selection_lab.recollection_feed import build_feed, get_feed


def main():
    lab = Lab(*paths())
    protected = [p for p in lab.state_dir.rglob("*.json")
                 if "recollections" not in p.relative_to(lab.state_dir).parts]
    protected += list(lab.cache_dir.glob("*.json"))
    before = {p: file_hash(p) for p in protected}
    result = build_feed(lab)
    if result != build_feed(lab):
        raise RuntimeError("相同输入未产生相同回忆")
    available = {p["id"] for p in result["photos"]}
    for album in result["albums"]:
        ids = album["photo_ids"]
        if not (12 <= len(ids) <= 24 and len(ids) == len(set(ids))
                and set(ids) <= available and album["cover"] in ids):
            raise RuntimeError("回忆成员校验失败")
    if any(file_hash(p) != sha for p, sha in before.items()):
        raise RuntimeError("其他缓存或快照已变化，请检查并发任务")
    feed = get_feed(lab)
    report = {"snapshot_id": result["id"], "dataset_id": lab.dataset_id,
              "deterministic_replay": True, "protected_files_unchanged": len(before),
              "albums": len(result["albums"]), "featured": [
                  {"title": a["title"], "photos": len(a["photo_ids"])}
                  for a in result["albums"] if a["id"] in feed["featured_ids"]],
              "user_quality_evaluation": "pending"}
    atomic_json(lab.state_dir / "recollections/verification.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

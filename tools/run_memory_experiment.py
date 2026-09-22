#!/usr/bin/env python3
"""Replay the current local dataset; write an independent memory experiment."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_lab.core import Lab, file_hash, atomic_json
from selection_lab.datasets import paths
from selection_lab.memory_experiment import build_experiment, save_experiment


def main():
    lab=Lab(*paths())
    protected=[p for p in lab.state_dir.rglob("*.json") if "memory-experiment" not in p.relative_to(lab.state_dir).parts]
    protected+=list(lab.cache_dir.glob("*.json"))
    before={p:file_hash(p) for p in protected}
    result=build_experiment(lab)
    again=build_experiment(lab,result["config"])
    if result != again:
        raise RuntimeError("相同缓存与参数产生了不同结果，未保存")
    variants=result["variants"]
    if [a for a in variants["controlled"] if a["kind"]=="trip"] != [a for a in variants["narrative"] if a["kind"]=="trip"]:
        raise RuntimeError("受控对照中的旅程输出不一致，未保存")
    eligible={p["id"] for p in result["photos"] if p["eligible"]}
    for albums in variants.values():
        for album in albums:
            ids=album["photo_ids"]
            if not (3<=len(ids)<=12 and len(set(ids))==len(ids) and album["cover"] in ids and set(ids)<=eligible):
                raise RuntimeError("相册包含无效成员，未保存")
    save_experiment(lab,result)
    if any(file_hash(p)!=sha for p,sha in before.items()):
        raise RuntimeError("原有缓存或快照发生变化，请检查其他并发任务")
    summary={"snapshot_id":result["id"],"dataset_id":lab.dataset_id,"stats":result["stats"],
             "diagnostics":result["diagnostics"],"verified":{"deterministic_replay":True,
             "same_trip_results":True,"old_files_unchanged":len(before),"album_integrity":True},
             "human_quality_evaluation":"pending; no generated labels or claimed improvement"}
    atomic_json(lab.state_dir/"memory-experiment/verification.json",summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=="__main__":main()

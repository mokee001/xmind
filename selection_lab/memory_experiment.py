"""Isolated, replayable event/selection experiment over complete Ente features.

No inference, network, production policy updates or inferred human ground truth.
The controlled comparison changes grouping only; both sides use select_story.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from collections import Counter
from pathlib import Path

from .collections import prepare_candidates, date_span, sample_date
from .core import LabError, TZ, atomic_json, digest, file_hash, read_json
from .ente import latest_result
from .hybrid import content_from_record
from .stories import (PRECISE_DATES, RULES as OLD_RULES, assemble, cosine, day,
                      distance, event_pools, load_evidence, person_pools, trip_pools)

VERSION = "memory-experiment-v1"
# Experimental policy constants, not calibrated accuracy/confidence estimates.
RULES = dict(max_span_hours=12, max_gap_hours=3, diameter_km=20,
             local_km=3, travel_gap_hours=1, person_gap_hours=2,
             visual_gap_minutes=45, visual_link_min=.72,
             duplicate_seconds=120, duplicate_cosine=.985,
             duplicate_supported_cosine=.94, duplicate_hash_bits=12,
             scene_cosine=.72, scene_gap_minutes=45, maximum_photos=12,
             selection_fraction=.65, slots_per_scene=1.5)


def chronological(p):
    return (p.get("taken_at") if p.get("taken_at") is not None else float("inf"), p["id"])


def episode_link(group, p, evidence, memberships):
    """Connect different scenes with time/location/person evidence, with bounds.

    Unknown/day-only timestamps never enter this function's candidate stream.
    All known positions must remain within the episode diameter; an unlocated
    image cannot bridge contradictory locations. Time proximity alone is weak.
    """
    if p["date_source"] not in PRECISE_DATES or any(x["date_source"] not in PRECISE_DATES for x in group):
        return None
    if day(p) != day(group[0]) or p["taken_at"] - group[0]["taken_at"] > RULES["max_span_hours"] * 3600:
        return None
    gap = p["taken_at"] - group[-1]["taken_at"]
    if gap < 0 or gap > RULES["max_gap_hours"] * 3600:
        return None
    positions = evidence["locations"]
    located = [q for q in group if q["id"] in positions]
    if p["id"] in positions and any(distance(positions[p["id"]], positions[q["id"]]) > RULES["diameter_km"] for q in located):
        return None
    for q in reversed(group):
        hours = (p["taken_at"] - q["taken_at"]) / 3600
        if hours > RULES["max_gap_hours"]:
            break
        if p["id"] in positions and q["id"] in positions:
            km = distance(positions[p["id"]], positions[q["id"]])
            if km <= RULES["local_km"]:
                return {"from": q["id"], "to": p["id"], "reason": "时间接近、地点相邻"}
            if hours <= RULES["travel_gap_hours"]:
                return {"from": q["id"], "to": p["id"], "reason": "短时间内的附近地点变化"}
        if hours <= RULES["person_gap_hours"] and memberships.get(p["id"], set()) & memberships.get(q["id"], set()):
            return {"from": q["id"], "to": p["id"], "reason": "时间接近、出现同一人物候选"}
        if hours <= RULES["visual_gap_minutes"] / 60 and cosine(evidence["vectors"][p["id"]], evidence["vectors"][q["id"]]) >= RULES["visual_link_min"]:
            return {"from": q["id"], "to": p["id"], "reason": "短时间内的相似画面"}
    return None


def episode_pools(photos, evidence, memberships):
    dated = sorted((p for p in photos if p.get("taken_at") is not None and p["date_source"] in PRECISE_DATES), key=chronological)
    buckets = []
    for p in dated:
        for group in reversed(buckets):
            link = episode_link(group["pool"], p, evidence, memberships)
            if link:
                group["pool"].append(p); group["links"].append(link)
                break
        else:
            buckets.append({"pool": [p], "links": []})
    result = []
    for group in buckets:
        ps = group["pool"]
        if len(ps) < 3:
            continue
        date = day(ps[0])
        result.append({"id": "episode-" + digest(sorted(p["id"] for p in ps))[:16],
            "kind": "event", "pool": ps, "title": f"{date.year}.{date.month}.{date.day} · 一段时光",
            "description": "时间与地点／人物线索连接多个画面；仅时间接近不足以归组。尚待确认是否同一次经历。",
            "evidence": {"date_precision": "timestamp", "event_confirmed": False,
                         "span_hours": round((ps[-1]["taken_at"]-ps[0]["taken_at"])/3600, 2),
                         "gps_photos": sum(p["id"] in evidence["locations"] for p in ps), "links": group["links"]}})
    return sorted(result, key=lambda g: (-g["pool"][0]["taken_at"], g["id"])), {
        "precise_inputs": len(dated), "unassigned_small_fragments": sum(len(g["pool"]) for g in buckets if len(g["pool"]) < 3)}


def quality(p):
    return .45 * p.get("quality", 0) + .35 * p.get("aesthetic", 0) + .20 * p.get("memory_score", 0)


def duplicate_reason(a, b, evidence, memberships):
    if a.get("sha256") and a["sha256"] == b.get("sha256"):
        return "相同文件内容"
    if a["date_source"] not in PRECISE_DATES or b["date_source"] not in PRECISE_DATES:
        return None
    if abs(a["taken_at"]-b["taken_at"]) > RULES["duplicate_seconds"]:
        return None
    ma, mb = memberships.get(a["id"], set()), memberships.get(b["id"], set())
    if ma and mb and not ma & mb:
        return None
    sim = cosine(evidence["vectors"][a["id"]], evidence["vectors"][b["id"]])
    if sim >= RULES["duplicate_cosine"]:
        return "两分钟内画面高度相似"
    ha, hb = a.get("phash"), b.get("phash")
    if ha is not None and hb is not None and sim >= RULES["duplicate_supported_cosine"] and bin(int(ha)^int(hb)).count("1") <= RULES["duplicate_hash_bits"]:
        return "两分钟内画面与感知哈希均相似"
    return None


def deduplicate(photos, evidence, memberships):
    # Complete-link clusters stop A~B~C chains; highest quality member is first.
    clusters = []
    for p in sorted(photos, key=lambda p: (-quality(p), p["id"])):
        target = next((g for g in clusters if all(duplicate_reason(p, q, evidence, memberships) for q in g)), None)
        if target is None:
            clusters.append([p])
        else:
            target.append(p)
    removed = [{"id": p["id"], "representative": g[0]["id"],
                "reason": duplicate_reason(p, g[0], evidence, memberships)} for g in clusters for p in g[1:]]
    return sorted((g[0] for g in clusters), key=chronological), removed


def scene_groups(photos, evidence):
    scenes = []
    for p in sorted(photos, key=chronological):
        current = scenes[-1] if scenes else []
        close = current and day(p) == day(current[0]) and p["taken_at"] - current[-1]["taken_at"] <= RULES["scene_gap_minutes"] * 60
        if close and all(cosine(evidence["vectors"][p["id"]], evidence["vectors"][q["id"]]) >= RULES["scene_cosine"] for q in current):
            current.append(p)
        else:
            scenes.append([p])
    return scenes


def select_story(group, evidence, memberships, count):
    candidates, removed = deduplicate(group["pool"], evidence, memberships)
    if len(candidates) < 3:
        return None
    scenes = scene_groups(candidates, evidence)
    budget = min(count, RULES["maximum_photos"], max(3, math.ceil(len(candidates)*RULES["selection_fraction"])),
                 max(3, math.ceil(len(scenes)*RULES["slots_per_scene"])))
    scene = {p["id"]: i for i, g in enumerate(scenes) for p in g}
    chronological_ids = sorted(candidates, key=chronological)
    # Three temporal positions are coverage bins, never invented narrative roles.
    bins = {p["id"]: min(2, i*3//len(candidates)) for i, p in enumerate(chronological_ids)}
    chosen, remaining, reasons = [], list(candidates), {}
    while remaining and len(chosen) < budget:
        covered = {scene[p["id"]] for p in chosen}
        times = {bins[p["id"]] for p in chosen}
        people = set().union(*(memberships.get(p["id"], set()) for p in chosen))
        def utility(p):
            similarity = max((cosine(evidence["vectors"][p["id"]], evidence["vectors"][q["id"]]) for q in chosen), default=0)
            return (quality(p) + .28*(scene[p["id"]] not in covered) + .14*(bins[p["id"]] not in times)
                    + .12*bool(memberships.get(p["id"], set())-people) - .20*similarity, p["id"])
        best = max(remaining, key=utility)
        notes = []
        if scene[best["id"]] not in covered: notes.append("补充一个画面片段")
        if bins[best["id"]] not in times: notes.append("补充一段拍摄时间")
        if memberships.get(best["id"], set())-people: notes.append("保留尚未出现的人物候选")
        reasons[best["id"]] = "；".join(notes) or "兼顾画质与画面变化"
        chosen.append(best); remaining.remove(best)
    if len(chosen) < 3:
        return None
    chosen.sort(key=chronological)
    cover = max(chosen, key=lambda p: (quality(p), p["id"]))
    return {**{k:v for k,v in group.items() if k not in {"pool", "faces"}},
            "photo_ids": [p["id"] for p in chosen], "cover": cover["id"], "subtitle": date_span(chosen),
            "candidate_ids": [p["id"] for p in sorted(group["pool"], key=chronological)],
            "candidate_count": len(group["pool"]), "removed": removed,
            "selection_reasons": reasons, "scene_count": len(scenes),
            "selected_scene_count": len({scene[p["id"]] for p in chosen}),
            "scenes": [{"id": i, "photo_ids": [p["id"] for p in g]} for i,g in enumerate(scenes)]}


def build_experiment(lab, raw=None, *, record=None, evidence=None):
    record = latest_result(lab) if record is None else record
    if not record:
        raise LabError("需要当前数据集完整的 Ente 识别缓存")
    content = content_from_record(lab, record)
    config, photos, excluded, dates, _, vision_revision = prepare_candidates(lab, raw or {}, content=content)
    if config["count"] < 3:
        raise LabError("回忆实验每组至少需要 3 张照片")
    evidence = load_evidence(lab, record) if evidence is None else evidence
    if set(evidence["vectors"]) != set(lab.assets):
        raise LabError("Ente 内容向量必须覆盖整个数据集")
    _, memberships, _ = person_pools(photos, evidence, record["result"]["ente_diagnostics"]["person_groups"])
    old_events, _ = event_pools(photos, evidence, memberships)
    # Restrict this experiment to actual timestamp event candidates. Day-only
    # groups stay in the existing theme page and do not pretend to be episodes.
    old_events = [g for g in old_events if g["evidence"]["date_precision"] == "timestamp"]
    trips, _ = trip_pools(photos, evidence)
    episodes, episode_stats = episode_pools(photos, evidence, memberships)
    old_pools, new_pools = old_events + trips, episodes + trips
    legacy, _, _ = assemble(lab, old_pools, config)
    pool_lookup = {g["id"]: g for g in old_pools}
    for a in legacy:
        a["candidate_ids"] = [p["id"] for p in pool_lookup[a["id"]]["pool"]]
    def select(pools):
        return [album for g in pools if (album := select_story(g, evidence, memberships, config["count"]))]
    variants = {"legacy": legacy, "controlled": select(old_pools), "narrative": select(new_pools)}
    provenance = {"dataset_id": lab.dataset_id, "version": VERSION, "rules": RULES,
        "old_rules": OLD_RULES, "models": evidence["models"], "evidence_revision": evidence["revision"],
        "feature_revision": lab.feature_revision, "ente_snapshot_id": record["id"],
        "content_revision": content["revision"], "vision_revision": vision_revision,
        "code_revision": file_hash(Path(__file__)), "old_grouping_revision": file_hash(Path(__file__).with_name("stories.py")),
        "eligibility_revision": file_hash(Path(__file__).with_name("collections.py")), "selection_revision": lab.engine_revision,
        "note": "使用既有 Ente 缓存，未运行新模型；人物是自动候选，事件与选片均待人工验收。"}
    prepared = {p["id"]: p for p in photos}
    public = []
    for p in lab.features:
        item = prepared.get(p["id"], {**p, "taken_at": sample_date(p)[0], "date_source": sample_date(p)[1]})
        public.append({**lab.public_photo(item), "eligible": p["id"] in prepared})
    stats = {key: {"albums": len(values), "photos": len({p for a in values for p in a["photo_ids"]}),
                   "events": sum(a["kind"]=="event" for a in values), "trips": sum(a["kind"]=="trip" for a in values)} for key,values in variants.items()}
    return {"id": digest({"provenance": provenance, "config": config, "variants": variants})[:24],
        "engine": VERSION, "config": config, "provenance": provenance, "variants": variants,
        "photos": public, "dataset_name": lab.dataset_info.get("name", "当前相簿"),
        "stats": stats, "diagnostics": {"input_count": len(lab.features), "eligible_count": len(photos),
             "date_sources": dates, "excluded": excluded, "episodes": episode_stats,
             "old_event_pools": len(old_events), "new_event_pools": len(episodes), "trip_pools": len(trips)},
        "comparison_note": "默认左右仅改变活动分组；两边使用同一完整 Ente 向量去重与选片。旅程分组相同。原算法参考保留每类最多10组上限，不能用相册数衡量改进。"}


def save_experiment(lab, result):
    if result.get("engine") != VERSION or result.get("provenance", {}).get("dataset_id") != lab.dataset_id or not re.fullmatch(r"[a-f0-9]{24}", result.get("id", "")):
        raise LabError("实验结果与当前数据集不匹配")
    with lab.lock:
        path = lab.state_dir / "memory-experiment" / (result["id"] + ".json")
        if not path.exists():
            atomic_json(path, result)
        atomic_json(lab.state_dir / "memory-experiment/latest.json", {"id": result["id"]})
    return result


def get_experiment(lab, snapshot_id=None):
    if snapshot_id is None:
        snapshot_id = read_json(lab.state_dir / "memory-experiment/latest.json", {}).get("id")
    if snapshot_id is None:
        return None
    if not isinstance(snapshot_id, str) or not re.fullmatch(r"[a-f0-9]{24}", snapshot_id):
        raise LabError("无效的实验快照")
    result = read_json(lab.state_dir / "memory-experiment" / (snapshot_id + ".json"))
    if not result or result.get("provenance", {}).get("dataset_id") != lab.dataset_id:
        raise LabError("实验快照不是当前数据集")
    return result


def reviews(lab):
    return read_json(lab.state_dir / "memory-experiment/reviews.json", {})


def save_review(lab, data):
    if not isinstance(data.get("snapshot_id"), str):
        raise LabError("验收记录必须指定实验快照")
    result = get_experiment(lab, data.get("snapshot_id"))
    if result is None:
        raise LabError("先生成实验快照")
    variant, album_id = data.get("variant"), data.get("album_id")
    if variant not in result["variants"]:
        raise LabError("未知对照方案")
    album = next((a for a in result["variants"][variant] if a["id"] == album_id), None)
    if album is None:
        raise LabError("相册不在指定快照中")
    verdict = data.get("verdict")
    if verdict not in {"good", "mixed", "missing", "duplicate", "cover", "unsure"}:
        raise LabError("请选择一个验收结论")
    note = data.get("note", "")
    if not isinstance(note, str) or len(note) > 1000:
        raise LabError("备注最多1000字")
    allowed = {p["id"] for p in result["photos"]}
    bad, keep = data.get("wrong_ids", []), data.get("must_keep_ids", [])
    for ids, valid in [(bad, set(album["photo_ids"])), (keep, allowed)]:
        if not isinstance(ids, list) or any(not isinstance(i, str) or i not in valid for i in ids):
            raise LabError("标记照片不在本次结果／数据集中")
    if set(bad) & set(keep):
        raise LabError("同一照片不能同时标为不该入选和必须保留")
    key = digest([result["id"], variant, album_id])[:24]
    review = {"snapshot_id": result["id"], "dataset_id": lab.dataset_id, "variant": variant, "album_id": album_id,
              "verdict": verdict, "note": note, "wrong_ids": sorted(set(bad)), "must_keep_ids": sorted(set(keep)),
              "updated_at": dt.datetime.now(TZ).isoformat(), "source": "user_review"}
    with lab.lock:
        values = reviews(lab); values[key] = review
        atomic_json(lab.state_dir / "memory-experiment/reviews.json", values)
    return review

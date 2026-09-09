"""Unified, evidence-led memory albums. All inputs stay local and old engines stay intact.

Recall from the full eligible library, not old selected IDs. A subject is not an
identity; a location/time episode is not a confirmed personal trip. Thresholds
are versioned experimental rules, never per-photo overrides or Apple claims.
"""
from __future__ import annotations

import copy
import datetime as dt
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

from backend import dedup, selector
from . import collections, stories
from .collections import classify, prepare_candidates, date_span
from .core import LabError, TZ, atomic_json, bounded, digest, file_hash, read_json
from .ente import latest_result
from .hybrid import content_from_record

VERSION = "unified-memories-v1"
RULES = {"min_photos": 8, "max_photos": 40, "max_albums": 18,
         "temporal_split_size": 80, "event_hours": 12, "event_radius_km": 3,
         "event_context_similarity": .60, "event_visual_similarity": .70,
         "day_similarity": .75, "trip_padding_hours": 6, "trip_radius_km": 30,
         "trip_visual_similarity": .55, "embedding_duplicate_similarity": .985,
         "album_jaccard": .8, "fragment_containment": .8}
TITLES = {"people": "人像时光", "pet": "毛茸茸的日常", "food": "餐桌记忆",
          "scene": "风景与城市", "stage": "舞台时光"}


def settings(raw=None):
    raw = {} if raw is None else raw
    if not isinstance(raw, dict) or set(raw) - {"max_photos", "max_albums"}:
        raise LabError("回忆精选只接受每册照片上限和精选册数上限")
    return {"max_photos": bounded(raw.get("max_photos", RULES["max_photos"]), 8, 60, "每册照片上限", True),
            "max_albums": bounded(raw.get("max_albums", RULES["max_albums"]), 1, 30, "精选册数上限", True)}


def combined_content(lab, record):
    """Logical union AFTER each provider's own threshold, not mixed probabilities."""
    content = copy.deepcopy(content_from_record(lab, record))
    index = read_json(lab.state_dir / "album-features.json", {})
    supports = {}
    for p in lab.features:
        asset = content["assets"][p["id"]]
        obs = index.get("assets", {}).get(p["id"], {})
        vision = classify(obs)[1] if obs.get("sha256") == p["sha256"] and not obs.get("error") else {}
        keys = set(asset["themes"]) | set(vision)
        supports[p["id"]] = {t: (["ente"] if t in asset["themes"] else []) + (["vision"] if t in vision else []) for t in sorted(keys)}
        # Binary relevance only. Raw per-provider scores remain in their caches.
        asset["themes"] = {t: 1. for t in sorted(keys)}
        asset["theme_support"] = supports[p["id"]]
        asset["source"] = "ente-and-vision-qualified-union"
    content["revision"] = digest({"ente": content["revision"], "support": supports,
                                  "vision": file_hash(lab.state_dir / "album-features.json")})
    return content


def dated(p):
    return p.get("taken_at") is not None and p["date_source"] in stories.PRECISE_DATES | {"filename_date"}


def split_period(pool):
    """Only split a large theme when at least two substantial periods remain."""
    bins = defaultdict(list)
    for p in pool:
        bins[stories.day(p).year if dated(p) else None].append(p)
    large = [year for year, group in bins.items() if len(group) >= RULES["min_photos"]]
    if len(pool) >= RULES["temporal_split_size"] and len(large) >= 2:
        return [(year, bins[year]) for year in sorted(large, key=lambda y: -(y or 0))]
    return [("all", pool)]


def proposal(kind, key, title, pool, *, topic=None, period="all", description="", **extra):
    by_id = {p["id"]: p for p in pool}
    return {"id": "memory-" + digest([kind, key])[:16], "kind": kind, "title": title,
            "pool": sorted(by_id.values(), key=lambda p: p["id"]), "topic": topic,
            "period": period, "description": description, "sources": [kind], **extra}


def recurring_proposals(photos, evidence):
    pools = []
    for topic, title in TITLES.items():
        matches = [p for p in photos if topic in p["album_themes"]]
        for period, group in split_period(matches):
            if len(group) >= RULES["min_photos"]:
                pools.append(proposal("theme", [topic, period], title, group, topic=topic, period=period,
                    description="独立达到 Ente 或本机 Vision 内容门槛后进入同一主题，结合时间、多样性和画质选片；人像可含不同人物，宠物也不代表同一只。"))
    cities = defaultdict(list)
    for p in photos:
        city = evidence["cities"].get(p["id"])
        if city and p["id"] in evidence["locations"]:
            cities[city].append(p)
    for city, matches in sorted(cities.items()):
        for period, group in split_period(matches):
            if len(group) >= RULES["min_photos"]:
                pools.append(proposal("place", [city, period], f"在{stories.CITY_LABELS.get(city, city)}的时光", group,
                    period=period, city=city,
                    description="同一实际定位城市的片段汇总；照片充足时按年份区分，小组不再机械拆成年份。它可以包括不同活动，不表示同一次旅行。"))
    return pools


def recalled(seed, photos, evidence, kind, *, base_position=None):
    """Expand only from fixed original anchors; never promote a recalled photo to an anchor."""
    anchors = seed["pool"]
    ids = {p["id"] for p in anchors}
    positions, vectors = evidence["locations"], evidence["vectors"]
    start, end = min(p["taken_at"] for p in anchors), max(p["taken_at"] for p in anchors)
    only_day = any(p["date_source"] == "filename_date" for p in anchors)
    core = list(anchors)
    for p in photos:
        if p["id"] in ids or not dated(p):
            continue
        if kind == "event":
            if stories.day(p) != stories.day(anchors[0]):
                continue
            # Fixed window prevents individually eligible additions from
            # stretching opposite ends into a 24-hour chain.
            if not only_day and abs(p["taken_at"]-(start+end)/2) > RULES["event_hours"]*1800:
                continue
        elif p["date_source"] == "filename_date" or only_day:
            if not start <= p["taken_at"] <= end:
                continue
        elif not start-RULES["trip_padding_hours"]*3600 <= p["taken_at"] <= end+RULES["trip_padding_hours"]*3600:
            continue
        near = sorted(anchors, key=lambda q: abs(p["taken_at"]-q["taken_at"]))[:3]
        located = [q for q in near if q["id"] in positions]
        both_gps = p["id"] in positions and bool(located)
        if both_gps:
            if kind == "trip" and base_position is not None and stories.distance(positions[p["id"]], base_position) < stories.RULES["trip_away_km"]:
                continue  # recall must not undo the original return-to-base split
            radius = RULES["trip_radius_km"] if kind == "trip" else RULES["event_radius_km"]
            if min(stories.distance(positions[p["id"]], positions[q["id"]]) for q in located) > radius:
                continue
            if kind == "trip":
                core.append(p); continue  # explicit time+location support, mixed subjects are legitimate in a journey
        # Missing GPS never enters a trip on time alone, nor with filename-day precision.
        if kind == "trip" and (not start <= p["taken_at"] <= end or p["date_source"] not in stories.PRECISE_DATES):
            continue
        similarities = sorted((stories.cosine(vectors[p["id"]], vectors[q["id"]]) for q in anchors), reverse=True)
        threshold = RULES["trip_visual_similarity"] if kind == "trip" else RULES["day_similarity"] if only_day or p["date_source"] == "filename_date" else RULES["event_context_similarity"] if both_gps else RULES["event_visual_similarity"]
        if len(similarities) >= 2 and similarities[1] >= threshold:
            core.append(p)
    return core


def episode_proposals(photos, evidence, source_groups):
    people, memberships, _ = stories.person_pools(photos, evidence, source_groups)
    trips, _ = stories.trip_pools(photos, evidence)
    base = stories.infer_base(photos, evidence["locations"])
    events, _ = stories.event_pools(photos, evidence, memberships)
    proposals = []
    for group in people:
        # Never trade identity precision for a target count. Small people groups
        # contribute recognition evidence to broad portrait memories instead.
        proposals.append(proposal("person", group["id"], group["title"], group["pool"],
            faces=group["faces"], evidence=group["evidence"], description=group["description"], anchor_count=len(group["pool"])))
    for group in trips:
        pool = recalled(group, photos, evidence, "trip", base_position=base["position"] if base else None)
        cities = Counter(evidence["cities"][p["id"]] for p in group["pool"] if p["id"] in evidence["cities"])
        place = "与".join(stories.CITY_LABELS.get(city, city) for city, _ in cities.most_common(2))
        proposals.append(proposal("trip", group["id"], (place + "之旅") if place else "远行片段", pool,
            anchor_count=len(group["pool"]), evidence={"anchor_evidence":group["evidence"],"trip_confirmed":False},
            description="从原始出行段出发补入时间与地点相符的照片；无定位照片须有精确时间及至少两张原始照片的内容支持。出行是自动候选，不确认是谁的行程。"))
    for group in events:
        pool = recalled(group, photos, evidence, "event")
        counts = Counter(t for p in pool for t in p["album_themes"])
        topic, count = counts.most_common(1)[0] if counts else (None, 0)
        if count < len(pool)*.5:
            continue  # no clear subject: do not promote a loose date bucket
        titles = {"people":"镜头里的身影", "pet":"与毛茸茸相遇", "food":"餐桌上的片段", "scene":"此刻的风景", "stage":"舞台瞬间"}
        proposals.append(proposal("event", group["id"], titles[topic], pool, topic=topic,
            anchor_count=len(group["pool"]), evidence={"anchor_evidence":group["evidence"],"event_confirmed":False,
                "date_precision":"day" if any(p["date_source"]=="filename_date" for p in pool) else "timestamp"},
            description="以有内容依据的小片段召回同日相关照片，不把同一天所有照片装入一册。只有日级时间的相册仅代表同日相似场景，不能确认是同一活动。"))
    return proposals


def curate(group, evidence, config, options):
    pool = group["pool"]
    candidates, _ = dedup.deduplicate(pool, config["hash_distance"], clip_distance_limit=config["clip_distance"])
    policy = {"name":"unified-memories", "weights":config["weights"]}
    ranked = selector.rank_photos(candidates, model={"weights":{},"bias":.5}, policy=policy)
    # Additional near-copy veto in a separate, complete MobileCLIP-S2 space.
    unique = []
    for p in ranked:
        if not any(stories.cosine(evidence["vectors"][p["id"]], evidence["vectors"][q["id"]]) >= RULES["embedding_duplicate_similarity"] for q in unique):
            unique.append(p)
    chosen, remaining = [], list(unique)
    similarities = {}
    def similarity(a, b):
        key = (a["id"], b["id"])
        if key not in similarities:
            similarities[key] = stories.cosine(evidence["vectors"][key[0]], evidence["vectors"][key[1]])
        return similarities[key]
    while remaining and len(chosen) < options["max_photos"]:
        def utility(p):
            similar = max((similarity(p,q) for q in chosen), default=0)
            same_date = sum(dated(p) and dated(q) and stories.day(p)==stories.day(q) for q in chosen)
            return (p["final_score"] - .5*config["semantic_diversity"]*similar - .1*config["event_diversity"]*min(same_date,5), p["id"])
        best = max(remaining, key=utility)
        chosen.append(best); remaining.remove(best)
    return chosen, len(unique), len(pool)-len(unique)


def choose_albums(proposals, evidence, config, options):
    candidates, suppressed = [], []
    for group in proposals:
        chosen, available, duplicate_count = curate(group, evidence, config, options)
        if len(chosen) < RULES["min_photos"]:
            suppressed.append({"id":group["id"],"reason":"too_small", "available":available}); continue
        candidates.append({**group, "selected":chosen, "available_count":available, "duplicate_count":duplicate_count,
                           "absorbed":[]})
    # Resolve children under richer parents before choosing the featured wall.
    removed = set()
    priorities = {"trip":4, "person":3, "place":2, "theme":2, "event":1}
    candidates.sort(key=lambda g:(-priorities[g["kind"]],-len(g["pool"]),g["id"]))
    for i, parent in enumerate(candidates):
        if parent["id"] in removed: continue
        parent_ids = {p["id"] for p in parent["pool"]}
        for child in candidates[i+1:]:
            if child["id"] in removed: continue
            child_ids = {p["id"] for p in child["pool"]}
            overlap = len(parent_ids & child_ids)
            same_story = (child["kind"] == "event" and parent["kind"] in {"trip","place"}) or (child["kind"] == "place" and parent["kind"] == "trip") or (child["topic"] and child["topic"] == parent["topic"])
            if overlap/len(parent_ids|child_ids) > RULES["album_jaccard"] or (same_story and overlap/len(child_ids) >= RULES["fragment_containment"] and len(parent_ids) >= len(child_ids)):
                parent["absorbed"].append({"id":child["id"],"kind":child["kind"],"title":child["title"],"count":len(child_ids),"shared":overlap})
                parent["sources"] = sorted(set(parent["sources"]) | set(child["sources"]))
                removed.add(child["id"])
                suppressed.append({"id":child["id"],"reason":"covered_fragment","parent":parent["id"]})
    remaining = [g for g in candidates if g["id"] not in removed]
    selected, used, kinds = [], set(), Counter()
    while remaining and len(selected) < options["max_albums"]:
        def value(g):
            ids = {p["id"] for p in g["selected"]}
            mean = sum(p["final_score"] for p in g["selected"])/len(ids)
            return (mean + .25*math.log1p(len(ids))/math.log(61) + .35*len(ids-used)/len(ids) - .06*kinds[g["kind"]], g["id"])
        best = max(remaining, key=value); remaining.remove(best)
        selected.append(best); used.update(p["id"] for p in best["selected"]); kinds[best["kind"]]+=1
    suppressed.extend({"id":g["id"],"reason":"wall_limit"} for g in remaining)
    return selected, suppressed


def build_memories(lab, raw, *, album_settings=None, record=None, evidence=None):
    start = time.perf_counter()
    options = settings(album_settings)
    record = latest_result(lab) if record is None else record
    if not record: raise LabError("先完成这批照片的本地识别；不使用模拟回忆填充")
    content = combined_content(lab, record)
    config, photos, excluded, dates, _, vision_revision = prepare_candidates(lab, raw, content=content)
    evidence = stories.load_evidence(lab, record) if evidence is None else evidence
    pools = recurring_proposals(photos, evidence) + episode_proposals(photos, evidence, record["result"]["ente_diagnostics"]["person_groups"])
    groups, suppressed = choose_albums(pools, evidence, config, options)
    albums, public, used_covers = [], {}, set()
    for group in groups:
        ordered = sorted(group["selected"], key=lambda p:(p["taken_at"] if dated(p) else float("inf"),p["id"]))
        cover = max(ordered, key=lambda p:(.6*p["aesthetic"]+.3*p["quality"]-.4*(p["id"] in used_covers),p["id"]))
        used_covers.add(cover["id"])
        known = [p for p in ordered if dated(p)]
        unknown = len(ordered)-len(known)
        subtitle = date_span(known) if known else "拍摄日期待补"
        if known and unknown: subtitle += f" · 另 {unknown} 张日期待补"
        photo_reasons = {p["id"]:{"theme_support":p["content_evidence"]["theme_support"],"date_source":p["date_source"],
                                      "has_location":p["id"] in evidence["locations"]} for p in ordered}
        a = {"id":group["id"],"kind":group["kind"],"title":group["title"],"subtitle":subtitle,
             "cover":cover["id"],"photo_ids":[p["id"] for p in ordered], "candidate_count":len(group["pool"]),
             "available_count":group["available_count"],"duplicate_count":group["duplicate_count"],
             "description":group["description"],"sources":group["sources"],"absorbed":group["absorbed"],
             "anchor_count":group.get("anchor_count"),"topic":group["topic"],"period":group["period"],
             "evidence":group.get("evidence",{}),"photo_reasons":photo_reasons,
             "selected_dates":len({stories.day(p) for p in known}),"unknown_dates":unknown}
        if "faces" in group: a["faces"] = {p["id"]:group["faces"][p["id"]] for p in ordered}
        albums.append(a)
        for p in ordered:
            public[p["id"]] = {**lab.public_photo(p),"date_source":p["date_source"],"face_count":p["face_count"]}
    provenance = {"dataset_id":lab.dataset_id,"ente_snapshot_id":record["id"],"ente_commit":record["result"]["provenance"]["commit"],
        "rules":dict(RULES),"models":evidence["models"],"evidence_revision":evidence["revision"],"content_revision":content["revision"],
        "feature_revision":lab.feature_revision,"vision_revision":vision_revision,"code_revision":file_hash(Path(__file__)),
        "grouping_revision":file_hash(Path(stories.__file__)),"selection_revision":lab.engine_revision,
        "eligibility_revision":file_hash(Path(collections.__file__)),
        "note":"本项目统一成册，非 Apple 或 Ente 原版回忆。主题可包含不同人物／宠物；旅行与活动是自动候选。照片和向量仅本地处理，不推断身份关系或居住地。",
        "recognition":"Ente and Vision independently thresholded; logical union, not averaged confidence",
        "dedup":"original project rules + separate MobileCLIP-S2 near-copy check; no mixed embedding space"}
    result_id = digest({"provenance":provenance,"config":config,"album_settings":options})[:24]
    return {"id":result_id,"engine":"photo-wall-memories","policy_version":VERSION,"title":"回忆精选",
            "config":config,"album_settings":options,"albums":albums,"photos":list(public.values()),"photo_count":len(public),
            "eligible_count":len(photos),"excluded":excluded,"provenance":provenance,"elapsed_ms":round((time.perf_counter()-start)*1000,1),
            "diagnostics":{"input_count":len(lab.features),"date_sources":dates,"proposal_count":len(pools),
                           "album_counts":dict(Counter(a["kind"] for a in albums)),"suppressed":suppressed,
                           "suppressed_counts":dict(Counter(g["reason"] for g in suppressed)),
                           "theme_candidates":dict(Counter(t for p in photos for t in p["album_themes"]))}}


def save_memories(lab, albums, name="回忆精选 · 统一成册"):
    if albums.get("engine") != "photo-wall-memories" or albums["provenance"]["dataset_id"] != lab.dataset_id:
        raise LabError("不能将其他引擎或数据集保存为回忆精选")
    ids = list(dict.fromkeys(i for a in albums["albums"] for i in a["photo_ids"]))
    result = {"id":albums["id"],"engine":"photo-wall-memories","engine_label":"回忆精选 · 统一成册",
        "config":albums["config"],"album_settings":albums["album_settings"],"selected_ids":ids,"photos":albums["photos"],
        "events":albums["albums"],"counts":{"selected":len(ids)},"collection_snapshot":albums,"signature":{"dataset":lab.dataset_id},
        "provenance":albums["provenance"],"elapsed_ms":albums["elapsed_ms"],"selection_mode":"统一主题相册成员并集",
        "warnings":[albums["provenance"]["note"]],"created_at":dt.datetime.now(TZ).isoformat()}
    record = lab.save_run(result,name)
    atomic_json(lab.state_dir / "memories/latest.json",{"dataset_id":lab.dataset_id,"run_id":record["id"]})
    return record


def latest_memories(lab):
    value = read_json(lab.state_dir / "memories/latest.json",{})
    if value.get("dataset_id") != lab.dataset_id: return None
    record = lab.get_run(value.get("run_id",""))
    if record["result"].get("engine") != "photo-wall-memories": raise LabError("回忆精选快照引擎不匹配")
    return record

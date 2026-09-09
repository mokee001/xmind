"""Evidence-constrained person, trip and event candidates; local, not Apple Memories.

Identity/episode labels are hypotheses. No filename-content inference, no model
fallback, and no mixing Ente image embeddings with the project's dedup vectors.
"""
from __future__ import annotations

import datetime as dt
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

from backend import dedup, selector
from .collections import date_span, prepare_candidates, sample_date
from .core import LabError, TZ, atomic_json, digest, file_hash, read_json
from .ente import latest_result
from .hybrid import content_from_record

VERSION = "evidence-stories-v3-subject-timeline"
RULES = {
    "minimum_photos": 3, "maximum_photos": 12, "maximum_albums_per_kind": 10,
    # Pinned Ente quality-score threshold; scores are not calibrated probabilities.
    "face_score_min": .8, "face_blur_min": 50, "face_similarity_min": .76, "face_area_min": .004,
    "event_visual_min": .62, "event_context_visual_min": .45, "day_visual_min": .75,
    "event_max_hours": 6, "event_gap_hours": 4, "event_radius_km": 1,
    "base_radius_km": 35, "base_min_days": 3, "base_min_day_share": .35,
    "trip_away_km": 50, "trip_gap_hours": 72, "trip_max_days": 14, "trip_min_hours": 4,
    "trip_speed_kmh": 1200,
    "reuse_penalty": .35, "maximum_photo_uses": 2, "minimum_fresh_fraction": .6,
}
PRECISE_DATES = {"exif_original_offset", "exif_original_assumed_utc8", "filename_datetime"}
KINDS = {"person": "人物", "place": "地点时光", "theme": "主题时光", "trip": "旅程", "event": "活动"}
CITY_LABELS = {"Shanghai": "上海", "Beijing": "北京", "Nanjing": "南京", "Changchun": "长春",
               "London": "伦敦", "Seville": "塞维利亚", "Granada": "格拉纳达", "Jeju City": "济州市", "Zhoushan": "舟山"}


def temporal_pools(photos, evidence):
    """Recurring subjects/places over a year, distinct from a single-day event.

    Public observations support content categories, not pet identities or personal
    relationships. Unknown dates are kept in an explicitly undated subject pool.
    """
    buckets = defaultdict(list)
    titles = {"pet": "毛茸茸的日常", "stage": "舞台时光", "food": "餐桌记忆"}
    for p in photos:
        dated = bool(p.get("taken_at")) and p["date_source"] in PRECISE_DATES | {"filename_date"}
        year = day(p).year if dated else None
        for theme in titles:
            if theme in p.get("album_themes", {}):
                buckets[("theme", theme, year)].append(p)
        city = evidence["cities"].get(p["id"])
        if dated and city and p["id"] in evidence["locations"]:
            buckets[("place", city, year)].append(p)
    pools = []
    for (kind, topic, year), group in buckets.items():
        days = len({day(p) for p in group if p.get("taken_at") and year is not None})
        if len(group) < RULES["minimum_photos"] or (year is not None and days < 2):
            continue
        pools.append({"id": kind + "-" + digest([topic, year, sorted(p["id"] for p in group)])[:16],
            "kind": kind, "pool": group,
            "title": (f"在{CITY_LABELS.get(topic, topic)}的时光" if kind == "place" else titles[topic]) + (f" · {year}" if year else " · 日期待补"),
            "evidence": {"topic": topic, "year": year, "distinct_dates": days,
                         "date_precision": "year" if year else "unknown", "identity_confirmed": False},
            "description": ("按真实定位城市和年份汇总不同日期的片段，不表示同一次旅行。" if kind == "place" else
                "同一内容主题按年份串联不同日期；宠物主题可以包含不同宠物，未做宠物身份识别。未知日期单列，不冒充某年回忆。")})
    pools.sort(key=lambda g: (-(g["evidence"]["year"] or 0), -len(g["pool"]), g["id"]))
    return pools


def unit(vector, dimensions=None):
    if not isinstance(vector, list) or not vector or (dimensions and len(vector) != dimensions):
        raise LabError("识别向量维数缺失或不一致")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vector):
        raise LabError("识别向量包含无效数值")
    norm = math.sqrt(sum(v*v for v in vector))
    if norm <= 1e-8:
        raise LabError("识别向量为空")
    return tuple(v/norm for v in vector)


def cosine(a, b):
    if len(a) != len(b):
        raise LabError("不同模型向量不能直接比较")
    return max(-1., min(1., sum(x*y for x, y in zip(a, b))))


def distance(a, b):
    """Great-circle distance in km. Coordinates never leave the local process."""
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def day(photo):
    return dt.datetime.fromtimestamp(photo["taken_at"], TZ).date()


def load_evidence(lab, record):
    ml_path, input_path = lab.state_dir / "ente/ml-index.json", lab.state_dir / "ente/memories-input.json"
    cache, source = read_json(ml_path, {}), read_json(input_path, {})
    identity = cache.get("identity", {})
    if identity.get("dataset") != lab.dataset_id or identity.get("commit") != record["result"]["provenance"]["commit"]:
        raise LabError("Ente 向量缓存与本批实跑结果不匹配")
    runtime = read_json(Path(__file__).resolve().parents[1] / "outputs/selection-lab/ente/runtime.json", {})
    if identity.get("models") != runtime.get("model_sha256") or not identity.get("models"):
        raise LabError("Ente 向量模型摘要不匹配，不跨模型聚合")
    items = source.get("photos", [])
    by_hash = {p["sha256"]: p for p in items}
    if len(by_hash) != len(items) or set(by_hash) != {p["sha256"] for p in lab.features}:
        raise LabError("Ente 位置/日期输入不是当前完整候选集")
    if set(cache.get("photos", {})) != set(lab.assets):
        raise LabError("Ente 向量未覆盖当前全部候选，不填补模拟结果")
    vectors, locations, cities, faces = {}, {}, {}, {}
    for photo in lab.features:
        key = photo["id"]
        item, cached = by_hash[photo["sha256"]], cache["photos"][key]
        if item.get("embedding") != cached.get("embedding") or item.get("faces") != cached.get("faces"):
            raise LabError("Ente 输入与识别缓存不同步，请先重跑识别适配")
        timestamp, date_source = sample_date(photo)
        if item.get("creation_time") != (int(timestamp * 1_000_000) if timestamp is not None else None) or item.get("date_source") != date_source:
            raise LabError("日期来源已变化，拒绝沿用旧时空分组")
        vectors[key] = unit(cached.get("embedding"), 512)
        if item.get("latitude") is not None or item.get("longitude") is not None:
            lat, lon = item.get("latitude"), item.get("longitude")
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in [lat, lon]) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                raise LabError("GPS 数据无效")
            locations[key] = (lat, lon)
            if (item.get("city") or {}).get("name"):
                cities[key] = item["city"]["name"]
        for face in cached.get("faces", []):
            face_id = face["face_id"]
            if face_id in faces:
                raise LabError("Ente 人脸 ID 重复")
            faces[face_id] = {**face, "photo_id": key, "sha256": photo["sha256"], "vector": unit(face.get("embedding"))}
    for face in record["result"]["ente_diagnostics"]["detected_faces"]:
        cached = faces.get(face["face_id"])
        if not cached or any(cached.get(k) != face[k] for k in ["sha256", "box", "score"]):
            raise LabError("人脸簇与检测向量的映射已变化")
    if len(faces) != record["result"]["ente_diagnostics"]["face_count"]:
        raise LabError("人脸向量覆盖不完整")
    return {"vectors": vectors, "locations": locations, "cities": cities, "faces": faces,
            "revision": digest({"ml": file_hash(ml_path), "input": file_hash(input_path)}), "models": identity["models"]}


def person_pools(photos, evidence, groups):
    eligible = {p["id"]: p for p in photos}
    pools, memberships, stats = [], {}, Counter()
    for group in sorted(groups, key=lambda g: g["cluster_id"]):
        usable = []
        for ref in group["faces"]:
            f = evidence["faces"][ref["face_id"]]
            if f["photo_id"] not in eligible:
                continue
            b = f["box"]
            if (f["score"] < RULES["face_score_min"] or f["blur"] < RULES["face_blur_min"] or
                    (b[2]-b[0])*(b[3]-b[1]) < RULES["face_area_min"]):
                stats["low_quality_faces"] += 1
                continue
            usable.append(f)
        # Complete-link refinement: no transitive A~B~C identity chaining, and
        # two distinct detections in one photo may not be the same person here.
        buckets = []
        for face in sorted(usable, key=lambda f: (-f["score"], f["face_id"])):
            target = next((b for b in buckets if all(face["photo_id"] != f["photo_id"] and
                cosine(face["vector"], f["vector"]) >= RULES["face_similarity_min"] for f in b)), None)
            if target is None:
                buckets.append([face])
            else:
                target.append(face)
        for bucket in buckets:
            if len(bucket) < RULES["minimum_photos"]:
                stats["small_face_groups"] += 1
                continue
            identity = "person-" + digest(sorted(f["face_id"] for f in bucket))[:16]
            for face in bucket:
                memberships.setdefault(face["photo_id"], set()).add(identity)
            pool = [eligible[f["photo_id"]] for f in bucket]
            boxes = {f["photo_id"]: [{"face_id": f["face_id"], "box": f["box"], "score": f["score"]}] for f in bucket}
            pair_min = min(cosine(a["vector"], b["vector"]) for i, a in enumerate(bucket) for b in bucket[i+1:])
            pools.append({"id": identity, "kind": "person", "pool": pool, "faces": boxes,
                "evidence": {"source_cluster": group["cluster_id"], "face_similarity_min": round(pair_min, 4),
                             "identity_confirmed": False, "unique_photos": len(pool)},
                "description": "Ente 人脸簇内再次要求每对人脸相似，且同张照片不合并两张脸。绿色框标出目标人物；自动分组尚未确认身份，不推断姓名或关系。"})
    pools.sort(key=lambda g: (-len(g["pool"]), g["id"]))
    for i, group in enumerate(pools, 1):
        group["title"] = f"人物 {i} · 待确认"
    return pools, memberships, dict(stats)


def event_compatible(a, b, evidence, memberships):
    if not a.get("taken_at") or not b.get("taken_at") or day(a) != day(b):
        return False
    if a["date_source"] not in PRECISE_DATES | {"filename_date"} or b["date_source"] not in PRECISE_DATES | {"filename_date"}:
        return False
    positions = evidence["locations"]
    both_gps = a["id"] in positions and b["id"] in positions
    if both_gps and distance(positions[a["id"]], positions[b["id"]]) > RULES["event_radius_km"]:
        return False
    sim = cosine(evidence["vectors"][a["id"]], evidence["vectors"][b["id"]])
    if "filename_date" in {a["date_source"], b["date_source"]}:
        return sim >= RULES["day_visual_min"]
    if abs(a["taken_at"] - b["taken_at"]) > RULES["event_gap_hours"] * 3600:
        return False
    shared_person = bool(memberships.get(a["id"], set()) & memberships.get(b["id"], set()))
    threshold = RULES["event_context_visual_min"] if both_gps or shared_person else RULES["event_visual_min"]
    return sim >= threshold


def event_pools(photos, evidence, memberships):
    dated = sorted((p for p in photos if p.get("taken_at") and p["date_source"] in PRECISE_DATES | {"filename_date"}),
                   key=lambda p: (p["taken_at"], p["id"]))
    buckets = []
    for p in dated:
        compatible = [group for group in buckets if (p["taken_at"]-group[0]["taken_at"]) <= RULES["event_max_hours"]*3600
                      and all(event_compatible(p, other, evidence, memberships) for other in group)]
        if compatible:
            chosen = max(compatible, key=lambda group: sum(cosine(evidence["vectors"][p["id"]], evidence["vectors"][x["id"]]) for x in group)/len(group))
            chosen.append(p)
        else:
            buckets.append([p])
    pools = []
    for group in buckets:
        if len(group) < RULES["minimum_photos"]:
            continue
        only_day = any(p["date_source"] == "filename_date" for p in group)
        sims = [cosine(evidence["vectors"][a["id"]], evidence["vectors"][b["id"]]) for i,a in enumerate(group) for b in group[i+1:]]
        date = day(group[0])
        pools.append({"id": "event-" + digest(sorted(p["id"] for p in group))[:16], "kind": "event", "pool": group,
            "title": f"{date.year}.{date.month}.{date.day} · " + ("相似场景" if only_day else "活动片段"),
            "evidence": {"date_precision": "day" if only_day else "timestamp", "visual_similarity_min": round(min(sims), 4),
                         "gps_photos": sum(p["id"] in evidence["locations"] for p in group),
                         "span_hours": None if only_day else round((group[-1]["taken_at"]-group[0]["taken_at"])/3600, 2),
                         "event_confirmed": False},
            "description": ("文件名仅精确到日：这里只代表同日相似场景，不确认是同一次活动。" if only_day else
                "拍摄时间接近，并要求每对照片内容相似；同地点或重复人物提供辅助证据，存在明显地点冲突则拆开。是活动片段候选，不保证完整事件。")})
    pools.sort(key=lambda g: (-len(g["pool"]), -g["pool"][0]["taken_at"], g["id"]))
    return pools, {"dated_inputs": len(dated), "small_fragments": sum(len(g) < RULES["minimum_photos"] for g in buckets)}


def infer_base(photos, locations):
    valid = [p for p in photos if p.get("taken_at") and p["id"] in locations and
             p["date_source"] in PRECISE_DATES | {"filename_date"}]
    if not valid:
        return None
    # A robust observed anchor, not a personal home address. Never export coordinates.
    candidates = []
    total_days = len({day(p) for p in valid})
    for anchor in valid:
        near = [p for p in valid if distance(locations[p["id"]], locations[anchor["id"]]) <= RULES["base_radius_km"]]
        days = len({day(p) for p in near})
        candidates.append((days, len(near), anchor["id"], near))
    days, count, anchor, near = max(candidates, key=lambda x: (x[0], x[1], x[2]))
    if days < RULES["base_min_days"] or days / total_days < RULES["base_min_day_share"]:
        return None
    return {"position": locations[anchor], "photos": near, "days": days, "total_days": total_days}


def trip_pools(photos, evidence):
    locations = evidence["locations"]
    base = infer_base(photos, locations)
    valid = sorted((p for p in photos if p.get("taken_at") and p["id"] in locations and
                    p["date_source"] in PRECISE_DATES | {"filename_date"}), key=lambda p: (p["taken_at"],p["id"]))
    if base is None:
        return [], {"located_dated_inputs": len(valid), "base_found": False, "reason": "无法建立有足够日期支持的主要拍摄区域，不将陌生城市直接当作旅行"}
    episodes, current = [], []
    def finish():
        nonlocal current
        if current:
            episodes.append(current)
        current = []
    for p in valid:
        if distance(locations[p["id"]], base["position"]) < RULES["trip_away_km"]:
            finish(); continue
        if current:
            elapsed = p["taken_at"] - current[-1]["taken_at"]
            jump = distance(locations[p["id"]], locations[current[-1]["id"]])
            precise = p["date_source"] in PRECISE_DATES and current[-1]["date_source"] in PRECISE_DATES
            impossible_jump = (jump/max(elapsed/3600, 1/60) > RULES["trip_speed_kmh"]) if precise else (elapsed==0 and jump>150)
            if elapsed > RULES["trip_gap_hours"]*3600 or p["taken_at"]-current[0]["taken_at"] > RULES["trip_max_days"]*86400 or impossible_jump:
                finish()
        current.append(p)
    finish()
    pools = []
    for group in episodes:
        if len(group) < RULES["minimum_photos"] or (group[-1]["taken_at"]-group[0]["taken_at"]) < RULES["trip_min_hours"]*3600:
            continue
        cities = Counter(evidence["cities"][p["id"]] for p in group if p["id"] in evidence["cities"])
        place = " / ".join(name for name, _ in cities.most_common(2)) or "异地"
        pools.append({"id": "trip-" + digest(sorted(p["id"] for p in group))[:16], "kind": "trip", "pool": group,
            "title": place + " · 出行候选", "evidence": {"gps_photos": len(group),
                "distinct_dates": len({day(p) for p in group}), "span_hours": round((group[-1]["taken_at"]-group[0]["taken_at"])/3600, 2),
                "minimum_away_km": round(min(distance(locations[p["id"]], base["position"]) for p in group)),
                "base_support_days": base["days"], "trip_confirmed": False},
            "description": "基于 EXIF 定位及可用日期，离开样本主要拍摄区域后按时间连续性归组；返回该区域、长时间空档或不合理地点跳转时切断。只是出行候选，不确认是谁的旅行，未将无定位照片补入。"})
    pools.sort(key=lambda g: (-g["pool"][0]["taken_at"],g["id"]))
    base_names = Counter(evidence["cities"][p["id"]] for p in base["photos"] if p["id"] in evidence["cities"])
    return pools, {"located_dated_inputs": len(valid), "base_found": True, "base_region": base_names.most_common(1)[0][0] if base_names else "主要拍摄区域",
                   "base_support_days": base["days"], "detected_episodes": len(episodes),
                   "small_or_short_episodes": len(episodes)-len(pools)}


def select_timeline(candidates, group, config, uses):
    """Keep a subject's time span, then trade score against repetition.

    Identity pools are fixed upstream. No new face memberships are inferred here.
    """
    policy = {"name": VERSION, "weights": config["weights"]}
    ranked = selector.rank_photos(candidates, model={"weights": {}, "bias": .5}, policy=policy)
    remaining = [p for p in ranked if group["kind"] == "person" or uses[p["id"]] < RULES["maximum_photo_uses"]]
    limit = min(RULES["maximum_photos"], config["count"], len(remaining))
    chosen = []
    def utility(p):
        same_day = sum(bool(p.get("taken_at") and q.get("taken_at")) and day(p) == day(q) for q in chosen)
        same_theme = max((len(set(p["album_themes"]) & set(q["album_themes"])) /
                          max(1, len(set(p["album_themes"]) | set(q["album_themes"]))) for q in chosen), default=0)
        return (p["final_score"] - RULES["reuse_penalty"] * uses[p["id"]]
                - .12 * config["event_diversity"] * same_day
                - .08 * config["semantic_diversity"] * same_theme, p["id"])
    # A cross-time story keeps representatives of its first and last day.
    dated = [p for p in remaining if p.get("taken_at")]
    if group["kind"] != "event" and limit >= 3 and len({day(p) for p in dated}) >= 2:
        for boundary in (min(day(p) for p in dated), max(day(p) for p in dated)):
            best = max((p for p in remaining if p.get("taken_at") and day(p) == boundary), key=utility)
            chosen.append(best); remaining.remove(best)
    while remaining and len(chosen) < limit:
        best = max(remaining, key=utility)
        chosen.append(best); remaining.remove(best)
    return chosen


def assemble(lab, pools, config):
    albums, public, skipped = [], {}, Counter()
    uses, covers = Counter(), set()
    # Specific stories get first choice; broad location summaries use alternatives.
    priority = {"person": 0, "trip": 1, "theme": 2, "place": 3, "event": 4}
    for group in sorted(pools, key=lambda g: priority[g["kind"]]):
        if sum(a["kind"] == group["kind"] for a in albums) >= RULES["maximum_albums_per_kind"]:
            skipped["category_limit"] += 1; continue
        candidates, _ = dedup.deduplicate(group["pool"], config["hash_distance"], clip_distance_limit=config["clip_distance"])
        chosen = select_timeline(candidates, group, config, uses)
        if group["kind"] in {"place", "theme"} and group["evidence"].get("year") and chosen:
            selected_days = {day(p) for p in chosen}
            if len(selected_days) < 2:
                alternatives = [p for p in candidates if day(p) not in selected_days]
                if not alternatives:
                    skipped["no_date_diversity_after_dedup"] += 1; continue
                skipped["no_date_diversity_after_reuse"] += 1; continue
        if len(chosen) < RULES["minimum_photos"]:
            skipped["too_small_after_selection"] += 1; continue
        ids = {p["id"] for p in chosen}
        fresh_count = sum(uses[i] == 0 for i in ids)
        if group["kind"] != "person" and fresh_count < math.ceil(len(ids) * RULES["minimum_fresh_fraction"]):
            skipped["already_covered"] += 1; continue
        if any(a["kind"] == group["kind"] and len(ids & set(a["photo_ids"]))/len(ids | set(a["photo_ids"])) > .85 for a in albums):
            skipped["overlapping_album"] += 1; continue
        # Representative face similarity / event cohesion are in group construction,
        # not substituted for the project's quality and aesthetic scores.
        cover = max(chosen, key=lambda p: (p["id"] not in covers, .5*p["aesthetic"]+.25*p["quality"]+.25*max(p["album_themes"].values(),default=0),p["id"]))
        ordered = sorted(chosen,key=lambda p:(p.get("taken_at") or float("inf"),p["filename"]))
        album = {k:v for k,v in group.items() if k not in {"pool","faces"}}
        album.update(cover=cover["id"], photo_ids=[p["id"] for p in ordered], subtitle=date_span(ordered), candidate_count=len(group["pool"]))
        album["selection_evidence"] = {"fresh_photos": fresh_count, "reused_photos": len(ids)-fresh_count,
            "selected_dates": len({day(p) for p in ordered if p.get("taken_at")}),
            "candidate_dates": len({day(p) for p in group["pool"] if p.get("taken_at")})}
        if group["kind"] == "event":
            topics = Counter(t for p in chosen for t in p["album_themes"])
            topic = next((t for t in ["stage", "pet", "food", "scene", "people"] if topics[t] >= len(chosen)*.6), None)
            if topic:
                album["title"] = {"people":"镜头里的身影", "pet":"与毛茸茸相遇", "food":"餐桌上的片段", "scene":"此刻的风景", "stage":"舞台瞬间"}[topic]
        if group["kind"] == "trip":
            place = group["title"].removesuffix(" · 出行候选")
            album["title"] = (" / ".join(CITY_LABELS.get(s, s) for s in place.split(" / ")) + " · 旅途时光") if place != "异地" else "远行片段"
        if "faces" in group:
            album["faces"] = {p["id"]:group["faces"][p["id"]] for p in ordered}
        albums.append(album)
        uses.update(ids); covers.add(cover["id"])
        for p in ordered:
            public[p["id"]] = {**lab.public_photo(p),"date_source":p["date_source"],"face_count":p["face_count"],"content_evidence":p["content_evidence"]}
    return albums, list(public.values()), dict(skipped)


def build_stories(lab, raw, *, record=None, evidence=None):
    start = time.perf_counter()
    record = latest_result(lab) if record is None else record
    if not record:
        raise LabError("尚无本批 Ente 完整识别结果，不能生成新聚合")
    content = content_from_record(lab, record)
    config, photos, excluded, dates, _, vision_revision = prepare_candidates(lab, raw, content=content)
    evidence = load_evidence(lab, record) if evidence is None else evidence
    persons, memberships, person_stats = person_pools(photos, evidence, record["result"]["ente_diagnostics"]["person_groups"])
    trips, trip_stats = trip_pools(photos, evidence)
    events, event_stats = event_pools(photos, evidence, memberships)
    recurring = temporal_pools(photos, evidence)
    albums, public, selection_stats = assemble(lab, persons+recurring+trips+events, config)
    appearances = Counter(i for a in albums for i in a["photo_ids"])
    selection_stats.update(repeated_placements=sum(n-1 for n in appearances.values()),
                           repeated_photos=sum(n>1 for n in appearances.values()))
    provenance = {"dataset_id":lab.dataset_id,"ente_snapshot_id":record["id"],"ente_commit":record["result"]["provenance"]["commit"],
        "rules":dict(RULES),"models":evidence["models"],"evidence_revision":evidence["revision"],"feature_revision":lab.feature_revision,"content_revision":content["revision"],
        "vision_revision":vision_revision,"code_revision":file_hash(Path(__file__)),"selection_revision":lab.engine_revision,
        "eligibility_revision":file_hash(Path(__file__).with_name("collections.py")),
        "filter_note":"shared prepare_candidates; same exclusions as hybrid", "grouping":"project rules over Ente embeddings and EXIF, not Apple or Ente original Memories",
        "note":"人物、出行和活动均为自动候选，尚未经用户确认。日期精度及缺失证据被保留；不推断姓名、关系或居住地址。"}
    return {"id":digest({"provenance":provenance,"config":config})[:24], "engine":"photo-wall-stories", "policy_version":VERSION,
        "title":"人物与主题时光", "config":config, "albums":albums,"photos":public,"photo_count":len(public),
        "eligible_count":len(photos),"excluded":excluded,"provenance":provenance,"elapsed_ms":round((time.perf_counter()-start)*1000,1),
        "diagnostics":{"input_count":len(lab.features),"date_sources":dates,"people":person_stats,"trips":trip_stats,"events":event_stats,
            "selection":selection_stats,"album_counts":{k:sum(a["kind"]==k for a in albums) for k in KINDS},
            "pool_counts":{"person":len(persons),"trip":len(trips),"event":len(events),
                           "place":sum(g["kind"]=="place" for g in recurring),"theme":sum(g["kind"]=="theme" for g in recurring)}}}


def save_stories(lab, albums, name="人物·旅程·活动 · 新聚合"):
    if albums.get("engine") != "photo-wall-stories" or albums["provenance"]["dataset_id"] != lab.dataset_id:
        raise LabError("不能将其他结果保存为新聚合")
    ids = list(dict.fromkeys(i for a in albums["albums"] for i in a["photo_ids"]))
    result = {"id":albums["id"],"engine":"photo-wall-stories","engine_label":"人物·旅程·活动", "config":albums["config"],
        "selected_ids":ids,"photos":albums["photos"],"events":albums["albums"],"counts":{"selected":len(ids)},"collection_snapshot":albums,
        "signature":{"dataset":lab.dataset_id},"provenance":albums["provenance"],"elapsed_ms":albums["elapsed_ms"],
        "selection_mode":"三类独立聚合的成员并集","warnings":[albums["provenance"]["note"]],"created_at":dt.datetime.now(TZ).isoformat()}
    with lab.lock:
        old = latest_stories(lab)
        pointer = read_json(lab.state_dir / "stories/latest.json", {})
        previous = (old["id"] if old and old["result"]["id"] != result["id"] else pointer.get("previous_run_id"))
        record = lab.save_run(result,name)
        atomic_json(lab.state_dir / "stories/latest.json",{"dataset_id":lab.dataset_id,"run_id":record["id"],
                                                           "previous_run_id": previous})
    return record


def latest_stories(lab):
    value = read_json(lab.state_dir / "stories/latest.json",{})
    if value.get("dataset_id") != lab.dataset_id:
        return None
    record = lab.get_run(value.get("run_id",""))
    if record["result"].get("engine") != "photo-wall-stories":
        raise LabError("新聚合快照引擎不匹配")
    return record


def previous_stories(lab):
    value = read_json(lab.state_dir / "stories/latest.json", {})
    if value.get("dataset_id") != lab.dataset_id or not value.get("previous_run_id"):
        return None
    record = lab.get_run(value["previous_run_id"])
    if record.get("dataset_id") != lab.dataset_id or record["result"].get("engine") != "photo-wall-stories":
        raise LabError("上轮相册不属于本批照片，不能对照")
    return record

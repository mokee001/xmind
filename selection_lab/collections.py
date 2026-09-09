"""Generate actual albums from eligible photos, not slices of the global Top N.

Public macOS Vision observations supply content evidence. Album grouping/selection
is our own deterministic policy; it is neither Apple Photos nor Ente Memories.
"""
from __future__ import annotations

import datetime as dt
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

from backend import curation, dedup, selector
from .core import LabError, TZ, digest, file_hash, read_json, validate_config

COLLECTION_POLICY_VERSION = "vision-albums-v1"
THEME_TITLES = {"people": "人物时刻", "food": "餐桌记忆", "scene": "城市与天空",
                "pet": "毛茸茸的日常", "stage": "舞台瞬间"}


def sample_date(photo):
    """Explicit filename date is sample metadata, not claimed EXIF capture time."""
    if photo.get("date_source") in {"exif_original_offset", "exif_original_assumed_utc8", "filename_datetime", "unknown"}:
        return photo.get("taken_at"), photo["date_source"]
    match = re.match(r"^(20\d\d)-(\d\d)-(\d\d)__", photo.get("filename", ""))
    if match:
        try:
            value = dt.datetime(*(int(x) for x in match.groups()), 12, tzinfo=TZ)
            return value.timestamp(), "filename_date"
        except ValueError:
            pass
    return photo.get("taken_at"), "cached_timestamp_unverified"


def classify(observation):
    scores = {p["identifier"]: p["confidence"] for p in observation.get("labels", [])}
    score = lambda *keys: max((scores.get(k, 0) for k in keys), default=0)
    rejected = (score("screenshot") >= .60 or score("printed_page", "receipt", "passport", "diagram") >= .80
                or score("document") >= .92)
    themes = {}
    person = score("people")
    human = max((h.get("confidence", 0) for h in observation.get("humans", [])), default=0)
    # Body evidence recovers profiles/back views, but does not identify a person.
    # A humanoid region alone also fires on statues, posters and toys.
    body_supported = human >= .65 and person >= .15 and person > score("statue", "sculpture", "toy", "doll", "painting")
    if person >= .50 or (observation.get("faces", 0) > 0 and person >= .20) or body_supported:
        themes["people"] = max(person, .50)
    if score("cat", "dog", "feline", "canine") >= .45:
        themes["pet"] = score("cat", "dog", "feline", "canine")
    if score("food") >= .55:
        themes["food"] = score("food")
    landscape = max(score("cityscape", "landscape", "sky", "sunset"), min(score("structure"), score("outdoor")))
    if landscape >= .50 and person < .65:
        themes["scene"] = landscape
    if score("performance", "entertainer", "musical_instrument") >= .55:
        themes["stage"] = score("performance", "entertainer", "musical_instrument")
    return rejected, themes, sorted(scores.items(), key=lambda x: -x[1])[:8]


def date_span(photos):
    values = [p["taken_at"] for p in photos if p.get("taken_at")]
    if not values:
        return "日期未知"
    lo, hi = (dt.datetime.fromtimestamp(value, TZ) for value in (min(values), max(values)))
    if lo.date() == hi.date():
        return f"{lo.year} 年 {lo.month} 月 {lo.day} 日"
    if (lo.year, lo.month) == (hi.year, hi.month):
        return f"{lo.year} 年 {lo.month} 月 {lo.day}–{hi.day} 日"
    return f"{lo.year}.{lo.month:02}.{lo.day:02} — {hi.year}.{hi.month:02}.{hi.day:02}"


def prepare_candidates(lab, raw, *, content=None):
    """One shared eligibility/date path for all project album engines."""
    config = validate_config(raw, lab.defaults)
    lab.ensure_sources_current()
    feature_path = lab.state_dir / "album-features.json"
    index = read_json(feature_path, {})
    if index.get("dataset_id") != lab.dataset_id:
        raise LabError("相册内容索引尚未生成或与照片集不匹配。先运行本机 Vision 特征提取，不生成假主题。")
    source_revision = file_hash(feature_path)
    photos, excluded = [], Counter()
    date_sources = Counter()
    for original in lab.features:
        if original.get("capture_source") == "non_photo" or original["id"] in lab.history:
            excluded["base_non_photo"] += 1
            continue
        if original.get("quality", 0) <= 0 or original["quality"] < config["quality_min"]:
            excluded["quality"] += 1
            continue
        obs = index.get("assets", {}).get(original["id"])
        if not obs or obs.get("error") or obs.get("sha256") != original["sha256"]:
            excluded["missing_vision"] += 1
            continue
        rejected, themes, top_labels = classify(obs)
        if rejected:
            excluded["vision_non_photo"] += 1
            continue
        face_count = obs.get("faces", 0)
        content_evidence = None
        if content is not None:
            content_evidence = content["assets"].get(original["id"])
            if content_evidence is None:
                raise LabError("组合方案缺少 Ente 特征，不使用 Vision 正向主题替代")
            themes = content_evidence["themes"]
            face_count = content_evidence["face_count"]
        if config["theme"] != "all" and config["theme"] not in themes:
            excluded["theme"] += 1
            continue
        timestamp, date_source = sample_date(original)
        date_sources[date_source] += 1
        photo = {**original, "taken_at": timestamp, "date_source": date_source,
                 "album_themes": themes, "vision_top_labels": top_labels, "face_count": face_count}
        if content_evidence is not None:
            photo["content_evidence"] = content_evidence
        augmented = set(original.get("tags", []))
        for theme in themes:
            augmented.update({"people": {"person"}, "food": {"food"}, "pet": {"pet"},
                              "scene": {"city"}, "stage": set()}[theme])
        photo["tags"] = sorted(augmented)
        photos.append(photo)
    now = dt.datetime.combine(dt.date.fromisoformat(config["as_of"]), dt.time(12), tzinfo=TZ).timestamp()
    prepared = curation.prepare(photos, now=now, event_gap_seconds=config["event_gap_hours"] * 3600, timezone=TZ)
    return config, prepared, dict(excluded), dict(date_sources), index, source_revision


def build_collections(lab, raw, *, content=None):
    """Shared selection policy; optional internal provider changes positive evidence only."""
    start = time.perf_counter()
    config, prepared, excluded, date_sources, index, source_revision = prepare_candidates(lab, raw, content=content)
    policy = {"name": "album-collection", "weights": config["weights"],
              "semantic_diversity": config["semantic_diversity"], "event_diversity": config["event_diversity"]}
    model = {"weights": {}, "bias": .5}
    albums, public_photos, used_covers = [], {}, set()

    def add_album(key, title, pool, kind, description, theme=None):
        candidates, _ = dedup.deduplicate(pool, config["hash_distance"], clip_distance_limit=config["clip_distance"])
        if len(candidates) < 3:
            return
        selected = selector.select_for_template(candidates, min(12, config["count"], len(candidates)), model=model, policy=policy)
        if len(selected) < 3:
            return
        ids = {p["id"] for p in selected}
        # Suppress nearly identical albums. No artificial reshuffling to fake variety.
        if any(len(ids & set(a["photo_ids"])) / len(ids | set(a["photo_ids"])) > .85 for a in albums):
            return
        def cover_score(p):
            relevance = p.get("album_themes", {}).get(theme, 0) if theme else max(p.get("album_themes", {}).values(), default=0)
            return (.50 * p.get("aesthetic", 0) + .25 * p.get("quality", 0) + .25 * relevance
                    - (.30 if p["id"] in used_covers else 0))
        cover = max(selected, key=cover_score)
        used_covers.add(cover["id"])
        ordered = sorted(selected, key=lambda p: (p.get("taken_at") or float("inf"), p["filename"]))
        for p in ordered:
            public_photos[p["id"]] = {**lab.public_photo(p), "date_source": p["date_source"],
                                      "face_count": p["face_count"], "vision_top_labels": p["vision_top_labels"],
                                      "album_themes": p["album_themes"]}
            if content is not None:
                public_photos[p["id"]]["content_evidence"] = p["content_evidence"]
        albums.append({"id": key, "title": title, "subtitle": date_span(ordered), "kind": kind,
                       "cover": cover["id"], "photo_ids": [p["id"] for p in ordered],
                       "candidate_count": len(pool), "description": description})

    months = defaultdict(list)
    for p in prepared:
        if p.get("taken_at"):
            date = dt.datetime.fromtimestamp(p["taken_at"], TZ)
            months[(date.year, date.month)].append(p)
    for (year, month), pool in sorted(months.items(), reverse=True)[:2]:
        add_album(f"month-{year}-{month}", f"{month} 月拾光", pool, "month", "从这个月的合格照片中，兼顾画质和内容多样性挑选；组内按日期排列。")
    for key, title in THEME_TITLES.items():
        pool = [p for p in prepared if key in p["album_themes"]]
        add_album("theme-" + key, title, pool, "theme",
                  ("Ente 内容主题映射及人脸检测后，沿用项目规则在主题内部独立去重、选片。" if content is not None else "本机 Vision 内容分类后，在主题内部独立去重、选片。") + ("人物可以是不同的人，未做身份聚类。" if key == "people" else ""), key)
    events = defaultdict(list)
    for p in prepared:
        # Filename dates have day precision; do not fabricate hour-level events.
        if not p.get("taken_at"):
            continue
        key = ("day-" + dt.datetime.fromtimestamp(p["taken_at"], TZ).strftime("%Y%m%d")) if p["date_source"] == "filename_date" else p.get("event_id", "undated")
        if key != "undated":
            events[key].append(p)
    event_pools = sorted(events.items(), key=lambda pair: (-len(pair[1]), -max(p.get("quality", 0) for p in pair[1]), pair[0]))
    for key, pool in event_pools:
        if len(albums) >= 10:
            break
        date = dt.datetime.fromtimestamp(pool[0]["taken_at"], TZ)
        title = f"{date.month} 月 {date.day} 日" if all(p["date_source"]=="filename_date" for p in pool) else f"{date.year} 年 {date.month} 月 {date.day} 日"
        add_album(key, title, pool, "day", "按可用日期或时间间隔归组；只是日期摘要，不代表已经确认属于同一活动。未知日期不进入日期组。")
    result_id = digest({"dataset": lab.dataset_id, "base_features": lab.feature_revision,
                        "vision": source_revision, "code": file_hash(Path(__file__)),
                        "selection_code": lab.engine_revision, "config": config,
                        **({"content": content["revision"]} if content is not None else {})})[:24]
    result = {"id": result_id, "engine": "photo-wall-vision-albums", "policy_version": COLLECTION_POLICY_VERSION,
            "title": "为你精选", "albums": albums, "photos": list(public_photos.values()),
            "config": config, "eligible_count": len(prepared), "excluded": dict(excluded),
            "photo_count": len(public_photos), "elapsed_ms": round((time.perf_counter()-start)*1000, 1),
            "provenance": {"extractor": index.get("extractor"), "date_sources": dict(date_sources),
                           "feature_revision": source_revision, "dataset_id": lab.dataset_id,
                           "note": "本项目生成 · 使用 macOS 公共 Vision 内容分类与人脸检测。不是苹果相册或 Ente 原版精选算法；未做人物身份、城市或旅行识别。"}}
    if content is not None:
        result["engine"] = "photo-wall-ente-hybrid"
        result["title"] = "Ente 识别＋我的成册"
        result["provenance"].update(content["provenance"])
        result["provenance"]["note"] = "Ente 的内容匹配及人脸检测＋本项目的过滤、去重、评分和成册规则。不是 Ente 原版回忆；未做同一人物或事件一致性聚合。"
        result["diagnostics"] = {
            "recognized_count": len(content["assets"]),
            "theme_candidates": {key: sum(key in p["album_themes"] for p in prepared) for key in THEME_TITLES},
            "eligible_unknown_date": sum(not p.get("taken_at") for p in prepared),
            "selected_unknown_date": sum(not p.get("taken_at") for p in public_photos.values()),
        }
    return result

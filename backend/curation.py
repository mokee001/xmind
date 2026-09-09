"""Template-neutral memory features and time-based event aggregation."""

from __future__ import annotations

import datetime as dt
from collections import Counter


EVENT_GAP_SECONDS = 4 * 60 * 60
THEME_TAGS = {
    "person", "portrait", "group", "selfie", "pet", "dog", "cat", "food",
    "landscape", "nature", "beach", "flower", "mountain", "city", "night",
    "travel", "sport", "indoor",
}


def _event_ids(photos: list[dict], event_gap_seconds: float = EVENT_GAP_SECONDS,
               timezone: dt.tzinfo | None = None) -> dict[str, str]:
    dated = sorted((photo for photo in photos if photo.get("taken_at")), key=lambda photo: float(photo["taken_at"]))
    result: dict[str, str] = {}
    previous = None
    sequence_by_day: Counter = Counter()
    event_id = ""
    for photo in dated:
        timestamp = float(photo["taken_at"])
        day = dt.datetime.fromtimestamp(timestamp, tz=timezone).strftime("%Y%m%d")
        if previous is None or timestamp - previous > event_gap_seconds:
            sequence_by_day[day] += 1
            event_id = f"event_{day}_{sequence_by_day[day]:02d}"
        result[str(photo.get("path"))] = event_id
        previous = timestamp
    return result


def prepare(photos: list[dict], now: float | None = None, *,
            event_gap_seconds: float = EVENT_GAP_SECONDS,
            timezone: dt.tzinfo | None = None) -> list[dict]:
    """Return photos enriched with explainable memory scores and neutral event IDs."""
    valid = [photo for photo in photos if photo.get("quality", 0) > 0]
    tag_counts = Counter(tag for photo in valid for tag in set(photo.get("tags", [])) if tag in THEME_TAGS)
    event_ids = _event_ids(valid, event_gap_seconds, timezone)
    event_counts = Counter(event_ids.values())
    current = now if now is not None else dt.datetime.now().timestamp()
    prepared = []
    for original in photos:
        photo = dict(original)
        event_id = event_ids.get(str(photo.get("path")))
        if event_id:
            photo["event_id"] = event_id
        if photo.get("quality", 0) <= 0:
            photo["memory_score"], photo["memory_reasons"] = 0.0, []
            prepared.append(photo)
            continue
        tags = set(photo.get("tags", []))
        reasons, score = [], 0.35
        if tags & {"person", "portrait", "group", "selfie"} or any(tag.startswith("person_") for tag in tags):
            score += 0.18
            reasons.append("人物记忆")
        if tags & {"pet", "dog", "cat"}:
            score += 0.14
            reasons.append("宠物记忆")
        if tags & {"travel", "city", "landscape", "nature", "beach", "mountain"}:
            score += 0.08
            reasons.append("地点或旅行")
        if any(tag_counts.get(tag, 0) <= 2 for tag in tags & THEME_TAGS):
            score += 0.08
            reasons.append("相册内少见内容")
        if event_id and event_counts[event_id] >= 3:
            score += 0.07
            reasons.append("完整事件")
        if photo.get("taken_at") and current - float(photo["taken_at"]) >= 180 * 86400:
            score += 0.08
            reasons.append("久未回顾")
        photo["memory_score"] = round(min(score, 1.0), 3)
        photo["memory_reasons"] = reasons
        prepared.append(photo)
    return prepared

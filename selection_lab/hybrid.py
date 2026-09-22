"""Ente recognition evidence with the unchanged project album-selection policy.

Uses all recognition matches, never the 18-photo natural Memories selection.
It does not mix MobileCLIP-S2 vectors into the existing ViT-B-32 deduplicator.
"""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path

from .collections import build_collections
from .core import LabError, TZ, atomic_json, digest, file_hash, read_json
from .ente import latest_result, people_result, recognition_result

ADAPTER_VERSION = "ente-recognition-project-albums-v1"
# Fixed before evaluating this batch; no per-photo labels or membership overrides.
THEME_MAPPING = {
    "people": ["groupSelfies", "goldenHourPortraits", "artisticPortraits", "babySmiles", "playfulKids", "candidLaughter"],
    "food": ["food", "streetFood"],
    "scene": ["city", "citySunsets", "mountains", "beach", "greenery", "sunrise", "moon", "lakeside",
              "forestTrails", "waterfalls", "coastalCliffs", "nightLights", "stargazing", "snowAdventures",
              "tropicalParadise", "desertDreams", "autumnColors", "architecture", "historicSites", "aerialViews"],
    "pet": ["pets"],
    "stage": ["concertNights"],
}


def content_from_record(lab, record):
    result = record.get("result", {})
    if record.get("dataset_id") != lab.dataset_id or result.get("signature", {}).get("dataset") != lab.dataset_id:
        raise LabError("Ente 特征不是当前候选集，拒绝混用")
    if result.get("engine") != "ente-import" or result.get("provenance", {}).get("mode") != "natural":
        raise LabError("需要本批已完成的 Ente 实跑快照及完整识别诊断")
    diag = result.get("ente_diagnostics", {})
    if diag.get("photo_count") != len(lab.features) or diag.get("embedding_count") != len(lab.features):
        raise LabError("Ente 尚未完成全部候选照片的识别，不用旧特征补齐")
    threshold = diag.get("clip_threshold")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 < threshold < 1:
        raise LabError("Ente 内容阈值无效")
    theme_types = [t["type"] for t in diag.get("themes", [])]
    required = {t for types in THEME_MAPPING.values() for t in types}
    if len(set(theme_types)) != len(theme_types) or not required.issubset(theme_types):
        raise LabError("Ente 主题诊断缺失或重复，不能假设没有匹配")
    # These validators check hashes, match counts, thresholds, face boxes and clusters.
    recognition = recognition_result(lab, diag)
    people = people_result(lab, diag)
    lookup = {a["id"].removeprefix("ente-theme-"): a for a in recognition["albums"]}
    overview = next((a for a in people["albums"] if a["kind"] == "all_faces"), {})
    assets = {}
    for photo in lab.features:
        photo_id = photo["id"]
        faces = overview.get("faces", {}).get(photo_id, [])
        themes, matches = {}, []
        for category, types in THEME_MAPPING.items():
            evidence = [{"type": kind, "score": lookup[kind]["scores"][photo_id]}
                        for kind in types if photo_id in lookup.get(kind, {}).get("scores", {})]
            if evidence:
                themes[category] = max(e["score"] for e in evidence)
                matches.extend({**e, "category": category} for e in evidence)
        # A face supports a broad people album, NOT a confirmed identity.
        # 0.5 is an explicit policy relevance floor, not a model probability.
        if faces:
            themes["people"] = max(.5, themes.get("people", 0))
        assets[photo_id] = {"themes": themes, "matches": matches, "face_count": len(faces),
                            "source": "ente-recognition", "sha256": photo["sha256"]}
    provenance = {"content_provider": ADAPTER_VERSION, "ente_snapshot_id": record["id"],
                  "ente_provenance": result["provenance"], "clip_threshold": threshold,
                  "theme_mapping": THEME_MAPPING,
                  "relevance_units": "raw cosine for matched themes; people face evidence has a policy floor of 0.5; not probabilities",
                  "dedup_provider": "unchanged project dHash/content signatures and available ViT-B-32 vectors; no MobileCLIP-S2 vector injection",
                  "date_policy": "same project dates; undated photos may enter content themes, never date groups",
                  "filter_provider": "unchanged base filters and macOS Vision non-photo veto"}
    revision = digest({"adapter": file_hash(Path(__file__)), "diagnostics": diag, "provenance": provenance})
    return {"assets": assets, "revision": revision, "provenance": provenance}


def build_hybrid_collections(lab, config, *, record=None):
    record = latest_result(lab) if record is None else record
    content = content_from_record(lab, record)
    return build_collections(lab, config, content=content)


def save_hybrid(lab, albums, name="Ente 识别＋我的成册"):
    """Store a distinct compatible snapshot without modifying natural Ente results."""
    if albums.get("engine") != "photo-wall-ente-hybrid" or albums["provenance"]["dataset_id"] != lab.dataset_id:
        raise LabError("不能把其他引擎结果保存成组合方案")
    selected_ids = list(dict.fromkeys(i for a in albums["albums"] for i in a["photo_ids"]))
    result = {"schema_version": 1, "id": albums["id"], "engine": "photo-wall-ente-hybrid",
              "engine_label": "Ente 识别＋本项目成册", "config": albums["config"],
              "selected_ids": selected_ids, "photos": albums["photos"], "events": albums["albums"],
              "counts": {"selected": len(selected_ids)}, "collection_snapshot": albums,
              "provenance": albums["provenance"], "signature": {"dataset": lab.dataset_id},
              "elapsed_ms": albums["elapsed_ms"], "selection_mode": "组合方案 · 全部相册成员并集，非全局 Top N",
              "warnings": [albums["provenance"]["note"]], "created_at": dt.datetime.now(TZ).isoformat()}
    saved = lab.save_run(result, name)
    atomic_json(lab.state_dir / "hybrid/latest.json", {"dataset_id": lab.dataset_id, "run_id": saved["id"]})
    return saved


def latest_hybrid(lab):
    latest = read_json(lab.state_dir / "hybrid/latest.json", {})
    if latest.get("dataset_id") != lab.dataset_id:
        return None
    record = lab.get_run(latest.get("run_id", ""))
    if record["result"].get("engine") != "photo-wall-ente-hybrid":
        raise LabError("组合方案快照的引擎来源不符")
    return record

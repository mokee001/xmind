#!/usr/bin/env python3
"""Render a clean final wall using the current curation and selection strategy."""

from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import engine  # noqa: E402
from backend import curation, dedup, selection_policy, selector  # noqa: E402
from immich_capabilities_demo import normalize, text_embedding  # noqa: E402


NEGATIVE_PROMPTS = [
    "a screenshot of a smartphone app",
    "a document or handwritten note with text",
    "a poster or advertisement with text",
    "a photo collage made of multiple images",
]
POSITIVE_PROMPTS = [
    "a real camera photograph of people",
    "a real camera photograph of food",
    "a real camera photograph of an object",
    "a real camera photograph of nature or a city",
]


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    cache = ROOT / "outputs" / "immich-comparison"
    output = ROOT / "outputs" / "new-strategy-preview"
    output.mkdir(parents=True, exist_ok=True)

    photos = list(load(cache / "current-cache.json").values())
    embeddings = load(cache / "immich-cache.json")
    candidates = []
    for photo in photos:
        if photo.get("quality", 0) <= 0 or photo.get("capture_source") == "non_photo":
            continue
        item = dict(photo)
        vector = embeddings.get(str(item["path"]), {}).get("embedding")
        if vector:
            item["clip_embedding"] = vector
        candidates.append(item)

    # A second-stage content review for shared photos. EXIF is not required, but
    # screenshots/documents/collages must beat real-photo prompts by a clear
    # margin before being rejected.
    content_rejected = []
    try:
        prompt_vectors = [normalize(text_embedding(
            "http://127.0.0.1:3003", "ViT-B-32__openai", prompt,
        )) for prompt in NEGATIVE_PROMPTS + POSITIVE_PROMPTS]
        reviewed = []
        for item in candidates:
            vector = normalize(item.get("clip_embedding", []))
            if vector.size == 0:
                reviewed.append(item)
                continue
            scores = [float(vector @ prompt) for prompt in prompt_vectors]
            margin = max(scores[:len(NEGATIVE_PROMPTS)]) - max(scores[len(NEGATIVE_PROMPTS):])
            item["non_photo_margin"] = round(margin, 4)
            if item.get("capture_source") == "shared" and margin >= 0.03:
                content_rejected.append(item)
            else:
                reviewed.append(item)
        candidates = reviewed
    except (urllib.error.URLError, KeyError, ValueError):
        pass

    candidates = curation.prepare(candidates)
    candidates, removed = dedup.deduplicate(candidates)
    policy = selection_policy.resolve("grid_20")
    selected = selector.select_for_template(
        candidates, min(20, len(candidates)),
        model={"weights": {}, "bias": 0.5}, policy=policy,
    )

    template = engine.load_template(str(ROOT / "templates" / "grid_20.json"))
    image = engine.render(
        template,
        [str(item["path"]) for item in selected],
        {"title": "七月拾光", "date": "2026 · 07"},
    )
    image_path = output / "july-final-wall.png"
    image.save(image_path)
    (output / "selected.json").write_text(json.dumps({
        "strategy": policy,
        "candidate_count": len(candidates),
        "content_rejected": [item["filename"] for item in content_rejected],
        "removed_duplicates": removed,
        "selected": [{
            "filename": item["filename"],
            "final_score": item.get("final_score"),
            "memory_score": item.get("memory_score"),
            "memory_reasons": item.get("memory_reasons", []),
            "event_id": item.get("event_id"),
        } for item in selected],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(image_path)


if __name__ == "__main__":
    main()

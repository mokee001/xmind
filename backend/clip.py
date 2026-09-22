"""Optional Immich CLIP bridge used for semantic deduplication and diversity.

Set PHOTOWALL_CLIP_ENDPOINT to the Immich machine-learning service URL. The
pipeline remains fully functional when the service is absent.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import urllib.parse
import urllib.request
import uuid


ENDPOINT = os.environ.get("PHOTOWALL_CLIP_ENDPOINT", "").rstrip("/")
MODEL = os.environ.get("PHOTOWALL_CLIP_MODEL", "ViT-B-32__openai")
TIMEOUT = float(os.environ.get("PHOTOWALL_CLIP_TIMEOUT", "30"))
NON_PHOTO_MARGIN = float(os.environ.get("PHOTOWALL_CLIP_NON_PHOTO_MARGIN", "0.03"))
NEGATIVE_PROMPTS = (
    "a screenshot of a smartphone app",
    "a document or handwritten note with text",
    "a poster or advertisement with text",
    "a photo collage made of multiple images",
)
POSITIVE_PROMPTS = (
    "a real camera photograph of people",
    "a real camera photograph of food",
    "a real camera photograph of an object",
    "a real camera photograph of nature or a city",
)
_PROMPT_CACHE: tuple[list[float], ...] | None = None


def _multipart(path: str) -> tuple[bytes, str]:
    boundary = f"----photo-wall-{uuid.uuid4().hex}"
    entries = json.dumps({"clip": {"visual": {"modelName": MODEL}}})
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    filename = os.path.basename(path)
    with open(path, "rb") as image_file:
        image_data = image_file.read()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"entries\"\r\n\r\n{entries}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + image_data + f"\r\n--{boundary}--\r\n".encode()
    return body, boundary


def embedding(path: str) -> list[float] | None:
    """Return a normalized-compatible CLIP vector, or None on any outage."""
    if not ENDPOINT:
        return None
    try:
        body, boundary = _multipart(path)
        request = urllib.request.Request(
            ENDPOINT + "/predict",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            value = json.loads(response.read())["clip"]
        vector = json.loads(value) if isinstance(value, str) else value
        return [float(item) for item in vector]
    except Exception:
        return None


def _text_embedding(text: str) -> list[float] | None:
    if not ENDPOINT:
        return None
    try:
        entries = json.dumps({"clip": {"textual": {"modelName": MODEL}}})
        body = urllib.parse.urlencode({"entries": entries, "text": text}).encode()
        request = urllib.request.Request(
            ENDPOINT + "/predict",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            value = json.loads(response.read())["clip"]
        vector = json.loads(value) if isinstance(value, str) else value
        return [float(item) for item in vector]
    except Exception:
        return None


def _prompt_embeddings() -> tuple[list[float], ...] | None:
    """Cache successful prompt vectors; outages are retried on later requests."""
    global _PROMPT_CACHE
    if _PROMPT_CACHE is not None:
        return _PROMPT_CACHE
    vectors = tuple(_text_embedding(prompt) for prompt in NEGATIVE_PROMPTS + POSITIVE_PROMPTS)
    if any(vector is None for vector in vectors):
        return None
    _PROMPT_CACHE = tuple(vector for vector in vectors if vector is not None)
    return _PROMPT_CACHE


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


def review_content(photo: dict) -> dict:
    """Reject shared images only when non-photo prompts clearly beat photo prompts."""
    if photo.get("capture_source") != "shared" or not photo.get("clip_embedding"):
        return photo
    prompts = _prompt_embeddings()
    if not prompts:
        photo["clip_content_review"] = "unavailable"
        return photo
    scores = [_cosine(photo["clip_embedding"], prompt) for prompt in prompts]
    split = len(NEGATIVE_PROMPTS)
    margin = max(scores[:split]) - max(scores[split:])
    photo["clip_non_photo_margin"] = round(margin, 4)
    if margin >= NON_PHOTO_MARGIN:
        photo["capture_source"] = "non_photo"
        photo["source_confidence"] = round(min(1.0, 0.5 + margin), 3)
        photo["junk_reason"] = "semantic_non_photo"
        photo["quality"] = 0.0
        photo["aesthetic"] = 0.0
        tags = set(photo.get("tags", []))
        tags.update({"junk", "junk_semantic_non_photo"})
        tags.discard("source_shared")
        photo["tags"] = sorted(tags)
        photo["clip_content_review"] = "rejected"
    else:
        photo["clip_content_review"] = "photo"
    return photo


def enrich(photos: list[dict]) -> list[dict]:
    """Attach vectors only to eligible photographic candidates that lack one."""
    for photo in photos:
        if photo.get("quality", 0) <= 0 or photo.get("capture_source") == "non_photo":
            continue
        if not photo.get("clip_embedding"):
            vector = embedding(str(photo.get("path", "")))
            if vector:
                photo["clip_embedding"] = vector
                photo["clip_model"] = MODEL
        review_content(photo)
    return photos

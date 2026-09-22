"""Device-confirmed display records, isolated by the current device binding.

Generation and queueing do not create history. Existing output URLs are public,
so they remain private metadata until a separately authorized image API exists.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import threading
from typing import Any

from . import store


_LOCK = threading.Lock()


def _binding_key(device: dict[str, Any]) -> str:
    # Reprovisioning keeps this binding; removing and reclaiming changes the
    # account credential. A new owner must never inherit another owner's log.
    identity = [device.get("device_id"), device.get("account_token"), device.get("created_at")]
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def _store_key(device: dict[str, Any]) -> str:
    return f"device_display_history_{_binding_key(device)}"


def _pending_key(device: dict[str, Any]) -> str:
    return f"{_store_key(device)}_pending"


def stage(device: dict[str, Any], revision: str, *, title: str, image_url: str = "") -> None:
    """Freeze metadata at publication, without adding an already-displayed item."""
    revision = str(revision or "")
    if not revision:
        return
    with _LOCK:
        key = _pending_key(device)
        previous = store.load(key, {})
        if isinstance(previous, dict) and previous.get("revision") == revision:
            return
        store.save(key, {
            "revision": revision,
            "title": str(title or "照片墙画面")[:160],
            "imageUrl": str(image_url or ""),
        })


def confirm(device: dict[str, Any], revision: str) -> None:
    """Append once after a matching device acknowledgement; never backfill."""
    if not revision or revision != str(device.get("revision") or ""):
        return
    record_id = hashlib.sha256(f"{_binding_key(device)}:{revision}".encode()).hexdigest()
    with _LOCK:
        candidate = store.load(_pending_key(device), {})
        if not isinstance(candidate, dict) or candidate.get("revision") != revision:
            return
        key = _store_key(device)
        records = store.load(key, [])
        if not isinstance(records, list):
            records = []
        if any(item.get("id") == record_id for item in records if isinstance(item, dict)):
            return
        records.append({
            "id": record_id,
            "revision": revision,
            "confirmedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "title": candidate["title"],
            # Kept only as the publication-time reference. It is deliberately
            # absent from the public projection, including /api/devices.
            "_publishedImageUrl": candidate.get("imageUrl", ""),
        })
        store.save(key, records)


def records_for(device: dict[str, Any]) -> list[dict[str, Any]]:
    with _LOCK:
        records = store.load(_store_key(device), [])
    if not isinstance(records, list):
        return []
    fields = ("id", "revision", "confirmedAt", "title")
    return [
        {field: record[field] for field in fields}
        for record in reversed(records)
        if isinstance(record, dict) and all(record.get(field) for field in fields)
    ]

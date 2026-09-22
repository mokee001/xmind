"""HTTP integration test for the Mac-independent E Ink device lifecycle.

Run against an already started local backend:
    python3 tests/test_device_flow.py
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

BASE = os.environ.get("PHOTOWALL_TEST_BASE", "http://127.0.0.1:8000").rstrip("/")
RUN_ID = str(time.time_ns())
DEVICE_ID = f"pwe6-test-{RUN_ID}"
PAIRING_CODE = RUN_ID[-6:]
SETUP_TOKEN = "a" * 32


def request(path: str, method: str = "GET", body: dict | None = None, headers: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    request_headers = dict(headers or {})
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=request_headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.status, response.headers, response.read()


def publish_photo(photo: Path, account_token: str) -> dict:
    boundary = "----PhotoWallIntegrationBoundary"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{photo.name}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode() + photo.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/api/devices/{DEVICE_ID}/publish",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Account-Token": account_token,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read())


def test_photo() -> tuple[Path, bool]:
    """Return an existing sample, or make a disposable image for clean checkouts."""
    photos_dir = Path("photos")
    if photos_dir.is_dir():
        existing = next(
            (path for path in photos_dir.iterdir()
             if path.suffix.lower() in (".jpg", ".jpeg", ".png")),
            None,
        )
        if existing:
            return existing, False

    path = Path(tempfile.gettempdir()) / f"photowall-device-flow-{RUN_ID}.jpg"
    image = Image.new("RGB", (960, 720), "#5e8ab6")
    draw = ImageDraw.Draw(image)
    draw.ellipse((180, 120, 780, 650), fill="#f4c95d", outline="white", width=12)
    draw.text((360, 350), "PhotoWall", fill="#24344d", stroke_width=2, stroke_fill="white")
    image.save(path, format="JPEG", quality=92)
    return path, True


def main() -> None:
    _, _, raw = request("/api/devices/bootstrap", "POST", {
        "device_id": DEVICE_ID,
        "pairing_code": PAIRING_CODE,
        "setup_token": SETUP_TOKEN,
        "ip": "192.168.1.55",
        "firmware_version": "integration-test",
        "device_token": "",
    })
    bootstrap = json.loads(raw)
    device_token = bootstrap["device_token"]

    _, _, raw = request("/api/devices/auto-claim", "POST", {
        "device_id": DEVICE_ID,
        "setup_token": SETUP_TOKEN,
        "name": "集成测试屏",
    })
    claim = json.loads(raw)
    account_token = claim["account_token"]
    try:
        request("/api/devices/auto-claim", "POST", {
            "device_id": DEVICE_ID,
            "setup_token": SETUP_TOKEN,
            "name": "不应重复绑定",
        })
        raise AssertionError("已消费的 setup token 不应允许重复绑定")
    except urllib.error.HTTPError as error:
        assert error.code == 403, error.code

    photo, disposable_photo = test_photo()
    try:
        revision = publish_photo(photo, account_token)["revision"]
    finally:
        if disposable_photo:
            photo.unlink(missing_ok=True)

    query = urllib.parse.urlencode({"revision": "", "token": device_token})
    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{query}")
    pending = json.loads(raw)
    assert pending["revision"] == revision

    _, _, frame = request(pending["frame_url"])
    magic, version, width, height, size, digest = struct.unpack(">4sBHHI32s", frame[:45])
    assert (magic, version, width, height, size, len(frame)) == (
        b"PWE6", 1, 1200, 1600, 960000, 960045)
    assert hashlib.sha256(frame[45:]).digest() == digest

    token_query = urllib.parse.urlencode({"token": device_token})
    request(f"/api/devices/{DEVICE_ID}/status?{token_query}", "POST", {
        "state": "displayed",
        "revision": revision,
        "progress": 100,
        "ip": "192.168.1.55",
    })
    _, _, raw = request("/api/devices", headers={"X-Account-Token": account_token})
    devices = json.loads(raw)["devices"]
    device = next(item for item in devices if item["device_id"] == DEVICE_ID)
    assert device["displayed_revision"] == revision
    assert device["state"] == "displayed"
    print(f"Device lifecycle OK: {revision}, {len(frame)} byte PWE6")


if __name__ == "__main__":
    main()

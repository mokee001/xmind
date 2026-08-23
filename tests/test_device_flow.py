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
import urllib.error
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


def upload_library_photo(photo: Path, account_token: str) -> dict:
    boundary = "----PhotoWallLibraryBoundary"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{photo.name}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode() + photo.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/api/upload",
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


def test_library_photos() -> list[Path]:
    paths: list[Path] = []
    for index, color in enumerate(("#5e8ab6", "#b66e5e", "#629668"), start=1):
        path = Path(tempfile.gettempdir()) / f"photowall-template-{RUN_ID}-{index}.jpg"
        texture = Image.effect_noise((960, 720), 72 + index * 18).convert("RGB")
        image = Image.blend(texture, Image.new("RGB", (960, 720), color), 0.45)
        draw = ImageDraw.Draw(image)
        for stripe in range(0, 960, 32):
            draw.line((stripe, 0, 960 - stripe // 2, 720), fill=(255, 255, 255), width=2)
        draw.rectangle((140 + index * 30, 120, 760, 620), outline="white", width=14)
        draw.text((360, 350), f"Photo {index}", fill="white", stroke_width=2, stroke_fill="#24344d")
        exif = image.getexif()
        exif[271] = "Apple"
        exif[272] = "iPhone"
        image.save(path, format="JPEG", quality=92, exif=exif)
        paths.append(path)
    return paths


def assert_account_library_isolation(legacy_photo: Path) -> None:
    """An empty account must never generate a wall from the legacy library."""
    upload_library_photo(legacy_photo, "")
    isolated_token = f"isolated-{RUN_ID}"
    _, _, raw = request("/api/smart_albums")
    assert json.loads(raw)["total"] >= 1
    isolated_headers = {"X-Account-Token": isolated_token}
    _, _, raw = request("/api/smart_albums", headers=isolated_headers)
    isolated_albums = json.loads(raw)
    assert isolated_albums["total"] == 0 and isolated_albums["albums"] == []
    _, _, raw = request("/api/people", headers=isolated_headers)
    assert json.loads(raw)["people"] == []
    try:
        request(
            "/api/generate",
            "POST",
            {"template": "daily_polaroid", "title": "不应跨账户取图"},
            headers=isolated_headers,
        )
        raise AssertionError("空账户不应从旧公共图库生成照片墙")
    except urllib.error.HTTPError as error:
        assert error.code == 400, error.code
        payload = json.loads(error.read())
        assert payload.get("error") == "相册为空，请先授权/上传照片", payload


def assert_account_model_isolation(account_token: str) -> None:
    """Preference learning for one family must never affect another family."""
    account_headers = {"X-Account-Token": account_token}
    other_headers = {"X-Account-Token": f"other-account-{RUN_ID}"}

    _, _, raw = request("/api/model", headers=account_headers)
    assert json.loads(raw)["trained_samples"] == 0
    _, _, raw = request("/api/model", headers=other_headers)
    assert json.loads(raw)["trained_samples"] == 0
    _, _, raw = request("/api/model")
    legacy_before = json.loads(raw)

    _, _, raw = request(
        "/api/label",
        "POST",
        {"wall_id": "account-wall", "samples": [{"tag": "warm", "score": 1.0}]},
        headers=account_headers,
    )
    trained = json.loads(raw)["model"]
    assert trained["trained_samples"] == 1
    assert trained["weights"]["warm"] > 0.5

    _, _, raw = request("/api/model", headers=account_headers)
    assert json.loads(raw) == trained
    _, _, raw = request("/api/model", headers=other_headers)
    other_model = json.loads(raw)
    assert other_model["trained_samples"] == 0 and "warm" not in other_model["weights"]
    _, _, raw = request("/api/model")
    assert json.loads(raw) == legacy_before


def assert_reprovision_and_delete_lifecycle(device_token: str, account_token: str) -> None:
    """Exercise Wi-Fi replacement, removal, and a clean second pairing."""
    account_headers = {"X-Account-Token": account_token}
    _, _, raw = request(
        f"/api/devices/{DEVICE_ID}/reprovision",
        "POST",
        headers=account_headers,
    )
    assert json.loads(raw)["reprovision_required"] is True

    device_query = urllib.parse.urlencode({"revision": "", "token": device_token})
    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{device_query}")
    command = json.loads(raw)
    assert command == {"command": "reprovision", "preserve_binding": True}, command

    token_query = urllib.parse.urlencode({"token": device_token})
    request(f"/api/devices/{DEVICE_ID}/status?{token_query}", "POST", {
        "state": "reprovisioning",
        "progress": 0,
        "ip": "192.168.1.55",
    })
    replacement_setup_token = "b" * 32
    _, _, raw = request("/api/devices/bootstrap", "POST", {
        "device_id": DEVICE_ID,
        "pairing_code": PAIRING_CODE,
        "setup_token": replacement_setup_token,
        "ip": "192.168.2.55",
        "firmware_version": "integration-test-reconfigured",
        "device_token": device_token,
    })
    reconfigured = json.loads(raw)
    assert reconfigured["device_token"] == device_token
    assert reconfigured["claimed"] is True
    _, _, raw = request("/api/devices", headers=account_headers)
    assert any(item["device_id"] == DEVICE_ID for item in json.loads(raw)["devices"])

    # Reconfiguration normally drops the old network immediately. If the
    # "reprovisioning" status acknowledgement never reaches the cloud, a
    # bootstrap carrying the retained device token and a fresh setup token
    # must still complete the Wi-Fi replacement and clear the stale command.
    request(
        f"/api/devices/{DEVICE_ID}/reprovision",
        "POST",
        headers=account_headers,
    )
    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{device_query}")
    assert json.loads(raw) == {"command": "reprovision", "preserve_binding": True}
    recovery_setup_token = "d" * 32
    _, _, raw = request("/api/devices/bootstrap", "POST", {
        "device_id": DEVICE_ID,
        "pairing_code": PAIRING_CODE,
        "setup_token": recovery_setup_token,
        "ip": "192.168.4.55",
        "firmware_version": "integration-test-recovered-reconfigure",
        "device_token": device_token,
    })
    recovered = json.loads(raw)
    assert recovered["device_token"] == device_token
    assert recovered["claimed"] is True
    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{device_query}")
    assert "command" not in json.loads(raw)

    _, _, raw = request(
        f"/api/devices/{DEVICE_ID}",
        "DELETE",
        headers=account_headers,
    )
    removed = json.loads(raw)
    assert removed["removed"] is True and removed["reprovision_required"] is True
    _, _, raw = request("/api/devices", headers=account_headers)
    assert not json.loads(raw)["devices"]

    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{device_query}")
    command = json.loads(raw)
    assert command == {"command": "reprovision", "preserve_binding": False}, command
    request(f"/api/devices/{DEVICE_ID}/status?{token_query}", "POST", {
        "state": "unbound",
        "progress": 0,
        "ip": "192.168.2.55",
    })

    second_setup_token = "c" * 32
    _, _, raw = request("/api/devices/bootstrap", "POST", {
        "device_id": DEVICE_ID,
        "pairing_code": PAIRING_CODE,
        "setup_token": second_setup_token,
        "ip": "192.168.3.55",
        "firmware_version": "integration-test-second-pairing",
        "device_token": "",
    })
    second_bootstrap = json.loads(raw)
    assert second_bootstrap["device_token"] != device_token
    assert second_bootstrap["claimed"] is False
    _, _, raw = request("/api/devices/auto-claim", "POST", {
        "device_id": DEVICE_ID,
        "setup_token": second_setup_token,
        "name": "重新添加的测试屏",
    })
    second_claim = json.loads(raw)
    assert second_claim["account_token"] != account_token
    _, _, raw = request(
        "/api/devices",
        headers={"X-Account-Token": second_claim["account_token"]},
    )
    assert any(item["device_id"] == DEVICE_ID for item in json.loads(raw)["devices"])


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
    revision = publish_photo(photo, account_token)["revision"]

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

    library_photos = test_library_photos()
    for library_photo in library_photos:
        upload_library_photo(library_photo, account_token)
    _, _, raw = request(
        "/api/smart_albums",
        headers={"X-Account-Token": account_token},
    )
    recognition = json.loads(raw)
    assert recognition["total"] >= 1
    assert_account_library_isolation(library_photos[0])
    assert_account_model_isolation(account_token)
    _, _, raw = request(
        "/api/generate",
        "POST",
        {
            "template": "daily_polaroid",
            "title": "集成测试模板",
            "exclude_filters": ["__never__"],
        },
        headers={"X-Account-Token": account_token},
    )
    wall = json.loads(raw)
    assert wall["image_url"].startswith("/output/")
    assert wall["excluded_filters"] == ["__never__"]
    _, _, raw = request(
        f"/api/devices/{DEVICE_ID}/publish-last-wall",
        "POST",
        headers={"X-Account-Token": account_token},
    )
    template_revision = json.loads(raw)["revision"]
    _, _, raw = request(f"/api/devices/{DEVICE_ID}/next?{query}")
    template_pending = json.loads(raw)
    assert template_pending["revision"] == template_revision
    _, _, template_frame = request(template_pending["frame_url"])
    assert len(template_frame) == 960045
    assert_reprovision_and_delete_lifecycle(device_token, account_token)
    if disposable_photo:
        photo.unlink(missing_ok=True)
    for library_photo in library_photos:
        library_photo.unlink(missing_ok=True)
    print(f"Device lifecycle OK: {revision}, {len(frame)} byte PWE6")


if __name__ == "__main__":
    main()

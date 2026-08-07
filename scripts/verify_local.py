"""One-command isolated verification for the calendar-enabled PhotoWall backend.

Run from the repository root:
    python3 scripts/verify_local.py
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(base: str, path: str, *, method: str = "GET", data: bytes | None = None,
            headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.status, response.read()


def post_json(base: str, path: str, value: dict) -> dict:
    _, raw = request(
        base,
        path,
        method="POST",
        data=json.dumps(value).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(raw)


def multipart_photo(image_bytes: bytes) -> tuple[bytes, dict[str, str]]:
    boundary = "----PhotoWallCalendarVerification"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="files"; filename="2026-07-03.jpg"\r\n',
        b"Content-Type: image/jpeg\r\n\r\n",
        image_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def july_camera_photo() -> bytes:
    image = Image.effect_noise((900, 675), 120).convert("RGB")
    exif = Image.Exif()
    exif[271] = "Apple"
    exif[272] = "iPhone 16 Pro"
    exif[306] = "2026:07:03 12:00:00"
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=94, exif=exif)
    return output.getvalue()


def wait_for_server(base: str, process: subprocess.Popen) -> None:
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError("验证服务启动失败")
        try:
            request(base, "/")
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("等待验证服务超时")


def verify_calendar_publish(base: str) -> None:
    bootstrap = post_json(base, "/api/devices/bootstrap", {
        "device_id": "calendar-verify-device",
        "pairing_code": "123456",
        "ip": "192.168.1.50",
        "firmware_version": "verification",
        "device_token": "",
    })
    claim = post_json(base, "/api/devices/claim", {
        "pairing_code": "123456",
        "name": "日历验证屏",
    })
    body, headers = multipart_photo(july_camera_photo())
    status, raw = request(base, "/api/upload", method="POST", data=body, headers=headers)
    uploaded = json.loads(raw)
    assert status == 200 and uploaded["count"] == 1, uploaded

    status, raw = request(
        base,
        "/api/devices/calendar-verify-device/calendar/july-2026/publish",
        method="POST",
        data=b"",
        headers={"X-Account-Token": claim["account_token"]},
    )
    published = json.loads(raw)
    assert status == 200, published
    assert published["calendar"] == {
        "year": 2026,
        "month": 7,
        "selected_day_count": 1,
        "qa": "PASS",
    }, published

    query = urllib.parse.urlencode({"revision": "", "token": bootstrap["device_token"]})
    _, raw = request(base, f"/api/devices/calendar-verify-device/next?{query}")
    pending = json.loads(raw)
    assert pending["revision"] == published["revision"]
    _, frame = request(base, pending["frame_url"])
    magic, version, width, height, size, digest = struct.unpack(">4sBHHI32s", frame[:45])
    assert (magic, version, width, height, size, len(frame)) == (b"PWE6", 1, 1200, 1600, 960000, 960045)
    assert hashlib.sha256(frame[45:]).digest() == digest
    print("Calendar publish OK: QA PASS, 960045 byte PWE6")


def main() -> None:
    environment = os.environ.copy()
    with tempfile.TemporaryDirectory(prefix="photowall-verify-") as temporary:
        data_dir = Path(temporary) / "data"
        environment.update({
            "PYTHONPATH": str(ROOT),
            "PHOTOWALL_DATA_DIR": str(data_dir),
            "PHOTOWALL_STORE_DIR": str(data_dir / "store"),
            "PHOTOWALL_TAGGER": "mock",
        })
        subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"],
            cwd=ROOT,
            env=environment,
            check=True,
        )
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.server:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=ROOT,
            env=environment,
        )
        try:
            wait_for_server(base, process)
            status, raw = request(base, "/healthz")
            assert status == 200, raw
            assert json.loads(raw) == {"status": "ok", "storage_ready": True}
            subprocess.run(
                [sys.executable, "tests/test_device_flow.py"],
                cwd=ROOT,
                env={**environment, "PHOTOWALL_TEST_BASE": base},
                check=True,
            )
            verify_calendar_publish(base)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
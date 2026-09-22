"""受保护的软件测试设备。

真实墨水屏不可用时，这组端点允许 iOS 模拟器复用正式设备、家庭和发布状态
模型做冒烟测试。端点默认完全隐藏；只有同时显式开启开关并配置足够长的测试
密钥后才可调用，避免测试能力意外出现在生产环境。
"""

from __future__ import annotations

import hmac
import os
import secrets
import time
from typing import Any

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .. import store

router = APIRouter()

_ALLOWED_STATES = {
    "online",
    "queued",
    "downloading",
    "displaying",
    "displayed",
    "failed",
}
_NEXT_STATE = {
    "online": "queued",
    "queued": "downloading",
    "downloading": "displaying",
    "displaying": "displayed",
    "displayed": "queued",
    "failed": "queued",
}
_DEFAULT_PROGRESS = {
    "online": 0.0,
    "queued": 0.0,
    "downloading": 42.0,
    "displaying": 86.0,
    "displayed": 100.0,
    "failed": 0.0,
}


class CreateTestDeviceReq(BaseModel):
    name: str = Field(default="模拟照片墙", max_length=40)


class TestDeviceStateReq(BaseModel):
    state: str = Field(default="online", max_length=24)
    progress: float | None = None
    error: str = Field(default="", max_length=240)


def _test_api_response(test_key: str) -> Response | None:
    if os.environ.get("PHOTOWALL_ENABLE_TEST_API") != "1":
        return JSONResponse(status_code=404, content={"error": "接口不存在"})
    expected = os.environ.get("PHOTOWALL_TEST_API_KEY", "")
    if len(expected) < 16:
        return JSONResponse(status_code=503, content={"error": "测试设备接口尚未安全配置"})
    if not test_key or not hmac.compare_digest(expected, test_key):
        return JSONResponse(status_code=403, content={"error": "测试设备密钥无效"})
    return None


def _devices() -> dict[str, dict[str, Any]]:
    data = store.load("eink_devices", {})
    return data if isinstance(data, dict) else {}


def _public_device(device: dict[str, Any]) -> dict[str, Any]:
    private_keys = {
        "device_token",
        "account_token",
        "frame_path",
        "setup_token_digest",
        "setup_token_expires_at",
        "reprovision_setup_token_digest",
        "reprovision_setup_token_expires_at",
    }
    return {key: value for key, value in device.items() if key not in private_keys}


def _test_device_or_response(
    device_id: str,
    devices: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any] | None, Response | None]:
    device = devices.get(device_id)
    if not device:
        return None, JSONResponse(status_code=404, content={"error": "没有找到模拟照片墙"})
    if not device.get("test_device"):
        return None, JSONResponse(status_code=403, content={"error": "不能用测试接口控制真实照片墙"})
    return device, None


def _ensure_revision(device: dict[str, Any], *, new_revision: bool = False) -> str:
    revision = str(device.get("revision", ""))
    if new_revision or not revision:
        revision = f"sim-{time.time_ns()}"
        device["revision"] = revision
        device["published_at"] = time.time()
        device["preview_url"] = ""
    return revision


def _set_state(
    device: dict[str, Any],
    state: str,
    progress: float | None = None,
    error: str = "",
) -> None:
    state = state.strip().lower()
    if state == "online":
        for key in ("revision", "displayed_revision", "published_at", "preview_url", "frame_path"):
            device.pop(key, None)
    elif state == "queued":
        _ensure_revision(
            device,
            new_revision=str(device.get("state", "")).lower() in {"displayed", "failed"},
        )
        device["displayed_revision"] = ""
    elif state in {"downloading", "displaying", "displayed", "failed"}:
        revision = _ensure_revision(device)
        if state == "displayed":
            device["displayed_revision"] = revision

    device.update({
        "state": state,
        "progress": max(0.0, min(float(
            _DEFAULT_PROGRESS[state] if progress is None else progress
        ), 100.0)),
        "error": (error or "模拟墨水屏刷新失败") if state == "failed" else "",
        "last_seen": time.time(),
    })


@router.post("/api/test/devices")
def create_test_device(
    req: CreateTestDeviceReq,
    x_photowall_test_key: str = Header(default=""),
) -> Response:
    denied = _test_api_response(x_photowall_test_key)
    if denied:
        return denied

    now = time.time()
    suffix = secrets.token_hex(4)
    device_id = f"pwe6-sim-{suffix}"
    account_token = secrets.token_urlsafe(32)
    device = {
        "device_id": device_id,
        "device_token": secrets.token_urlsafe(32),
        "account_token": account_token,
        "claimed": True,
        "test_device": True,
        "name": " ".join(req.name.strip().split())[:40] or "模拟照片墙",
        "firmware_version": "software-simulator",
        "ip": "simulator",
        "created_at": now,
        "last_seen": now,
        "state": "online",
        "progress": 0.0,
        "error": "",
    }
    devices = _devices()
    devices[device_id] = device
    store.save("eink_devices", devices)
    return JSONResponse({
        "device": _public_device(device),
        "account_token": account_token,
    })


@router.patch("/api/test/devices/{device_id}/state")
def set_test_device_state(
    device_id: str,
    req: TestDeviceStateReq,
    x_photowall_test_key: str = Header(default=""),
) -> Response:
    denied = _test_api_response(x_photowall_test_key)
    if denied:
        return denied
    state = req.state.strip().lower()
    if state not in _ALLOWED_STATES:
        return JSONResponse(status_code=400, content={"error": "模拟设备状态无效"})
    devices = _devices()
    device, error_response = _test_device_or_response(device_id, devices)
    if error_response:
        return error_response
    assert device is not None
    _set_state(device, state, req.progress, req.error)
    devices[device_id] = device
    store.save("eink_devices", devices)
    return JSONResponse({"device": _public_device(device)})


@router.post("/api/test/devices/{device_id}/advance")
def advance_test_device(
    device_id: str,
    x_photowall_test_key: str = Header(default=""),
) -> Response:
    denied = _test_api_response(x_photowall_test_key)
    if denied:
        return denied
    devices = _devices()
    device, error_response = _test_device_or_response(device_id, devices)
    if error_response:
        return error_response
    assert device is not None
    current = str(device.get("state", "online")).lower()
    _set_state(device, _NEXT_STATE.get(current, "queued"))
    devices[device_id] = device
    store.save("eink_devices", devices)
    return JSONResponse({"device": _public_device(device)})


@router.delete("/api/test/devices/{device_id}")
def delete_test_device(
    device_id: str,
    x_photowall_test_key: str = Header(default=""),
) -> Response:
    denied = _test_api_response(x_photowall_test_key)
    if denied:
        return denied
    devices = _devices()
    _device, error_response = _test_device_or_response(device_id, devices)
    if error_response:
        return error_response
    devices.pop(device_id, None)
    store.save("eink_devices", devices)
    return JSONResponse({"ok": True, "device_id": device_id})

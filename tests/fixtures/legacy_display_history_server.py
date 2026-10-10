"""Exact relevant functions from the 2026-10-10 legacy production source.

Source SHA256: dd05f9239cecfbc832e1c8759b75cc345340b64138efc1702f69e30b2365f773
Only synthetic data is used by the test harness; this is never imported.
"""
from __future__ import annotations
from . import clip, eink_push, store


def _devices() -> dict[str, dict[str, Any]]:
    data = store.load("eink_devices", {})
    return data if isinstance(data, dict) else {}


def _device_auth(device: dict[str, Any], token: str) -> bool:
    expected = str(device.get("device_token", ""))
    return bool(expected and token and secrets.compare_digest(expected, token))


def _account_auth(device: dict[str, Any], token: str) -> bool:
    expected = str(device.get("account_token", ""))
    return bool(expected and token and secrets.compare_digest(expected, token))


def _queue_device_image(device: dict[str, Any], image_bytes: bytes) -> tuple[str, str]:
    """Convert an image to PWE6 and make it the device's next cloud-pulled frame."""
    preview, panel_codes = eink_push.prepare_image(
        image_bytes,
        dither=True,
        fit="contain",
        rotation=0,
        enhancement="standard",
    )
    revision = str(time.time_ns())
    device_id = str(device["device_id"])
    device_dir = os.path.join(DEVICE_FRAMES_DIR, device_id)
    os.makedirs(device_dir, exist_ok=True)
    frame_path = os.path.join(device_dir, f"{revision}.pwe6")
    preview_path = os.path.join(device_dir, f"{revision}.png")
    with open(frame_path, "wb") as output:
        output.write(eink_push.build_panel_frame(panel_codes))
    preview.save(preview_path, format="PNG", optimize=True)
    device.update({
        "revision": revision,
        "frame_path": frame_path,
        "preview_url": f"/output/device_frames/{device_id}/{revision}.png",
        "published_at": time.time(),
        "state": "queued",
        "progress": 0.0,
        "error": "",
    })
    return revision, preview_path


@app.post("/api/devices/{device_id}/publish")
async def device_publish(
    device_id: str,
    file: UploadFile,
    dither: bool = True,
    fit: str = "contain",
    rotation: int = 0,
    enhancement: str = "standard",
    x_account_token: str = Header(default=""),
) -> Response:
    """App 上传照片，云端转换为 PWE6 并设置为设备下一待显示版本。"""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _account_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    if not _is_eink_device(device):
        return JSONResponse(status_code=409, content={"error": "19 寸屏使用实时展示通道，不支持墨水屏帧发布"})
    if fit not in ("contain", "cover") or rotation not in (0, 90, 180, 270):
        return JSONResponse(status_code=400, content={"error": "图片适配参数无效"})
    if enhancement not in ("none", "standard", "strong"):
        return JSONResponse(status_code=400, content={"error": "显色增强参数无效"})

    image_bytes = await file.read()
    if not image_bytes or len(image_bytes) > 30 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": "请选择不超过 30MB 的图片"})
    try:
        preview, panel_codes = eink_push.prepare_image(
            image_bytes, dither=dither, fit=fit, rotation=rotation, enhancement=enhancement)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "无法识别或转换该图片"})

    revision = str(time.time_ns())
    device_dir = os.path.join(DEVICE_FRAMES_DIR, device_id)
    os.makedirs(device_dir, exist_ok=True)
    frame_path = os.path.join(device_dir, f"{revision}.pwe6")
    preview_path = os.path.join(device_dir, f"{revision}.png")
    frame_data = eink_push.build_panel_frame(panel_codes)
    with open(frame_path, "wb") as output:
        output.write(frame_data)
    preview.save(preview_path, format="PNG", optimize=True)

    device.update({
        "revision": revision,
        "frame_path": frame_path,
        "preview_url": f"/output/device_frames/{device_id}/{revision}.png",
        "published_at": time.time(),
        "state": "queued",
        "progress": 0.0,
        "error": "",
    })
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "revision": revision})


@app.post("/api/devices/{device_id}/publish-last-wall")
async def device_publish_last_wall(
    device_id: str,
    req: Optional[PublishWallReq] = None,
    x_account_token: str = Header(default=""),
) -> Response:
    """Queue the most recently generated cloud template after App confirmation."""
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _account_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    scope = _account_scope(str(device.get("account_token", "")))
    wall = store.load(_scoped_store_name("last_wall", scope), {})
    requested_wall_id = str(req.wall_id if req else "")
    if requested_wall_id and requested_wall_id != str(wall.get("wall_id", "")):
        return JSONResponse(
            status_code=409,
            content={"error": "当前预览已被新画面替换，请重新生成后再发布"},
        )
    image_url = str(wall.get("image_url", ""))
    if not image_url.startswith("/output/"):
        return JSONResponse(status_code=404, content={"error": "没有可发布的模板预览，请先生成画面"})
    image_path = os.path.join(OUTPUT_DIR, os.path.basename(image_url))
    if not os.path.isfile(image_path):
        return JSONResponse(status_code=404, content={"error": "模板预览已过期，请重新生成"})
    if _device_family(device) == DEVICE_FAMILY_WALNUTPI_19IN:
        revision = str(wall.get("wall_id", ""))
        device.pop("frame_path", None)
        device.pop("preview_url", None)
        device.update({
            "revision": revision,
            "published_at": time.time(),
            "state": "queued",
            "progress": 100.0,
            "error": "",
        })
        devices_data[device_id] = device
        store.save("eink_devices", devices_data)
        await hub.broadcast({"type": "wall", **wall}, target_device_ids={device_id})
        return JSONResponse({
            "device": _public_device(device),
            "revision": revision,
            "wall": wall,
            "delivery": "screen19_websocket",
        })
    if not _is_eink_device(device):
        return JSONResponse(status_code=409, content={"error": "当前设备不支持墨水屏帧发布"})
    with open(image_path, "rb") as image_file:
        revision, _ = _queue_device_image(device, image_file.read())
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"device": _public_device(device), "revision": revision, "wall": wall})


@app.post("/api/devices/{device_id}/status")
def device_status(device_id: str, req: DeviceStatusReq, token: str = "") -> Response:
    devices_data = _devices()
    device = devices_data.get(device_id)
    if not device or not _device_auth(device, token):
        return JSONResponse(status_code=401, content={"error": "设备凭据无效"})
    pending = device.get("pending_command")
    if req.state == "unbound":
        if not isinstance(pending, dict) or pending.get("type") != "reprovision":
            return JSONResponse(status_code=409, content={"error": "设备没有待执行的删除命令"})
        devices_data.pop(device_id, None)
        store.save("eink_devices", devices_data)
        return JSONResponse({"ok": True, "removed": True})
    device.update({
        "state": req.state[:24],
        "progress": max(0.0, min(float(req.progress), 100.0)),
        "error": req.error[:240],
        "last_seen": time.time(),
        "ip": req.ip or device.get("ip", ""),
    })
    if req.state == "displayed" and req.revision == str(device.get("revision", "")):
        device["displayed_revision"] = req.revision
    devices_data[device_id] = device
    store.save("eink_devices", devices_data)
    return JSONResponse({"ok": True})

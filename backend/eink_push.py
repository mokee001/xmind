"""Waveshare 13.3E6 Wi-Fi Loader image conversion and upload.

Implements the protocol used by the official Arduino 05_Loader_esp32wf example.
The board must already be running that loader firmware.
"""

from __future__ import annotations

import http.client
import io
import os
import threading
import time
from typing import Any, Union

from PIL import Image, ImageEnhance, ImageOps

WIDTH = 1200
HEIGHT = 1600
HALF_WIDTH = WIDTH // 2
CHUNK_PIXELS = 1000

# Compact quantization palette and the corresponding panel color codes.
# Panel codes: 0 black, 1 white, 2 yellow, 3 red, 5 blue, 6 green.
_RGB_COLORS = [
    (0, 0, 0),
    (255, 255, 255),
    (255, 255, 0),
    (255, 0, 0),
    (0, 0, 255),
    (0, 255, 0),
]
_PANEL_CODES = (0, 1, 2, 3, 5, 6)

_state_lock = threading.Lock()
_upload_lock = threading.Lock()
_state: dict[str, Any] = {
    "state": "idle",
    "progress": 0.0,
    "stage": "等待上传",
    "error": None,
    "host": os.getenv("EINK_HOST", "192.168.1.200"),
    "started_at": 0.0,
    "updated_at": 0.0,
    "preview_url": None,
}


def _set_state(**values: Any) -> None:
    with _state_lock:
        _state.update(values)
        _state["updated_at"] = time.time()


def status() -> dict[str, Any]:
    with _state_lock:
        return dict(_state)


def _palette() -> Image.Image:
    palette = Image.new("P", (1, 1))
    raw = [component for color in _RGB_COLORS for component in color]
    palette.putpalette(raw + [0] * (768 - len(raw)))
    return palette


def _enhance_for_panel(source: Image.Image, enhancement: str) -> Image.Image:
    """Compensate for the panel's pale highlights before six-color quantization."""
    if enhancement == "none":
        return source

    if enhancement == "strong":
        cutoff, contrast, color, gamma = 2.0, 1.32, 1.24, 1.12
    else:
        cutoff, contrast, color, gamma = 1.0, 1.18, 1.12, 1.07

    # Stretch weak black/white points first, then darken mid-tones slightly. Applying
    # this before fitting keeps the optional white letterbox border truly white.
    enhanced = ImageOps.autocontrast(source, cutoff=cutoff)
    enhanced = ImageEnhance.Contrast(enhanced).enhance(contrast)
    enhanced = ImageEnhance.Color(enhanced).enhance(color)
    lut = [round(255 * ((value / 255) ** gamma)) for value in range(256)]
    return enhanced.point(lut * 3)


def prepare_image(
    image_bytes: bytes,
    *,
    dither: bool = True,
    fit: str = "contain",
    rotation: int = 0,
    enhancement: str = "standard",
) -> tuple[Image.Image, bytearray]:
    """Convert an uploaded image to the native 1200x1600 six-color panel image."""
    with Image.open(io.BytesIO(image_bytes)) as opened:
        source = ImageOps.exif_transpose(opened).convert("RGB")

    if rotation in (90, 180, 270):
        source = source.rotate(-rotation, expand=True)

    source = _enhance_for_panel(source, enhancement)

    if fit == "cover":
        canvas = ImageOps.fit(source, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)
    else:
        fitted = ImageOps.contain(source, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (WIDTH, HEIGHT), "white")
        canvas.paste(fitted, ((WIDTH - fitted.width) // 2, (HEIGHT - fitted.height) // 2))

    dither_mode = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    compact = canvas.quantize(palette=_palette(), dither=dither_mode)
    compact_indices = compact.tobytes()
    panel_codes = bytearray(_PANEL_CODES[index] for index in compact_indices)
    return compact, panel_codes


def _byte_to_str(value: int) -> str:
    return chr(97 + (value & 0x0F)) + chr(97 + ((value >> 4) & 0x0F))


def _word_to_str(value: int) -> str:
    return _byte_to_str(value & 0xFF) + _byte_to_str((value >> 8) & 0xFF)


def _encode_pixels(pixels: Union[bytes, bytearray]) -> str:
    """Pack four 4-bit panel color codes into four a-p protocol characters."""
    encoded: list[str] = []
    for offset in range(0, len(pixels), 4):
        value = 0
        for shift, color in enumerate(pixels[offset:offset + 4]):
            value |= (color & 0x0F) << (shift * 4)
        encoded.append(_word_to_str(value))
    return "".join(encoded)


def _post_command(host: str, command: str, timeout: float = 12.0) -> None:
    connection = http.client.HTTPConnection(host, 80, timeout=timeout)
    try:
        connection.request("POST", "/" + command, body=b"", headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read()
        if response.status != 200 or b"Ok!" not in body:
            raise RuntimeError(f"设备响应异常: HTTP {response.status} {body[:80]!r}")
    finally:
        connection.close()


def _channel_pixels(panel_codes: bytearray, start_x: int) -> bytearray:
    channel = bytearray(HALF_WIDTH * HEIGHT)
    target = 0
    for y in range(HEIGHT):
        source = y * WIDTH + start_x
        channel[target:target + HALF_WIDTH] = panel_codes[source:source + HALF_WIDTH]
        target += HALF_WIDTH
    return channel


def _send_channel(host: str, pixels: bytearray, start_progress: float, span: float, label: str) -> None:
    total = len(pixels)
    for offset in range(0, total, CHUNK_PIXELS):
        chunk = pixels[offset:offset + CHUNK_PIXELS]
        encoded = _encode_pixels(chunk)
        command = encoded + _word_to_str(len(encoded)) + "LOAD_"
        _post_command(host, command)
        progress = start_progress + span * min(offset + len(chunk), total) / total
        _set_state(progress=round(progress, 1), stage=label)


def upload_panel_codes(host: str, panel_codes: bytearray) -> None:
    """Upload a native panel image through the official Loader protocol."""
    if len(panel_codes) != WIDTH * HEIGHT:
        raise ValueError(f"像素数量错误: {len(panel_codes)}")

    _set_state(progress=1.0, stage="初始化墨水屏")
    _post_command(host, "EPDY_", timeout=30.0)

    left = _channel_pixels(panel_codes, 0)
    right = _channel_pixels(panel_codes, HALF_WIDTH)
    _send_channel(host, left, 2.0, 47.0, "发送左半屏")

    _set_state(progress=50.0, stage="切换右半屏")
    _post_command(host, "NEXT_")
    _send_channel(host, right, 51.0, 47.0, "发送右半屏")

    _set_state(progress=99.0, stage="墨水屏全刷中（约 19 秒）")
    _post_command(host, "SHOW_", timeout=90.0)


def _worker(
    image_bytes: bytes,
    host: str,
    dither: bool,
    fit: str,
    rotation: int,
    enhancement: str,
    preview_path: str,
    preview_url: str,
) -> None:
    try:
        _set_state(state="processing", progress=0.0, stage="转换六色图片", error=None)
        preview, panel_codes = prepare_image(
            image_bytes,
            dither=dither,
            fit=fit,
            rotation=rotation,
            enhancement=enhancement,
        )
        preview.save(preview_path, format="PNG", optimize=True)
        _set_state(state="uploading", preview_url=preview_url, stage="连接墨水屏")
        upload_panel_codes(host, panel_codes)
        _set_state(state="done", progress=100.0, stage="显示完成")
    except Exception as exc:
        _set_state(state="error", stage="推送失败", error=str(exc))
    finally:
        _upload_lock.release()


def start_upload(
    image_bytes: bytes,
    *,
    host: str,
    dither: bool,
    fit: str,
    rotation: int,
    enhancement: str,
    preview_path: str,
    preview_url: str,
) -> dict[str, Any]:
    if not _upload_lock.acquire(blocking=False):
        raise RuntimeError("已有图片正在推送，请等待当前任务完成")

    _set_state(
        state="queued",
        progress=0.0,
        stage="准备处理",
        error=None,
        host=host,
        started_at=time.time(),
        preview_url=None,
    )
    thread = threading.Thread(
        target=_worker,
        args=(image_bytes, host, dither, fit, rotation, enhancement, preview_path, preview_url),
        daemon=True,
        name="eink-uploader",
    )
    thread.start()
    return status()

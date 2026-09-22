from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import threading
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = ROOT / "assets" / "templates"
CUTOUT_CACHE = Path(os.getenv("PHOTOWALL_DATA_DIR", ROOT)) / "output" / "template_cutouts"
PACKAGE_IDS = ("template_1", "template_2", "template_3")


def cutout_unavailable_reason() -> str:
    if importlib.util.find_spec("rembg") is None or importlib.util.find_spec("onnxruntime") is None:
        return "分层抠图拼贴所需的 rembg / onnxruntime 尚未部署"
    model_home = Path(os.getenv("PHOTO_WALL_REMBG_HOME", os.getenv("U2NET_HOME", str(ROOT / ".cache/rembg"))))
    if not (model_home / "isnet-general-use.onnx").is_file():
        return "分层抠图拼贴所需的 isnet-general-use 模型尚未部署"
    return ""

_session_lock = threading.Lock()
_rembg_session: Any = None
_rembg_remove: Any = None


def is_package(template_id: str) -> bool:
    return template_id in PACKAGE_IDS


def load_package(template_id: str) -> dict[str, Any]:
    if not is_package(template_id):
        raise ValueError(f"Unknown template package: {template_id}")
    path = ASSET_ROOT / template_id / "template.json"
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def required_photo_count(template_id: str) -> int:
    package = load_package(template_id)
    if template_id == "template_3":
        return int(package["requiredPhotoCount"])
    return int(package["image_requirement"]["total_images"])


def render(
    template_id: str,
    photo_paths: list[str],
    context: dict[str, str] | None = None,
) -> Image.Image:
    required = required_photo_count(template_id)
    if len(photo_paths) < required:
        raise ValueError(f"{template_id} requires {required} photos, got {len(photo_paths)}")
    context = context or {}
    if template_id == "template_1":
        return _render_template_1(photo_paths[:required], context)
    if template_id == "template_2":
        return _render_template_2(photo_paths[:required], context)
    return _render_template_3(photo_paths[:required])


def _open_image(path: str | Path) -> Image.Image:
    with Image.open(path) as source:
        return ImageOps.exif_transpose(source).convert("RGBA")


def _cover(image: Image.Image, width: int, height: int, align_y: str = "center") -> Image.Image:
    centering_y = 0.0 if align_y == "top" else 1.0 if align_y == "bottom" else 0.5
    return ImageOps.fit(
        image,
        (max(1, width), max(1, height)),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, centering_y),
    )


def _rounded(image: Image.Image, radius: int) -> Image.Image:
    if radius <= 0:
        return image
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, image.width - 1, image.height - 1),
        radius=radius,
        fill=255,
    )
    result = image.copy()
    result.putalpha(mask)
    return result


def _paste_transformed(
    canvas: Image.Image,
    image: Image.Image,
    frame: dict[str, Any],
    *,
    rotation: float = 0.0,
    radius: float = 0.0,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
) -> None:
    width = max(1, round(float(frame.get("width", frame.get("w", 1)))))
    height = max(1, round(float(frame.get("height", frame.get("h", 1)))))
    tile = _cover(image, width, height, str(frame.get("alignY", "center")))
    tile = _rounded(tile, round(radius))
    if scale_x < 0:
        tile = ImageOps.mirror(tile)
    if scale_y < 0:
        tile = ImageOps.flip(tile)
    if rotation:
        tile = tile.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)
    center_x = float(frame.get("x", 0)) + width / 2
    center_y = float(frame.get("y", 0)) + height / 2
    canvas.alpha_composite(tile, (round(center_x - tile.width / 2), round(center_y - tile.height / 2)))


def _font(size: int, path: Path | None = None) -> ImageFont.FreeTypeFont:
    candidates = [
        path,
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                continue
    return ImageFont.load_default()


def _fitted_font(text: str, width: int, start_size: int, minimum: int, path: Path | None = None) -> ImageFont.FreeTypeFont:
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for size in range(start_size, minimum - 1, -2):
        font = _font(size, path)
        bounds = probe.textbbox((0, 0), text, font=font)
        if bounds[2] - bounds[0] <= width:
            return font
    return _font(minimum, path)


def _render_template_1(photo_paths: list[str], context: dict[str, str]) -> Image.Image:
    package = load_package("template_1")
    canvas = _cover(_open_image(ASSET_ROOT / "template_1" / "bg.png"), 2000, 2668)
    for path, slot in zip(photo_paths, package["slots"]):
        _paste_transformed(canvas, _open_image(path), slot["frame"])

    defaults = package.get("default_copy", {})
    values = {
        "sentence_line_1": context.get("line1", defaults.get("line_1", "")),
        "sentence_line_2": context.get("line2", defaults.get("line_2", "")),
        "sentence_line_3": context.get("line3", defaults.get("line_3", "")),
        "theme_or_mood_tag": context.get("tag", defaults.get("tag", "")),
    }
    draw = ImageDraw.Draw(canvas)
    for text_slot in package.get("text_slots", []):
        role = text_slot.get("role")
        frame = text_slot["frame"]
        if role == "user_nickname_signature":
            nickname = context.get("nickname", defaults.get("nickname", "Me"))[:18]
            text = str(text_slot.get("template", "{nickname}Plog")).format(nickname=nickname)
            font_path = ASSET_ROOT / "template_1" / "fonts" / "momo-zhuanji-handwriting-4.0.ttf"
            font = _fitted_font(text, int(frame["width"]), 64, 36, font_path)
            bounds = draw.textbbox((0, 0), text, font=font)
            x = int(frame["x"] + (frame["width"] - (bounds[2] - bounds[0])) / 2)
            draw.text((x, int(frame["y"])), text, font=font, fill=(255, 255, 255, 204))
            continue
        text = values.get(str(role), "")
        if not text:
            continue
        style = text_slot.get("style", {})
        font = _fitted_font(text, int(frame["width"]), int(style.get("font_size", 44)), 28)
        draw.text((int(frame["x"]), int(frame["y"])), text, font=font, fill=style.get("color", "#C4CED1"))
    return canvas.convert("RGB")


def _render_template_2(photo_paths: list[str], context: dict[str, str]) -> Image.Image:
    package = load_package("template_2")
    canvas = _cover(_open_image(ASSET_ROOT / "template_2" / "bg.jpg"), 2000, 2668)
    for path, slot in zip(photo_paths, package["slots"]):
        transform = slot.get("transform", {})
        _paste_transformed(
            canvas,
            _open_image(path),
            slot["frame"],
            rotation=float(transform.get("rotation_degrees", 0)),
            radius=float(slot.get("style", {}).get("corner_radius", 0)),
        )
    overlay = _cover(_open_image(ASSET_ROOT / "template_2" / "sticker.png"), 2000, 2668)
    canvas.alpha_composite(overlay)

    defaults = package.get("default_copy", {})
    nickname = context.get("nickname", defaults.get("nickname", "chenchen"))[:18]
    text = f"{nickname}’Plog"
    font_path = ASSET_ROOT / "template_2" / "assets" / "momo-zhuanji-handwriting-4.0.ttf"
    font = _fitted_font(text, 478, 64, 36, font_path)
    draw = ImageDraw.Draw(canvas)
    bounds = draw.textbbox((0, 0), text, font=font)
    draw.text((762 + (478 - (bounds[2] - bounds[0])) / 2, 2516), text, font=font, fill="white")
    return canvas.convert("RGB")


def _cutout(path: str) -> Image.Image:
    reason = cutout_unavailable_reason()
    if reason:
        raise RuntimeError(reason)
    source = Path(path)
    identity = f"{source.resolve()}:{source.stat().st_size}:{source.stat().st_mtime_ns}"
    cache_path = CUTOUT_CACHE / f"{hashlib.sha256(identity.encode()).hexdigest()}.png"
    if cache_path.exists():
        return _open_image(cache_path)

    global _rembg_remove
    global _rembg_session
    with _session_lock:
        if _rembg_remove is None:
            try:
                from rembg import new_session, remove
            except ImportError as exc:
                raise RuntimeError("template_3 requires rembg and onnxruntime") from exc
            model_home = Path(os.getenv("PHOTO_WALL_REMBG_HOME", os.getenv("U2NET_HOME", str(ROOT / ".cache/rembg"))))
            os.environ["U2NET_HOME"] = str(model_home)
            _rembg_session = new_session("isnet-general-use", providers=["CPUExecutionProvider"])
            _rembg_remove = remove
        with source.open("rb") as image_file:
            output = _rembg_remove(image_file.read(), session=_rembg_session)

    CUTOUT_CACHE.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(output)
    return Image.open(io.BytesIO(output)).convert("RGBA")


def _render_template_3(photo_paths: list[str]) -> Image.Image:
    package = load_package("template_3")
    canvas = Image.new("RGBA", (2000, 2668), package["canvas"].get("backgroundColor", "#140A12"))
    for layer in package.get("layers", []):
        frame = dict(layer["frame"])
        frame["alignY"] = layer.get("alignY", "center")
        layer_type = layer.get("type")
        if layer_type == "mock":
            width = max(1, round(float(frame.get("width", 1))))
            height = max(1, round(float(frame.get("height", 1))))
            mock = Image.new("RGBA", (width, height), layer.get("color", "#F8F8F8"))
            _paste_transformed(
                canvas,
                mock,
                frame,
                rotation=float(layer.get("rotationDegrees", 0)),
                radius=float(layer.get("cornerRadius", 0)),
            )
            continue
        if layer_type not in ("image", "image_cutout"):
            continue
        path = photo_paths[int(layer["index"])]
        image = _cutout(path) if layer_type == "image_cutout" else _open_image(path)
        _paste_transformed(
            canvas,
            image,
            frame,
            rotation=float(layer.get("rotationDegrees", 0)),
            radius=float(layer.get("cornerRadius", 0)),
            scale_x=float(layer.get("scaleX", 1)),
            scale_y=float(layer.get("scaleY", 1)),
        )
    return canvas.convert("RGB")

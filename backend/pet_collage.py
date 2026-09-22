from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from pydantic import BaseModel, Field, ValidationError

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

from . import store


ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = Path(os.environ.get("PHOTOWALL_DATA_DIR", str(ROOT)))
OUTPUT_ROOT = DATA_ROOT / "output"
JOB_ROOT = DATA_ROOT / "pet_collage_jobs"
ASSET_ROOT = ROOT / "assets" / "templates" / "denim"
REQUIRED_PHOTOS = 5
MAX_ANALYSIS_PHOTOS = 40
ANALYSIS_BATCH_SIZE = 5
MAX_CUTOUT_BYTES = 30 * 1024 * 1024

_lock = threading.Lock()


class PetPhotoScore(BaseModel):
    filename: str
    is_pet: bool
    pet_count: int = Field(ge=0, le=8)
    has_human: bool
    blur_type: str
    technical_quality: float = Field(ge=0, le=10)
    life_moment: float = Field(ge=0, le=10)
    subject_ratio: float = Field(ge=0, le=100)
    pet_id: str
    face_score: float = Field(ge=0, le=10)
    shot_type: str
    background_complexity: float = Field(ge=0, le=5)
    dominant_color: str = "#808080"


class PetPhotoScoreBatch(BaseModel):
    items: list[PetPhotoScore]


def _job_path(scope: str, job_id: str) -> Path:
    return JOB_ROOT / scope / f"{job_id}.json"


def _save_job(job: dict[str, Any]) -> None:
    path = _job_path(str(job["scope"]), str(job["job_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with _lock:
        temporary.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)


def get_job(scope: str, job_id: str) -> dict[str, Any] | None:
    path = _job_path(scope, job_id)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key not in {"scope", "candidates", "cutouts", "scores"}
    }


def _candidate_rank(photo: dict[str, Any]) -> tuple[float, float]:
    return (
        float(photo.get("final_score", 0.0)),
        float(photo.get("quality", 0.0)),
    )


def start_job(scope: str, photos: list[dict[str, Any]]) -> dict[str, Any]:
    usable = [photo for photo in photos if photo.get("path") and Path(str(photo["path"])).is_file()]
    pet_candidates = [
        photo for photo in usable
        if {str(tag).lower() for tag in photo.get("tags", [])}.intersection({"pet", "cat", "dog"})
    ]
    candidates = pet_candidates if len(pet_candidates) >= REQUIRED_PHOTOS else usable
    candidates = sorted(candidates, key=_candidate_rank, reverse=True)[:MAX_ANALYSIS_PHOTOS]
    if len(candidates) < REQUIRED_PHOTOS:
        raise ValueError("至少需要 5 张已同步照片才能分析宠物拼贴")

    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "scope": scope,
        "template": "denim_pet",
        "status": "analyzing",
        "progress": 5,
        "message": f"正在分析 {len(candidates)} 张候选照片",
        "created_at": time.time(),
        "updated_at": time.time(),
        "candidates": [
            {"filename": str(photo.get("filename") or Path(str(photo["path"])).name), "path": str(photo["path"])}
            for photo in candidates
        ],
        "selected": [],
        "cutouts": {},
        "image_url": "",
        "error": "",
    }
    _save_job(job)
    return public_job(job)


def _cluster_key(score: PetPhotoScore) -> str | None:
    parts = [part.strip().lower() for part in score.pet_id.split("-") if part.strip()]
    if len(parts) < 2 or score.pet_id.strip().lower() == "none":
        return None
    return "-".join(parts[:2])


def _passes_common(score: PetPhotoScore) -> bool:
    return (
        score.is_pet
        and score.pet_count == 1
        and not score.has_human
        and score.blur_type != "out_of_focus"
        and score.shot_type in {"close_up", "half_body"}
    )


def passes_strict(score: PetPhotoScore) -> bool:
    return (
        _passes_common(score)
        and score.technical_quality >= 7
        and score.face_score >= 7
        and score.background_complexity < 4
    )


def passes_loose(score: PetPhotoScore) -> bool:
    return (
        _passes_common(score)
        and score.technical_quality >= 6
        and score.face_score >= 6
        and score.background_complexity < 5
    )


def composite_score(score: PetPhotoScore) -> float:
    return (
        score.subject_ratio / 10.0 * 0.40
        + score.technical_quality * 0.40
        + score.life_moment * 0.20
    )


def _hex_rgb(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        return 128, 128, 128
    try:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
    except ValueError:
        return 128, 128, 128


def _color_distance(first: str, second: str) -> float:
    a = _hex_rgb(first)
    b = _hex_rgb(second)
    return sum((left - right) ** 2 for left, right in zip(a, b)) ** 0.5


def select_scores(scores: list[PetPhotoScore]) -> list[dict[str, Any]]:
    grouped: dict[str, list[PetPhotoScore]] = {}
    for predicate in (passes_strict, passes_loose):
        grouped.clear()
        for score in scores:
            key = _cluster_key(score)
            if key and predicate(score):
                grouped.setdefault(key, []).append(score)
        eligible = {key: values for key, values in grouped.items() if len(values) >= REQUIRED_PHOTOS}
        if eligible:
            grouped = eligible
            break
    else:
        raise ValueError("没有找到同一只宠物的 5 张合格近景或半身照片")

    cluster = max(
        grouped.values(),
        key=lambda values: (len(values), sum(composite_score(item) for item in values[:10])),
    )
    hero = max(cluster, key=composite_score)
    remaining = [item for item in cluster if item.filename != hero.filename]
    remaining.sort(
        key=lambda item: composite_score(item) - _color_distance(item.dominant_color, hero.dominant_color) / 50.0,
        reverse=True,
    )
    side_slots = ["photo_1", "photo_2", "photo_3", "photo_4"]
    selected = [
        {"slot": slot, "filename": score.filename, "mirror": False}
        for slot, score in zip(side_slots, remaining[:4])
    ]
    selected.append({"slot": "photo_hero", "filename": hero.filename, "mirror": False})
    return selected


def _encoded_preview(path: Path) -> str:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def _parse_json_content(raw_content: Any) -> dict[str, Any]:
    if isinstance(raw_content, list):
        text = "".join(
            str(item.get("text", "")) for item in raw_content if isinstance(item, dict)
        ).strip()
    else:
        text = str(raw_content or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()[1:]
        if lines and lines[-1].strip() == "```":
            lines.pop()
        text = "\n".join(lines).strip()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Qwen 未返回 JSON 对象")
    return value


def _analyze_batch(candidates: list[dict[str, str]]) -> list[PetPhotoScore]:
    from openai import OpenAI

    api_key = (
        os.environ.get("QWEN_DECISION_API_KEY", "").strip()
        or os.environ.get("DASHSCOPE_API_KEY", "").strip()
    )
    if not api_key:
        raise RuntimeError("服务器尚未配置 QWEN_DECISION_API_KEY 或 DASHSCOPE_API_KEY")
    client = OpenAI(
        api_key=api_key,
        base_url=os.environ.get(
            "QWEN_DECISION_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
        timeout=180,
    )
    content: list[dict[str, Any]] = [{
        "type": "text",
        "text": (
            "逐张分析以下照片是否适合五图宠物拼贴。filename 必须原样返回。"
            "pet_id 使用 颜色-花纹-毛长-品种猜测；同一宠物应保持前两段稳定。"
            "shot_type 只能是 close_up、half_body、full_body、other。"
            "blur_type 只能是 none、motion、out_of_focus。只输出符合 Schema 的 JSON。\n"
            + json.dumps(PetPhotoScoreBatch.model_json_schema(), ensure_ascii=False)
        ),
    }]
    for candidate in candidates:
        content.extend([
            {"type": "text", "text": f"filename: {candidate['filename']}"},
            {"type": "image_url", "image_url": {"url": _encoded_preview(Path(candidate["path"]))}},
        ])

    last_error: Exception | None = None
    for _ in range(2):
        response = client.chat.completions.create(
            model=os.environ.get("PHOTOWALL_PET_VISION_MODEL", "qwen3-vl-plus"),
            messages=[
                {"role": "system", "content": "你是严格的宠物照片策展与身份聚类助手。"},
                {"role": "user", "content": content},
            ],
            response_format={"type": "json_object"},
            extra_body={"enable_thinking": False},
        )
        try:
            batch = PetPhotoScoreBatch.model_validate(_parse_json_content(response.choices[0].message.content))
            expected = {candidate["filename"] for candidate in candidates}
            actual = {item.filename for item in batch.items}
            if expected != actual:
                raise ValueError("Qwen 返回的 filename 与当前批次不一致")
            return batch.items
        except (json.JSONDecodeError, ValidationError, ValueError) as error:
            last_error = error
    raise RuntimeError(f"Qwen 宠物分析连续两次未通过校验：{last_error}")


def analyze_job(scope: str, job_id: str) -> None:
    job = get_job(scope, job_id)
    if not job or job.get("status") != "analyzing":
        return
    try:
        cache_key = "pet_collage_analysis" if scope == "legacy" else f"pet_collage_analysis_{scope}"
        cache = store.load(cache_key, {})
        scores: list[PetPhotoScore] = []
        pending: list[tuple[str, dict[str, str]]] = []
        for candidate in job["candidates"]:
            digest = hashlib.sha256(Path(candidate["path"]).read_bytes()).hexdigest()
            cached = cache.get(digest)
            if cached:
                scores.append(PetPhotoScore.model_validate(cached))
            else:
                pending.append((digest, candidate))

        total = max(1, len(pending))
        for offset in range(0, len(pending), ANALYSIS_BATCH_SIZE):
            batch_pairs = pending[offset:offset + ANALYSIS_BATCH_SIZE]
            analyzed = _analyze_batch([candidate for _, candidate in batch_pairs])
            by_name = {item.filename: item for item in analyzed}
            for digest, candidate in batch_pairs:
                item = by_name[candidate["filename"]]
                cache[digest] = item.model_dump()
                scores.append(item)
            store.save(cache_key, cache)
            job["progress"] = min(70, 10 + round((offset + len(batch_pairs)) / total * 60))
            job["message"] = f"已分析 {min(offset + len(batch_pairs), total)}/{total} 张照片"
            job["updated_at"] = time.time()
            _save_job(job)

        job["scores"] = [score.model_dump() for score in scores]
        job["selected"] = select_scores(scores)
        job["status"] = "awaiting_cutouts"
        job["progress"] = 72
        job["message"] = "已选出 5 张照片，等待 iPhone 抠图"
        job["updated_at"] = time.time()
        _save_job(job)
    except Exception as error:
        job["status"] = "failed"
        job["progress"] = 0
        job["error"] = str(error)
        job["message"] = "宠物照片分析失败"
        job["updated_at"] = time.time()
        _save_job(job)


def add_cutout(scope: str, job_id: str, filename: str, data: bytes) -> tuple[dict[str, Any], bool]:
    job = get_job(scope, job_id)
    if not job:
        raise FileNotFoundError("拼贴任务不存在或已过期")
    if job.get("status") not in {"awaiting_cutouts", "composing"}:
        raise ValueError("当前任务不接受抠图")
    selected = {item["filename"]: item for item in job.get("selected", [])}
    if filename not in selected:
        raise ValueError("这张照片不属于当前拼贴任务")
    if len(data) > MAX_CUTOUT_BYTES:
        raise ValueError("单张抠图不能超过 30 MB")
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            if source.format != "PNG" or source.mode not in {"RGBA", "LA"}:
                raise ValueError("iPhone 必须上传带透明通道的 PNG 抠图")
            alpha = source.getchannel("A")
            if alpha.getextrema() == (255, 255):
                raise ValueError("上传的 PNG 没有透明背景")
    except OSError as error:
        raise ValueError("无法读取 iPhone 抠图 PNG") from error

    cutout_dir = JOB_ROOT / scope / job_id / "cutouts"
    cutout_dir.mkdir(parents=True, exist_ok=True)
    slot = selected[filename]["slot"]
    path = cutout_dir / f"{slot}.png"
    path.write_bytes(data)
    job.setdefault("cutouts", {})[filename] = str(path)
    count = len(job["cutouts"])
    complete = count == REQUIRED_PHOTOS
    job["status"] = "composing" if complete else "awaiting_cutouts"
    job["progress"] = 72 + round(count / REQUIRED_PHOTOS * 18)
    job["message"] = "iPhone 抠图完成，正在合成" if complete else f"iPhone 已完成 {count}/5 张抠图"
    job["updated_at"] = time.time()
    _save_job(job)
    return public_job(job), complete


def _prepare_cutout(path: str, mirror: bool, target_width: int, target_height: int) -> Image.Image:
    with Image.open(path) as source:
        cutout = source.convert("RGBA")
    if mirror:
        cutout = ImageOps.mirror(cutout)
    pad = 45
    padded = Image.new("RGBA", (cutout.width + pad * 2, cutout.height + pad * 2))
    padded.alpha_composite(cutout, (pad, pad))
    alpha = padded.getchannel("A").point(lambda value: 255 if value > 128 else 0)
    red, green, blue, _ = padded.split()
    solid = Image.merge("RGBA", (red, green, blue, alpha))
    stroke_mask = alpha.filter(ImageFilter.MaxFilter(81))
    result = Image.new("RGBA", solid.size)
    result.paste(Image.new("RGBA", solid.size, "white"), mask=stroke_mask)
    result.paste(solid, mask=alpha)
    bounds = result.getbbox()
    if bounds:
        result = result.crop(bounds)
    rgb = ImageEnhance.Color(result.convert("RGB")).enhance(0.75)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.08)
    red, green, blue = rgb.split()
    result = Image.merge("RGBA", (red, green, blue, result.getchannel("A")))
    ratio = max(target_width / result.width, target_height / result.height)
    return result.resize(
        (max(1, round(result.width * ratio)), max(1, round(result.height * ratio))),
        Image.Resampling.LANCZOS,
    )


def _paste_centered(canvas: Image.Image, layer: Image.Image, item: dict[str, Any]) -> None:
    rotation = float(item.get("rotation", 0))
    if abs(rotation) > 0.1:
        layer = layer.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
    center_x = float(item["x"]) + float(item["width"]) / 2
    center_y = float(item["y"]) + float(item["height"]) / 2
    canvas.alpha_composite(layer, (round(center_x - layer.width / 2), round(center_y - layer.height / 2)))


def render_denim(
    selected: list[dict[str, Any]],
    cutouts: dict[str, str],
    output_path: Path,
    asset_root: Path = ASSET_ROOT,
) -> None:
    template = json.loads((asset_root / "template.json").read_text(encoding="utf-8"))
    width = round(float(template["canvas"]["width"]))
    height = round(float(template["canvas"]["height"]))
    with Image.open(asset_root / "background.png") as source:
        canvas = source.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS)

    selected_by_slot = {item["slot"]: item for item in selected}
    layers = [
        (int(item.get("z_index", 0)), "sticker", item)
        for item in template.get("stickers", [])
    ] + [
        (int(item.get("z_index", 0)), "photo", item)
        for item in template.get("photo_slots", [])
    ]
    scale_factor = 2.0
    for sticker in template.get("stickers", []):
        if abs(float(sticker.get("rotation", 0))) < 0.5:
            with Image.open(asset_root / sticker["asset_file"]) as source:
                scale_factor = source.width / float(sticker["width"])
            break

    for _, kind, item in sorted(layers, key=lambda value: value[0]):
        if kind == "photo":
            selection = selected_by_slot[item["name"]]
            layer = _prepare_cutout(
                cutouts[selection["filename"]],
                bool(selection.get("mirror")),
                round(float(item["width"])),
                round(float(item["height"])),
            )
        else:
            with Image.open(asset_root / item["asset_file"]) as source:
                sticker = source.convert("RGBA")
            layer = sticker.resize(
                (
                    max(1, round(sticker.width / scale_factor)),
                    max(1, round(sticker.height / scale_factor)),
                ),
                Image.Resampling.LANCZOS,
            )
        _paste_centered(canvas, layer, item)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, format="PNG", optimize=True)


def compose_job(scope: str, job_id: str) -> None:
    job = get_job(scope, job_id)
    if not job or job.get("status") != "composing":
        return
    try:
        output_name = f"{scope}_denim_pet_{time.time_ns()}.png"
        output_path = OUTPUT_ROOT / output_name
        render_denim(job["selected"], job["cutouts"], output_path)
        wall = {
            "wall_id": output_path.stem,
            "template": "denim_pet",
            "title": "宠物牛仔拼贴",
            "date": "",
            "image_url": f"/output/{output_name}",
            "elements": ["pet", "denim"],
            "filters": ["pet"],
            "excluded_filters": [],
            "filter_fallback": False,
            "chosen": [{"filename": item["filename"], "final_score": 1.0} for item in job["selected"]],
            "stickers": 18,
        }
        last_wall_key = "last_wall" if scope == "legacy" else f"last_wall_{scope}"
        store.save(last_wall_key, wall)
        job["status"] = "ready"
        job["progress"] = 100
        job["message"] = "拼贴预览已生成，等待确认发布"
        job["image_url"] = wall["image_url"]
        job["wall"] = wall
        job["updated_at"] = time.time()
        _save_job(job)
    except Exception as error:
        job["status"] = "failed"
        job["progress"] = 0
        job["error"] = str(error)
        job["message"] = "宠物拼贴合成失败"
        job["updated_at"] = time.time()
        _save_job(job)
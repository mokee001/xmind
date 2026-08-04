from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Sequence

from PIL import Image

from .analyzer import encode_image, load_config, validate_image
from .keychain import load_api_key
from .schemas import ImageTreatmentDecision, TreatmentMode


DEFAULT_QWEN_IMAGE_ENDPOINT = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/"
    "multimodal-generation/generation"
)


@dataclass(frozen=True)
class IllustrationGenerationResult:
    output_path: Path
    request_id: str
    model: str
    size: tuple[int, int]


def _style_prompt(brief: str) -> str:
    cleaned = brief.strip()
    if not cleaned:
        raise ValueError("插画简述不能为空。")
    return (
        "为 AI 手帐月历的一个小日期格绘制单个插画素材。\n"
        f"主题：{cleaned}\n"
        "固定风格：黑色单色手绘线描涂鸦，自然略不均匀的线条，"
        "轮廓优先，低细节，允许极少量实心黑色强调，保留至少三分之一留白。"
        "只突出一个核心主体或动作局部，使用特写或单一视觉重点。"
        "人物只画头像、头肩、上半身或动作相关局部，禁止人物全身。"
        "禁止写实、3D、彩色填充、渐变、阴影、复杂背景、完整环境场景、"
        "品牌标志、二维码、条形码。不要生成文字。"
        "画面背景使用纯白，主体边缘清楚，便于本地去白底后缩小到日历格。"
    )


def _build_request_payload(
    *,
    model: str,
    brief: str,
    size: str,
    reference_paths: Sequence[Path] = (),
) -> Dict[str, Any]:
    if len(reference_paths) > 3:
        raise ValueError("Qwen 插画生成最多接收 3 张参考图。")
    content: list[Dict[str, str]] = []
    for path in reference_paths:
        validate_image(path)
        content.append({"image": encode_image(path)})
    content.append({"text": _style_prompt(brief)})
    return {
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": {
            "n": 1,
            "size": size,
            "prompt_extend": False,
            "watermark": False,
            "negative_prompt": (
                "photorealistic, 3d, clay, full body person, detailed background, "
                "color fill, gradient, shadow, logo, qr code, barcode, text"
            ),
        },
    }


def _post_json(
    endpoint: str,
    api_key: str,
    payload: Dict[str, Any],
    timeout: float,
) -> tuple[Dict[str, Any], str]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
            request_id = response.headers.get("X-DashScope-Request-Id", "")
            return body, request_id
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RuntimeError(
            f"Qwen 插画请求失败（HTTP {error.code}）：{detail}"
        ) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"无法连接 Qwen 插画服务：{error.reason}") from error


def _parse_image_url(response: Dict[str, Any]) -> str:
    try:
        content = response["output"]["choices"][0]["message"]["content"]
        image_url = next(item["image"] for item in content if item.get("image"))
    except (KeyError, IndexError, StopIteration, TypeError) as error:
        raise RuntimeError("Qwen 插画服务没有返回可下载的图片。") from error
    if not isinstance(image_url, str) or not image_url.startswith("https://"):
        raise RuntimeError("Qwen 插画服务返回了无效的图片地址。")
    return image_url


def _download_bytes(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "AI-Calendar/2.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.URLError as error:
        raise RuntimeError(f"无法下载生成的插画：{error.reason}") from error


def generate_calendar_illustration(
    brief: str,
    output_path: Path,
    project_root: Path,
    reference_paths: Sequence[Path] = (),
) -> IllustrationGenerationResult:
    config = load_config(project_root)
    if not config.get("qwen_image_enabled", False):
        raise RuntimeError(
            "当前已关闭 Qwen 插画生成。完成风格抽检后，"
            "再在 config.json 中启用 qwen_image_enabled。"
        )

    endpoint = (
        os.environ.get("QWEN_IMAGE_ENDPOINT", "").strip()
        or str(config.get("qwen_image_endpoint", "")).strip()
        or DEFAULT_QWEN_IMAGE_ENDPOINT
    )
    model = str(config.get("qwen_image_model") or "qwen-image-3.0-pro").strip()
    size = str(config.get("qwen_image_size") or "1024*1024").strip()
    timeout = float(config.get("image_api_timeout_seconds", 300))
    payload = _build_request_payload(
        model=model,
        brief=brief,
        size=size,
        reference_paths=reference_paths,
    )
    response, request_id = _post_json(
        endpoint,
        load_api_key("qwen_image"),
        payload,
        timeout,
    )
    image_bytes = _download_bytes(_parse_image_url(response), timeout)
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
            rendered = image.convert("RGBA")
    except Exception as error:
        raise RuntimeError("Qwen 返回的插画文件无法被 Pillow 读取。") from error

    output_path.parent.mkdir(parents=True, exist_ok=True)
    rendered.save(output_path, format="PNG")
    return IllustrationGenerationResult(
        output_path=output_path,
        request_id=request_id or str(response.get("request_id", "")),
        model=model,
        size=rendered.size,
    )


def generate_decision_illustration(
    decision: ImageTreatmentDecision,
    output_path: Path,
    project_root: Path,
    reference_paths: Sequence[Path] = (),
) -> IllustrationGenerationResult:
    allowed_modes = {
        TreatmentMode.illustration_only,
        TreatmentMode.illustration_with_text,
    }
    if decision.treatment_mode not in allowed_modes:
        raise ValueError("只有插画处理决策才能调用 Qwen 插画生成。")
    if not decision.illustration_required or not decision.illustration_brief.strip():
        raise ValueError("插画处理决策缺少可执行的 illustration_brief。")
    return generate_calendar_illustration(
        decision.illustration_brief,
        output_path,
        project_root,
        reference_paths=reference_paths,
    )

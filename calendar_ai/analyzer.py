from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from pydantic import ValidationError

from .keychain import load_api_key
from .schemas import (
    IllustrationRole,
    ImageTreatmentDecision,
    TextLayout,
    TextSource,
    TreatmentMode,
)


SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def project_file(project_root: Path, *parts: str) -> Path:
    direct = project_root.joinpath(*parts)
    packaged = project_root.joinpath("calendar_engine", *parts)
    for candidate in (direct, packaged):
        if candidate.exists():
            return candidate
    return direct


def load_config(project_root: Path) -> Dict[str, Any]:
    return json.loads(project_file(project_root, "config.json").read_text(encoding="utf-8"))


def encode_image(path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def validate_image(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"找不到照片：{path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError(f"当前 API 分析不支持该文件类型：{path.suffix}")


def _decision_model(config: Dict[str, Any], backend: str) -> str:
    backend_key = f"{backend}_decision_model"
    return str(
        config.get(backend_key)
        or config.get("decision_model")
        or config.get("model")
        or ""
    ).strip()


def _usage_dict(usage: Any) -> Dict[str, Any]:
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump()
    if isinstance(usage, dict):
        return usage
    return {}


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _decision_context(
    existing_analysis: Optional[Dict[str, Any]],
    rules: str,
    calibration_examples: Sequence[Dict[str, Any]] = (),
) -> str:
    return (
        "请判断这个日期已有的 0-3 张素材与文字线索的最佳处理方式。"
        "不要重新选择其他日期的照片，也不要生成或重绘图片。"
        "最终只输出一个 JSON 对象，不要使用 Markdown 代码块。"
        "所有字段都必须符合给定 JSON Schema；无法确认时使用保守回退方案。"
        "\n\n已有视觉理解结果：\n"
        f"{json.dumps(existing_analysis or {}, ensure_ascii=False)}"
        "\n\n以下是必须遵守的处理规则注册表：\n"
        f"{rules}"
        "\n\n以下是从已人工校准案例中按当前输入挑选的参考。"
        "案例的 expected 只列关键字段；实际回答仍必须输出完整 Schema。\n"
        f"{json.dumps(list(calibration_examples), ensure_ascii=False)}"
        "\n\n输出 JSON Schema：\n"
        f"{json.dumps(ImageTreatmentDecision.model_json_schema(), ensure_ascii=False)}"
    )


def _load_calibration_cases(project_root: Path) -> list[Dict[str, Any]]:
    path = project_file(
        project_root,
        "training",
        "illustration_text",
        "calibration_cases_v1.jsonl",
    )
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _select_calibration_examples(
    cases: Sequence[Dict[str, Any]],
    existing_analysis: Optional[Dict[str, Any]],
    image_count: int,
) -> list[Dict[str, Any]]:
    by_id = {case.get("case_id"): case for case in cases}
    analysis = existing_analysis or {}
    text_candidates = analysis.get("text_candidates") or []
    blank_run = int(analysis.get("consecutive_blank_run_length") or 0)
    layout_balance_needed = bool(analysis.get("layout_balance_needed"))

    if image_count:
        selected_ids = [
            "it_031",
            "it_032",
            "it_033",
            "it_034",
            "it_035",
        ]
        if text_candidates:
            selected_ids.append("it_027")
    else:
        selected_ids = ["it_020", "it_005"]
        if layout_balance_needed and blank_run >= 2:
            selected_ids.append("it_001")
        if text_candidates:
            selected_ids.extend(["it_006", "it_013", "it_014", "it_030"])

    selected = []
    for case_id in selected_ids:
        case = by_id.get(case_id)
        if not case:
            continue
        selected.append(
            {
                "case_type": case.get("case_type"),
                "input": case.get("input"),
                "expected": case.get("expected"),
                "reason": case.get("reason"),
            }
        )
    return selected


def _qwen_messages(
    prompt: str,
    context: str,
    image_paths: Sequence[Path],
    retry_feedback: str = "",
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": context}]
    for index, image_path in enumerate(image_paths, start=1):
        content.extend(
            [
                {"type": "text", "text": f"素材 {index}："},
                {
                    "type": "image_url",
                    "image_url": {"url": encode_image(image_path)},
                },
            ]
        )
    if retry_feedback:
        content.append(
            {
                "type": "text",
                "text": (
                    "上一次结果未通过本地校验。请修正后重新输出完整 JSON。"
                    f"\n校验错误：{retry_feedback}"
                ),
            }
        )
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": content},
    ]


def _parse_qwen_decision(raw_content: Any) -> ImageTreatmentDecision:
    if isinstance(raw_content, str):
        text = raw_content.strip()
    elif isinstance(raw_content, list):
        text = "".join(
            str(item.get("text", ""))
            for item in raw_content
            if isinstance(item, dict)
        ).strip()
    else:
        text = str(raw_content or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return ImageTreatmentDecision.model_validate_json(text)


def _analyze_day_qwen(
    image_paths: Sequence[Path],
    config: Dict[str, Any],
    prompt: str,
    context: str,
) -> tuple[ImageTreatmentDecision, Dict[str, Any]]:
    from openai import OpenAI

    base_url = (
        os.environ.get("QWEN_DECISION_BASE_URL", "").strip()
        or str(config.get("qwen_decision_base_url", "")).strip()
        or DEFAULT_QWEN_BASE_URL
    )
    model = _decision_model(config, "qwen")
    if not model:
        raise RuntimeError("config.json 缺少 Qwen 决策模型名称。")
    client = OpenAI(
        api_key=load_api_key("qwen_decision"),
        base_url=base_url,
        timeout=float(config.get("api_timeout_seconds", 180)),
    )

    attempts = max(1, min(3, int(config.get("decision_validation_attempts", 2))))
    retry_feedback = ""
    last_error: Exception | None = None
    last_response: Any = None
    for attempt in range(1, attempts + 1):
        response = client.chat.completions.create(
            model=model,
            messages=_qwen_messages(
                prompt,
                context,
                image_paths,
                retry_feedback=retry_feedback,
            ),
            response_format={"type": "json_object"},
            extra_body={"enable_thinking": False},
        )
        last_response = response
        raw_content = response.choices[0].message.content
        try:
            decision = _parse_qwen_decision(raw_content)
            _validate_decision(decision, len(image_paths))
        except (ValidationError, ValueError, RuntimeError) as error:
            last_error = error
            retry_feedback = str(error)[:1200]
            continue

        metadata = {
            "response_id": response.id,
            "backend": "qwen",
            "model": model,
            "base_url": base_url,
            "attempt": attempt,
            "image_names": [path.name for path in image_paths],
            "usage": _usage_dict(getattr(response, "usage", None)),
        }
        return decision, metadata

    response_id = getattr(last_response, "id", "")
    raise RuntimeError(
        f"Qwen 决策连续 {attempts} 次未通过本地校验"
        f"（response_id={response_id}）：{last_error}"
    )


def _analyze_day_openai(
    image_paths: Sequence[Path],
    config: Dict[str, Any],
    prompt: str,
    context: str,
) -> tuple[ImageTreatmentDecision, Dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI(api_key=load_api_key("openai"))
    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": context,
        }
    ]
    for index, image_path in enumerate(image_paths, start=1):
        content.extend(
            [
                {"type": "input_text", "text": f"素材 {index}："},
                {
                    "type": "input_image",
                    "image_url": encode_image(image_path),
                    "detail": config.get("image_detail", "high"),
                },
            ]
        )

    model = _decision_model(config, "openai")
    response = client.responses.parse(
        model=model,
        reasoning={"effort": config.get("reasoning_effort", "low")},
        input=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": content},
        ],
        text_format=ImageTreatmentDecision,
    )
    if response.output_parsed is None:
        raise RuntimeError("模型没有返回可解析的处理计划。")

    decision = response.output_parsed
    _validate_decision(decision, len(image_paths))
    return decision, {
        "response_id": response.id,
        "backend": "openai",
        "model": model,
        "image_names": [path.name for path in image_paths],
        "usage": _usage_dict(getattr(response, "usage", None)),
    }


def analyze_day(
    image_paths: Sequence[Path],
    project_root: Path,
    existing_analysis: Optional[Dict[str, Any]] = None,
) -> tuple[ImageTreatmentDecision, Dict[str, Any]]:
    if not image_paths and not existing_analysis:
        raise ValueError("无图片日期必须提供文字线索或布局上下文。")
    if len(image_paths) > 3:
        raise ValueError("单个日期最多只能传入 3 张素材。")
    for image_path in image_paths:
        validate_image(image_path)

    config = load_config(project_root)
    if not config.get("api_enabled", False):
        raise RuntimeError(
            "当前已关闭 API 调用。请先在本机安全配置密钥，"
            "完成连接测试后再在 config.json 中启用。"
        )
    prompt = project_file(project_root, "prompts", "treatment_decision.md").read_text(
        encoding="utf-8"
    )
    rules = project_file(project_root, "rules", "treatment_rules_v1.json").read_text(
        encoding="utf-8"
    )
    calibration_examples = _select_calibration_examples(
        _load_calibration_cases(project_root),
        existing_analysis,
        len(image_paths),
    )
    context = _decision_context(
        existing_analysis,
        rules,
        calibration_examples,
    )
    backend = str(config.get("decision_backend", "openai")).strip().lower()
    if backend in {"qwen", "qwen3.8-max", "qwen3_8_max"}:
        decision, metadata = _analyze_day_qwen(
            image_paths,
            config,
            prompt,
            context,
        )
    elif backend in {"openai", "gpt_vision", "manual_gpt_vision"}:
        decision, metadata = _analyze_day_openai(
            image_paths,
            config,
            prompt,
            context,
        )
    else:
        raise RuntimeError(f"不支持的图片处理决策后端：{backend}")
    metadata.update(
        {
            "prompt_sha256": _sha256_text(prompt),
            "rules_sha256": _sha256_text(rules),
            "rules_version": json.loads(rules).get("version", ""),
            "calibration_case_count": len(calibration_examples),
            "decision_mode": str(config.get("decision_mode", "shadow")),
        }
    )
    return decision, metadata


def analyze_image(
    image_path: Path,
    project_root: Path,
) -> tuple[ImageTreatmentDecision, Dict[str, Any]]:
    return analyze_day([image_path], project_root)


def _validate_decision(
    decision: ImageTreatmentDecision,
    input_count: int,
) -> None:
    indices = decision.selected_asset_indices
    if len(indices) != len(set(indices)):
        raise RuntimeError("模型返回了重复的素材索引。")
    if any(index < 1 or index > input_count for index in indices):
        raise RuntimeError("模型返回了不存在的素材索引。")

    no_image_modes = {
        TreatmentMode.illustration_only,
        TreatmentMode.illustration_with_text,
        TreatmentMode.text_only,
        TreatmentMode.blank,
    }
    if decision.treatment_mode in no_image_modes:
        if indices or decision.primary_asset_index != 0:
            raise RuntimeError("无图片处理方式不能引用图片素材。")
    else:
        if not indices:
            raise RuntimeError("图片处理方式至少需要引用一张素材。")
        if decision.primary_asset_index not in indices:
            raise RuntimeError("主素材必须包含在已选择素材索引中。")

    if decision.element_count > 3:
        raise RuntimeError("单个日期的可见图片元素不能超过 3 个。")

    text_modes = {
        TreatmentMode.text_only: 24,
        TreatmentMode.illustration_with_text: 14,
        TreatmentMode.irregular_cutout_with_text: 14,
    }
    if decision.treatment_mode in text_modes:
        limit = text_modes[decision.treatment_mode]
        if not decision.text_required or not decision.short_text.strip():
            raise RuntimeError("文字处理方式必须提供要显示的短文字。")
        if len(decision.short_text) > limit:
            raise RuntimeError(f"当前处理方式的短文字不得超过 {limit} 个字符。")
        if decision.text_source == TextSource.none:
            raise RuntimeError("显示文字时必须记录可靠的文字来源。")
        if not decision.text_source_excerpt.strip():
            raise RuntimeError("显示文字时必须保留支撑决策的原始文字片段。")
        if decision.text_layout == TextLayout.none:
            raise RuntimeError("显示文字时必须指定文字布局。")
    else:
        if decision.text_required or decision.short_text or decision.text_layout != TextLayout.none:
            raise RuntimeError("当前处理方式不能显示文字。")

    direct_quote_sources = {
        TextSource.user_caption,
        TextSource.manual_annotation,
        TextSource.ocr_note,
        TextSource.ocr_chat,
        TextSource.ocr_system_screenshot,
        TextSource.ocr_web_content,
    }
    if (
        decision.text_is_direct_quote
        and decision.text_source not in direct_quote_sources
    ):
        raise RuntimeError("直接引语必须来自用户文字或 OCR 原文。")

    illustration_modes = {
        TreatmentMode.illustration_only,
        TreatmentMode.illustration_with_text,
    }
    if decision.treatment_mode in illustration_modes:
        if not decision.illustration_required:
            raise RuntimeError("插画处理方式必须请求插画素材。")
        if decision.illustration_role == IllustrationRole.none:
            raise RuntimeError("插画处理方式必须说明插画作用。")
        if not decision.illustration_category.strip():
            raise RuntimeError("插画处理方式必须给出素材库类别。")
        if decision.illustration_style_id != "journal_line_doodle_v1":
            raise RuntimeError("插画必须使用 journal_line_doodle_v1 风格。")
        if not decision.illustration_brief.strip():
            raise RuntimeError("插画处理方式必须提供可执行的线描简述。")
    else:
        if (
            decision.illustration_required
            or decision.illustration_role != IllustrationRole.none
            or decision.illustration_category
            or decision.illustration_style_id
            or decision.illustration_brief
        ):
            raise RuntimeError("当前处理方式不能请求插画素材。")

    if (
        decision.illustration_role == IllustrationRole.decorative
        and not decision.layout_balance_needed
    ):
        raise RuntimeError("中性装饰插画只能用于明确的版面平衡需求。")
    if decision.treatment_mode == TreatmentMode.illustration_only:
        if decision.illustration_role != IllustrationRole.decorative:
            raise RuntimeError("仅插画模式只用于连续空白格中的中性装饰。")
        if decision.consecutive_blank_run_length < 2:
            raise RuntimeError("仅插画模式要求至少存在 2 个连续空白日期。")
    elif decision.consecutive_blank_run_length != 0:
        raise RuntimeError("非仅插画模式的连续空白长度必须为 0。")
    if (
        decision.treatment_mode == TreatmentMode.illustration_with_text
        and decision.illustration_role == IllustrationRole.decorative
    ):
        raise RuntimeError("插画加文字必须表达有证据的事件或状态，不能只是装饰。")

    expected_element_counts = {
        TreatmentMode.blank: 0,
        TreatmentMode.text_only: 1,
        TreatmentMode.illustration_only: 1,
        TreatmentMode.illustration_with_text: 2,
    }
    expected = expected_element_counts.get(decision.treatment_mode)
    if expected is not None and decision.element_count != expected:
        raise RuntimeError(
            f"{decision.treatment_mode.value} 的可见元素数量必须为 {expected}。"
        )

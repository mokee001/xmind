from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from calendar_ai.analyzer import (
    _decision_model,
    _load_calibration_cases,
    _ollama_base_url,
    _ollama_payload,
    _normalize_local_decision,
    _parse_qwen_decision,
    _select_calibration_examples,
    _validate_decision,
)
from calendar_ai.keychain import load_api_key
from calendar_ai.schemas import TextSource
from calendar_ai.qwen_image import (
    _build_request_payload,
    _parse_image_url,
    _style_prompt,
    generate_decision_illustration,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class QwenDecisionProviderTest(unittest.TestCase):
    def test_backend_specific_models_do_not_leak_between_providers(self) -> None:
        config = {
            "qwen_decision_model": "qwen3.8-max",
            "openai_decision_model": "gpt-example",
        }
        self.assertEqual(_decision_model(config, "qwen"), "qwen3.8-max")
        self.assertEqual(_decision_model(config, "openai"), "gpt-example")

    def test_local_ollama_configuration_is_independent(self) -> None:
        config = {
            "local_ollama_decision_model": "qwen3-vl:4b-instruct",
            "qwen_decision_model": "qwen3.8-max",
        }
        self.assertEqual(
            _decision_model(config, "local_ollama"),
            "qwen3-vl:4b-instruct",
        )
        with patch.dict(os.environ, {"OLLAMA_HOST": "127.0.0.1:11434"}):
            self.assertEqual(
                _ollama_base_url(config),
                "http://127.0.0.1:11434",
            )

    def test_local_ollama_payload_keeps_images_on_device(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "photo.jpg"
            Image.new("RGB", (16, 16), "white").save(image_path)
            payload = _ollama_payload(
                "qwen3-vl:4b-instruct",
                "system rules",
                "decision context",
                [image_path],
            )
        self.assertEqual(payload["model"], "qwen3-vl:4b-instruct")
        self.assertFalse(payload["stream"])
        self.assertFalse(payload["think"])
        self.assertEqual(payload["options"]["temperature"], 0)
        self.assertEqual(payload["format"]["title"], "ImageTreatmentDecision")
        encoded = payload["messages"][1]["images"][0]
        self.assertNotIn("data:image", encoded)
        self.assertGreater(len(encoded), 20)

    def test_local_ollama_rejects_remote_hosts(self) -> None:
        config = {"local_ollama_base_url": "https://example.com"}
        with self.assertRaisesRegex(RuntimeError, "只允许连接本机回环地址"):
            _ollama_base_url(config)

    def test_selects_photo_contrast_cases_for_image_input(self) -> None:
        cases = _load_calibration_cases(PROJECT_ROOT)
        selected = _select_calibration_examples(cases, {}, image_count=1)
        modes = {case["expected"]["treatment_mode"] for case in selected}
        self.assertEqual(
            modes,
            {
                "irregular_cutout",
                "proportional_full_image",
                "circle_image",
                "non_cell_ratio_image",
                "oval_image_with_cutout",
            },
        )

    def test_photo_calibration_warns_against_animal_circle_shortcut(self) -> None:
        cases = _load_calibration_cases(PROJECT_ROOT)
        selected = _select_calibration_examples(cases, {}, image_count=1)
        reasons = " ".join(case["reason"] for case in selected)
        self.assertIn("不能因为宠物类别默认使用圆形", reasons)

    def test_selects_blank_and_text_cases_for_no_image_input(self) -> None:
        cases = _load_calibration_cases(PROJECT_ROOT)
        analysis = {
            "text_candidates": [{"source": "ocr_note", "text": "今天烤蛋糕"}],
            "layout_balance_needed": True,
            "consecutive_blank_run_length": 3,
        }
        selected = _select_calibration_examples(cases, analysis, image_count=0)
        modes = {case["expected"]["treatment_mode"] for case in selected}
        self.assertIn("illustration_only", modes)
        self.assertIn("illustration_with_text", modes)
        self.assertIn("text_only", modes)
        self.assertIn("blank", modes)

    def test_parser_accepts_json_code_fence_but_returns_typed_decision(self) -> None:
        payload = {
            "decision": "USE",
            "treatment_mode": "text_only",
            "fallback_treatment_mode": "blank",
            "confidence": 0.9,
            "selected_asset_indices": [],
            "primary_asset_index": 0,
            "element_count": 1,
            "content_type": "文字记录",
            "main_subject": "休息记录",
            "subject_bbox": [0, 0, 1, 1],
            "anchor": "center",
            "overflow_level": "none",
            "rotation_degrees": 0,
            "crop_focus": "",
            "keep_background": False,
            "crop_safety": 1,
            "cutout_suitability": 0,
            "background_value": 0,
            "small_cell_readability": 1,
            "multiple_subjects": False,
            "text_required": True,
            "short_text": "今天早点休息",
            "text_source": "user_caption",
            "text_source_excerpt": "今天早点休息",
            "text_is_direct_quote": True,
            "text_layout": "full_cell",
            "illustration_required": False,
            "illustration_role": "none",
            "illustration_category": "",
            "illustration_style_id": "",
            "illustration_brief": "",
            "layout_balance_needed": False,
            "consecutive_blank_run_length": 0,
            "reject_reasons": [],
            "reasons": ["文字本身有意义"],
            "matched_rule_ids": ["text_only"],
            "risks": [],
            "executor_notes": [],
        }
        decision = _parse_qwen_decision(
            "```json\n" + json.dumps(payload, ensure_ascii=False) + "\n```"
        )
        self.assertEqual(decision.treatment_mode.value, "text_only")

        with self.assertRaisesRegex(RuntimeError, "已有合格照片"):
            _validate_decision(decision, input_count=1)

        photo_decision = decision.model_copy(
            update={
                "treatment_mode": "proportional_full_image",
                "fallback_treatment_mode": "irregular_cutout",
                "selected_asset_indices": [1],
                "primary_asset_index": 1,
            }
        )
        normalized = _normalize_local_decision(photo_decision)
        self.assertFalse(normalized.text_required)
        self.assertEqual(normalized.short_text, "")
        self.assertEqual(normalized.text_source, TextSource.none)
        _validate_decision(normalized, input_count=1)

    def test_key_loader_prefers_environment_and_does_not_need_keychain(self) -> None:
        with patch.dict(os.environ, {"QWEN_DECISION_API_KEY": "test-only-key"}):
            self.assertEqual(load_api_key("qwen_decision"), "test-only-key")


class QwenImageProviderTest(unittest.TestCase):
    def test_style_prompt_encodes_closeup_and_no_full_body_rules(self) -> None:
        prompt = _style_prompt("一杯热茶")
        self.assertIn("特写", prompt)
        self.assertIn("禁止人物全身", prompt)
        self.assertIn("不要生成文字", prompt)

    def test_payload_uses_image_api_shape_and_inline_reference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            reference = Path(temporary) / "reference.jpg"
            Image.new("RGB", (16, 16), "white").save(reference)
            payload = _build_request_payload(
                model="qwen-image-3.0-pro",
                brief="一只猫的脸部特写",
                size="1024*1024",
                reference_paths=[reference],
            )
        content = payload["input"]["messages"][0]["content"]
        self.assertTrue(content[0]["image"].startswith("data:image/jpeg;base64,"))
        self.assertIn("text", content[-1])
        self.assertFalse(payload["parameters"]["prompt_extend"])
        self.assertFalse(payload["parameters"]["watermark"])

    def test_parse_image_url(self) -> None:
        response = {
            "output": {
                "choices": [
                    {"message": {"content": [{"image": "https://example.com/a.png"}]}}
                ]
            }
        }
        self.assertEqual(_parse_image_url(response), "https://example.com/a.png")

    def test_non_illustration_decision_cannot_trigger_generation(self) -> None:
        payload = {
            "decision": "USE",
            "treatment_mode": "text_only",
            "fallback_treatment_mode": "blank",
            "confidence": 0.9,
            "selected_asset_indices": [],
            "primary_asset_index": 0,
            "element_count": 1,
            "content_type": "文字记录",
            "main_subject": "休息记录",
            "subject_bbox": [0, 0, 1, 1],
            "anchor": "center",
            "overflow_level": "none",
            "rotation_degrees": 0,
            "crop_focus": "",
            "keep_background": False,
            "crop_safety": 1,
            "cutout_suitability": 0,
            "background_value": 0,
            "small_cell_readability": 1,
            "multiple_subjects": False,
            "text_required": True,
            "short_text": "今天早点休息",
            "text_source": "user_caption",
            "text_source_excerpt": "今天早点休息",
            "text_is_direct_quote": True,
            "text_layout": "full_cell",
            "illustration_required": False,
            "illustration_role": "none",
            "illustration_category": "",
            "illustration_style_id": "",
            "illustration_brief": "",
            "layout_balance_needed": False,
            "consecutive_blank_run_length": 0,
            "reject_reasons": [],
            "reasons": ["文字本身有意义"],
            "matched_rule_ids": ["text_only"],
            "risks": [],
            "executor_notes": [],
        }
        decision = _parse_qwen_decision(json.dumps(payload, ensure_ascii=False))
        with self.assertRaises(ValueError):
            generate_decision_illustration(
                decision,
                Path("unused.png"),
                PROJECT_ROOT,
            )


if __name__ == "__main__":
    unittest.main()

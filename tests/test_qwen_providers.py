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
    _parse_qwen_decision,
    _select_calibration_examples,
)
from calendar_ai.keychain import load_api_key
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

    def test_selects_photo_contrast_cases_for_image_input(self) -> None:
        cases = _load_calibration_cases(PROJECT_ROOT)
        selected = _select_calibration_examples(cases, {}, image_count=1)
        modes = {case["expected"]["treatment_mode"] for case in selected}
        self.assertIn("proportional_full_image", modes)
        self.assertIn("non_cell_ratio_image", modes)

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

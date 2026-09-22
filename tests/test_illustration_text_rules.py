from __future__ import annotations

import json
import sys
import unittest
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESOURCE_ROOT = PROJECT_ROOT / "calendar_engine"
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.analyzer import _validate_decision  # noqa: E402
from calendar_ai.schemas import (  # noqa: E402
    Anchor,
    Decision,
    IllustrationRole,
    ImageTreatmentDecision,
    OverflowLevel,
    TextLayout,
    TextSource,
    TreatmentMode,
)


def make_decision(**overrides: object) -> ImageTreatmentDecision:
    values = {
        "decision": Decision.use,
        "treatment_mode": TreatmentMode.illustration_with_text,
        "fallback_treatment_mode": TreatmentMode.text_only,
        "confidence": 0.9,
        "selected_asset_indices": [],
        "primary_asset_index": 0,
        "element_count": 2,
        "content_type": "文字记录",
        "main_subject": "下班记录",
        "subject_bbox": (0.0, 0.0, 1.0, 1.0),
        "anchor": Anchor.center,
        "overflow_level": OverflowLevel.none,
        "rotation_degrees": 0,
        "crop_focus": "",
        "keep_background": False,
        "crop_safety": 1.0,
        "cutout_suitability": 0.0,
        "background_value": 0.0,
        "small_cell_readability": 0.9,
        "multiple_subjects": False,
        "text_required": True,
        "short_text": "终于下班啦",
        "text_source": TextSource.ocr_chat,
        "text_source_excerpt": "终于下班啦",
        "text_is_direct_quote": True,
        "text_layout": TextLayout.bottom_band,
        "illustration_required": True,
        "illustration_role": IllustrationRole.event,
        "illustration_category": "activity.off_work",
        "illustration_style_id": "journal_line_doodle_v1",
        "illustration_brief": "一个小公文包和简化时钟，单色线描",
        "layout_balance_needed": False,
        "consecutive_blank_run_length": 0,
        "reject_reasons": [],
        "reasons": ["短文字和插画互补"],
        "matched_rule_ids": ["illustration_with_text"],
        "risks": [],
        "executor_notes": [],
    }
    values.update(overrides)
    return ImageTreatmentDecision(**values)


class IllustrationTextRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rules = json.loads(
            (RESOURCE_ROOT / "rules" / "treatment_rules_v1.json").read_text(
                encoding="utf-8"
            )
        )
        cls.cases = [
            json.loads(line)
            for line in (
                RESOURCE_ROOT
                / "training"
                / "illustration_text"
                / "calibration_cases_v1.jsonl"
            )
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        cls.style_manifest = json.loads(
            (
                RESOURCE_ROOT
                / "training"
                / "illustration_text"
                / "style_manifest_v1.json"
            ).read_text(encoding="utf-8")
        )

    def test_no_image_policy_defaults_to_blank_without_evidence(self) -> None:
        policy = self.rules["no_image_content_policy"]
        global_rules = self.rules["global_rules"]
        self.assertTrue(policy["blank_is_default_without_evidence"])
        self.assertTrue(policy["decorative_illustration_requires_layout_need"])
        self.assertTrue(
            policy["decorative_illustration_requires_consecutive_blank_run"]
        )
        self.assertEqual(policy["minimum_consecutive_blank_run_length"], 2)
        self.assertEqual(global_rules["maximum_consecutive_blank_days"], 1)
        self.assertTrue(
            global_rules["consecutive_blank_days_must_be_interrupted"]
        )

    def test_registered_illustration_style_matches_modes(self) -> None:
        styles = self.rules["illustration_style_profiles"]
        self.assertIn("journal_line_doodle_v1", styles)
        modes = {mode["id"]: mode for mode in self.rules["modes"]}
        self.assertEqual(
            modes["illustration_only"]["illustration_style_id"],
            "journal_line_doodle_v1",
        )
        self.assertEqual(
            modes["illustration_with_text"]["illustration_style_id"],
            "journal_line_doodle_v1",
        )
        self.assertEqual(
            modes["illustration_with_text"]["text_style"]["font_size"],
            8,
        )
        self.assertEqual(
            modes["text_only"]["text_style"]["font_size"],
            10,
        )
        self.assertEqual(
            self.style_manifest["text_styles"]["illustration_with_text"][
                "font_size"
            ],
            8,
        )
        self.assertEqual(
            self.style_manifest["text_styles"]["text_only"]["font_size"],
            10,
        )
        self.assertFalse(
            styles["journal_line_doodle_v1"]["generation_fallback_allowed"]
        )
        self.assertEqual(
            self.style_manifest["style_id"],
            "journal_line_doodle_v1",
        )
        rule_composition = styles["journal_line_doodle_v1"]["composition"]
        manifest_style = self.style_manifest["illustration_style"]
        self.assertEqual(
            rule_composition["framing"],
            "close_up_or_single_focus",
        )
        self.assertFalse(rule_composition["human_full_body_allowed"])
        self.assertEqual(
            manifest_style["framing"],
            "close_up_or_single_focus",
        )
        self.assertFalse(manifest_style["human_full_body_allowed"])
        self.assertIn(
            "人物全身构图",
            styles["journal_line_doodle_v1"]["forbidden_visuals"],
        )
        for reference in self.style_manifest["reference_files"].values():
            reference_path = Path(reference)
            self.assertFalse(reference_path.is_absolute())
            self.assertNotIn("..", reference_path.parts)

    def test_calibration_set_has_all_target_and_contrast_modes(self) -> None:
        self.assertGreaterEqual(len(self.cases), 30)
        counts = Counter(
            case["expected"]["treatment_mode"] for case in self.cases
        )
        for mode in [
            "blank",
            "illustration_only",
            "illustration_with_text",
            "text_only",
            "proportional_full_image",
            "non_cell_ratio_image",
        ]:
            self.assertGreater(counts[mode], 0)

    def test_calibration_text_lengths_follow_mode_limits(self) -> None:
        limits = self.rules["text_evidence_policy"]["mode_text_limits"]
        for case in self.cases:
            expected = case["expected"]
            mode = expected["treatment_mode"]
            if mode not in limits:
                continue
            maximum = limits[mode]["maximum_chinese_characters"]
            self.assertLessEqual(
                len(expected["short_text"]),
                maximum,
                msg=case["case_id"],
            )

    def test_accepts_no_image_illustration_with_text(self) -> None:
        _validate_decision(make_decision(), input_count=0)

    def test_accepts_web_ocr_as_direct_quote(self) -> None:
        decision = make_decision(
            treatment_mode=TreatmentMode.text_only,
            fallback_treatment_mode=TreatmentMode.blank,
            element_count=1,
            short_text="怎么才周四，好期待周末啊",
            text_source=TextSource.ocr_web_content,
            text_source_excerpt="怎么才周四，好期待周末啊",
            text_layout=TextLayout.full_cell,
            illustration_required=False,
            illustration_role=IllustrationRole.none,
            illustration_category="",
            illustration_style_id="",
            illustration_brief="",
        )
        _validate_decision(decision, input_count=0)

    def test_rejects_model_summary_disguised_as_direct_quote(self) -> None:
        decision = make_decision(
            text_source=TextSource.model_summary,
            text_is_direct_quote=True,
        )
        with self.assertRaises(RuntimeError):
            _validate_decision(decision, input_count=0)

    def test_rejects_decorative_illustration_without_layout_need(self) -> None:
        decision = make_decision(
            treatment_mode=TreatmentMode.illustration_only,
            fallback_treatment_mode=TreatmentMode.blank,
            element_count=1,
            text_required=False,
            short_text="",
            text_source=TextSource.none,
            text_source_excerpt="",
            text_is_direct_quote=False,
            text_layout=TextLayout.none,
            illustration_role=IllustrationRole.decorative,
            illustration_category="neutral.star",
            illustration_brief="三颗中性小星星，单色线描",
            layout_balance_needed=False,
            consecutive_blank_run_length=3,
        )
        with self.assertRaises(RuntimeError):
            _validate_decision(decision, input_count=0)

    def test_rejects_decorative_illustration_without_blank_run(self) -> None:
        decision = make_decision(
            treatment_mode=TreatmentMode.illustration_only,
            fallback_treatment_mode=TreatmentMode.blank,
            element_count=1,
            text_required=False,
            short_text="",
            text_source=TextSource.none,
            text_source_excerpt="",
            text_is_direct_quote=False,
            text_layout=TextLayout.none,
            illustration_role=IllustrationRole.decorative,
            illustration_category="neutral.star",
            illustration_brief="三颗中性小星星，单色线描",
            layout_balance_needed=True,
            consecutive_blank_run_length=1,
        )
        with self.assertRaises(RuntimeError):
            _validate_decision(decision, input_count=0)

    def test_accepts_decorative_illustration_for_consecutive_blanks(self) -> None:
        decision = make_decision(
            treatment_mode=TreatmentMode.illustration_only,
            fallback_treatment_mode=TreatmentMode.blank,
            element_count=1,
            text_required=False,
            short_text="",
            text_source=TextSource.none,
            text_source_excerpt="",
            text_is_direct_quote=False,
            text_layout=TextLayout.none,
            illustration_role=IllustrationRole.decorative,
            illustration_category="daily_object.tea_cup",
            illustration_brief="一个冒热气的小茶杯，单色线描",
            layout_balance_needed=True,
            consecutive_blank_run_length=2,
        )
        _validate_decision(decision, input_count=0)

    def test_illustration_only_cases_never_hide_meaningful_text(self) -> None:
        cases = [
            case
            for case in self.cases
            if case["expected"]["treatment_mode"] == "illustration_only"
        ]
        for case in cases:
            self.assertEqual(case["input"]["text_candidates"], [], case["case_id"])
            self.assertEqual(
                case["expected"]["illustration_role"],
                "decorative",
                case["case_id"],
            )
            self.assertGreaterEqual(
                case["expected"]["consecutive_blank_run_length"],
                2,
                case["case_id"],
            )

    def test_figma_cases_are_registered(self) -> None:
        case_types = {case["case_type"] for case in self.cases}
        self.assertIn("figma_text_only_web_event", case_types)
        self.assertIn("figma_text_only_chat", case_types)
        self.assertIn("figma_text_only_health", case_types)
        self.assertIn("figma_illustration_with_text", case_types)


if __name__ == "__main__":
    unittest.main()

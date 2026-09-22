from __future__ import annotations

import json
import sys
import unittest
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


class TreatmentRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rules = json.loads(
            (RESOURCE_ROOT / "rules" / "treatment_rules_v1.json").read_text(
                encoding="utf-8"
            )
        )

    def test_mode_registry_matches_structured_output_enum(self) -> None:
        registered = {mode["id"] for mode in self.rules["modes"]}
        schema_modes = {mode.value for mode in TreatmentMode}
        self.assertEqual(registered, schema_modes)

    def test_global_hard_limits(self) -> None:
        global_rules = self.rules["global_rules"]
        self.assertEqual(global_rules["maximum_images_per_day"], 3)
        self.assertEqual(global_rules["maximum_absolute_rotation_degrees"], 10)
        self.assertFalse(global_rules["cutout_white_outline_allowed"])
        self.assertFalse(global_rules["cutout_shadow_allowed"])

    def test_irregular_maximum_contains_safe_zone(self) -> None:
        geometry = self.rules["shared_irregular_geometry"]
        self.assertLessEqual(
            geometry["safe_zone"]["width"],
            geometry["maximum_zone"]["width"],
        )
        self.assertLessEqual(
            geometry["safe_zone"]["height"],
            geometry["maximum_zone"]["height"],
        )

    def test_rejects_asset_index_outside_input(self) -> None:
        decision = ImageTreatmentDecision(
            decision=Decision.use,
            treatment_mode=TreatmentMode.irregular_cutout,
            fallback_treatment_mode=TreatmentMode.proportional_full_image,
            confidence=0.9,
            selected_asset_indices=[2],
            primary_asset_index=2,
            element_count=1,
            content_type="宠物",
            main_subject="猫",
            subject_bbox=(0.1, 0.1, 0.9, 0.9),
            anchor=Anchor.center,
            overflow_level=OverflowLevel.safe_zone,
            rotation_degrees=0,
            crop_focus="猫",
            keep_background=False,
            crop_safety=0.9,
            cutout_suitability=0.9,
            background_value=0.2,
            small_cell_readability=0.9,
            multiple_subjects=False,
            text_required=False,
            short_text="",
            text_source=TextSource.none,
            text_source_excerpt="",
            text_is_direct_quote=False,
            text_layout=TextLayout.none,
            illustration_required=False,
            illustration_role=IllustrationRole.none,
            illustration_category="",
            illustration_style_id="",
            illustration_brief="",
            layout_balance_needed=False,
            consecutive_blank_run_length=0,
            reject_reasons=[],
            reasons=["主体清晰"],
            matched_rule_ids=["irregular_cutout"],
            risks=[],
            executor_notes=[],
        )
        with self.assertRaises(RuntimeError):
            _validate_decision(decision, input_count=1)


if __name__ == "__main__":
    unittest.main()

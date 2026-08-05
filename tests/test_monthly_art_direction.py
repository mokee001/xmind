from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESOURCE_ROOT = PROJECT_ROOT / "calendar_engine"
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.art_direction import direct_day, direct_month, load_art_direction_rules  # noqa: E402
from tools.build_treatment_plan_from_qwen import build_plan  # noqa: E402


class MonthlyArtDirectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rules = load_art_direction_rules()
        cls.reference = json.loads(
            (RESOURCE_ROOT / "training" / "monthly_layout" / "gpt_july_reference_v1.json").read_text(
                encoding="utf-8"
            )
        )

    def test_reference_does_not_embed_private_images(self) -> None:
        self.assertEqual(
            self.reference["source_policy"],
            "只保存设计决策，不保存原始照片或参考成图",
        )
        serialized = json.dumps(self.reference, ensure_ascii=False)
        self.assertNotIn("/Users/", serialized)
        self.assertNotIn(".jpg", serialized)
        self.assertNotIn(".png", serialized)

    def test_third_party_chat_without_personal_emotion_becomes_blank(self) -> None:
        selected = {
            "day": 2,
            "sources": [],
            "analysis_context": {"text_candidates": [{"text": "朋友捡的猫咪好聪明"}]},
        }
        decision = {"treatment_mode": "illustration_with_text", "short_text": "朋友捡的猫咪好聪明"}
        directive = direct_day(selected, decision, self.rules)
        self.assertEqual(directive["treatment_mode"], "blank")
        self.assertTrue(directive["omit_from_render_plan"])

    def test_personal_health_state_becomes_illustration_with_text(self) -> None:
        selected = {
            "day": 19,
            "sources": [],
            "analysis_context": {"text_candidates": [{"text": "痛经真的很难，得好好休息"}]},
        }
        decision = {"treatment_mode": "text_only", "short_text": "痛经真的很难，得好好休息"}
        directive = direct_day(selected, decision, self.rules)
        self.assertEqual(directive["treatment_mode"], "illustration_with_text")
        self.assertEqual(directive["illustration_category"], "health.comfort")

    def test_compact_coffee_becomes_circle(self) -> None:
        selected = {"day": 18, "sources": ["photo.jpg"], "analysis_context": {"content_type": "咖啡日常"}}
        decision = {"treatment_mode": "proportional_full_image", "content_type": "咖啡日常"}
        directive = direct_day(selected, decision, self.rules)
        self.assertEqual(directive["treatment_mode"], "circle_image")

    def test_pet_relationship_becomes_large_cutout(self) -> None:
        selected = {"day": 27, "sources": ["photo.jpg"], "analysis_context": {"content_type": "双宠物关系"}}
        decision = {"treatment_mode": "proportional_full_image", "content_type": "双宠物关系"}
        directive = direct_day(selected, decision, self.rules)
        self.assertEqual(directive["treatment_mode"], "irregular_cutout")
        self.assertLess(directive["box"][0], 0)
        self.assertGreater(directive["box"][2], 1)

    def test_confirmed_july_reference_has_no_long_rectangular_run(self) -> None:
        selection = []
        decisions = {}
        for item in self.reference["days"]:
            day = item["day"]
            sources = [] if item["treatment"] in {"blank", "text_only", "illustration_with_text"} else ["photo.jpg"]
            selection.append({"day": day, "sources": sources, "analysis_context": {"content_type": item["semantic"]}})
            decisions[day] = {"treatment_mode": item["treatment"], "content_type": item["semantic"]}
        _directives, summary = direct_month(selection, decisions, self.rules)
        self.assertEqual(summary["consecutive_rectangular_runs_over_limit"], [])

    def test_local_decision_metadata_is_preserved_in_treatment_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            selection = {
                "days": [
                    {
                        "day": 3,
                        "sources": ["proxies/2026-07-03__001.jpg"],
                        "reason": "手写卡片记录",
                        "analysis_context": {"content_type": "纸质手写卡片"},
                    }
                ]
            }
            (run_dir / "selection.json").write_text(
                json.dumps(selection, ensure_ascii=False),
                encoding="utf-8",
            )
            decision_dir = run_dir / "api_decisions"
            decision_dir.mkdir()
            (decision_dir / "day03.json").write_text(
                json.dumps(
                    {
                        "metadata": {
                            "backend": "local_ollama",
                            "model": "qwen3-vl:4b-instruct",
                            "decision_mode": "shadow",
                        },
                        "decision": {
                            "treatment_mode": "non_cell_ratio_image",
                            "rotation_degrees": 2,
                            "subject_bbox": [0.1, 0.1, 0.9, 0.9],
                            "reasons": ["保留卡片边缘"],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            plan = build_plan(run_dir)

        self.assertEqual(plan["decision"]["backend"], "local_ollama")
        self.assertEqual(plan["decision"]["models"], ["qwen3-vl:4b-instruct"])
        self.assertFalse(plan["decision"]["api_used"])
        self.assertEqual(plan["decision"]["processing"], "local_loopback_only")


if __name__ == "__main__":
    unittest.main()

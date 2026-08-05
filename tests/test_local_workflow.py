from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from calendar_engine.local_workflow import (
    LocalWorkflowError,
    pending_assets,
    validate_prepared_run,
    write_workflow_report,
)


class LocalWorkflowTest(unittest.TestCase):
    def write_json(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_prepared_run_requires_selection_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            with self.assertRaisesRegex(LocalWorkflowError, "selection.json"):
                validate_prepared_run(run_dir)

            self.write_json(
                run_dir / "selection.json",
                {"days": [{"day": 1, "sources": [], "analysis_context": {}}]},
            )
            with self.assertRaisesRegex(LocalWorkflowError, "manifest.json"):
                validate_prepared_run(run_dir)

    def test_no_photo_day_requires_analysis_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            self.write_json(
                run_dir / "selection.json",
                {"days": [{"day": 8, "sources": []}]},
            )
            self.write_json(run_dir / "manifest.json", {"summary": {}})

            with self.assertRaisesRegex(LocalWorkflowError, "analysis_context"):
                validate_prepared_run(run_dir)

    def test_prepared_run_accepts_relative_work_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            proxy = run_dir / "proxies" / "2026-07-03__001.jpg"
            proxy.parent.mkdir()
            proxy.write_bytes(b"photo-placeholder")
            self.write_json(
                run_dir / "selection.json",
                {
                    "days": [
                        {
                            "day": 3,
                            "sources": ["proxies/2026-07-03__001.jpg"],
                        }
                    ]
                },
            )
            self.write_json(run_dir / "manifest.json", {"summary": {}})

            selection = validate_prepared_run(run_dir)

        self.assertEqual(selection["days"][0]["day"], 3)

    def test_pending_assets_lists_only_missing_generated_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            existing = run_dir / "assets" / "cutouts" / "day03.png"
            existing.parent.mkdir(parents=True)
            existing.write_bytes(b"png-placeholder")
            plan = {
                "days": [
                    {
                        "day": 3,
                        "placements": [
                            {"kind": "cutout", "asset": "assets/cutouts/day03.png"}
                        ],
                    },
                    {
                        "day": 8,
                        "placements": [
                            {
                                "kind": "illustration",
                                "asset": "assets/illustrations/day08.png",
                            }
                        ],
                    },
                    {"day": 9, "placements": [{"kind": "photo"}]},
                ]
            }
            missing = pending_assets(run_dir, plan)

        self.assertEqual(
            missing,
            [
                {
                    "day": 8,
                    "kind": "illustration",
                    "asset": "assets/illustrations/day08.png",
                }
            ],
        )

    def test_workflow_report_states_weights_are_not_bundled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            report_path = write_workflow_report(
                run_dir,
                status="PLAN_READY",
                stages=[{"name": "输入检查", "status": "PASS"}],
                config={
                    "decision_backend": "local_ollama",
                    "local_ollama_decision_model": "qwen3-vl:4b-instruct",
                    "local_ollama_base_url": "http://127.0.0.1:11434",
                },
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))

        self.assertFalse(report["runtime"]["weights_bundled_in_git"])
        self.assertEqual(report["status"], "PLAN_READY")


if __name__ == "__main__":
    unittest.main()

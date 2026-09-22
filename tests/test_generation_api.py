from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from calendar_engine import GenerationError, generate_july_calendar


class GenerationApiTest(unittest.TestCase):
    def write_json(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def make_template(self, folder: Path) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (1500, 2001), "white").save(folder / "base.png")
        Image.new("RGBA", (1500, 2001), (0, 0, 0, 0)).save(folder / "date.png")
        Image.new("RGBA", (1500, 2001), (0, 0, 0, 0)).save(
            folder / "overlay_sticker_static.png"
        )

    def make_plan(self, run_dir: Path, *, month: int = 7) -> None:
        self.write_json(
            run_dir / "treatment_plan.json",
            {
                "schema_version": "1.0",
                "calendar": {
                    "year": 2026,
                    "month": month,
                    "week_start": "sunday",
                    "template": "unused-because-cli-overrides-it",
                },
                "decision": {
                    "cutout_style": {"white_outline": False, "shadow": False}
                },
                "days": [
                    {
                        "day": day,
                        "sources": [],
                        "treatment": "blank",
                        "placements": [],
                    }
                    for day in range(1, 32)
                ],
            },
        )

    def test_generates_qa_approved_july_calendar(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "run"
            template_dir = root / "template"
            run_dir.mkdir()
            self.make_template(template_dir)
            self.make_plan(run_dir)

            result = generate_july_calendar(
                run_dir,
                template_dir=template_dir,
                final_name="calendar.png",
                preview_name="preview.jpg",
            )

            self.assertEqual(result.qa_report["status"], "PASS")
            self.assertTrue(result.calendar_path.exists())
            with Image.open(result.calendar_path) as output:
                self.assertEqual(output.size, (1500, 2001))

    def test_rejects_non_july_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "run"
            template_dir = root / "template"
            run_dir.mkdir()
            self.make_template(template_dir)
            self.make_plan(run_dir, month=8)

            with self.assertRaisesRegex(GenerationError, "只保证 2026 年 7 月"):
                generate_july_calendar(run_dir, template_dir=template_dir)


if __name__ == "__main__":
    unittest.main()

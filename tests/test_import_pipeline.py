from __future__ import annotations

import importlib.util
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "import_real_user_july.py"
SPEC = importlib.util.spec_from_file_location("import_real_user_july", MODULE_PATH)
assert SPEC and SPEC.loader
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class ImportPipelineTests(unittest.TestCase):
    def test_filename_date_has_priority_over_embedded_creation(self) -> None:
        capture_at, source, confidence = IMPORTER.parse_capture_time(
            Path("IMG_20260717_160300.jpg"),
            {"creation": "2026:08:01 10:30:00"},
        )

        self.assertEqual(capture_at, datetime(2026, 7, 17, 12, 0, 0))
        self.assertEqual(source, "filename")
        self.assertEqual(confidence, "medium")

    def test_jpeg_proxy_preserves_visible_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jpg"
            destination = Path(folder) / "proxy.jpg"
            Image.new("RGB", (2000, 1200), (220, 80, 40)).save(source)

            IMPORTER.convert_proxy(source, destination)

            with Image.open(destination) as proxy:
                self.assertLessEqual(max(proxy.size), 1600)
                self.assertGreater(proxy.convert("L").getextrema()[1], 8)


if __name__ == "__main__":
    unittest.main()

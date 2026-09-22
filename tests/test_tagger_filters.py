from __future__ import annotations

import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from PIL import Image, ImageDraw

from backend import tagger


class TaggerFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        detector = patch.object(tagger, "semantic_result", return_value={"tags": [], "status": "complete", "engine": "test"})
        detector.start()
        self.addCleanup(detector.stop)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _photo(self, name: str, *, camera_exif: bool) -> Path:
        path = Path(self.temp_dir.name) / name
        image = Image.effect_noise((720, 540), 70).convert("RGB")
        draw = ImageDraw.Draw(image)
        draw.rectangle((80, 70, 640, 470), outline=(255, 80, 40), width=18)
        draw.ellipse((220, 130, 500, 430), fill=(30, 150, 220), outline="white", width=10)
        exif = image.getexif()
        if camera_exif:
            exif[271] = "Apple"
            exif[272] = "iPhone"
        image.save(path, format="JPEG", quality=94, exif=exif)
        return path

    def test_camera_photo_remains_selectable(self) -> None:
        tagged = tagger.tag_photo(str(self._photo("IMG_1001.jpg", camera_exif=True)))

        self.assertTrue(tagged["camera_exif"])
        self.assertIsNone(tagged["junk_reason"])
        self.assertGreater(tagged["quality"], 0)
        self.assertNotIn("junk", tagged["tags"])

    def test_photo_without_camera_exif_is_kept_as_shared_photo(self) -> None:
        tagged = tagger.tag_photo(str(self._photo("saved-photo.jpg", camera_exif=False)))

        self.assertFalse(tagged["camera_exif"])
        self.assertEqual(tagged["capture_source"], "shared")
        self.assertIsNone(tagged["junk_reason"])
        self.assertGreater(tagged["quality"], 0)
        self.assertIn("source_shared", tagged["tags"])

    def test_screenshot_filename_has_structured_reason(self) -> None:
        tagged = tagger.tag_photo(str(self._photo("Screenshot_1002.jpg", camera_exif=True)))

        self.assertEqual(tagged["junk_reason"], "screenshot")
        self.assertEqual(tagged["capture_source"], "non_photo")
        self.assertEqual(tagged["quality"], 0)
        self.assertIn("junk_screenshot", tagged["tags"])

    def test_decode_failure_has_structured_reason(self) -> None:
        path = Path(self.temp_dir.name) / "broken.jpg"
        path.write_bytes(b"not an image")

        tagged = tagger.tag_photo(str(path))

        self.assertEqual(tagged["junk_reason"], "decode")
        self.assertEqual(tagged["quality"], 0)


if __name__ == "__main__":
    unittest.main()

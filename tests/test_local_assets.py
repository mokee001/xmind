from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from calendar_engine.local_assets import generate_health_comfort_illustration


class LocalAssetTest(unittest.TestCase):
    def test_health_illustration_is_transparent_and_nonblank(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "health.png"
            generate_health_comfort_illustration(output, size=256)
            with Image.open(output) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.size, (256, 256))
                alpha = image.getchannel("A")
                self.assertEqual(alpha.getextrema()[0], 0)
                self.assertGreater(alpha.getextrema()[1], 0)


if __name__ == "__main__":
    unittest.main()

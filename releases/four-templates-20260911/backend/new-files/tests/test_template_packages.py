from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend import template_packages


class TemplatePackageTests(unittest.TestCase):
	def setUp(self) -> None:
		self.temp_dir = tempfile.TemporaryDirectory()
		self.photos: list[str] = []
		for index in range(8):
			path = Path(self.temp_dir.name) / f"photo-{index}.jpg"
			Image.new(
				"RGB",
				(640 + index * 10, 480 + index * 10),
				(40 + index * 20, 90 + index * 10, 150 - index * 10),
			).save(path, format="JPEG")
			self.photos.append(str(path))

	def tearDown(self) -> None:
		self.temp_dir.cleanup()

	def test_confirmed_three_packages_are_registered(self) -> None:
		self.assertTrue(template_packages.is_package("template_1"))
		self.assertTrue(template_packages.is_package("template_2"))
		self.assertTrue(template_packages.is_package("template_3"))

	def test_template_1_and_2_render_declared_canvas(self) -> None:
		for template_id in ("template_1", "template_2"):
			with self.subTest(template_id=template_id):
				required = template_packages.required_photo_count(template_id)
				rendered = template_packages.render(
					template_id,
					self.photos[:required],
					{"nickname": "PhotoWall"},
				)
				self.assertEqual(rendered.mode, "RGB")
				self.assertEqual(rendered.size, (2000, 2668))

	def test_render_rejects_too_few_photos(self) -> None:
		with self.assertRaisesRegex(ValueError, "requires 8 photos, got 7"):
			template_packages.render("template_1", self.photos[:7])


if __name__ == "__main__":
	unittest.main()

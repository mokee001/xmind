from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from backend.pet_collage import PetPhotoScore, render_denim, select_scores


def score(filename: str, pet_id: str = "white-tabby-longhair-cat", quality: float = 8) -> PetPhotoScore:
    return PetPhotoScore(
        filename=filename,
        is_pet=True,
        pet_count=1,
        has_human=False,
        blur_type="none",
        technical_quality=quality,
        life_moment=8,
        subject_ratio=72,
        pet_id=pet_id,
        face_score=8,
        shot_type="close_up",
        background_complexity=2,
        dominant_color="#8899aa",
    )


class PetCollageTests(unittest.TestCase):
    def test_selection_requires_five_photos_of_same_pet(self) -> None:
        mixed = [score(f"a-{index}.jpg") for index in range(4)]
        mixed.extend(score(f"b-{index}.jpg", "black-solid-shorthair-cat") for index in range(4))
        with self.assertRaisesRegex(ValueError, "同一只宠物"):
            select_scores(mixed)

        selected = select_scores(mixed + [score("a-hero.jpg", quality=9.5)])
        self.assertEqual(len(selected), 5)
        self.assertEqual({item["slot"] for item in selected}, {
            "photo_1", "photo_2", "photo_3", "photo_4", "photo_hero",
        })
        self.assertEqual(next(item["filename"] for item in selected if item["slot"] == "photo_hero"), "a-hero.jpg")

    def test_denim_renderer_uses_transparent_cutouts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            asset_root = root / "assets"
            asset_root.mkdir()
            Image.new("RGBA", (400, 500), "#27465f").save(asset_root / "background.png")
            Image.new("RGBA", (40, 40), "#ffd84d").save(asset_root / "sticker.png")
            slots = []
            for index, name in enumerate(("photo_1", "photo_2", "photo_hero", "photo_3", "photo_4")):
                slots.append({
                    "name": name,
                    "x": (index % 2) * 200,
                    "y": (index // 2) * 160,
                    "width": 180,
                    "height": 180,
                    "rotation": 0,
                    "z_index": 2 + index,
                })
            template = {
                "canvas": {"width": 400, "height": 500},
                "photo_slots": slots,
                "stickers": [{
                    "name": "sticker",
                    "x": 180,
                    "y": 220,
                    "width": 20,
                    "height": 20,
                    "rotation": 0,
                    "z_index": 1,
                    "asset_file": "sticker.png",
                }],
            }
            (asset_root / "template.json").write_text(json.dumps(template), encoding="utf-8")
            selected = []
            cutouts = {}
            for index, slot in enumerate(slots):
                filename = f"pet-{index}.jpg"
                path = root / f"cutout-{index}.png"
                image = Image.new("RGBA", (120, 120))
                ImageDraw.Draw(image).ellipse((10, 10, 110, 110), fill=(230, 160, 80, 255))
                image.save(path)
                selected.append({"slot": slot["name"], "filename": filename, "mirror": False})
                cutouts[filename] = str(path)
            output = root / "result.png"
            render_denim(selected, cutouts, output, asset_root=asset_root)
            with Image.open(output) as rendered:
                self.assertEqual(rendered.mode, "RGB")
                self.assertEqual(rendered.size, (400, 500))


if __name__ == "__main__":
    unittest.main()
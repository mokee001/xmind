from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from calendar_engine.decoration import (
    build_decoration_plan,
    category_candidate_score,
    category_scores,
    strongest_category,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LIBRARY_DIR = PROJECT_ROOT / "calendar_engine" / "assets" / "dynamic_stickers"


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class DecorationPlanTest(unittest.TestCase):
    def sample_plan(self) -> dict[str, object]:
        def photo_day(day: int, reason: str) -> dict[str, object]:
            return {
                "day": day,
                "sources": [f"proxies/2026-07-{day:02d}__001.jpg"],
                "treatment": "irregular_cutout",
                "reason": reason,
                "placements": [],
            }

        return {
            "schema_version": "1.2",
            "calendar": {"year": 2026, "month": 7},
            "days": [
                photo_day(3, "手写生日贺卡与纸张内容"),
                photo_day(4, "人物半身近景"),
                photo_day(11, "电影海报"),
                photo_day(20, "城市晚霞与湖面风景"),
                photo_day(25, "现场音乐演出与唱歌"),
                photo_day(27, "两只宠物猫的亲密互动"),
            ],
        }

    def test_music_and_film_outranks_paper_for_movie_poster(self) -> None:
        day = {"reason": "电影海报记录当晚娱乐生活"}
        scores = category_scores(day)
        category, _score = strongest_category(day)
        self.assertGreater(scores["music_and_film"], scores["paper"])
        self.assertEqual(category, "music_and_film")

    def test_pure_scenery_outranks_portrait_with_scenic_background(self) -> None:
        portrait = {"reason": "湖边人物侧脸肖像，背景是旅行中的湖水"}
        scenery = {"reason": "城市晚霞与湖面风景"}
        portrait_score = category_candidate_score(
            portrait,
            "scenery",
            category_scores(portrait)["scenery"],
        )
        scenery_score = category_candidate_score(
            scenery,
            "scenery",
            category_scores(scenery)["scenery"],
        )
        self.assertGreater(scenery_score, portrait_score)

    def test_builds_sparse_semantic_plan_and_copies_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            write_json(run_dir / "treatment_plan.json", self.sample_plan())
            result = build_decoration_plan(run_dir, maximum_decorated_cells=5)

            items = result["dynamic_layer"]["items"]
            by_category = {item["category"]: item for item in items}
            self.assertEqual(by_category["paper"]["owner_day"], 3)
            self.assertEqual(by_category["people_and_animals"]["owner_day"], 27)
            self.assertEqual(by_category["scenery"]["owner_day"], 20)
            self.assertEqual(by_category["music_and_film"]["owner_day"], 25)
            self.assertIn("abstract", by_category)
            self.assertLessEqual(len(items), 5)
            self.assertTrue((run_dir / "decoration_plan.json").is_file())
            self.assertTrue(
                (run_dir / "assets" / "dynamic_stickers" / "manifest.json").is_file()
            )

            for item in items:
                asset = run_dir / item["asset"]
                self.assertTrue(asset.is_file())
                with Image.open(asset) as image:
                    self.assertEqual(image.mode, "RGBA")
                    alpha_minimum, alpha_maximum = image.getchannel("A").getextrema()
                    self.assertLess(alpha_minimum, 250)
                    self.assertGreater(alpha_maximum, 0)
                self.assertLessEqual(item["visual_count"], 2)

            serialized = json.dumps(result, ensure_ascii=False)
            self.assertNotIn("/Users/", serialized)
            self.assertEqual(
                result["layer_order"],
                [
                    "base",
                    "content",
                    "date",
                    "overlay_sticker_static",
                    "overlay_sticker_dynamic",
                ],
            )

    def test_no_abstract_item_when_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            write_json(run_dir / "treatment_plan.json", self.sample_plan())
            result = build_decoration_plan(
                run_dir,
                maximum_decorated_cells=5,
                include_abstract_blank=False,
            )
            categories = {
                item["category"] for item in result["dynamic_layer"]["items"]
            }
            self.assertNotIn("abstract", categories)


if __name__ == "__main__":
    unittest.main()

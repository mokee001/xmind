from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend import curation, selection_policy, selector


def photo(name: str, timestamp: float, tags: list[str], quality: float = 0.8) -> dict:
    return {"path": f"/{name}", "filename": name, "taken_at": timestamp,
            "tags": tags, "quality": quality, "aesthetic": quality}


class CurationTests(unittest.TestCase):
    def test_groups_nearby_photos_and_splits_distant_events(self) -> None:
        photos = [photo("a.jpg", 1_700_000_000, ["person"]),
                  photo("b.jpg", 1_700_000_600, ["person"]),
                  photo("c.jpg", 1_700_020_000, ["city"])]
        prepared = curation.prepare(photos, now=1_700_020_001)
        self.assertEqual(prepared[0]["event_id"], prepared[1]["event_id"])
        self.assertNotEqual(prepared[1]["event_id"], prepared[2]["event_id"])

    def test_memory_score_is_explainable_and_rejected_photo_stays_zero(self) -> None:
        valid = photo("family.jpg", 1_600_000_000, ["person", "travel"])
        rejected = photo("screen.png", 1_600_000_000, ["person"], quality=0.0)
        prepared = curation.prepare([valid, rejected], now=1_700_000_000)
        self.assertGreater(prepared[0]["memory_score"], 0.5)
        self.assertIn("人物记忆", prepared[0]["memory_reasons"])
        self.assertEqual(prepared[1]["memory_score"], 0.0)


class SelectionPolicyTests(unittest.TestCase):
    def test_explicit_theme_profile_does_not_require_template_changes(self) -> None:
        travel = selection_policy.resolve(profile_name="travel")
        self.assertEqual(travel["name"], "travel")
        self.assertAlmostEqual(sum(travel["weights"].values()), 1.0)
        self.assertGreater(travel["weights"]["memory"], travel["weights"]["quality"])

    def test_template_binding_is_data_driven(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "profiles.json"
            path.write_text(json.dumps({
                "default_profile": "default",
                "profiles": {"default": selection_policy.FALLBACK,
                             "pet": {"weights": {"quality": 0, "aesthetic": 0,
                                                   "preference": 0, "memory": 1}}},
                "template_bindings": {"pet_collage": "pet"},
            }), encoding="utf-8")
            original = selection_policy.CONFIG_PATH
            try:
                selection_policy.CONFIG_PATH = path
                self.assertEqual(selection_policy.resolve("pet_collage")["name"], "pet")
            finally:
                selection_policy.CONFIG_PATH = original

    def test_memory_weight_changes_ranking(self) -> None:
        policy = {"name": "memory-only",
                  "weights": {"quality": 0, "aesthetic": 0, "preference": 0, "memory": 1},
                  "semantic_diversity": 0, "event_diversity": 0}
        low = {**photo("pretty.jpg", 1, [], 1.0), "memory_score": 0.2}
        high = {**photo("memory.jpg", 2, [], 0.4), "memory_score": 0.9}
        ranked = selector.rank_photos([low, high], model={"weights": {}, "bias": 0.5}, policy=policy)
        self.assertEqual(ranked[0]["filename"], "memory.jpg")


if __name__ == "__main__":
    unittest.main()

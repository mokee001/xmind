from __future__ import annotations

import copy
import datetime as dt
import json
import unittest
from unittest.mock import patch

from test_selection_lab import LabFixture, ServerTests
from selection_lab.collections import build_collections, classify, sample_date
from selection_lab.core import LabError, TZ, atomic_json


class CollectionTests(LabFixture):
    def prepare_vision(self):
        index = {"schema_version": 1, "dataset_id": self.lab.dataset_id,
                 "extractor": {"engine": "synthetic fixture, not Vision inference"}, "assets": {}}
        for p in self.lab.features:
            index["assets"][p["id"]] = {"sha256": p["sha256"], "faces": 1, "labels": [
                {"identifier": "people", "confidence": .9}, {"identifier": "food", "confidence": .1}]}
        atomic_json(self.state / "album-features.json", index)
        return index

    def test_missing_content_index_never_fabricates_themes(self):
        with self.assertRaises(LabError):
            build_collections(self.lab, {})

    def test_collections_are_deterministic_and_filtered(self):
        self.prepare_vision()
        with patch("urllib.request.urlopen", side_effect=AssertionError("network disallowed")):
            a, b = build_collections(self.lab, {}), build_collections(self.lab, {})
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(a["albums"], b["albums"])
        self.assertTrue(a["albums"])
        forbidden = {self.lab.features[4]["id"], self.lab.features[5]["id"]}
        for album in a["albums"]:
            self.assertFalse(set(album["photo_ids"]) & forbidden)
            self.assertIn(album["cover"], album["photo_ids"])
            self.assertEqual(len(album["photo_ids"]), len(set(album["photo_ids"])))
            self.assertGreaterEqual(len(album["photo_ids"]), 3)

    def test_higher_quality_limit_can_result_in_no_albums(self):
        self.prepare_vision()
        self.assertEqual(build_collections(self.lab, {"quality_min": .99})["albums"], [])
        self.assertEqual(build_collections(self.lab, {"count": 1})["albums"], [])

    def test_new_non_photo_evidence_is_excluded(self):
        index = self.prepare_vision()
        first = self.lab.features[0]["id"]
        index["assets"][first]["labels"].append({"identifier": "screenshot", "confidence": .95})
        atomic_json(self.state / "album-features.json", index)
        result = build_collections(self.lab, {})
        self.assertEqual(result["excluded"]["vision_non_photo"], 1)
        self.assertNotIn(first, {p["id"] for p in result["photos"]})

    def test_filename_date_is_explicit_and_does_not_mutate_original(self):
        p = {"filename": "2026-07-04__003.jpg", "taken_at": 1785200000}
        before = copy.deepcopy(p)
        timestamp, source = sample_date(p)
        self.assertEqual(dt.datetime.fromtimestamp(timestamp, TZ).day, 4)
        self.assertEqual(source, "filename_date")
        self.assertEqual(p, before)
        self.assertEqual(sample_date({"filename": "2026-99-99__1.jpg", "taken_at": 123}), (123, "cached_timestamp_unverified"))

    def test_theme_scores_are_required_and_faces_do_not_claim_identity(self):
        rejected, themes, _ = classify({"faces": 0, "labels": [{"identifier": "food", "confidence": .1}]})
        self.assertFalse(rejected)
        self.assertEqual(themes, {})
        _, themes, _ = classify({"faces": 1, "labels": [{"identifier": "people", "confidence": .3}]})
        self.assertIn("people", themes)
        self.assertNotIn("person_id", themes)

    def test_unknown_or_failed_features_fail_closed(self):
        index = self.prepare_vision()
        index["assets"][self.lab.features[0]["id"]]["sha256"] = "wrong"
        index["assets"][self.lab.features[1]["id"]]["error"] = "vision_failed"
        atomic_json(self.state / "album-features.json", index)
        result = build_collections(self.lab, {})
        self.assertEqual(result["excluded"]["missing_vision"], 2)
        self.assertEqual(result["albums"], [])

    def test_body_evidence_recovers_back_views_without_accepting_statues(self):
        obs = {"faces": 0, "humans": [{"confidence": .8}],
               "labels": [{"identifier": "people", "confidence": .3}]}
        self.assertIn("people", classify(obs)[1])
        obs["labels"].append({"identifier": "statue", "confidence": .8})
        self.assertNotIn("people", classify(obs)[1])
        self.assertNotIn("people", classify({"humans": [{"confidence": .9}], "labels": []})[1])

    def test_albums_use_their_own_pool_not_global_top_n(self):
        self.prepare_vision()
        # This function never calls Lab.run or reads a global Top N selection.
        with patch.object(self.lab, "run", side_effect=AssertionError("not a Top N regrouping")):
            self.assertTrue(build_collections(self.lab, {})["albums"])


class CollectionApiTests(ServerTests):
    def test_collection_api_and_snapshot_save(self):
        CollectionTests.prepare_vision(self)
        with self.request("/api/collections", {"config": {}}) as response:
            albums = json.load(response)
        with self.request("/api/run", {"config": {}}) as response:
            run = json.load(response)
        with self.request("/api/save", {"config": run["config"], "expected_id": run["id"],
                                       "name": "With album snapshot", "collection_id": albums["id"]}) as response:
            saved = json.load(response)
        self.assertEqual(saved["result"]["collection_snapshot"]["id"], albums["id"])


if __name__ == "__main__":
    unittest.main()

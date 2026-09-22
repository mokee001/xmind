import copy
import json
from unittest.mock import patch

from test_album_collections import CollectionTests as _CollectionTests
from test_selection_lab import LabFixture, ServerTests as _ServerTests
from selection_lab.collections import build_collections
from selection_lab.core import LabError, atomic_json
from selection_lab.ente import latest_result
from selection_lab.hybrid import (THEME_MAPPING, build_hybrid_collections, content_from_record,
                                  latest_hybrid, save_hybrid)


def prepare(lab_fixture):
    _CollectionTests.prepare_vision(lab_fixture)
    lab = lab_fixture.lab
    # Deliberately tiny, synthetic test data; not claimed as an actual inference run.
    hashes = [p["sha256"] for p in lab.features]
    package = lab_fixture.ente_package()
    package["memories"] = []  # Hybrid must not be derived from natural Memories membership.
    result = lab.import_ente(package)
    types = sorted({kind for values in THEME_MAPPING.values() for kind in values})
    themes = [{"type": kind, "title": "fixture " + kind,
               "matching_count": 3 if kind == "pets" else 0,
               "matches": [{"sha256": sha, "score": .3} for sha in hashes[:3]] if kind == "pets" else []}
              for kind in types]
    result["ente_diagnostics"] = {"photo_count": len(lab.features), "embedding_count": len(lab.features),
        "clip_threshold": .225, "themes": themes, "face_count": 0, "cluster_count": 0,
        "detected_faces": [], "person_groups": []}
    record = lab.save_run(result, "synthetic complete recognition fixture")
    return record


class HybridTests(LabFixture):
    def test_uses_all_recognition_not_empty_natural_memories_and_no_vision_positive_fallback(self):
        record = prepare(self)
        self.assertEqual(record["result"]["events"], [])
        with patch.object(self.lab, "run", side_effect=AssertionError("must not regroup global Top N")):
            result = build_hybrid_collections(self.lab, {}, record=record)
        self.assertEqual(result["engine"], "photo-wall-ente-hybrid")
        self.assertIn("theme-pet", {a["id"] for a in result["albums"]})
        self.assertNotIn("theme-people", {a["id"] for a in result["albums"]})  # Vision strongly says people, Ente does not.
        self.assertEqual(result["diagnostics"]["theme_candidates"]["pet"], 3)

    def test_shared_filters_are_identical_even_when_ente_matches_excluded_photos(self):
        record = prepare(self)
        pet = next(t for t in record["result"]["ente_diagnostics"]["themes"] if t["type"] == "pets")
        pet["matches"] = [{"sha256": p["sha256"], "score": .7} for p in self.lab.features]
        pet["matching_count"] = len(self.lab.features)
        vision = _CollectionTests.prepare_vision(self)
        vision["assets"][self.lab.features[0]["id"]]["labels"].append({"identifier": "screenshot", "confidence": .9})
        atomic_json(self.state / "album-features.json", vision)
        self.lab.features[1]["quality"] = 0
        current = build_collections(self.lab, {})
        hybrid = build_hybrid_collections(self.lab, {}, record=record)
        self.assertEqual(current["excluded"], hybrid["excluded"])
        self.assertEqual(current["eligible_count"], hybrid["eligible_count"])
        self.assertEqual(hybrid["excluded"], {"base_non_photo": 2, "vision_non_photo": 1, "quality": 1})
        self.assertEqual(hybrid["albums"], [])  # never relax minimum size to fill output

    def test_undated_enters_theme_but_never_month_or_day(self):
        record = prepare(self)
        first = self.lab.features[0]
        first.update(taken_at=None, date_source="unknown")
        hybrid = build_hybrid_collections(self.lab, {}, record=record)
        pet = next(a for a in hybrid["albums"] if a["id"] == "theme-pet")
        self.assertIn(first["id"], pet["photo_ids"])
        for album in hybrid["albums"]:
            if album["kind"] != "theme":
                self.assertNotIn(first["id"], album["photo_ids"])
        self.assertEqual(hybrid["diagnostics"]["selected_unknown_date"], 1)

    def test_semantics_do_not_delete_photos_or_inject_ente_vectors(self):
        record = prepare(self)
        self.lab.features[1]["clip_embedding"] = self.lab.features[0]["clip_embedding"][:]
        before = copy.deepcopy(self.lab.features)
        hybrid = build_hybrid_collections(self.lab, {}, record=record)
        self.assertIn("theme-pet", {a["id"] for a in hybrid["albums"]})  # semantic-only matches remain
        self.assertEqual(self.lab.features, before)
        self.assertIn("no MobileCLIP-S2", hybrid["provenance"]["dedup_provider"])

    def test_replay_deterministic_and_read_only(self):
        record = prepare(self)
        before = copy.deepcopy(record)
        original_files = {p: p.read_bytes() for p in self.cache.glob("*.json")}
        with patch("urllib.request.urlopen", side_effect=AssertionError("no network")):
            a = build_hybrid_collections(self.lab, {}, record=record)
            b = build_hybrid_collections(self.lab, {}, record=record)
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(a["albums"], b["albums"])
        self.assertEqual(record, before)
        self.assertTrue(all(p.read_bytes() == value for p, value in original_files.items()))

    def test_missing_or_mismatched_diagnostics_fail_closed(self):
        initial = prepare(self)
        for mutate in [lambda r: r.update(dataset_id="wrong"),
                       lambda r: r["result"]["signature"].update(dataset="wrong"),
                       lambda r: r["result"]["provenance"].update(mode="debug_all_candidates"),
                       lambda r: r["result"]["ente_diagnostics"].update(photo_count=1),
                       lambda r: r["result"]["ente_diagnostics"].update(embedding_count=1),
                       lambda r: r["result"]["ente_diagnostics"].update(clip_threshold=float("nan")),
                       lambda r: r["result"]["ente_diagnostics"]["themes"].pop()]:
            record = copy.deepcopy(initial); mutate(record)
            with self.assertRaises(LabError):
                build_hybrid_collections(self.lab, {}, record=record)

    def test_invalid_hash_or_score_rejected(self):
        initial = prepare(self)
        for value in [{"sha256": "wrong", "score": .3},
                      {"sha256": self.lab.features[0]["sha256"], "score": .225}]:
            record = copy.deepcopy(initial)
            next(t for t in record["result"]["ente_diagnostics"]["themes"] if t["type"] == "pets")["matches"][0] = value
            with self.assertRaises(LabError):
                build_hybrid_collections(self.lab, {}, record=record)

    def test_people_face_evidence_does_not_claim_identity(self):
        record = prepare(self)
        face = {"face_id": "fixture-face", "sha256": self.lab.features[0]["sha256"], "box": [.1, .1, .4, .4], "score": .95}
        record["result"]["ente_diagnostics"].update(face_count=1, cluster_count=1, detected_faces=[face],
            person_groups=[{"cluster_id": "fixture-person", "faces": [face]}])
        data = content_from_record(self.lab, record)
        person = data["assets"][self.lab.features[0]["id"]]
        self.assertEqual(person["themes"]["people"], .5)
        self.assertEqual(person["face_count"], 1)
        self.assertNotIn("person_id", person)

    def test_empty_themes_do_not_create_fake_theme_albums(self):
        record = prepare(self)
        for theme in record["result"]["ente_diagnostics"]["themes"]:
            theme.update(matches=[], matching_count=0)
        hybrid = build_hybrid_collections(self.lab, {}, record=record)
        self.assertTrue(all(a["kind"] != "theme" for a in hybrid["albums"]))
        self.assertTrue(all(n == 0 for n in hybrid["diagnostics"]["theme_candidates"].values()))

    def test_snapshot_round_trip_separate_from_ente_natural_and_old_runs(self):
        source = prepare(self)
        original = build_collections(self.lab, {})
        before = (self.state / "runs" / (source["id"] + ".json")).read_bytes()
        self.assertIsNone(latest_hybrid(self.lab))
        saved = save_hybrid(self.lab, build_hybrid_collections(self.lab, {}, record=source))
        self.assertEqual(latest_hybrid(self.lab)["id"], saved["id"])
        self.assertEqual(latest_result(self.lab)["id"], source["id"])
        self.assertEqual((self.state / "runs" / (source["id"] + ".json")).read_bytes(), before)
        self.assertEqual(build_collections(self.lab, {})["albums"], original["albums"])
        self.assertEqual(len(saved["result"]["selected_ids"]), len(set(saved["result"]["selected_ids"])))
        with self.assertRaises(LabError):
            save_hybrid(self.lab, original)


class HybridApiTests(_ServerTests):
    def test_run_and_get_use_correct_engine_and_keep_natural(self):
        source = prepare(self)
        with self.request("/api/hybrid") as response:
            self.assertIsNone(json.load(response)["record"])
        with self.request("/api/hybrid-run", {"config": {}, "name": "fixture hybrid"}) as response:
            record = json.load(response)["record"]
        self.assertEqual(record["result"]["engine"], "photo-wall-ente-hybrid")
        with self.request("/api/hybrid") as response:
            self.assertEqual(json.load(response)["record"]["id"], record["id"])
        with self.request("/api/ente") as response:
            self.assertEqual(json.load(response)["record"]["id"], source["id"])

    def test_no_ente_recognition_does_not_fallback(self):
        import urllib.error
        _CollectionTests.prepare_vision(self)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/hybrid-run", {"config": {}})
        self.assertEqual(error.exception.code, 400)
        self.assertIsNone(latest_hybrid(self.lab))

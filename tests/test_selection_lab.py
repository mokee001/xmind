from __future__ import annotations

import copy
import datetime as dt
import json
import random
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend import curation, dedup, selector
from selection_lab.core import Lab, LabError, MODEL, TZ, atomic_json, validate_config
from selection_lab.server import LabServer


class LabFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.state = self.root / "state"
        self.cache.mkdir()
        local, vectors = {}, {}
        for i in range(6):
            path = self.root / f"photo-{i}.jpg"
            Image.new("RGB", (40, 30), (i * 32, 90, 170)).save(path)
            stat = path.stat()
            stamp = f"{stat.st_size}:{stat.st_mtime_ns}:"
            local[str(path)] = {"path": str(path), "filename": path.name, "quality": .9 - i / 20,
                "aesthetic": .6 + i / 40, "capture_source": "shared", "tags": ["person" if i < 3 else "city"],
                "taken_at": 1783000000 + i * 300, "phash": None, "csig": None,
                "_stamp": stamp + "shared-photo-source-v3"}
            vector = [0.0] * 512
            vector[i] = 1.0
            vectors[str(path)] = {"_stamp": stamp + MODEL, "embedding": vector}
        local[str(self.root / "photo-5.jpg")]["capture_source"] = "non_photo"
        atomic_json(self.cache / "current-cache.json", local)
        atomic_json(self.cache / "immich-cache.json", vectors)
        self.history = self.root / "history.json"
        atomic_json(self.history, {"content_rejected": ["photo-4.jpg"]})
        self.lab = Lab(self.cache, self.state, self.history)

    def tearDown(self):
        self.tmp.cleanup()

    def ente_package(self):
        return {"schema_version": 1, "engine": "ente", "dataset_id": self.lab.dataset_id,
            "provenance": {"commit": "a" * 40, "app_version": "test-fixture", "platform": "test",
                           "generated_at": "2026-09-07T12:00:00+08:00", "model": "fixture-not-real-ente",
                           "exporter_version": "fixture-1", "mode": "natural"},
            "memories": [{"id": "fixture", "title": "Synthetic fixture — not an Ente inference result",
                          "photo_sha256": [self.lab.features[2]["sha256"], self.lab.features[0]["sha256"]]}]}


class ReplayTests(LabFixture):
    def test_replay_is_deterministic_and_read_only(self):
        before = copy.deepcopy(self.lab.features)
        with patch("urllib.request.urlopen", side_effect=AssertionError("network not allowed")):
            a = self.lab.run({"count": 2})
            b = self.lab.run(a["config"])
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(a["selected_ids"], b["selected_ids"])
        self.assertEqual(before, self.lab.features)
        self.assertEqual(a["counts"]["non_photo"], 1)
        self.assertEqual(a["counts"]["historical_content"], 1)
        self.assertEqual(sum(a["counts"].values()), 6)
        self.assertFalse(self.state.exists())

    def test_config_changes_result_without_touching_cache(self):
        snapshots = [(p, p.read_bytes()) for p in self.cache.glob("*.json")]
        all_photos = self.lab.run({"count": 4})
        fewer = self.lab.run({"count": 1})
        self.assertEqual(len(fewer["selected_ids"]), 1)
        self.assertNotEqual(all_photos["id"], fewer["id"])
        self.assertTrue(all(p.read_bytes() == data for p, data in snapshots))

    def test_theme_filters_real_cached_tags(self):
        run = self.lab.run({"theme": "scene"})
        self.assertEqual(len(run["selected_ids"]), 1)
        chosen = next(p for p in run["photos"] if p["id"] in run["selected_ids"])
        self.assertEqual(chosen["filename"], "photo-3.jpg")

    def test_zero_quality_and_non_photo_never_reenter(self):
        self.lab.features[0]["quality"] = 0
        run = self.lab.run({"quality_min": 0, "count": 60})
        self.assertEqual(run["counts"]["quality"], 1)
        self.assertEqual(len(run["selected_ids"]), 3)

    def test_parameter_validation(self):
        for raw in [{"count": -1}, {"count": 2.5}, {"quality_min": float("nan")}, {"theme": "unknown"},
                    {"as_of": "2026-02-30"}, {"new_key": 1}, {"count": True},
                    {"weights": dict.fromkeys(["quality", "aesthetic", "preference", "memory"], 0)}]:
            with self.subTest(raw=raw), self.assertRaises(LabError):
                self.lab.run(raw)

    def test_weight_normalization_is_idempotent(self):
        rng = random.Random(42)
        for _ in range(100):
            config = validate_config({"weights": {k: rng.random() for k in self.lab.defaults["weights"]}}, self.lab.defaults)
            self.assertEqual(config, validate_config(config, self.lab.defaults))

    def test_source_change_does_not_silently_use_cache(self):
        path = Path(self.lab.features[0]["path"])
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaises(LabError):
            self.lab.run({})
        reloaded = Lab(self.cache, self.state, self.history)
        self.assertEqual(len(reloaded.features), 5)

    def test_stale_embeddings_are_not_attached(self):
        vectors = json.loads((self.cache / "immich-cache.json").read_text())
        for item in vectors.values():
            item["_stamp"] = "old-model"
        atomic_json(self.cache / "immich-cache.json", vectors)
        lab = Lab(self.cache, self.state, self.history)
        self.assertEqual(lab.metadata()["clip"]["cached"], 0)
        self.assertEqual(lab.run({"count": 2})["selection_mode"], "标签多样性回退")

    def test_snapshot_and_annotations_survive_restart(self):
        result = self.lab.run({"count": 2})
        saved = self.lab.save_run(result, "First run")
        asset_id = result["selected_ids"][0]
        self.lab.annotate(asset_id, "good", "fixture note")
        lab2 = Lab(self.cache, self.state, self.history)
        self.assertEqual(lab2.get_run(saved["id"])["result"]["selected_ids"], result["selected_ids"])
        self.assertEqual(lab2.get_annotations()[asset_id]["note"], "fixture note")
        self.assertEqual(len(lab2.list_runs()), 1)
        self.assertNotIn("path", lab2.manifest["assets"][0])
        with self.assertRaises(LabError):
            lab2.get_run("../../cache/current-cache")

    def test_shared_default_dedup_and_selector_are_equivalent(self):
        enriched = curation.prepare(self.lab.features[:4], now=1800000000, timezone=TZ)
        kept, _ = dedup.deduplicate(enriched)
        clusters = dedup.duplicate_clusters(enriched)
        self.assertEqual(kept, [max(c, key=lambda p: p["quality"]) for c in clusters])
        policy = {"name": "lab", "weights": self.lab.defaults["weights"], "semantic_diversity": .35, "event_diversity": .12}
        selected = selector.select_for_template(kept, 2, model={"weights": {}, "bias": .5}, policy=policy)
        result = self.lab.run({"count": 2, "as_of": "2027-01-15"})
        self.assertEqual(result["selected_ids"], [p["id"] for p in selected])

    def test_event_gap_does_not_mutate_global(self):
        photos = self.lab.features[:2]
        photos[1]["taken_at"] = photos[0]["taken_at"] + 3600
        small = curation.prepare(photos, event_gap_seconds=900, timezone=TZ)
        normal = curation.prepare(photos, timezone=TZ)
        self.assertNotEqual(small[0]["event_id"], small[1]["event_id"])
        self.assertEqual(normal[0]["event_id"], normal[1]["event_id"])
        self.assertEqual(curation.EVENT_GAP_SECONDS, 14400)


class EnteImportTests(LabFixture):
    def test_import_preserves_order_and_does_not_run_our_selector(self):
        data = self.ente_package()
        with patch.object(selector, "select_for_template", side_effect=AssertionError("not Ente")):
            result = self.lab.import_ente(data)
        self.assertEqual(result["selected_ids"], [self.lab.features[2]["id"], self.lab.features[0]["id"]])
        self.assertEqual(result["engine"], "ente-import")
        self.assertIsNone(result["config"])
        self.assertTrue(all("final_score" not in p for p in result["photos"]))

    def test_empty_natural_result_is_not_filled_by_our_engine(self):
        data = self.ente_package()
        data["memories"] = []
        result = self.lab.import_ente(data)
        self.assertEqual(result["selected_ids"], [])

    def test_import_rejects_other_dataset_or_unknown_assets(self):
        bad_dataset = self.ente_package()
        bad_dataset["dataset_id"] = "wrong"
        bad_hash = self.ente_package()
        bad_hash["memories"][0]["photo_sha256"] = ["0" * 64]
        for data in (bad_dataset, bad_hash):
            with self.assertRaises(LabError):
                self.lab.import_ente(data)

    def test_import_requires_explicit_provenance_and_mode(self):
        for field in ("commit", "model", "mode"):
            data = self.ente_package()
            data["provenance"].pop(field)
            with self.assertRaises(LabError):
                self.lab.import_ente(data)

    def test_import_rejects_duplicates_and_nonmember_cover(self):
        data = self.ente_package()
        data["memories"][0]["photo_sha256"] *= 2
        with self.assertRaises(LabError):
            self.lab.import_ente(data)
        data = self.ente_package()
        data["memories"][0]["cover_sha256"] = self.lab.features[4]["sha256"]
        with self.assertRaises(LabError):
            self.lab.import_ente(data)


class ServerTests(LabFixture):
    def test_engine_comparison_rejects_missing_and_wrong_dataset(self):
        for record in [None, {"dataset_id": "another-library", "engines": []}]:
            if record is not None:
                atomic_json(self.state / "engine-comparison.json", record)
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/engine-comparison")
            self.assertEqual(error.exception.code, 400)

    def test_engine_comparison_preserves_empty_and_pending_results(self):
        record = {"dataset_id": self.lab.dataset_id, "engines": [
            {"id": "ente", "status": "complete", "groups": []},
            {"id": "immich", "status": "preparing", "groups": []}]}
        atomic_json(self.state / "engine-comparison.json", record)
        with patch.object(self.lab, "run", side_effect=AssertionError("No substitute selection")):
            with self.request("/api/engine-comparison") as response:
                self.assertEqual(json.load(response), record)

    def setUp(self):
        super().setUp()
        self.server = LabServer(("127.0.0.1", 0), self.lab)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        super().tearDown()

    def request(self, path, data=None, headers=None):
        h = {"Content-Type": "application/json", "X-Lab-Token": self.server.token, **(headers or {})}
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode() if data is not None else None, headers=h)
        return urllib.request.urlopen(request, timeout=10)

    def test_root_bootstrap_and_thumbnail(self):
        with self.request("/") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        with self.request("/api/bootstrap") as response:
            self.assertEqual(json.load(response)["dataset"]["count"], 6)
        with self.request("/media/" + self.lab.features[0]["id"]) as response:
            self.assertEqual(response.headers["Content-Type"], "image/jpeg")
            self.assertTrue(response.read().startswith(b"\xff\xd8"))

    def test_wrong_host_and_cross_origin_mutations_blocked(self):
        for headers in ({"Host": "attacker.invalid"}, {"Origin": "https://attacker.invalid"}, {"X-Lab-Token": "bad"}):
            with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/run", {"config": {}}, headers)
            self.assertEqual(error.exception.code, 403)

    def test_run_save_restore_and_ente_api(self):
        with self.request("/api/run", {"config": {"count": 2}}) as response:
            result = json.load(response)
        with self.request("/api/save", {"config": result["config"], "expected_id": result["id"], "name": "API fixture"}) as response:
            saved = json.load(response)
        with self.request("/api/runs/" + saved["id"]) as response:
            self.assertEqual(json.load(response)["result"]["selected_ids"], result["selected_ids"])
        with self.request("/api/ente-import", {"export": self.ente_package()}) as response:
            self.assertEqual(json.load(response)["result"]["engine"], "ente-import")

    def test_invalid_request_and_unknown_engine_fail_closed(self):
        for body in ({"config": {"count": "oops"}}, {"engine": "ente", "config": {}}):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/run", body)
            self.assertEqual(error.exception.code, 400)

    def test_arbitrary_files_and_path_traversal_not_served(self):
        for path in ("/../config/selection_profiles.json", "/media/../../README.md", "/api/runs/../../README"):
            with self.assertRaises(urllib.error.HTTPError):
                self.request(path)


if __name__ == "__main__":
    unittest.main()

"""Synthetic boundary tests, never presented as inference on the user's photos."""
import copy
import datetime as dt
import json
import math
from collections import Counter
import unittest
import urllib.error
from unittest.mock import patch

import test_selection_lab as fixtures
import test_album_collections as collection_tests
from test_hybrid_albums import prepare
from selection_lab.core import LabError, TZ, atomic_json, read_json
from selection_lab.collections import build_collections, sample_date
from selection_lab.ente import latest_result
from selection_lab.hybrid import latest_hybrid, save_hybrid, build_hybrid_collections
from selection_lab.stories import (RULES, build_stories, save_stories, latest_stories, load_evidence,
                                   person_pools, event_pools, event_compatible, trip_pools, temporal_pools, unit, cosine,
                                   select_timeline, previous_stories)


def photo(key, hours=0, days=0, source="exif_original_offset"):
    return {"id": str(key), "date_source": source,
            "taken_at": dt.datetime(2026, 7, 1, 8, tzinfo=TZ).timestamp() + days*86400 + hours*3600}


def evidence_for(photos):
    return {"vectors": {p["id"]: (1., 0.) for p in photos}, "locations": {}, "cities": {}, "faces": {},
            "revision": "synthetic-evidence", "models": {"fixture": "not-real-model"}}


def face(key, photo_id, angle=0):
    radians = math.radians(angle)
    return {"face_id": key, "photo_id": photo_id, "score": .87, "blur": 200,
            "box": [.1, .1, .5, .5], "vector": (math.cos(radians), math.sin(radians))}


def recognition_fixture(owner):
    record = prepare(owner)
    e = evidence_for(owner.lab.features)
    detected = []
    for i, p in enumerate(owner.lab.features):
        p["date_source"] = "exif_original_offset"
        f = face(f"face-{i}", p["id"])
        f["sha256"] = p["sha256"]
        e["faces"][f["face_id"]] = f
        detected.append({k: f[k] for k in ["face_id", "sha256", "box", "score"]})
    record["result"]["ente_diagnostics"].update(face_count=len(detected), cluster_count=1,
        detected_faces=detected, person_groups=[{"cluster_id": "synthetic-person", "faces": detected}])
    # Save separately, preserving the original synthetic source too.
    record = owner.lab.save_run(record["result"], "synthetic faces")
    return record, e


class GroupingTests(unittest.TestCase):
    def test_recurring_themes_require_multiple_dates_and_keep_years_separate(self):
        ps = [photo(i, days=i) for i in range(3)]
        for p in ps: p["album_themes"] = {"pet": .7}
        pools = temporal_pools(ps, evidence_for(ps))
        self.assertEqual(len(pools), 1)
        self.assertEqual(pools[0]["evidence"]["distinct_dates"], 3)
        for p in ps: p["taken_at"] = ps[0]["taken_at"]
        self.assertEqual(temporal_pools(ps, evidence_for(ps)), [])
        for p in ps: p.update(taken_at=None, date_source="unknown")
        pools = temporal_pools(ps, evidence_for(ps))
        self.assertIsNone(pools[0]["evidence"]["year"])
        self.assertIn("日期待补", pools[0]["title"])

    def test_bad_vectors_and_mixed_spaces_fail(self):
        for v in [None, [], [0., 0.], [float("nan")], [True]]:
            with self.assertRaises(LabError): unit(v)
        with self.assertRaises(LabError): unit([1., 0.], 512)
        with self.assertRaises(LabError): cosine([1.], [1., 0.])

    def test_person_complete_link_blocks_similarity_chains(self):
        ps = [photo(i) for i in range(3)]
        e = evidence_for(ps)
        fs = [face(str(i), p["id"], i*30) for i, p in enumerate(ps)]
        e["faces"] = {f["face_id"]: f for f in fs}
        pools, _, _ = person_pools(ps, e, [{"cluster_id": "chain", "faces": fs}])
        self.assertEqual(pools, [])  # A~B and B~C must not imply A~C.
        fs[2]["vector"] = fs[1]["vector"]
        pools, memberships, _ = person_pools(ps, e, [{"cluster_id": "chain", "faces": fs}])
        self.assertEqual(len(pools), 1)
        self.assertFalse(pools[0]["evidence"]["identity_confirmed"])
        self.assertEqual(len(memberships), 3)

    def test_two_faces_in_one_photo_cannot_fill_a_person_group(self):
        ps = [photo(i) for i in range(2)]
        fs = [face("a", "0"), face("b", "0"), face("c", "1")]
        e = evidence_for(ps); e["faces"] = {f["face_id"]: f for f in fs}
        self.assertEqual(person_pools(ps, e, [{"cluster_id": "same-photo", "faces": fs}])[0], [])

    def test_small_blurry_or_low_score_faces_are_not_identity_evidence(self):
        ps = [photo(i) for i in range(3)]
        for override in [{"score": .79}, {"blur": 49}, {"box": [.1, .1, .11, .11]}]:
            fs = [face(str(i), str(i)) for i in range(3)]; fs[0].update(override)
            e = evidence_for(ps); e["faces"] = {f["face_id"]: f for f in fs}
            self.assertEqual(person_pools(ps, e, [{"cluster_id": "quality", "faces": fs}])[0], [])

    def test_same_day_is_not_sufficient_and_location_conflict_splits(self):
        a, b = photo("a"), photo("b", hours=1)
        e = evidence_for([a, b]); e["vectors"]["b"] = (0., 1.)
        self.assertFalse(event_compatible(a, b, e, {}))
        e["vectors"]["b"] = (1., 0.)
        self.assertTrue(event_compatible(a, b, e, {}))
        e["locations"] = {"a": (30., 120.), "b": (31., 120.)}
        self.assertFalse(event_compatible(a, b, e, {}))

    def test_event_time_boundary_unknown_date_and_broad_similarity(self):
        a, b = photo("a"), photo("b", hours=5)
        e = evidence_for([a, b])
        self.assertFalse(event_compatible(a, b, e, {}))
        b.update(taken_at=a["taken_at"], date_source="unknown")
        self.assertFalse(event_compatible(a, b, e, {}))
        b["date_source"] = "exif_original_offset"
        e["vectors"]["b"] = (.5, math.sqrt(.75))
        self.assertFalse(event_compatible(a, b, e, {}))
        self.assertTrue(event_compatible(a, b, e, {"a": {"candidate"}, "b": {"candidate"}}))

    def test_day_only_group_labeled_as_scene_not_confirmed_activity(self):
        ps = [photo(i, source="filename_date") for i in range(3)]
        groups, _ = event_pools(ps, evidence_for(ps), {})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["evidence"]["date_precision"], "day")
        self.assertIn("相似场景", groups[0]["title"])
        self.assertFalse(groups[0]["evidence"]["event_confirmed"])
        self.assertIsNone(groups[0]["evidence"]["span_hours"])

    def test_event_complete_link_does_not_chain_different_scenes(self):
        ps = [photo(i, hours=i) for i in range(3)]
        e = evidence_for(ps)
        e["vectors"] = {str(i): (math.cos(math.radians(i*30)), math.sin(math.radians(i*30))) for i in range(3)}
        self.assertEqual(event_pools(ps, e, {})[0], [])

    def trip_fixture(self):
        base = [photo("base"+str(i), days=i) for i in range(3)]
        away = [photo("away"+str(i), days=3, hours=i*2) for i in range(3)]
        e = evidence_for(base+away)
        e["locations"] = {p["id"]: (30., 120.) for p in base}
        e["locations"].update({p["id"]: (32., 120.) for p in away})
        return base, away, e

    def test_trip_requires_base_gps_and_time_not_city_label(self):
        base, away, e = self.trip_fixture()
        groups, stats = trip_pools(base+away, e)
        self.assertTrue(stats["base_found"])
        self.assertEqual(len(groups), 1)
        self.assertFalse(groups[0]["evidence"]["trip_confirmed"])
        self.assertEqual(trip_pools(away, e)[0], [])  # one day cannot establish base
        e["locations"] = {}; e["cities"] = {p["id"]: "A city" for p in base+away}
        self.assertEqual(trip_pools(base+away, e)[0], [])

    def test_return_long_gap_and_impossible_jump_split_trips(self):
        base, away, e = self.trip_fixture()
        returned = photo("return", days=3, hours=3)
        e["locations"]["return"] = (30., 120.)
        self.assertEqual(trip_pools(base+away+[returned], e)[0], [])
        other = [photo("other"+str(i), days=10, hours=i*2) for i in range(3)]
        e["locations"].update({p["id"]: (32., 120.) for p in other})
        self.assertEqual(len(trip_pools(base+away+other, e)[0]), 2)
        e["locations"][away[1]["id"]] = (50., 0.)
        self.assertEqual(trip_pools(base+away, e)[0], [])


class StoriesTests(fixtures.LabFixture):
    def test_shared_filters_dedup_identity_dates_and_determinism(self):
        record, e = recognition_fixture(self)
        before = copy.deepcopy(self.lab.features)
        with patch("urllib.request.urlopen", side_effect=AssertionError("no network")):
            a = build_stories(self.lab, {}, record=record, evidence=e)
            b = build_stories(self.lab, {}, record=record, evidence=e)
        self.assertEqual(a["id"], b["id"]); self.assertEqual(a["albums"], b["albums"])
        self.assertEqual(self.lab.features, before)
        self.assertEqual(a["eligible_count"], 4)
        self.assertEqual(a["excluded"], build_collections(self.lab, {})["excluded"])
        self.assertEqual(a["diagnostics"]["album_counts"], {"person": 1, "event": 0, "trip": 0, "place": 0, "theme": 0})
        self.assertEqual(a["diagnostics"]["selection"]["already_covered"], 1)
        self.assertEqual(a["photo_count"], 4)  # not 8 memberships
        encoded = json.dumps(a)
        for sensitive in ['"embedding"', '"latitude"', '"longitude"', '"vector"', '"path"']:
            self.assertNotIn(sensitive, encoded)
        self.lab.features[0].update(taken_at=None, date_source="unknown")
        r = build_stories(self.lab, {}, record=record, evidence=e)
        key = self.lab.features[0]["id"]
        self.assertIn(key, next(g for g in r["albums"] if g["kind"]=="person")["photo_ids"])
        self.assertNotIn(key, [i for g in r["albums"] if g["kind"]=="event" for i in g["photo_ids"]])
        self.lab.features[1]["clip_embedding"] = self.lab.features[2]["clip_embedding"][:]
        self.assertEqual(build_stories(self.lab, {}, record=record, evidence=e)["photo_count"], 4)  # semantic similarity is not duplication
        for i in (1, 2):
            self.lab.features[i].update(phash=1234, csig=list(range(36)))
        self.assertLess(build_stories(self.lab, {}, record=record, evidence=e)["photo_count"], 4)
        self.assertEqual(build_stories(self.lab, {"count": 1}, record=record, evidence=e)["albums"], [])

    def test_snapshot_is_separate_and_existing_results_are_preserved(self):
        record, e = recognition_fixture(self)
        h = save_hybrid(self.lab, build_hybrid_collections(self.lab, {}, record=record))
        before = {p: p.read_bytes() for p in (self.state / "runs").glob("*.json")}
        self.assertIsNone(latest_stories(self.lab))
        saved = save_stories(self.lab, build_stories(self.lab, {}, record=record, evidence=e))
        self.assertEqual(latest_stories(self.lab)["id"], saved["id"])
        self.assertEqual(latest_result(self.lab)["id"], record["id"])
        self.assertEqual(latest_hybrid(self.lab)["id"], h["id"])
        self.assertTrue(all(p.read_bytes()==body for p, body in before.items()))
        with self.assertRaises(LabError): save_stories(self.lab, build_collections(self.lab, {}))

    def test_timeline_preserves_span_and_prefers_unseen_within_the_same_day(self):
        ps = [{**photo(i, days=i//2), "quality": .7, "aesthetic": .7, "album_themes": {"pet": .8}, "tags": ["pet"]} for i in range(6)]
        cfg = {**self.lab.defaults, "count": 3}
        uses = Counter({"0": 1, "4": 1})
        result = select_timeline(ps, {"kind": "theme"}, cfg, uses)
        self.assertEqual({p["id"] for p in result}, {"1", "3", "5"})
        ps.append({**ps[0], "id": "unknown", "taken_at": None, "date_source": "unknown"})
        self.assertEqual(len(select_timeline(ps, {"kind": "theme"}, cfg, uses)), 3)
        self.assertEqual(uses, Counter({"0": 1, "4": 1}))

    def test_repeated_save_does_not_erase_before_snapshot(self):
        record, e = recognition_fixture(self)
        first = save_stories(self.lab, build_stories(self.lab, {}, record=record, evidence=e))
        changed = build_stories(self.lab, {"count": 3}, record=record, evidence=e)
        save_stories(self.lab, changed)
        self.assertEqual(previous_stories(self.lab)["id"], first["id"])
        save_stories(self.lab, changed)
        self.assertEqual(previous_stories(self.lab)["id"], first["id"])

    def test_evidence_cache_validation_fails_closed(self):
        record, e = recognition_fixture(self)
        photos, items = {}, []
        for p in self.lab.features:
            f = next(f for f in e["faces"].values() if f["photo_id"]==p["id"])
            cached = {"embedding": [1.] + [0.]*511, "faces": [{**f, "embedding": list(f["vector"])}]}
            photos[p["id"]] = cached
            timestamp, source = sample_date(p)
            items.append({**cached, "sha256": p["sha256"], "creation_time": int(timestamp*1e6), "date_source": source})
        cache = {"identity": {"dataset": self.lab.dataset_id, "commit": record["result"]["provenance"]["commit"], "models": e["models"]}, "photos": photos}
        atomic_json(self.state/"ente/ml-index.json", cache)
        atomic_json(self.state/"ente/memories-input.json", {"photos": items})
        def mocked_read(path, default=None):
            return {"model_sha256": e["models"]} if path.name=="runtime.json" else read_json(path, default)
        with patch("selection_lab.stories.read_json", side_effect=mocked_read):
            self.assertEqual(len(load_evidence(self.lab, record)["vectors"]), 6)
            for mutate in [lambda c:c["identity"].update(dataset="wrong"), lambda c:c["identity"].update(models={"other":"model"}), lambda c:c["photos"].pop(next(iter(c["photos"]))), lambda c:c["photos"][next(iter(c["photos"]))].update(embedding=[0.]*512)]:
                changed = copy.deepcopy(cache); mutate(changed)
                atomic_json(self.state/"ente/ml-index.json", changed)
                with self.assertRaises(LabError): load_evidence(self.lab, record)
            atomic_json(self.state/"ente/ml-index.json", cache)
            self.lab.features[0]["taken_at"] += 1
            with self.assertRaises(LabError): load_evidence(self.lab, record)


class StoriesApiTests(fixtures.ServerTests):
    def test_separate_route_and_no_missing_evidence_fallback(self):
        with self.request("/api/stories") as response:
            self.assertIsNone(json.load(response)["record"])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/stories-run", {"config": {}})
        self.assertEqual(error.exception.code, 400)
        record, e = recognition_fixture(self)
        with patch("selection_lab.stories.load_evidence", return_value=e):
            with self.request("/api/stories-run", {"config": {}}) as response:
                saved = json.load(response)["record"]
        with self.request("/api/stories") as response:
            self.assertEqual(json.load(response)["record"]["id"], saved["id"])
        self.assertEqual(saved["result"]["engine"], "photo-wall-stories")
        with self.request("/story-albums.js") as response:
            self.assertEqual(response.status, 200)

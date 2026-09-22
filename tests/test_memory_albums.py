"""Synthetic tests for unified memory construction; no model inference or uploads."""
import copy
import json
import math
import unittest
import urllib.error
from unittest.mock import patch

import test_selection_lab as fixtures
from test_story_albums import recognition_fixture, photo, evidence_for
from selection_lab.core import LabError, read_json, atomic_json
from selection_lab.collections import build_collections
from selection_lab.ente import latest_result
from selection_lab.stories import latest_stories
from selection_lab.hybrid import latest_hybrid
from selection_lab.memories import (RULES, settings, combined_content, split_period, recalled,
    proposal, curate, choose_albums, build_memories, save_memories, latest_memories)


def orthogonal_evidence(photos):
    e = evidence_for(photos)
    e["vectors"] = {p["id"]: tuple(float(i==j) for j in range(len(photos))) for i,p in enumerate(photos)}
    return e


def album_photos(n):
    return [{**photo(str(i), hours=i/10),"filename":str(i)+".jpg","quality":.9,"aesthetic":.7,
             "tags":[],"phash":None,"csig":None} for i in range(n)]


class MemoryRulesTests(unittest.TestCase):
    def test_album_settings_have_independent_safe_limits(self):
        self.assertEqual(settings(), {"max_photos":40,"max_albums":18})
        for config in [{"max_photos":7},{"max_photos":61},{"max_photos":True},{"max_albums":0},{"max_photos":float("nan")},{"unknown":1}]:
            with self.assertRaises(LabError): settings(config)

    def test_small_themes_are_not_fragmented_by_year(self):
        ps = [photo(i, days=i*370) for i in range(12)]
        self.assertEqual(split_period(ps), [("all",ps)])
        ps = [photo(i) for i in range(90)]
        for p in ps[45:]: p["taken_at"] += 365*86400
        self.assertEqual(sorted(len(group) for _,group in split_period(ps)), [45,45])

    def test_event_expansion_uses_fixed_anchors_without_chaining(self):
        ps = [photo(i) for i in range(5)]
        e = evidence_for(ps)
        e["vectors"]["3"] = (math.cos(math.radians(40)),math.sin(math.radians(40)))
        e["vectors"]["4"] = (math.cos(math.radians(70)),math.sin(math.radians(70)))
        result = recalled({"pool":ps[:3]},ps,e,"event")
        self.assertEqual({p["id"] for p in result}, {"0","1","2","3"})

    def test_event_recall_rejects_conflicting_place_and_day(self):
        ps = [photo(i) for i in range(5)]
        e = evidence_for(ps)
        e["locations"] = {p["id"]:(30,120) for p in ps[:3]}
        e["locations"]["3"] = (45,120)
        ps[4]["taken_at"] += 86400
        self.assertEqual(len(recalled({"pool":ps[:3]},ps,e,"event")),3)

    def test_recall_never_undoes_return_to_base_boundary(self):
        ps=[photo(i,hours=i) for i in range(4)];e=evidence_for(ps)
        e["locations"]={p["id"]:(30.6,120) for p in ps[:3]}
        e["locations"]["3"]=(30.35,120)
        self.assertEqual(len(recalled({"pool":ps[:3]},ps,e,"trip",base_position=(30,120))),3)

    def test_trip_recall_does_not_use_unknown_dates_or_time_alone(self):
        ps = [photo(i, hours=min(i,4)) for i in range(9)]
        e = evidence_for(ps)
        e["locations"] = {p["id"]:(30,120) for p in ps[:3]}
        e["locations"]["3"] = (30.01,120)  # nearby GPS within the extra time window
        ps[4]["taken_at"] = ps[1]["taken_at"]  # no GPS, but content + exact time
        ps[5].update(taken_at=ps[1]["taken_at"],date_source="filename_date")
        ps[6].update(taken_at=None,date_source="unknown")
        ps[7]["taken_at"] = ps[1]["taken_at"];e["vectors"]["7"]=(0,1)  # time alone
        e["locations"]["8"] = (50,120)  # conflict must not fall back to matching content
        ids = {p["id"] for p in recalled({"pool":ps[:3]},ps,e,"trip")}
        self.assertEqual(ids,{"0","1","2","3","4"})

    def test_complete_vectors_check_duplicates_without_modifying_old_space(self):
        ps = album_photos(20);e = orthogonal_evidence(ps)
        e["vectors"]["1"] = e["vectors"]["0"]
        for i,p in enumerate(ps):p["clip_embedding"]=[float(i==j) for j in range(20)]
        before = copy.deepcopy(ps)
        config={"hash_distance":8,"clip_distance":.03,"weights":{"quality":.5,"aesthetic":.5,"preference":0,"memory":0},"semantic_diversity":.3,"event_diversity":.2}
        chosen, available, removed = curate({"pool":ps},e,config,{"max_photos":40})
        self.assertEqual(available,19);self.assertEqual(removed,1);self.assertEqual(len(chosen),19)
        self.assertEqual(ps,before)
        self.assertEqual(len(curate({"pool":ps},e,config,{"max_photos":8})[0]),8)

    def test_covered_fragments_fold_under_trip_instead_of_duplicate_cards(self):
        ps = album_photos(12);e = orthogonal_evidence(ps)
        config={"hash_distance":8,"clip_distance":.03,"weights":{"quality":.5,"aesthetic":.5,"preference":0,"memory":0},"semantic_diversity":.3,"event_diversity":.2}
        trip = proposal("trip","a","journey",ps)
        fragment = proposal("event","b","fragment",ps[:8],topic="scene")
        groups, skipped = choose_albums([trip,fragment],e,config,settings())
        self.assertEqual(len(groups),1);self.assertEqual(len(groups[0]["selected"]),12)
        self.assertEqual(groups[0]["sources"],["event","trip"])
        self.assertEqual(skipped[0]["reason"],"covered_fragment")


class MemoryIntegrationTests(fixtures.LabFixture):
    def prepare(self):
        record,e = recognition_fixture(self)
        e["vectors"] = orthogonal_evidence(self.lab.features)["vectors"]
        return record,e

    def test_independent_provider_union_and_shared_nonphoto_veto(self):
        record,e = self.prepare()
        content=combined_content(self.lab,record)
        first=self.lab.features[0]
        self.assertEqual(content["assets"][first["id"]]["theme_support"]["pet"],["ente"])
        self.assertIn("vision",content["assets"][first["id"]]["theme_support"]["people"])
        index=read_json(self.state/"album-features.json")
        index["assets"][first["id"]]["labels"].append({"identifier":"screenshot","confidence":.9})
        atomic_json(self.state/"album-features.json",index)
        with patch.dict(RULES,min_photos=3):r=build_memories(self.lab,{},record=record,evidence=e)
        self.assertNotIn(first["id"],{p["id"] for p in r["photos"]})
        self.assertEqual(r["excluded"],build_collections(self.lab,{})["excluded"])

    def test_local_deterministic_full_pool_not_old_top_n_and_safe_payload(self):
        record,e=self.prepare();before=copy.deepcopy(self.lab.features)
        with patch.dict(RULES,min_photos=3),patch.object(self.lab,"run",side_effect=AssertionError("not Top N")),patch("urllib.request.urlopen",side_effect=AssertionError("no network")):
            a=build_memories(self.lab,{},record=record,evidence=e)
            b=build_memories(self.lab,{},record=record,evidence=e)
        self.assertEqual(a["albums"],b["albums"]);self.assertEqual(a["id"],b["id"])
        self.assertEqual(self.lab.features,before)
        self.assertTrue(a["albums"])
        ids={p for album in a["albums"] for p in album["photo_ids"]}
        self.assertEqual(a["photo_count"],len(ids));self.assertEqual({p["id"] for p in a["photos"]},ids)
        for secret in ['"embedding"','"latitude"','"longitude"','"vector"','"path"']:
            self.assertNotIn(secret,json.dumps(a))

    def test_preserves_all_old_snapshots_and_has_own_latest_pointer(self):
        record,e=self.prepare()
        from selection_lab.hybrid import save_hybrid,build_hybrid_collections
        from selection_lab.stories import save_stories,build_stories
        hybrid=save_hybrid(self.lab,build_hybrid_collections(self.lab,{},record=record))
        old=save_stories(self.lab,build_stories(self.lab,{},record=record,evidence=e))
        before={p:p.read_bytes() for p in (self.state/"runs").glob("*.json")}
        with patch.dict(RULES,min_photos=3):saved=save_memories(self.lab,build_memories(self.lab,{},record=record,evidence=e))
        self.assertEqual(latest_memories(self.lab)["id"],saved["id"])
        self.assertEqual(latest_stories(self.lab)["id"],old["id"])
        self.assertEqual(latest_hybrid(self.lab)["id"],hybrid["id"])
        self.assertEqual(latest_result(self.lab)["id"],record["id"])
        self.assertTrue(all(p.read_bytes()==body for p,body in before.items()))

    def test_missing_recognition_never_falls_back_to_simulated_photos(self):
        with self.assertRaises(LabError):build_memories(self.lab,{})


class MemoriesApiTests(fixtures.ServerTests):
    def test_generate_read_restore_and_guard(self):
        with self.request("/api/memories") as response:self.assertIsNone(json.load(response)["record"])
        with self.assertRaises(urllib.error.HTTPError) as error:self.request("/api/memories-run",{})
        self.assertEqual(error.exception.code,400)
        record,e=recognition_fixture(self);e["vectors"]=orthogonal_evidence(self.lab.features)["vectors"]
        with patch.dict(RULES,min_photos=3),patch("selection_lab.stories.load_evidence",return_value=e):
            with self.request("/api/memories-run",{"config":{},"album_settings":{"max_photos":24}}) as response:
                saved=json.load(response)["record"]
        self.assertEqual(saved["result"]["engine"],"photo-wall-memories")
        self.assertEqual(saved["result"]["album_settings"]["max_photos"],24)
        with self.request("/api/memories") as response:self.assertEqual(json.load(response)["record"]["id"],saved["id"])
        with self.request("/memory-albums.js") as response:self.assertEqual(response.status,200)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/memories-run",{},headers={"X-Lab-Token":"bad"})
        self.assertEqual(error.exception.code,403)

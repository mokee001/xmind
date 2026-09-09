"""Synthetic algorithm boundaries and isolated HTTP persistence, not user labels."""
import copy
import json
import math
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import test_selection_lab as fixtures
from test_story_albums import photo, evidence_for, recognition_fixture
from selection_lab.core import LabError, atomic_json
from selection_lab.server import LabServer
from selection_lab.memory_experiment import (RULES, build_experiment, episode_pools, episode_link,
    duplicate_reason, deduplicate, select_story, save_experiment, get_experiment, save_review, reviews)


def ps(n, minutes=10):
    return [{**photo(str(i), hours=i*minutes/60), "quality": .9, "aesthetic": .8,
             "memory_score": .5, "filename": f"synthetic-{i}.jpg", "sha256": f"sha-{i}"} for i in range(n)]


def pool(photos):
    return {"id": "synthetic", "kind": "event", "pool": photos, "evidence": {}, "title": "Synthetic"}


class EpisodeTests(unittest.TestCase):
    def test_geographic_context_connects_very_different_scenes(self):
        photos = ps(4, 30); e = evidence_for(photos)
        e["vectors"] = {p["id"]: tuple(float(i==j) for j in range(4)) for i,p in enumerate(photos)}
        e["locations"] = {p["id"]: (30., 120.) for p in photos}
        groups, _ = episode_pools(photos, e, {})
        self.assertEqual([len(g["pool"]) for g in groups], [4])
        self.assertEqual(len(groups[0]["evidence"]["links"]), 3)
        self.assertFalse(groups[0]["evidence"]["event_confirmed"])

    def test_time_alone_cannot_connect_unrelated_photos(self):
        photos=ps(3); e=evidence_for(photos)
        e["vectors"]={p["id"]: tuple(float(i==j) for j in range(3)) for i,p in enumerate(photos)}
        self.assertEqual(episode_pools(photos,e,{})[0], [])
        members={p["id"]:{"same-candidate"} for p in photos}
        self.assertEqual(len(episode_pools(photos,e,members)[0]), 1)

    def test_location_diameter_prevents_chain_and_unknown_location_bridge(self):
        photos=ps(3); e=evidence_for(photos)
        e["locations"]={"0":(30,120), "1":(30.12,120), "2":(30.24,120)}
        self.assertIsNotNone(episode_link(photos[:1],photos[1],e,{}))
        self.assertIsNone(episode_link(photos[:2],photos[2],e,{}))
        del e["locations"]["1"]
        self.assertIsNone(episode_link(photos[:2],photos[2],e,{}))

    def test_gap_day_and_total_span_boundaries(self):
        photos=ps(3); e=evidence_for(photos);e["locations"]={p["id"]:(30,120) for p in photos}
        for hours in (4,13,24):
            p={**photos[2],"taken_at":photos[0]["taken_at"]+hours*3600}
            self.assertIsNone(episode_link(photos[:1],p,e,{}))
        chain=[{**photos[0],"taken_at":photos[0]["taken_at"]-12*3600},photos[1]]
        self.assertIsNone(episode_link(chain,photos[2],e,{}))

    def test_unknown_and_day_only_dates_do_not_enter_episodes(self):
        for source in ("unknown","filename_date","cached_timestamp_unverified"):
            photos=ps(4)
            for p in photos:p["date_source"]=source
            self.assertEqual(episode_pools(photos,evidence_for(photos),{})[0],[])

    def test_input_order_does_not_change_episodes(self):
        photos=ps(5);e=evidence_for(photos)
        self.assertEqual(episode_pools(photos,e,{}),episode_pools(list(reversed(photos)),e,{}))


class SelectionTests(unittest.TestCase):
    def test_duplicate_needs_strong_visual_and_temporal_evidence(self):
        photos=ps(2,1);e=evidence_for(photos)
        self.assertIsNotNone(duplicate_reason(*photos,e,{}))
        photos[1]["taken_at"]+=86400
        self.assertIsNone(duplicate_reason(*photos,e,{}))
        photos[1]["taken_at"]=photos[0]["taken_at"]
        photos[1]["date_source"]="filename_date"
        self.assertIsNone(duplicate_reason(*photos,e,{}))
        photos[1]["sha256"]=photos[0]["sha256"]
        self.assertIsNotNone(duplicate_reason(*photos,e,{}))

    def test_different_people_and_low_cosine_hash_collision_are_preserved(self):
        photos=ps(2,1);e=evidence_for(photos)
        self.assertIsNone(duplicate_reason(*photos,e,{"0":{"a"},"1":{"b"}}))
        for p in photos:p["phash"]=1
        e["vectors"]["1"]=(0.,1.)
        self.assertIsNone(duplicate_reason(*photos,e,{}))

    def test_complete_link_dedup_keeps_end_of_similarity_chain(self):
        photos=ps(3,.5);e=evidence_for(photos)
        e["vectors"]={str(i):(math.cos(math.radians(i*8)),math.sin(math.radians(i*8))) for i in range(3)}
        kept,removed=deduplicate(photos,e,{})
        self.assertEqual(len(kept),2);self.assertEqual(len(removed),1)
        self.assertEqual(removed[0]["representative"],"0")
        self.assertEqual(deduplicate(photos[::-1],e,{}),(kept,removed))

    def test_one_scene_does_not_fill_all_twelve_slots(self):
        photos=ps(12,3);e=evidence_for(photos)
        album=select_story(pool(photos),e,{},12)
        self.assertEqual(album["scene_count"],1)
        self.assertEqual(len(album["photo_ids"]),3)

    def test_selection_covers_distinct_scenes_and_retains_chronology(self):
        photos=ps(9,3);e=evidence_for(photos)
        for i,p in enumerate(photos):e["vectors"][p["id"]]=tuple(float(j==i//3) for j in range(3))
        album=select_story(pool(photos),e,{},12)
        self.assertEqual(album["selected_scene_count"],3)
        self.assertEqual(len(album["photo_ids"]),5)
        self.assertEqual(album["photo_ids"],sorted(album["photo_ids"],key=int))
        self.assertIn(album["cover"],album["photo_ids"])

    def test_old_clip_vectors_are_ignored_by_new_selection(self):
        photos=ps(5,3);e=evidence_for(photos)
        before=select_story(pool(photos),e,{},12)
        for p in photos:p["clip_embedding"]=[float("nan")]
        self.assertEqual(before,select_story(pool(photos),e,{},12))


class ExperimentTests(fixtures.LabFixture):
    def make(self):
        record,e=recognition_fixture(self)
        return build_experiment(self.lab,{},record=record,evidence=e)

    def test_deterministic_no_network_no_mutation_complete_vectors(self):
        record,e=recognition_fixture(self);before=copy.deepcopy(self.lab.features)
        with patch("urllib.request.urlopen",side_effect=AssertionError("no network")):
            a=build_experiment(self.lab,{},record=record,evidence=e)
            b=build_experiment(self.lab,{},record=record,evidence=e)
        self.assertEqual(a,b);self.assertEqual(before,self.lab.features)
        self.assertEqual(a["diagnostics"]["eligible_count"],4)
        self.assertEqual(len(a["photos"]),6) # also available for false-rejection reviews
        for sensitive in ('"embedding"','"latitude"','"longitude"','"vector"','"path"'):
            self.assertNotIn(sensitive,json.dumps(a))
        e["vectors"].pop(next(iter(e["vectors"])))
        with self.assertRaises(LabError):build_experiment(self.lab,{},record=record,evidence=e)

    def test_snapshot_and_review_leave_old_state_unchanged(self):
        result=self.make();before={p:p.read_bytes() for p in self.state.rglob("*.json")}
        save_experiment(self.lab,result);self.assertEqual(get_experiment(self.lab),result)
        album=result["variants"]["narrative"][0]
        data=dict(snapshot_id=result["id"],variant="narrative",album_id=album["id"],verdict="missing",
                  must_keep_ids=[self.lab.features[-1]["id"]],wrong_ids=[],note="Synthetic test, not a user rating")
        self.assertEqual(save_review(self.lab,data)["source"],"user_review")
        self.assertEqual(len(reviews(self.lab)),1)
        self.assertEqual(get_experiment(self.lab),result)
        self.assertTrue(all(p.read_bytes()==body for p,body in before.items()))
        save_experiment(self.lab,result)
        self.assertEqual(len(reviews(self.lab)),1)

    def test_review_rejects_cross_snapshot_photos_and_conflicting_labels(self):
        r=save_experiment(self.lab,self.make());a=r["variants"]["narrative"][0]
        data=dict(snapshot_id=r["id"],variant="narrative",album_id=a["id"],verdict="good")
        for change in ({"snapshot_id":"../escape"},{"snapshot_id":None},{"album_id":"other"},{"variant":"other"},
                       {"wrong_ids":["outside"]},{"must_keep_ids":["outside"]},
                       {"wrong_ids":[a["cover"]],"must_keep_ids":[a["cover"]]}):
            with self.assertRaises(LabError):save_review(self.lab,{**data,**change})
        self.assertEqual(reviews(self.lab),{})

    def test_http_page_generate_read_and_review(self):
        result=self.make();server=LabServer(("127.0.0.1",0),self.lab)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f"http://127.0.0.1:{server.server_port}"
        def request(path,data=None,token=True):
            headers={"Content-Type":"application/json"}
            if token:headers["X-Lab-Token"]=server.token
            req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
            with urllib.request.urlopen(req) as response:return response.read()
        try:
            self.assertIn("回忆实验",request("/memories").decode())
            for path in ("/memory-experiment.js","/memory-experiment.css"):self.assertTrue(request(path))
            with patch("selection_lab.memory_experiment.build_experiment",return_value=result):
                self.assertEqual(json.loads(request("/api/memory-experiment-run",{}))["result"],result)
            self.assertEqual(json.loads(request("/api/memory-experiment"))["result"],result)
            album=result["variants"]["narrative"][0]
            payload=dict(snapshot_id=result["id"],variant="narrative",album_id=album["id"],verdict="unsure",note="HTTP fixture")
            with self.assertRaises(urllib.error.HTTPError) as error:request("/api/memory-experiment-review",payload,False)
            self.assertEqual(error.exception.code,403)
            self.assertEqual(json.loads(request("/api/memory-experiment-review",payload))["review"]["note"],"HTTP fixture")
            self.assertEqual(len(json.loads(request("/api/memory-experiment"))["reviews"]),1)
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__ == "__main__":unittest.main()

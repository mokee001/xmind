"""Independent synthetic boundaries; no annotations are written to real photos."""
import datetime as dt
import json
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from test_memory_experiment import ps
from test_story_albums import evidence_for
from test_selection_lab import LabFixture
from selection_lab.core import LabError, atomic_json
from selection_lab.recollection_feed import (
    select_photos, recommend, theme_pools, TOPICS, NEGATIVES, TOPIC_NEGATIVES,
    get_feed, feedback, update_feedback)
from selection_lab.server import LabServer


def album(key, topic="pets", score=.7, ids=None):
    return dict(id=key, topic=topic, kind="theme", quality_score=score,
                photo_ids=ids or [f"{key}-{i}" for i in range(24)])


class SelectionTests(unittest.TestCase):
    def test_minimum_and_full_selection_without_percentage_cap(self):
        for count, expected in ((11, None), (12, 12), (18, 18), (35, 24)):
            photos = ps(count)
            result = select_photos({"pool": photos}, evidence_for(photos), {})
            self.assertEqual(len(result["photo_ids"]) if result else None, expected)
            if result:
                self.assertEqual(len(set(result["photo_ids"])), expected)
                self.assertEqual(result["photo_ids"], sorted(result["photo_ids"], key=int))

    def test_deduplication_happens_before_minimum(self):
        photos = ps(12)
        photos[-1]["sha256"] = photos[0]["sha256"]
        self.assertIsNone(select_photos({"pool": photos}, evidence_for(photos), {}))

    def test_topic_and_photo_overlap_limit_feed(self):
        a = album("a", score=.95)
        b = album("b", topic="table", ids=a["photo_ids"])
        c = album("c", score=.6)
        d = album("d", topic="outdoors")
        self.assertEqual(recommend([d, c, b, a], {}, 0), ["a", "d"])

    def test_seen_favorite_hidden_and_feed_limit(self):
        a, b = album("a", score=.8), album("b", score=.7)
        now = dt.datetime.fromisoformat("2026-09-08T12:00:00+08:00").timestamp()
        self.assertEqual(recommend([a, b], {}, now), ["a"])
        self.assertEqual(recommend([a, b], {"b": {"favorite": True}}, now), ["b"])
        self.assertEqual(recommend([a, b], {"a": {"seen_at": "2026-09-08T11:00:00+08:00"}}, now), ["b"])
        self.assertEqual(recommend([a, b], {"a": {"hidden": True}}, now), ["b"])
        self.assertEqual(len(recommend([album(str(i), str(i)) for i in range(10)], {}, now)), 4)

    def test_theme_negative_rejects_lookalikes_and_dates_stay_honest(self):
        photos = ps(12)
        for p in photos:
            p["album_themes"] = ["pet"]
            p["date_source"] = "unknown"
        evidence = evidence_for(photos)
        evidence["vectors"] = {p["id"]: (1., 0.) for p in photos}
        texts = {q: (0., 1.) for t in TOPICS.values() for q in t["prompts"]}
        texts.update({q: (0., 1.) for q in NEGATIVES})
        texts.update({q: (0., 1.) for qs in TOPIC_NEGATIVES.values() for q in qs})
        for q in TOPICS["pets"]["prompts"]: texts[q] = (1., 0.)
        index = {"assets": {p["id"]: {} for p in photos}}
        result = theme_pools(photos, evidence, index, texts)
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]["year"])
        texts[TOPIC_NEGATIVES["pets"][0]] = (1., 0.)
        self.assertEqual(theme_pools(photos, evidence, index, texts), [])


class PersistenceTests(LabFixture):
    def make(self):
        result = {"id": "a" * 24, "provenance": {"dataset_id": self.lab.dataset_id},
                  "albums": [album("a"), album("b", "table")], "photos": []}
        atomic_json(self.state / "recollections/latest.json", {
            "id": result["id"], "dataset_id": self.lab.dataset_id})
        atomic_json(self.state / f"recollections/{result['id']}.json", result)
        return result

    def test_feedback_roundtrip_keeps_snapshot_immutable(self):
        result = self.make()
        path = self.state / f"recollections/{result['id']}.json"
        before = path.read_bytes()
        update_feedback(self.lab, {"album_id": "a", "action": "hide"})
        self.assertNotIn("a", get_feed(self.lab)["featured_ids"])
        update_feedback(self.lab, {"album_id": "a", "action": "restore"})
        update_feedback(self.lab, {"album_id": "a", "action": "favorite"})
        self.assertTrue(feedback(self.lab)["albums"]["a"]["favorite"])
        self.assertIn("a", get_feed(self.lab)["featured_ids"])
        self.assertEqual(before, path.read_bytes())

    def test_invalid_membership_action_and_dataset(self):
        self.make()
        for data in ({"album_id": "missing", "action": "hide"}, {"album_id": "a", "action": "bad"}):
            with self.assertRaises(LabError): update_feedback(self.lab, data)
        atomic_json(self.state / "recollections/latest.json", {"id": "a" * 24, "dataset_id": "other"})
        self.assertIsNone(get_feed(self.lab))
        self.assertEqual(feedback(self.lab)["albums"], {})

    def test_http_page_read_and_protected_feedback(self):
        self.make()
        server = LabServer(("127.0.0.1", 0), self.lab)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        def request(path, data=None, token=True):
            headers = {"Content-Type": "application/json"}
            if token: headers["X-Lab-Token"] = server.token
            req = urllib.request.Request(base + path, headers=headers,
                data=json.dumps(data).encode() if data is not None else None)
            with urllib.request.urlopen(req) as r: return r.read()
        try:
            self.assertIn("值得再看", request("/recollections").decode())
            self.assertTrue(json.loads(request("/api/recollections"))["result"])
            data = {"album_id": "a", "action": "favorite"}
            with self.assertRaises(urllib.error.HTTPError) as error:
                request("/api/recollections-feedback", data, False)
            self.assertEqual(error.exception.code, 403)
            self.assertTrue(json.loads(request("/api/recollections-feedback", data))["feedback"]["favorite"])
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__": unittest.main()

"""Display history uses isolated stores and mocked rendering, never live devices."""

from __future__ import annotations

import asyncio
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from starlette.datastructures import UploadFile

from backend import display_history, server, store


def payload(response):
    return json.loads(response.body)


class DisplayHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="photowall-display-history-")
        self.addCleanup(self.temp.cleanup)
        self.patchers = [
            patch.object(store, "_BASE", self.temp.name),
            patch.object(server, "DEVICE_FRAMES_DIR", str(Path(self.temp.name) / "frames")),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.device = {
            "device_id": "history-device",
            "account_token": "owner-token",
            "device_token": "device-token",
            "device_family": "esp32_e6",
            "created_at": 123,
            "claimed": True,
            "revision": "frame-1",
        }
        self.persist()

    def persist(self):
        store.save("eink_devices", {self.device["device_id"]: self.device})

    def stage(self, revision="frame-1", title="已经展示的旅行"):
        self.device["revision"] = revision
        display_history.stage(self.device, revision, title=title, image_url=f"/output/{revision}.png")
        self.persist()

    def status(self, state="displayed", revision="frame-1", error="", token="device-token"):
        return server.device_status(
            self.device["device_id"],
            server.DeviceStatusReq(state=state, revision=revision, error=error),
            token,
        )

    def records(self, token="owner-token"):
        return server.device_display_history(self.device["device_id"], token)

    def test_queueing_and_non_displayed_states_never_create_history(self):
        self.stage()
        self.assertEqual(payload(self.records()), {"records": []})
        for state in ("queued", "downloading", "refreshing", "error", "failed"):
            self.status(state=state)
            self.assertEqual(payload(self.records()), {"records": []})

    def test_matching_ack_is_idempotent_and_keeps_original_confirmation(self):
        self.stage()
        self.status()
        first = payload(self.records())["records"]
        self.status()
        self.assertEqual(payload(self.records())["records"], first)
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["title"], "已经展示的旅行")
        self.assertEqual(first[0]["revision"], "frame-1")
        self.assertEqual(set(first[0]), {"id", "revision", "confirmedAt", "title"})

    def test_stale_ack_or_error_cannot_create_history(self):
        self.stage("frame-2")
        self.status(revision="frame-1")
        self.status(revision="frame-2", error="panel refresh failed")
        self.assertEqual(payload(self.records())["records"], [])

    def test_unstaged_existing_display_cannot_be_backfilled(self):
        self.device["displayed_revision"] = "frame-1"
        self.persist()
        store.save("last_wall", {"wall_id": "frame-1", "title": "generated only"})
        store.save("recent_shown", ["generated.jpg"])
        self.status()
        self.assertEqual(payload(self.records())["records"], [])

    def test_history_and_ack_require_separate_correct_credentials(self):
        self.stage()
        self.assertEqual(self.status(token="owner-token").status_code, 401)
        for token in ("", "other-account", "device-token"):
            self.assertEqual(self.records(token).status_code, 401)
        self.assertEqual(server.device_display_history("missing-device", "owner-token").status_code, 401)
        self.assertEqual(payload(self.records())["records"], [])

    def test_rebinding_does_not_expose_old_records_or_pending_metadata(self):
        self.stage()
        self.status()
        self.device = store.load("eink_devices", {})[self.device["device_id"]]
        self.device["account_token"] = "new-owner"
        self.persist()
        self.status()
        self.assertEqual(payload(self.records("new-owner"))["records"], [])
        self.assertEqual(self.records("owner-token").status_code, 401)

    def test_reprovisioning_device_credential_keeps_same_owner_history(self):
        self.stage()
        self.status()
        self.device = store.load("eink_devices", {})[self.device["device_id"]]
        self.device["device_token"] = "new-device-token"
        self.persist()
        self.assertEqual(len(payload(self.records())["records"]), 1)

    def test_private_image_and_unconfirmed_metadata_are_not_public(self):
        self.stage()
        published_device = payload(server.device_list("owner-token"))["devices"][0]
        self.assertNotIn("已经展示的旅行", json.dumps(published_device, ensure_ascii=False))
        self.assertNotIn("/output/frame-1.png", json.dumps(published_device))
        self.assertNotIn("已经展示的旅行", json.dumps(server.family._public_device(self.device), ensure_ascii=False))
        self.status()
        self.assertNotIn("/output/", json.dumps(payload(self.records())))

    def test_history_is_newest_first_and_metadata_is_frozen(self):
        self.stage()
        display_history.stage(self.device, "frame-1", title="changed after publication")
        self.persist()
        self.status()
        self.stage("frame-2", "第二次回忆")
        self.status(revision="frame-2")
        records = payload(self.records())["records"]
        self.assertEqual([item["revision"] for item in records], ["frame-2", "frame-1"])
        self.assertEqual(records[1]["title"], "已经展示的旅行")

    def test_screen19_publishing_only_stages_until_ack(self):
        self.device["device_family"] = "walnutpi_19in"
        self.persist()
        wall = {"wall_id": "wall-19", "title": "十九寸回忆", "image_url": "/output/wall-19.png"}
        store.save("last_wall_history-test", wall)

        class Hub:
            async def send_device(self, *args):
                return True

        with (
            patch.object(server, "_account_scope", return_value="history-test"),
            patch.object(server.os.path, "isfile", return_value=True),
            patch.object(server, "hub", Hub()),
        ):
            result = asyncio.run(server.device_publish_last_wall(
                self.device["device_id"], server.PublishWallReq(wall_id="wall-19"), "owner-token",
            ))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(payload(self.records())["records"], [])
        store.save("last_wall_history-test", {"wall_id": "never-published", "title": "下一张预览"})
        self.status(revision="wall-19")
        self.assertEqual(payload(self.records())["records"][0]["title"], "十九寸回忆")

    def test_direct_photo_publish_stages_real_revision(self):
        with (
            patch.object(server.eink_push, "prepare_image", return_value=(Image.new("RGB", (4, 4)), object())),
            patch.object(server.eink_push, "build_panel_frame", return_value=b"test-frame"),
        ):
            response = asyncio.run(server.device_publish(
                self.device["device_id"], UploadFile(file=io.BytesIO(b"test-image")),
                x_account_token="owner-token",
            ))
        revision = payload(response)["revision"]
        self.assertEqual(payload(self.records())["records"], [])
        self.status(revision=revision)
        self.assertEqual(payload(self.records())["records"][0]["revision"], revision)

    def test_shared_queue_helper_preserves_published_title(self):
        with (
            patch.object(server.eink_push, "prepare_image", return_value=(Image.new("RGB", (4, 4)), object())),
            patch.object(server.eink_push, "build_panel_frame", return_value=b"test-frame"),
        ):
            revision, _ = server._queue_device_image(self.device, b"image", title="日历回忆")
        self.persist()
        self.status(revision=revision)
        self.assertEqual(payload(self.records())["records"][0]["title"], "日历回忆")


if __name__ == "__main__":
    unittest.main()

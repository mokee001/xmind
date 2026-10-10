"""Run patched production function bodies with synthetic photos and credentials.

Set PHOTOWALL_LEGACY_HISTORY_SOURCE to also run against a newly retrieved legacy
server source. Otherwise the checked-in exact relevant legacy function fixture
keeps this test reproducible without network or production data access.
"""

from __future__ import annotations

import ast
import asyncio
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import Header
from fastapi.responses import JSONResponse, Response
from PIL import Image
from starlette.datastructures import UploadFile

from backend import display_history, store
from tools.patch_legacy_display_history import CHANGED_FUNCTIONS, patch_source, validate_diff


SOURCE = Path(os.environ.get("PHOTOWALL_LEGACY_HISTORY_SOURCE",
                            Path(__file__).parent / "fixtures/legacy_display_history_server.py"))


def payload(response):
    return json.loads(response.body)


class LegacyDisplayHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="legacy-display-history-")
        self.addCleanup(self.temp.cleanup)
        change = patch.object(store, "_BASE", self.temp.name)
        change.start()
        self.addCleanup(change.stop)
        original = SOURCE.read_text()
        self.source = patch_source(original)
        validate_diff(original, self.source)
        wanted = CHANGED_FUNCTIONS | {"_devices", "_device_auth", "_account_auth", "device_display_history"}
        selected = []
        for node in ast.parse(self.source).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
                node.decorator_list = []
                selected.append(node)
        self.assertEqual({node.name for node in selected}, wanted)
        module = ast.Module(body=[ast.ImportFrom(module="__future__",
                          names=[ast.alias(name="annotations")], level=0), *selected], type_ignores=[])
        self.prepare_image = Mock(return_value=(Image.new("RGB", (4, 4)), b"synthetic-pixels"))
        self.hub = SimpleNamespace(broadcast=AsyncMock())
        self.ns = {
            "store": store, "display_history": display_history, "os": os, "time": time,
            "secrets": secrets, "JSONResponse": JSONResponse, "Response": Response, "Header": Header,
            "DEVICE_FRAMES_DIR": str(Path(self.temp.name) / "frames"), "OUTPUT_DIR": self.temp.name,
            "eink_push": SimpleNamespace(prepare_image=self.prepare_image,
                                         build_panel_frame=lambda pixels: b"synthetic-pwe6"),
            "_device_family": lambda device: device.get("device_family"),
            "_is_eink_device": lambda device: device.get("device_family") == "esp32_e6",
            "DEVICE_FAMILY_WALNUTPI_19IN": "walnutpi_19in", "hub": self.hub,
            "_public_device": lambda device: {k: device.get(k) for k in ("device_id", "revision", "state")},
            "_account_scope": lambda token: hashlib.sha256(token.encode()).hexdigest()[:24],
            "_scoped_store_name": lambda name, scope: name + "_" + scope,
        }
        exec(compile(ast.fix_missing_locations(module), str(SOURCE), "exec"), self.ns)
        self.device = {"device_id": "synthetic-device", "account_token": "synthetic-owner",
                       "device_token": "synthetic-hardware", "created_at": 123, "claimed": True,
                       "device_family": "esp32_e6", "revision": "old-frame", "displayed_revision": "old-frame"}
        self.persist()

    def persist(self):
        store.save("eink_devices", {self.device["device_id"]: self.device})

    def refresh(self):
        self.device = store.load("eink_devices", {})[self.device["device_id"]]

    def history(self, token="synthetic-owner", device_id="synthetic-device"):
        return self.ns["device_display_history"](device_id, token)

    def status(self, revision, state="displayed", error="", token="synthetic-hardware"):
        return self.ns["device_status"](self.device["device_id"],
            SimpleNamespace(state=state, revision=revision, error=error, progress=100, ip="192.0.2.2"), token)

    def queue(self, title="合成测试画面"):
        revision, _ = self.ns["_queue_device_image"](self.device, b"synthetic-image", title=title)
        self.persist()
        return revision

    def publish_wall(self, family="esp32_e6"):
        self.device["device_family"] = family
        self.persist()
        wall = {"wall_id": "synthetic-wall", "title": "合成发布标题", "image_url": "/output/synthetic.png"}
        Path(self.temp.name, "synthetic.png").write_bytes(b"synthetic-image")
        scope = self.ns["_account_scope"]("synthetic-owner")
        store.save("last_wall_" + scope, wall)
        response = asyncio.run(self.ns["device_publish_last_wall"](
            self.device["device_id"], SimpleNamespace(wall_id=wall["wall_id"]), "synthetic-owner"))
        return response

    def test_only_matching_successful_device_receipt_creates_record(self):
        revision = self.queue()
        self.assertEqual(payload(self.history()), {"records": []})
        for state in ("queued", "downloading", "refreshing", "failed", "error"):
            self.status(revision, state=state)
            self.assertEqual(payload(self.history())["records"], [])
        self.status("stale-revision")
        self.status(revision, error="synthetic refresh failure")
        self.assertEqual(payload(self.history())["records"], [])
        before = datetime.datetime.now(datetime.timezone.utc)
        self.status(revision)
        after = datetime.datetime.now(datetime.timezone.utc)
        record = payload(self.history())["records"][0]
        self.assertEqual(record["revision"], revision)
        self.assertEqual(record["title"], "合成测试画面")
        self.assertLessEqual(before, datetime.datetime.fromisoformat(record["confirmedAt"]))
        self.assertLessEqual(datetime.datetime.fromisoformat(record["confirmedAt"]), after)
        self.assertEqual(set(record), {"id", "revision", "confirmedAt", "title"})

    def test_duplicate_ack_preserves_id_and_first_confirmation_time(self):
        revision = self.queue()
        self.status(revision)
        first = payload(self.history())
        self.status(revision)
        self.assertEqual(payload(self.history()), first)

    def test_missing_or_wrong_account_and_device_credentials_are_rejected(self):
        revision = self.queue()
        for token in ("", "other-owner", "synthetic-hardware"):
            self.assertEqual(self.history(token=token).status_code, 401)
        self.assertEqual(self.history(device_id="other-device").status_code, 401)
        for token in ("", "other-hardware", "synthetic-owner"):
            self.assertEqual(self.status(revision, token=token).status_code, 401)
        self.assertEqual(payload(self.history())["records"], [])

    def test_rebinding_cannot_read_old_history_or_confirm_old_pending_metadata(self):
        revision = self.queue()
        self.status(revision)
        self.refresh()
        self.device["account_token"] = "new-owner"
        self.persist()
        self.status(revision)
        self.assertEqual(self.history().status_code, 401)
        self.assertEqual(payload(self.history(token="new-owner"))["records"], [])

    def test_same_owner_new_device_credential_retains_history(self):
        revision = self.queue()
        self.status(revision)
        self.refresh()
        self.device["device_token"] = "new-hardware-token"
        self.persist()
        self.assertEqual(len(payload(self.history())["records"]), 1)

    def test_existing_wall_is_not_backfilled_from_published_or_last_seen_time(self):
        self.device.update(published_at=100, last_seen=time.time(), state="displayed")
        self.persist()
        self.assertEqual(payload(self.history())["records"], [])
        self.status("old-frame")
        self.assertEqual(payload(self.history())["records"], [])

    def test_direct_photo_publication_stages_without_changing_legacy_conversion(self):
        result = asyncio.run(self.ns["device_publish"](
            self.device["device_id"], UploadFile(file=io.BytesIO(b"synthetic-image")),
            x_account_token="synthetic-owner"))
        self.assertEqual(result.status_code, 200)
        self.prepare_image.assert_called_once_with(b"synthetic-image", dither=True,
                                                  fit="contain", rotation=0, enhancement="standard")
        revision = payload(result)["revision"]
        self.assertEqual(payload(self.history())["records"], [])
        self.status(revision)
        self.assertEqual(payload(self.history())["records"][0]["revision"], revision)

    def test_template_publication_preserves_title_and_waits_for_receipt(self):
        result = self.publish_wall()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(payload(self.history())["records"], [])
        self.status(payload(result)["revision"])
        record = payload(self.history())["records"][0]
        self.assertEqual(record["title"], "合成发布标题")
        self.assertNotIn("/output/", json.dumps(record))
        self.assertNotIn("synthetic-owner", json.dumps(record))

    def test_screen19_keeps_targeted_delivery_and_waits_for_real_receipt(self):
        result = self.publish_wall("walnutpi_19in")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(payload(result)["delivery"], "screen19_websocket")
        self.hub.broadcast.assert_awaited_once()
        self.assertEqual(self.hub.broadcast.call_args.kwargs["target_device_ids"], {self.device["device_id"]})
        self.assertEqual(payload(self.history())["records"], [])
        self.status(payload(result)["revision"])
        self.assertEqual(payload(self.history())["records"][0]["title"], "合成发布标题")

    def test_patch_rejects_reapplication_or_unrelated_changes(self):
        with self.assertRaises(ValueError):
            patch_source(self.source)
        with self.assertRaises(ValueError):
            validate_diff(SOURCE.read_text(), self.source + "\nUNRELATED_CHANGE = True\n")


if __name__ == "__main__":
    unittest.main()

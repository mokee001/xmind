"""Synthetic verification for the narrowly scoped 2026-10-10 history repair."""

from __future__ import annotations

import copy
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import display_history, store
from tools import backfill_verified_display_20261010 as migration


class VerifiedDisplayBackfillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="verified-display-repair-")
        self.addCleanup(self.temp.cleanup)
        change = patch.object(store, "_BASE", self.temp.name)
        change.start()
        self.addCleanup(change.stop)
        self.device = {
            "device_id": migration.DEVICE_ID, "revision": migration.REVISION,
            "displayed_revision": migration.REVISION, "state": "displayed", "error": "",
            "published_at": migration.PUBLISHED_AT, "last_seen": 0,
            "created_at": 123, "claimed": True, "account_token": "synthetic-owner",
            "device_token": "synthetic-device-token",
        }
        self.persist()
        self.binding = display_history._binding_key(self.device)
        self.now = datetime.datetime(2026, 10, 10, 8, 30, tzinfo=datetime.timezone.utc)

    def persist(self):
        store.save("eink_devices", {migration.DEVICE_ID: self.device})

    def repair(self, apply=False, now=None):
        return migration.repair(self.binding, apply=apply, observed_at=now or self.now)

    def test_dry_run_writes_nothing_and_marks_unknown_first_display_time(self):
        before = sorted(Path(self.temp.name).iterdir())
        result = self.repair()
        self.assertFalse(result["written"])
        self.assertEqual(sorted(Path(self.temp.name).iterdir()), before)
        record = result["record"]
        self.assertEqual(record["confirmedAt"], self.now.isoformat())
        self.assertEqual(record["observedAt"], self.now.isoformat())
        self.assertIsNone(record["firstDisplayedAt"])
        self.assertEqual(record["source"], "observed_device_state")
        self.assertIn("时间为核对时间", record["title"])
        self.assertIn("首次上屏时间未记录", record["title"])

    def test_apply_is_idempotent_preserves_device_bytes_and_uses_no_photo_metadata(self):
        device_path = Path(store._path("eink_devices"))
        before = device_path.read_bytes()
        first = self.repair(apply=True)
        second = self.repair(apply=True, now=self.now + datetime.timedelta(minutes=1))
        self.assertTrue(first["written"])
        self.assertFalse(second["written"])
        self.assertTrue(second["already_present"])
        self.assertEqual(first["record"], second["record"])
        self.assertEqual(device_path.read_bytes(), before)
        records = display_history.records_for(self.device)
        self.assertEqual(len(records), 1)
        self.assertEqual(set(records[0]), {"id", "revision", "title", "confirmedAt"})
        self.assertNotIn("synthetic-owner", json.dumps(first))
        self.assertNotIn("Image", json.dumps(first))
        path = Path(store._path(display_history._store_key(self.device)))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_binding_device_state_revision_error_or_pending_changes_abort(self):
        original = copy.deepcopy(self.device)
        mutations = [
            {"account_token": "new-owner"}, {"created_at": 124},
            {"device_id": "other-device"}, {"claimed": False},
            {"revision": "new-frame"}, {"displayed_revision": "stale-frame"},
            {"state": "refreshing"}, {"error": "refresh failed"},
            {"pending_command": {"type": "reprovision"}},
            {"published_at": migration.PUBLISHED_AT + 1},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.device = {**original, **mutation}
                self.persist()
                with self.assertRaises(ValueError):
                    self.repair(apply=True)
        self.assertEqual(len(list(Path(self.temp.name).glob("device_display_history*"))), 0)

    def test_only_same_shanghai_day_after_publication_is_allowed(self):
        for timestamp in (
            self.now.replace(tzinfo=None),
            datetime.datetime(2026, 10, 10, 8, 0, tzinfo=datetime.timezone.utc),
            datetime.datetime(2026, 10, 10, 16, 0, tzinfo=datetime.timezone.utc),
            datetime.datetime(2026, 10, 11, 8, 30, tzinfo=datetime.timezone.utc),
        ):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                self.repair(apply=True, now=timestamp)

    def test_last_seen_never_determines_confirmation_time(self):
        self.device["last_seen"] = self.now.timestamp() + 100_000_000
        self.persist()
        result = self.repair()
        self.assertEqual(result["record"]["confirmedAt"], self.now.isoformat())
        self.assertNotEqual(result["record"]["confirmedAt"], result["record"]["publishedAt"])

    def test_existing_different_or_malformed_history_is_never_overwritten(self):
        key = display_history._store_key(self.device)
        for existing in ([], [{"id": "other-record"}], {"not": "a record list"}):
            with self.subTest(existing=existing):
                store.save(key, existing)
                original = Path(store._path(key)).read_bytes()
                with self.assertRaises(ValueError):
                    self.repair(apply=True)
                self.assertEqual(Path(store._path(key)).read_bytes(), original)

    def test_second_snapshot_change_aborts_before_write(self):
        real_validate = migration.validated_device
        calls = 0

        def changing(expected, observed):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.device["revision"] = "next-frame"
                self.persist()
            return real_validate(expected, observed)

        with patch.object(migration, "validated_device", side_effect=changing):
            with self.assertRaises(ValueError):
                self.repair(apply=True)
        self.assertEqual(len(list(Path(self.temp.name).glob("device_display_history*"))), 0)

    def test_cli_cannot_apply_while_main_service_is_running(self):
        result = type("Result", (), {"stdout": "active\n"})()
        with (patch("sys.argv", ["repair", "--expected-binding-sha256", self.binding,
                                "--store-dir", self.temp.name, "--apply"]),
              patch.object(migration.subprocess, "run", return_value=result),
              patch.object(migration, "repair") as repair):
            with self.assertRaises(SystemExit):
                migration.main()
            repair.assert_not_called()


if __name__ == "__main__":
    unittest.main()

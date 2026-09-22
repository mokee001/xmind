"""Guarded software-device contract for hardware-independent App smoke tests."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from backend import store
from backend.routers import test_devices


TEST_KEY = "local-software-device-key-2026"


def payload(response) -> dict:
    return json.loads(response.body.decode("utf-8"))


class SoftwareDeviceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_store = store._BASE
        self.previous_enabled = os.environ.get("PHOTOWALL_ENABLE_TEST_API")
        self.previous_key = os.environ.get("PHOTOWALL_TEST_API_KEY")
        self.temp = tempfile.TemporaryDirectory(prefix="photowall-software-device-")
        store._BASE = self.temp.name
        os.environ["PHOTOWALL_ENABLE_TEST_API"] = "1"
        os.environ["PHOTOWALL_TEST_API_KEY"] = TEST_KEY

    def tearDown(self) -> None:
        store._BASE = self.previous_store
        if self.previous_enabled is None:
            os.environ.pop("PHOTOWALL_ENABLE_TEST_API", None)
        else:
            os.environ["PHOTOWALL_ENABLE_TEST_API"] = self.previous_enabled
        if self.previous_key is None:
            os.environ.pop("PHOTOWALL_TEST_API_KEY", None)
        else:
            os.environ["PHOTOWALL_TEST_API_KEY"] = self.previous_key
        self.temp.cleanup()

    def create_device(self) -> dict:
        response = test_devices.create_test_device(
            test_devices.CreateTestDeviceReq(name="iOS 模拟照片墙"),
            x_photowall_test_key=TEST_KEY,
        )
        self.assertEqual(response.status_code, 200)
        return payload(response)

    def test_full_state_cycle_and_failure_recovery(self) -> None:
        created = self.create_device()
        device_id = created["device"]["device_id"]
        self.assertTrue(created["device"]["test_device"])
        self.assertEqual(created["device"]["state"], "online")
        self.assertTrue(created["account_token"])

        expected_states = ["queued", "downloading", "displaying", "displayed"]
        for expected in expected_states:
            response = test_devices.advance_test_device(
                device_id,
                x_photowall_test_key=TEST_KEY,
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(payload(response)["device"]["state"], expected)

        displayed = payload(response)["device"]
        self.assertEqual(displayed["displayed_revision"], displayed["revision"])

        failed_response = test_devices.set_test_device_state(
            device_id,
            test_devices.TestDeviceStateReq(state="failed", progress=36, error="模拟中断"),
            x_photowall_test_key=TEST_KEY,
        )
        failed = payload(failed_response)["device"]
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["error"], "模拟中断")

        recovered_response = test_devices.advance_test_device(
            device_id,
            x_photowall_test_key=TEST_KEY,
        )
        recovered = payload(recovered_response)["device"]
        self.assertEqual(recovered["state"], "queued")
        self.assertNotEqual(recovered["revision"], displayed["revision"])
        self.assertEqual(recovered["error"], "")

    def test_guard_and_real_device_protection(self) -> None:
        denied = test_devices.create_test_device(
            test_devices.CreateTestDeviceReq(),
            x_photowall_test_key="wrong-key",
        )
        self.assertEqual(denied.status_code, 403)

        store.save("eink_devices", {
            "pwe6-real-test": {"device_id": "pwe6-real-test", "state": "online"}
        })
        protected = test_devices.set_test_device_state(
            "pwe6-real-test",
            test_devices.TestDeviceStateReq(state="failed"),
            x_photowall_test_key=TEST_KEY,
        )
        self.assertEqual(protected.status_code, 403)

        os.environ["PHOTOWALL_ENABLE_TEST_API"] = "0"
        hidden = test_devices.create_test_device(
            test_devices.CreateTestDeviceReq(),
            x_photowall_test_key=TEST_KEY,
        )
        self.assertEqual(hidden.status_code, 404)

    def test_delete_only_removes_test_device(self) -> None:
        created = self.create_device()
        device_id = created["device"]["device_id"]
        deleted = test_devices.delete_test_device(
            device_id,
            x_photowall_test_key=TEST_KEY,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertNotIn(device_id, store.load("eink_devices", {}))


if __name__ == "__main__":
    unittest.main()

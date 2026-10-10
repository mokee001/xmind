"""Isolated regression for the real server's setup-proof/claim lifecycle.

Load only these route functions so the test has no model, server, photo, or
filesystem-store side effects. All request data is synthetic.
"""
from __future__ import annotations

import ast
import copy
import hashlib
import hmac
from pathlib import Path
import re
import secrets
from types import SimpleNamespace
import unittest


SERVER = Path(__file__).resolve().parents[1] / "backend/server.py"
NOW = 1000000.0
DEVICE_ID = "pwe6-test-device"
DEVICE_TOKEN = "synthetic-device-token"
SETUP_TOKEN = "synthetic-physical-setup-proof-001"
OTHER_SETUP_TOKEN = "synthetic-other-device-proof-002"


class Response:
    def __init__(self, content=None, status_code=200, **kwargs):
        self.content = content
        self.status_code = status_code


class MemoryStore:
    def __init__(self):
        self.data = {}

    def load(self, key, default=None):
        return copy.deepcopy(self.data.get(key, default))

    def save(self, key, value):
        self.data[key] = copy.deepcopy(value)


def load_routes(store):
    names = {
        "_devices", "_public_device", "_device_auth", "device_bootstrap",
        "device_auto_claim", "device_next", "device_status", "device_frame",
    }
    selected = []
    for node in ast.parse(SERVER.read_text()).body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            node.decorator_list = []
            selected.append(node)
    assert {node.name for node in selected} == names
    tree = ast.Module(body=[
        ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
        *selected,
    ], type_ignores=[])
    namespace = {
        "store": store, "Response": Response, "JSONResponse": Response,
        "time": SimpleNamespace(time=lambda: NOW), "hashlib": hashlib,
        "hmac": hmac, "secrets": secrets,
        "_DEVICE_ID_RE": re.compile(r"^[A-Za-z0-9_-]{4,64}$"),
        "_PAIRING_CODE_RE": re.compile(r"^\d{6}$"),
    }
    exec(compile(ast.fix_missing_locations(tree), str(SERVER), "exec"), namespace)
    return namespace


class DeviceClaimRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.routes = load_routes(self.store)
        self.store.save("eink_devices", {DEVICE_ID: {
            "device_id": DEVICE_ID, "device_token": DEVICE_TOKEN,
            "claimed": False, "account_token": "", "revision": "",
            "pending_command": {"type": "reprovision", "preserve_binding": False},
        }})

    def device(self):
        return self.store.load("eink_devices")[DEVICE_ID]

    def update(self, **changes):
        devices = self.store.load("eink_devices")
        devices[DEVICE_ID].update(changes)
        self.store.save("eink_devices", devices)

    def bootstrap(self, token=DEVICE_TOKEN):
        return self.routes["device_bootstrap"](SimpleNamespace(
            device_id=DEVICE_ID, device_family="esp32_e6", pairing_code="123456",
            device_token=token, setup_token=SETUP_TOKEN, ip="192.0.2.1",
            firmware_version="test",
        ))

    def claim(self, setup=SETUP_TOKEN):
        return self.routes["device_auto_claim"](SimpleNamespace(
            device_id=DEVICE_ID, setup_token=setup, name="test"))

    def test_retained_device_token_claim_does_not_receive_old_unbind(self):
        self.assertEqual(self.bootstrap().status_code, 200)
        self.assertIn("pending_command", self.device())
        self.assertEqual(self.claim().status_code, 200)
        self.assertTrue(self.device()["claimed"])
        self.assertNotIn("pending_command", self.device())
        self.assertNotIn("setup_token_digest", self.device())
        self.assertEqual(self.device()["device_token"], DEVICE_TOKEN)
        self.assertEqual(self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN).status_code, 204)
        before = copy.deepcopy(self.store.data)
        response = self.routes["device_status"](
            DEVICE_ID, SimpleNamespace(state="unbound"), token=DEVICE_TOKEN)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.store.data, before)

    def test_empty_device_token_keeps_existing_reset_recovery(self):
        self.assertEqual(self.bootstrap(token="").status_code, 200)
        new_token = self.device()["device_token"]
        self.assertNotEqual(new_token, DEVICE_TOKEN)
        self.assertNotIn("pending_command", self.device())
        self.assertEqual(self.claim().status_code, 200)
        self.assertEqual(self.routes["device_next"](DEVICE_ID, token=new_token).status_code, 204)
        self.assertEqual(self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN).status_code, 401)

    def test_wrong_nonempty_device_token_cannot_reset_or_clear_command(self):
        before = copy.deepcopy(self.store.data)
        self.assertEqual(self.bootstrap(token="synthetic-forged-token").status_code, 401)
        self.assertEqual(self.store.data, before)

    def test_invalid_expired_or_missing_setup_proof_does_not_clear_command(self):
        self.bootstrap()
        initial = copy.deepcopy(self.store.data)
        for setup, changes in [
            (OTHER_SETUP_TOKEN, {}),
            (SETUP_TOKEN, {"setup_token_expires_at": NOW - 1}),
            (SETUP_TOKEN, {"setup_token_digest": ""}),
            ("short", {}),
        ]:
            with self.subTest(proof_state="rejected"):
                self.store.data = copy.deepcopy(initial)
                self.update(**changes)
                before = copy.deepcopy(self.store.data)
                self.assertIn(self.claim(setup).status_code, (400, 403))
                self.assertEqual(self.store.data, before)

    def test_expired_online_claim_window_does_not_clear_command(self):
        self.bootstrap()
        self.update(last_seen=NOW - 301)
        before = copy.deepcopy(self.store.data)
        self.assertEqual(self.claim().status_code, 409)
        self.assertEqual(self.store.data, before)

    def test_other_device_setup_proof_cannot_take_over_binding(self):
        self.bootstrap()
        self.update(claimed=True, account_token="synthetic-other-account")
        before = copy.deepcopy(self.store.data)
        self.assertEqual(self.claim(OTHER_SETUP_TOKEN).status_code, 403)
        self.assertEqual(self.store.data, before)

    def test_consumed_proof_cannot_be_replayed(self):
        self.bootstrap()
        self.assertEqual(self.claim().status_code, 200)
        before = copy.deepcopy(self.store.data)
        self.assertEqual(self.claim().status_code, 403)
        self.assertEqual(self.store.data, before)

    def test_other_commands_and_preserve_binding_are_unchanged(self):
        self.bootstrap()
        wall_fields = {
            "revision": "synthetic-current-wall", "displayed_revision": "synthetic-current-wall",
            "frame_path": "/synthetic/frame.pwe6", "preview_url": "/synthetic/preview.jpg",
            "published_at": NOW - 100,
        }
        self.update(**wall_fields)
        initial = copy.deepcopy(self.store.data)
        for pending in [
            {"type": "reprovision", "preserve_binding": True},
            {"type": "other", "preserve_binding": False},
            {"type": "reprovision"},
            {"type": "reprovision", "preserve_binding": 0},
            "unknown-command", None,
        ]:
            with self.subTest(command_type=type(pending).__name__):
                self.store.data = copy.deepcopy(initial)
                self.update(pending_command=pending)
                self.assertEqual(self.claim().status_code, 200)
                self.assertEqual(self.device().get("pending_command"), pending)
                self.assertEqual({key: self.device()[key] for key in wall_fields}, wall_fields)

    def test_pending_delete_still_works_before_new_claim(self):
        response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
        self.assertEqual(response.content, {"command": "reprovision", "preserve_binding": False})
        response = self.routes["device_status"](
            DEVICE_ID, SimpleNamespace(state="unbound"), token=DEVICE_TOKEN)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(DEVICE_ID, self.store.load("eink_devices"))

    def test_first_poll_waits_for_claim_without_rebinding_or_publishing(self):
        self.bootstrap()
        old_revision = "synthetic-old-private-wall"
        self.update(
            revision=old_revision, displayed_revision=old_revision,
            frame_path="/synthetic/old-frame.pwe6", preview_url="/synthetic/old-preview.jpg",
            published_at=NOW - 100,
        )
        before = self.device()
        response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
        self.assertEqual(response.status_code, 204)
        self.assertIsNone(response.content)
        self.assertFalse(self.device()["claimed"])
        self.assertEqual(self.device()["account_token"], "")
        self.assertEqual(self.device(), before)
        self.assertEqual(self.claim().status_code, 200)
        self.assertNotIn("pending_command", self.device())
        self.assertEqual(self.device()["revision"], "")
        self.assertEqual(self.device()["displayed_revision"], "")
        self.assertFalse({"frame_path", "preview_url", "published_at"} & self.device().keys())
        self.assertEqual(self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN).status_code, 204)
        response = self.routes["device_frame"](DEVICE_ID, old_revision, token=DEVICE_TOKEN)
        self.assertEqual(response.status_code, 401)

    def test_repeated_polls_do_not_extend_setup_window(self):
        self.bootstrap()
        expires = self.device()["setup_token_expires_at"]
        self.assertEqual(expires, NOW + 600)
        for elapsed in (1, 30, 300, 599):
            self.routes["time"].time = lambda elapsed=elapsed: NOW + elapsed
            before = self.device()
            response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
            self.assertEqual(response.status_code, 204)
            after = self.device()
            self.assertEqual(after["setup_token_expires_at"], expires)
            self.assertEqual(after, {**before, "last_seen": NOW + elapsed})
        self.routes["time"].time = lambda: expires + 1
        response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
        self.assertEqual(response.content, {"command": "reprovision", "preserve_binding": False})
        self.assertEqual(self.device()["setup_token_expires_at"], expires)
        self.assertEqual(self.claim().status_code, 403)

    def test_missing_or_expired_setup_does_not_defer_unbind(self):
        self.bootstrap()
        initial = copy.deepcopy(self.store.data)
        for changes in (
            {"setup_token_digest": ""},
            {"setup_token_expires_at": NOW - 1},
        ):
            with self.subTest(proof_state="unavailable"):
                self.store.data = copy.deepcopy(initial)
                self.update(**changes)
                response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
                self.assertEqual(response.content, {"command": "reprovision", "preserve_binding": False})

    def test_claimed_or_owned_devices_do_not_enter_unclaimed_wait(self):
        self.bootstrap()
        initial = copy.deepcopy(self.store.data)
        for changes in (
            {"claimed": True},
            {"account_token": "synthetic-retained-owner"},
            {"pending_command": {"type": "reprovision", "preserve_binding": True}},
        ):
            with self.subTest(state="outside recovery wait"):
                self.store.data = copy.deepcopy(initial)
                self.update(**changes)
                response = self.routes["device_next"](DEVICE_ID, token=DEVICE_TOKEN)
                self.assertEqual(response.content["command"], "reprovision")

    def test_invalid_device_credentials_cannot_poll_recovery_window(self):
        self.bootstrap()
        before = copy.deepcopy(self.store.data)
        response = self.routes["device_next"](DEVICE_ID, token="synthetic-forged-token")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.store.data, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Original 19-inch display connection and targeted delivery contract."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch

from backend import store
from backend import server
from backend.server import (
    DisplayHub,
)


def payload(response) -> dict:
    return json.loads(response.body.decode("utf-8"))


class FakeWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.messages: list[dict] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, message: dict) -> None:
        self.messages.append(message)


class ConfiguredDisplayWebSocket(FakeWebSocket):
    def __init__(self, device_id: str) -> None:
        super().__init__()
        self.query_params = {"device_id": device_id}

    async def receive_text(self) -> str:
        raise server.WebSocketDisconnect()


class RecordingHub:
    def __init__(self) -> None:
        self.deliveries: list[tuple[str, dict]] = []

    async def send_device(self, device_id: str, message: dict) -> bool:
        self.deliveries.append((device_id, message))
        return True


class Screen19DeviceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_store = store._BASE
        self.temp = tempfile.TemporaryDirectory(prefix="photowall-screen19-")
        store._BASE = self.temp.name

    def tearDown(self) -> None:
        store._BASE = self.previous_store
        self.temp.cleanup()

    def test_browser_screen_connects_by_configured_device_id_without_token(self) -> None:
        device_id = "walnutpi-living-room"
        wall = {"wall_id": "wall-19", "image_url": "/output/wall-19.png"}
        store.save("eink_devices", {
            device_id: {
                "device_id": device_id,
                "device_family": "walnutpi_19in",
                "account_token": "account-token",
            },
        })
        store.save("last_wall_screen19-test", wall)

        async def exercise() -> None:
            display = ConfiguredDisplayWebSocket(device_id)
            with (
                patch.object(server, "_account_scope", return_value="screen19-test"),
                patch.object(server, "hub", DisplayHub()),
            ):
                await server.ws_display(display)
            self.assertTrue(display.accepted)
            self.assertEqual(display.messages, [{"type": "wall", **wall}])

        asyncio.run(exercise())

    def test_screen19_cannot_enter_pwe6_publish_route(self) -> None:
        device = {
            "device_id": "walnutpi-living-room",
            "device_family": "walnutpi_19in",
            "account_token": "account-token",
        }
        with patch.object(server, "_devices", return_value={device["device_id"]: device}):
            response = asyncio.run(server.device_publish(
                device["device_id"],
                object(),
                x_account_token="account-token",
            ))

        self.assertEqual(response.status_code, 400)
        self.assertEqual(payload(response)["error"], "19 寸屏请使用模板发布")

    def test_last_wall_publish_targets_selected_screen19(self) -> None:
        device_id = "walnutpi-studio"
        account_token = "account-token"
        device = {
            "device_id": device_id,
            "device_family": "walnutpi_19in",
            "account_token": account_token,
            "claimed": True,
            "state": "online",
        }
        wall = {"wall_id": "wall-19", "image_url": "/output/wall-19.png"}
        store.save("eink_devices", {device_id: device})
        store.save("last_wall_screen19-test", wall)
        recording_hub = RecordingHub()

        with (
            patch.object(server, "_account_scope", return_value="screen19-test"),
            patch.object(server.os.path, "isfile", return_value=True),
            patch.object(server, "hub", recording_hub),
        ):
            response = asyncio.run(server.device_publish_last_wall(
                device_id,
                server.PublishWallReq(wall_id=wall["wall_id"]),
                account_token,
            ))

        result = payload(response)
        self.assertEqual(len(recording_hub.deliveries), 1)
        target_device_id, message = recording_hub.deliveries[0]
        self.assertEqual(target_device_id, device_id)
        self.assertEqual(message["type"], "wall")
        self.assertEqual(message["wall_id"], wall["wall_id"])
        self.assertEqual(result["revision"], wall["wall_id"])
        self.assertEqual(result["device"]["state"], "queued")
        self.assertEqual(result["device"]["progress"], 100.0)
        self.assertNotIn("pending_wall", result["device"])
        persisted = store.load("eink_devices", {})[device_id]
        self.assertEqual(persisted["revision"], wall["wall_id"])
        self.assertEqual(persisted["state"], "queued")

    def test_managed_screens_receive_only_targeted_messages(self) -> None:
        async def exercise() -> None:
            hub = DisplayHub()
            legacy = FakeWebSocket()
            living_room = FakeWebSocket()
            studio = FakeWebSocket()
            await hub.connect(legacy)
            await hub.connect(living_room, "walnutpi-living-room")
            await hub.connect(studio, "walnutpi-studio")

            await hub.broadcast({"type": "wall", "wall_id": "legacy"}, legacy_only=True)
            self.assertEqual([item["wall_id"] for item in legacy.messages], ["legacy"])
            self.assertEqual(living_room.messages, [])
            self.assertEqual(studio.messages, [])

            delivered = await hub.send_device(
                "walnutpi-studio",
                {"type": "wall", "wall_id": "studio-only"},
            )
            self.assertTrue(delivered)
            self.assertEqual(legacy.messages[-1]["wall_id"], "legacy")
            self.assertEqual(living_room.messages, [])
            self.assertEqual(studio.messages[-1]["wall_id"], "studio-only")

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
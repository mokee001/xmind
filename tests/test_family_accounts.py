"""Multi-account household authorization contract."""

from __future__ import annotations

import os
import tempfile

_TEMP_ROOT = tempfile.mkdtemp(prefix="photowall-family-test-")
os.environ["PHOTOWALL_STORE_DIR"] = os.path.join(_TEMP_ROOT, "store")
os.environ["PHOTOWALL_DATA_DIR"] = os.path.join(_TEMP_ROOT, "data")

from fastapi.testclient import TestClient  # noqa: E402

from backend import store  # noqa: E402
from backend.server import app  # noqa: E402


client = TestClient(app)


def register(name: str) -> tuple[dict, str]:
    response = client.post("/api/accounts/register", json={"name": name})
    assert response.status_code == 200, response.text
    payload = response.json()
    return payload["account"], payload["access_token"]


def user_headers(token: str) -> dict[str, str]:
    return {"X-User-Token": token}


def device_headers(token: str) -> dict[str, str]:
    return {"X-Account-Token": token}


def test_household_invite_and_device_permissions() -> None:
    owner, owner_token = register("王欢")
    member, member_token = register("家人")
    legacy_device_token = "legacy-owner-token"
    device_id = "pwe6-family-test"
    store.save("eink_devices", {
        device_id: {
            "device_id": device_id,
            "device_token": "device-secret",
            "account_token": legacy_device_token,
            "claimed": True,
            "name": "客厅照片墙",
            "state": "online",
            "last_seen": 1,
        }
    })

    adopted = client.post(
        "/api/households/adopt-device",
        headers=user_headers(owner_token),
        json={
            "device_id": device_id,
            "device_account_token": legacy_device_token,
            "household_name": "王欢的家",
        },
    )
    assert adopted.status_code == 200, adopted.text
    household = adopted.json()["household"]
    household_id = household["household_id"]
    assert household["role"] == "owner"
    assert household["devices"][0]["device_id"] == device_id

    owner_devices = client.get("/api/devices", headers=device_headers(owner_token)).json()["devices"]
    assert [device["device_id"] for device in owner_devices] == [device_id]

    invite_response = client.post(
        f"/api/households/{household_id}/invites",
        headers=user_headers(owner_token),
    )
    assert invite_response.status_code == 200, invite_response.text
    invite = invite_response.json()["invite"]
    assert len(invite["code"]) == 8
    assert invite["deep_link"].endswith(invite["code"])

    accepted = client.post(
        "/api/households/invites/accept",
        headers=user_headers(member_token),
        json={"code": invite["code"].lower()},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["membership"]["role"] == "member"
    assert accepted.json()["membership"]["can_publish"] is False

    member_devices = client.get("/api/devices", headers=device_headers(member_token)).json()["devices"]
    assert [device["device_id"] for device in member_devices] == [device_id]

    # Joining a family grants read access, but not destructive device management.
    forbidden = client.post(
        f"/api/devices/{device_id}/reprovision",
        headers=device_headers(member_token),
    )
    assert forbidden.status_code == 401

    updated = client.patch(
        f"/api/households/{household_id}/members/{member['user_id']}",
        headers=user_headers(owner_token),
        json={"can_publish": True},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["membership"]["can_publish"] is True

    members = client.get(
        f"/api/households/{household_id}/members",
        headers=user_headers(member_token),
    )
    assert members.status_code == 200, members.text
    assert {item["user_id"] for item in members.json()["members"]} == {
        owner["user_id"], member["user_id"]
    }

    removed = client.delete(
        f"/api/households/{household_id}/members/{member['user_id']}",
        headers=user_headers(owner_token),
    )
    assert removed.status_code == 200, removed.text
    assert client.get("/api/devices", headers=device_headers(member_token)).json()["devices"] == []

    leaving_member, leaving_token = register("主动退出的家人")
    second_invite = client.post(
        f"/api/households/{household_id}/invites",
        headers=user_headers(owner_token),
    ).json()["invite"]
    assert client.post(
        "/api/households/invites/accept",
        headers=user_headers(leaving_token),
        json={"code": second_invite["code"]},
    ).status_code == 200
    left = client.delete(
        f"/api/households/{household_id}/members/{leaving_member['user_id']}",
        headers=user_headers(leaving_token),
    )
    assert left.status_code == 200, left.text
    assert client.get("/api/devices", headers=device_headers(leaving_token)).json()["devices"] == []


def test_account_photo_scope_is_stable_and_separate() -> None:
    first, first_token = register("甲")
    second, second_token = register("乙")
    from backend.routers import family

    first_scope = family.account_scope(first_token)
    second_scope = family.account_scope(second_token)
    assert first_scope == f"user_{first['user_id']}"
    assert second_scope == f"user_{second['user_id']}"
    assert first_scope != second_scope

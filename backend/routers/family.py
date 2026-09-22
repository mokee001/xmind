"""家庭空间、多账户与成员授权。

这个模块刻意与设备配网路由分离：设备仍由 ``server.py`` 负责上线、配网和
下发画面；这里仅维护“谁可以访问哪一个家庭中的设备”。JSON 存储是当前
测试阶段的实现，后续迁移 PostgreSQL 时可保持 API 结构不变。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import string
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .. import store

router = APIRouter()

_STORE_NAME = "family_accounts"
_LOCK = threading.Lock()
_INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _empty_data() -> dict[str, Any]:
    return {"accounts": {}, "households": {}, "memberships": {}, "invites": {}}


def _load() -> dict[str, Any]:
    data = store.load(_STORE_NAME, _empty_data())
    if not isinstance(data, dict):
        return _empty_data()
    for key in ("accounts", "households", "memberships", "invites"):
        if not isinstance(data.get(key), dict):
            data[key] = {}
    return data


def _save(data: dict[str, Any]) -> None:
    store.save(_STORE_NAME, data)


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _clean_name(value: str, fallback: str) -> str:
    name = " ".join(str(value or "").strip().split())[:40]
    return name or fallback


def _public_account(account: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": account.get("user_id", ""),
        "name": account.get("name", "家庭成员"),
        "avatar": account.get("avatar", "家"),
        "created_at": account.get("created_at", 0),
    }


def _public_device(device: dict[str, Any]) -> dict[str, Any]:
    private_keys = {
        "device_token",
        "account_token",
        "frame_path",
        "pending_command",
        "setup_token_digest",
        "setup_token_expires_at",
        "reprovision_setup_token_digest",
        "reprovision_setup_token_expires_at",
    }
    return {key: value for key, value in device.items() if key not in private_keys}


def account_for_token(token: str) -> Optional[dict[str, Any]]:
    """Return the account for a bearer token without ever persisting raw tokens."""
    if not token:
        return None
    supplied = _token_digest(token)
    for account in _load()["accounts"].values():
        expected = str(account.get("token_digest", ""))
        if expected and hmac.compare_digest(expected, supplied):
            return account
    return None


def account_scope(token: str) -> str:
    """Stable photo/model namespace for a real account, independent of token rotation."""
    account = account_for_token(token)
    return f"user_{account['user_id']}" if account else ""


def _membership(data: dict[str, Any], household_id: str, user_id: str) -> Optional[dict[str, Any]]:
    household_members = data["memberships"].get(household_id, {})
    membership = household_members.get(user_id) if isinstance(household_members, dict) else None
    return membership if isinstance(membership, dict) else None


def membership_for_device(token: str, device: dict[str, Any]) -> Optional[dict[str, Any]]:
    account = account_for_token(token)
    household_id = str(device.get("household_id", ""))
    if not account or not household_id:
        return None
    return _membership(_load(), household_id, str(account["user_id"]))


def can_access_device(token: str, device: dict[str, Any]) -> bool:
    return membership_for_device(token, device) is not None


def can_manage_device(token: str, device: dict[str, Any]) -> bool:
    membership = membership_for_device(token, device)
    return bool(membership and membership.get("role") == "owner")


def can_publish_to_device(token: str, device: dict[str, Any]) -> bool:
    membership = membership_for_device(token, device)
    return bool(
        membership
        and (membership.get("role") == "owner" or membership.get("can_publish"))
    )


def _request_account(x_user_token: str, x_account_token: str = "") -> Optional[dict[str, Any]]:
    return account_for_token(x_user_token or x_account_token)


def _household_payload(data: dict[str, Any], household_id: str, user_id: str) -> dict[str, Any]:
    household = data["households"].get(household_id, {})
    membership = _membership(data, household_id, user_id) or {}
    devices = []
    for device in store.load("eink_devices", {}).values():
        if device.get("household_id") != household_id:
            continue
        public = _public_device(device)
        public["can_manage"] = membership.get("role") == "owner"
        public["can_publish"] = bool(
            membership.get("role") == "owner" or membership.get("can_publish")
        )
        devices.append(public)
    return {
        "household_id": household_id,
        "name": household.get("name", "我的家庭"),
        "owner_user_id": household.get("owner_user_id", ""),
        "role": membership.get("role", "member"),
        "can_publish": bool(membership.get("can_publish")),
        "members_count": len(data["memberships"].get(household_id, {})),
        "devices": devices,
        "created_at": household.get("created_at", 0),
    }


def _require_membership(
    data: dict[str, Any], household_id: str, account: dict[str, Any]
) -> Optional[dict[str, Any]]:
    return _membership(data, household_id, str(account.get("user_id", "")))


class RegisterAccountReq(BaseModel):
    name: str = Field(default="我", max_length=40)


class UpdateAccountReq(BaseModel):
    name: str = Field(default="", max_length=40)


class AdoptDeviceReq(BaseModel):
    device_id: str
    device_account_token: str
    household_name: str = Field(default="我的家庭", max_length=40)


class AcceptInviteReq(BaseModel):
    code: str = Field(default="", max_length=16)


class UpdateMemberReq(BaseModel):
    can_publish: Optional[bool] = None


@router.post("/api/accounts/register")
def register_account(req: RegisterAccountReq) -> Response:
    now = time.time()
    access_token = secrets.token_urlsafe(32)
    user_id = f"usr_{secrets.token_hex(8)}"
    name = _clean_name(req.name, "我")
    account = {
        "user_id": user_id,
        "name": name,
        "avatar": name[:1].upper(),
        "token_digest": _token_digest(access_token),
        "created_at": now,
        "updated_at": now,
    }
    with _LOCK:
        data = _load()
        data["accounts"][user_id] = account
        _save(data)
    return JSONResponse({"account": _public_account(account), "access_token": access_token})


@router.get("/api/accounts/me")
def read_account(
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    return JSONResponse({"account": _public_account(account)})


@router.patch("/api/accounts/me")
def update_account(
    req: UpdateAccountReq,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    with _LOCK:
        data = _load()
        current = data["accounts"].get(account["user_id"])
        if not current:
            return JSONResponse(status_code=404, content={"error": "账户不存在"})
        current["name"] = _clean_name(req.name, current.get("name", "我"))
        current["avatar"] = current["name"][:1].upper()
        current["updated_at"] = time.time()
        data["accounts"][account["user_id"]] = current
        _save(data)
    return JSONResponse({"account": _public_account(current)})


@router.get("/api/households")
def list_households(
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    data = _load()
    user_id = str(account["user_id"])
    households = [
        _household_payload(data, household_id, user_id)
        for household_id in data["households"]
        if _membership(data, household_id, user_id)
    ]
    return JSONResponse({"households": households})


@router.post("/api/households/adopt-device")
def adopt_device(
    req: AdoptDeviceReq,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    with _LOCK:
        devices = store.load("eink_devices", {})
        device = devices.get(req.device_id)
        if not device or not device.get("claimed"):
            return JSONResponse(status_code=404, content={"error": "没有找到已绑定的照片墙"})
        data = _load()
        existing_household_id = str(device.get("household_id", ""))
        if existing_household_id:
            membership = _membership(data, existing_household_id, str(account["user_id"]))
            if not membership:
                return JSONResponse(status_code=409, content={"error": "这台设备已属于其他家庭，请让所有者发送邀请码"})
            return JSONResponse({
                "household": _household_payload(data, existing_household_id, str(account["user_id"])),
                "membership": membership,
            })

        expected = str(device.get("account_token", ""))
        supplied = str(req.device_account_token or "")
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            return JSONResponse(status_code=403, content={"error": "只有当前设备管理员可以创建家庭"})

        household_id = f"home_{secrets.token_hex(8)}"
        now = time.time()
        data["households"][household_id] = {
            "household_id": household_id,
            "name": _clean_name(req.household_name, "我的家庭"),
            "owner_user_id": account["user_id"],
            "created_at": now,
        }
        membership = {
            "user_id": account["user_id"],
            "household_id": household_id,
            "role": "owner",
            "can_publish": True,
            "joined_at": now,
        }
        data["memberships"][household_id] = {account["user_id"]: membership}
        device["household_id"] = household_id
        devices[req.device_id] = device
        _save(data)
        store.save("eink_devices", devices)
    return JSONResponse({
        "household": _household_payload(data, household_id, str(account["user_id"])),
        "membership": membership,
    })


@router.get("/api/households/{household_id}/members")
def list_members(
    household_id: str,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    data = _load()
    if not account or not _require_membership(data, household_id, account):
        return JSONResponse(status_code=403, content={"error": "没有访问这个家庭的权限"})
    members = []
    for user_id, membership in data["memberships"].get(household_id, {}).items():
        member_account = data["accounts"].get(user_id)
        if not member_account:
            continue
        members.append({
            **_public_account(member_account),
            "role": membership.get("role", "member"),
            "can_publish": bool(membership.get("can_publish")),
            "joined_at": membership.get("joined_at", 0),
            "is_self": user_id == account["user_id"],
        })
    members.sort(key=lambda item: (item["role"] != "owner", item["joined_at"]))
    return JSONResponse({
        "household": _household_payload(data, household_id, str(account["user_id"])),
        "members": members,
    })


@router.post("/api/households/{household_id}/invites")
def create_invite(
    household_id: str,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    with _LOCK:
        data = _load()
        membership = _require_membership(data, household_id, account)
        if not membership or membership.get("role") != "owner":
            return JSONResponse(status_code=403, content={"error": "只有家庭所有者可以邀请成员"})
        now = time.time()
        data["invites"] = {
            code: invite
            for code, invite in data["invites"].items()
            if float(invite.get("expires_at", 0)) > now and not invite.get("used_at")
        }
        code = "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(8))
        while code in data["invites"]:
            code = "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(8))
        invite = {
            "code": code,
            "household_id": household_id,
            "created_by": account["user_id"],
            "created_at": now,
            "expires_at": now + 24 * 60 * 60,
            "used_at": 0,
        }
        data["invites"][code] = invite
        _save(data)
    return JSONResponse({
        "invite": {
            "code": code,
            "expires_at": invite["expires_at"],
            "deep_link": f"photowall://join?code={code}",
        }
    })


@router.post("/api/households/invites/accept")
def accept_invite(
    req: AcceptInviteReq,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    code = "".join(character for character in req.code.upper() if character.isalnum())
    with _LOCK:
        data = _load()
        invite = data["invites"].get(code)
        if not invite or invite.get("used_at"):
            return JSONResponse(status_code=404, content={"error": "邀请码不存在或已经使用"})
        if float(invite.get("expires_at", 0)) <= time.time():
            return JSONResponse(status_code=410, content={"error": "邀请码已过期，请让所有者重新生成"})
        household_id = str(invite.get("household_id", ""))
        if household_id not in data["households"]:
            return JSONResponse(status_code=404, content={"error": "家庭空间不存在"})
        membership = _membership(data, household_id, str(account["user_id"]))
        if not membership:
            membership = {
                "user_id": account["user_id"],
                "household_id": household_id,
                "role": "member",
                "can_publish": False,
                "joined_at": time.time(),
            }
            data["memberships"].setdefault(household_id, {})[account["user_id"]] = membership
        invite["used_at"] = time.time()
        invite["used_by"] = account["user_id"]
        data["invites"][code] = invite
        _save(data)
    return JSONResponse({
        "household": _household_payload(data, household_id, str(account["user_id"])),
        "membership": membership,
    })


@router.patch("/api/households/{household_id}/members/{user_id}")
def update_member(
    household_id: str,
    user_id: str,
    req: UpdateMemberReq,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    with _LOCK:
        data = _load()
        requester = _require_membership(data, household_id, account)
        target = _membership(data, household_id, user_id)
        if not requester or requester.get("role") != "owner":
            return JSONResponse(status_code=403, content={"error": "只有家庭所有者可以修改成员权限"})
        if not target:
            return JSONResponse(status_code=404, content={"error": "没有找到这个成员"})
        if target.get("role") == "owner":
            return JSONResponse(status_code=400, content={"error": "所有者的管理权限不能关闭"})
        if req.can_publish is not None:
            target["can_publish"] = bool(req.can_publish)
        data["memberships"][household_id][user_id] = target
        _save(data)
    return JSONResponse({"membership": target})


@router.delete("/api/households/{household_id}/members/{user_id}")
def remove_member(
    household_id: str,
    user_id: str,
    x_user_token: str = Header(default=""),
    x_account_token: str = Header(default=""),
) -> Response:
    account = _request_account(x_user_token, x_account_token)
    if not account:
        return JSONResponse(status_code=401, content={"error": "账户登录已失效"})
    with _LOCK:
        data = _load()
        requester = _require_membership(data, household_id, account)
        target = _membership(data, household_id, user_id)
        removing_self = str(account["user_id"]) == user_id
        if not requester or (requester.get("role") != "owner" and not removing_self):
            return JSONResponse(status_code=403, content={"error": "只有家庭所有者可以移除其他成员"})
        if not target:
            return JSONResponse(status_code=404, content={"error": "没有找到这个成员"})
        if target.get("role") == "owner":
            return JSONResponse(status_code=400, content={"error": "不能移除家庭所有者"})
        data["memberships"][household_id].pop(user_id, None)
        _save(data)
    return JSONResponse({"removed": True, "user_id": user_id})

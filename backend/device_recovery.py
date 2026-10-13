"""Device binding transactions and deletion receipts. No image processing."""
from __future__ import annotations

from contextlib import contextmanager
import copy
import fcntl
import functools
import hashlib
import hmac
import inspect
import json
import os
import secrets
import stat
import tempfile
import threading
import time

from . import store

_LOCK = threading.Lock()
_RECEIPT_TTL = 7 * 24 * 3600
_RECEIPT_LIMIT = 16
_WALL_FIELDS = ("revision", "frame_path", "preview_url",
                "published_at", "state", "progress", "error")


@contextmanager
def transaction():
    """Called in a sync route/worker thread, never across render or await."""
    with _LOCK:
        descriptor = os.open(store._path("eink_devices") + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)


def serialized(function):
    if inspect.iscoroutinefunction(function):
        raise TypeError("Device transaction decorator is synchronous only")

    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with transaction():
            return function(*args, **kwargs)
    # FastAPI resolves forward references against the wrapper module otherwise.
    wrapped.__signature__ = inspect.signature(function, eval_str=True)
    return wrapped


def save_devices(data):
    """Atomically save the device and its receipts in the same durable file."""
    path = store._path("eink_devices")
    directory = os.path.dirname(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".devices-", dir=directory)
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else 0o600
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def binding_id(device):
    explicit = str(device.get("binding_id", ""))
    if explicit:
        return explicit
    # Stable upgrade identity; legacy clients can still delete the existing
    # binding once. This is not an account credential or an authorization grant.
    identity = [device.get("device_id"), device.get("account_token"), device.get("created_at")]
    return "legacy-" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def account_proof(token):
    return hashlib.sha256(("device-delete-owner:" + token).encode()).hexdigest()


def receipts(device):
    now = time.time()
    values = device.get("_delete_receipts", []) if isinstance(device, dict) else []
    return [copy.deepcopy(row) for row in values if isinstance(row, dict)
            and isinstance(row.get("at"), (int, float))
            and 0 <= now - row["at"] <= _RECEIPT_TTL][-_RECEIPT_LIMIT:]


def find_receipt(device, token, requested_binding, request_id):
    if not token:
        return None
    for row in reversed(receipts(device)):
        if not hmac.compare_digest(str(row.get("owner_proof", "")), account_proof(token)):
            continue
        if request_id != row.get("request_id", ""):
            continue
        if requested_binding and requested_binding != row.get("binding_id"):
            continue
        # New-style receipts always require the binding id. A legacy retry has
        # neither header and can replay only its own legacy receipt.
        if not requested_binding and (request_id or not row.get("legacy_request")):
            continue
        return row
    return None


def record_receipt(device, token, request_id):
    row = {"device_id": device["device_id"], "binding_id": binding_id(device),
           "request_id": request_id, "owner_proof": account_proof(token),
           "at": time.time(), "legacy_request": not request_id,
           "reprovision_required": device.get("device_family") != "walnutpi_19in"}
    device["_delete_receipts"] = (receipts(device) + [row])[-_RECEIPT_LIMIT:]
    return row


def receipt_response(row, *, replay):
    return {"device_id": row["device_id"], "removed": True, "deleted": True,
            "binding_id": row["binding_id"], "request_id": row["request_id"],
            "reprovision_required": row["reprovision_required"], "already_removed": replay}


def tombstone(device):
    return {"device_id": device["device_id"], "device_family": device.get("device_family"),
            "created_at": device.get("created_at"), "claimed": False,
            "account_token": "", "device_token": "", "state": "unbound",
            "_delete_tombstone": True, "_delete_receipts": receipts(device),
            "recovery_generation": secrets.token_urlsafe(24)}


def start_binding(device):
    invalidate_recovery(device)
    device.pop("_bootstrap_receipt", None)
    device["binding_id"] = secrets.token_urlsafe(24)
    # The existing history key contains created_at. Change it only when starting
    # a new binding, never for Wi-Fi reconfiguration, to isolate old history.
    device["created_at"] = time.time()


def recovery_generation(device):
    explicit = str(device.get("recovery_generation", ""))
    return explicit or "legacy-" + hashlib.sha256(("device-recovery:" + binding_id(device)).encode()).hexdigest()


def invalidate_recovery(device):
    device["recovery_generation"] = secrets.token_urlsafe(24)
    device.pop("_recovery_operation", None)


def operation_transition(device, operation_id, expected_generation, phase, setup_token):
    """Validate without modifying state; old generations can never be rebased."""
    current = device.get("_recovery_operation")
    proof = hashlib.sha256(setup_token.encode()).hexdigest() if setup_token else ""
    if isinstance(current, dict) and current.get("id") == operation_id:
        if (current.get("binding_id") != binding_id(device)
                or current.get("from_generation") != expected_generation
                or current.get("generation") != recovery_generation(device)):
            return None, "recovery_operation_conflict", False
        if phase == "enter_setup":
            return copy.deepcopy(current), "", False
        if current.get("stage") in ("authorized", "completed"):
            if not hmac.compare_digest(str(current.get("proof_digest", "")), proof):
                return None, "recovery_operation_conflict", False
            return copy.deepcopy(current), "", False
        operation = copy.deepcopy(current)
    else:
        if expected_generation != recovery_generation(device):
            return None, "recovery_generation_changed", False
        operation = {"id": operation_id, "binding_id": binding_id(device),
                     "from_generation": expected_generation, "generation": secrets.token_urlsafe(24),
                     "stage": "entered"}
    if phase == "authorize":
        operation.update(stage="authorized", proof_digest=proof)
    return operation, "", True


def operation_response(operation):
    return {key: operation[key] for key in ("id", "binding_id", "from_generation", "generation", "stage")}


def complete_recovery(device, setup_token):
    current = device.get("_recovery_operation")
    if (isinstance(current, dict) and current.get("stage") == "authorized"
            and current.get("binding_id") == binding_id(device)
            and current.get("generation") == recovery_generation(device)
            and hmac.compare_digest(str(current.get("proof_digest", "")), hashlib.sha256(setup_token.encode()).hexdigest())):
        current["stage"] = "completed"


def _bootstrap_identity(device):
    return {"device_id": str(device.get("device_id", "")),
            "binding_id": binding_id(device),
            "owner_proof": account_proof(str(device.get("account_token", ""))),
            "device_token_digest": hashlib.sha256(str(device.get("device_token", "")).encode()).hexdigest()}


def remember_bootstrap(device, setup_token):
    """Issued once with a new hardware token, never renewed by a replay."""
    if len(setup_token) < 24:
        return
    device["_bootstrap_receipt"] = {
        **_bootstrap_identity(device),
        "setup_digest": hashlib.sha256(setup_token.encode()).hexdigest(),
        "issued_at": time.time(),
    }


def can_replay_bootstrap(device, setup_token):
    """Same proof may recover the same token for 60s, without mutation."""
    receipt = device.get("_bootstrap_receipt")
    if (not isinstance(receipt, dict) or device.get("pending_command")
            or not device.get("device_token") or len(setup_token) < 24):
        return False
    issued = receipt.get("issued_at")
    if not isinstance(issued, (int, float)) or not 0 <= time.time() - issued <= 60:
        return False
    expected = {**_bootstrap_identity(device),
                "setup_digest": hashlib.sha256(setup_token.encode()).hexdigest()}
    return all(hmac.compare_digest(str(receipt.get(key, "")), value)
               for key, value in expected.items())


def publication_identity(device):
    return (binding_id(device), account_proof(str(device.get("account_token", ""))),
            str(device.get("revision", "")))


def commit_publication(proposed, identity):
    """Merge only wall fields after rendering; reject obsolete/withdrawn binds."""
    with transaction():
        devices = store.load("eink_devices", {})
        current = devices.get(proposed["device_id"])
        if (not current or not current.get("claimed") or not current.get("account_token")
                or publication_identity(current) != identity or current.get("pending_command")):
            return None
        for field in _WALL_FIELDS:
            if field in proposed:
                current[field] = proposed[field]
            elif field in ("frame_path", "preview_url"):
                current.pop(field, None)
        devices[current["device_id"]] = current
        save_devices(devices)
        return copy.deepcopy(current)

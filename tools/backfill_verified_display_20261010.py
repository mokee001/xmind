"""One-device, one-revision repair of a missing display-history record.

The existing authenticated displayed state proves display, but not its original
time. confirmedAt therefore means verification time for this visibly labelled
repair only. The exact first display time remains null. This is not a generic
backfill mechanism. Dry-run is the default; --apply requires the main service to
be stopped, so its legacy JSON writer cannot race this one-time migration.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from zoneinfo import ZoneInfo

from backend import display_history, store


DEVICE_ID = "pwe6-8C8A38D9B4DC"
REVISION = "1791620155385286937"
PUBLISHED_AT = 1791620156.952945
SHANGHAI = ZoneInfo("Asia/Shanghai")
TARGET_DAY = datetime.date(2026, 10, 10)
TITLE = "今日精选（补记；时间为核对时间，首次上屏时间未记录）"
SERVICE = "photowall-staging.service"


def validated_device(expected_binding: str, observed_at: datetime.datetime) -> dict:
    devices = store.load("eink_devices", {})
    device = devices.get(DEVICE_ID) if isinstance(devices, dict) else None
    if not isinstance(device, dict):
        raise ValueError("Target device missing")
    if not expected_binding or not secrets.compare_digest(display_history._binding_key(device), expected_binding):
        raise ValueError("Device binding changed")
    if (not device.get("claimed") or not device.get("account_token")
            or device.get("device_id") != DEVICE_ID or device.get("revision") != REVISION
            or device.get("displayed_revision") != REVISION or device.get("state") != "displayed"
            or device.get("error") or device.get("pending_command")):
        raise ValueError("Target display acknowledgement no longer matches the verified state")
    if device.get("published_at") != PUBLISHED_AT:
        raise ValueError("Target publication changed")
    if observed_at.tzinfo is None or observed_at.utcoffset() is None:
        raise ValueError("Verification time must be timezone aware")
    published = datetime.datetime.fromtimestamp(PUBLISHED_AT, datetime.timezone.utc)
    if (observed_at < published or published.astimezone(SHANGHAI).date() != TARGET_DAY
            or observed_at.astimezone(SHANGHAI).date() != TARGET_DAY):
        raise ValueError("This one-time repair is restricted to the verified publication day")
    return device


def _existing(path: Path, record_id: str) -> dict | None:
    if not path.exists():
        return None
    records = json.loads(path.read_text())
    if not isinstance(records, list):
        raise ValueError("Existing history is malformed; stop without writing")
    matches = [r for r in records if isinstance(r, dict) and r.get("id") == record_id]
    if (len(matches) == 1 and matches[0].get("revision") == REVISION
            and matches[0].get("confirmedAt") and matches[0].get("title")):
        return matches[0]
    raise ValueError("A history file already exists without exactly this record; stop without replacing it")


def repair(expected_binding: str, *, apply: bool = False,
           observed_at: datetime.datetime | None = None) -> dict:
    # The CLI never accepts a timestamp override: real execution uses server now.
    observed_at = observed_at or datetime.datetime.now(datetime.timezone.utc)
    device = validated_device(expected_binding, observed_at)
    binding = display_history._binding_key(device)
    record_id = hashlib.sha256(f"{binding}:{REVISION}".encode()).hexdigest()
    path = Path(store._path(display_history._store_key(device)))
    existing = _existing(path, record_id)
    if existing is not None:
        return {"written": False, "already_present": True, "record": existing}
    record = {
        "id": record_id, "revision": REVISION, "title": TITLE,
        "confirmedAt": observed_at.isoformat(),
        "observedAt": observed_at.isoformat(),
        "publishedAt": datetime.datetime.fromtimestamp(PUBLISHED_AT, datetime.timezone.utc).isoformat(),
        "firstDisplayedAt": None,
        "source": "observed_device_state",
        "confirmationTimeMeaning": "verification_of_existing_authenticated_display_receipt",
    }
    if not apply:
        return {"written": False, "already_present": False, "record": record}
    # Callers must also honor the CLI's stopped-service precondition. No device
    # state is mutated, and exclusive file creation cannot replace other history.
    validated_device(expected_binding, observed_at)
    descriptor, filename = tempfile.mkstemp(prefix=".display-history-repair-", dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump([record], stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        if os.geteuid() == 0:
            owner = path.parent.stat()
            os.chown(temporary, owner.st_uid, owner.st_gid)
        try:
            os.link(temporary, path)
        except FileExistsError:
            existing = _existing(path, record_id)
            if existing is None:
                raise ValueError("History changed during repair")
            return {"written": False, "already_present": True, "record": existing}
    finally:
        temporary.unlink(missing_ok=True)
    return {"written": True, "already_present": False, "record": record}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-binding-sha256", required=True)
    parser.add_argument("--store-dir", type=Path, required=True,
                        help="Exact PHOTOWALL_STORE_DIR used by the running main service")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    store._BASE = str(args.store_dir.resolve(strict=True))
    if args.apply:
        check = subprocess.run(["systemctl", "show", "--property=ActiveState", "--value", SERVICE],
                               check=True, capture_output=True, text=True, timeout=10)
        if check.stdout.strip() != "inactive":
            parser.error("Stop the main service in the controlled deployment window before --apply")
    result = repair(args.expected_binding_sha256, apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

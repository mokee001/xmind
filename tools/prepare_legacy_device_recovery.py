from pathlib import Path
import ast
import argparse
import difflib
import hashlib
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="Build exact legacy device-recovery candidate without changing backend/server.py")
parser.add_argument("--source", type=Path, default=ROOT/"outputs/wifi-recheck-20261012/server-before.py")
parser.add_argument("--output-dir", type=Path, required=True)
args = parser.parse_args()
OUT = args.output_dir.resolve()
if OUT == ROOT or OUT == ROOT/"backend":
    raise SystemExit("Output must be a separate staging directory")
(OUT/"backend").mkdir(parents=True, exist_ok=True)
(OUT/"backend/device_recovery.py").write_bytes((ROOT/"backend/device_recovery.py").read_bytes())
BASE = args.source
EXPECTED = "5ad66096ab702b185dae28334624b259d5386e7cc08437eca840faf578898846"
before = BASE.read_text()
assert hashlib.sha256(BASE.read_bytes()).hexdigest() == EXPECTED
with tempfile.TemporaryDirectory() as directory:
    target = Path(directory) / "backend/server.py"
    target.parent.mkdir()
    target.write_text(before)
    subprocess.run(["git", "apply", "--no-index", str(ROOT / "config/patches/server-reprovision-compat-20261012.patch")],
                   cwd=directory, check=True)
    source = target.read_text()


def replace_function(name, change):
    global source
    node = next(n for n in ast.parse(source).body if getattr(n, "name", None) == name)
    lines = source.splitlines(keepends=True)
    old = "".join(lines[node.lineno - 1:node.end_lineno])
    new = change(old)
    source = "".join(lines[:node.lineno - 1]) + new + "".join(lines[node.end_lineno:])


source = source.replace("import datetime\n", "import datetime\nimport asyncio\n")
source = source.replace("from . import display_history\n", "from . import display_history, device_recovery\n")
replace_function("_public_device", lambda s: s.replace(
    '"reprovision_setup_token_digest", "reprovision_setup_token_expires_at")',
    '"setup_token_digest", "setup_token_expires_at",\n'
    '                       "reprovision_setup_token_digest", "reprovision_setup_token_expires_at",\n'
    '                       "_delete_receipts", "_delete_tombstone", "_bootstrap_receipt")').replace(
    '    if hub.connected(', '    if device.get("claimed"):\n'
    '        public["binding_id"] = device_recovery.binding_id(device)\n'
    '    if hub.connected('))


def bootstrap(s):
    s = s.replace('    existing = devices_data.get(req.device_id)\n',
        '    existing = devices_data.get(req.device_id)\n'
        '    previous_receipts = device_recovery.receipts(existing)\n'
        '    if existing and existing.get("_delete_tombstone"):\n'
        '        existing = None\n')
    s = s.replace('    if existing and existing.get("device_token") and not _device_auth(existing, req.device_token):\n',
        '    issued_device_token = not existing\n'
        '    if existing and existing.get("device_token") and not _device_auth(existing, req.device_token):\n'
        '        if not req.device_token and device_recovery.can_replay_bootstrap(existing, req.setup_token.strip()):\n'
        '            return JSONResponse({"device_id": req.device_id, "device_token": existing["device_token"],\n'
        '                                 "claimed": bool(existing.get("claimed")), "poll_seconds": 15})\n')
    s = s.replace('        if reset_is_pending:\n            existing = None\n',
        '        if reset_is_pending:\n            existing = None\n            issued_device_token = True\n')
    s = s.replace('            existing["device_token"] = secrets.token_urlsafe(32)\n',
        '            existing["device_token"] = secrets.token_urlsafe(32)\n            issued_device_token = True\n')
    s = s.replace('    devices_data[req.device_id] = device\n',
        '    if issued_device_token:\n'
        '        device_recovery.remember_bootstrap(device, setup_token)\n'
        '    devices_data[req.device_id] = device\n')
    s = s.replace('    device.update({\n',
        '    if previous_receipts:\n'
        '        device["_delete_receipts"] = previous_receipts\n'
        '    device.update({\n', 1)
    return s
replace_function("device_bootstrap", bootstrap)
replace_function("_queue_reprovision", lambda s: s.replace(
    '    device["pending_command"] = {\n', '    device.pop("_bootstrap_receipt", None)\n    device["pending_command"] = {\n'))


def claim(s):
    s = s.replace('    if not device.get("account_token"):\n',
        '    previous_owner = str(device.get("account_token", ""))\n'
        '    if not device.get("account_token"):\n', 1) if "def device_claim(" in s else s.replace(
        '    account_token = x_account_token.strip()\n',
        '    previous_owner = str(device.get("account_token", ""))\n'
        '    account_token = x_account_token.strip()\n', 1)
    s = s.replace('    device["claimed"] = True\n',
        '    if not device.get("claimed") or str(device.get("account_token", "")) != previous_owner:\n'
        '        device_recovery.start_binding(device)\n'
        '    device["claimed"] = True\n')
    if "def device_claim(" in s:
        s = s.replace('    previous_owner = str(device.get("account_token", ""))\n',
            '    pending = device.get("pending_command")\n'
            '    if isinstance(pending, dict) and pending.get("type") == "reprovision" and not pending.get("preserve_binding"):\n'
            '        return JSONResponse(status_code=409, content={"error": "设备正在解除旧绑定，请通过蓝牙重新连接", "code": "device_recovery_pending"})\n'
            '    previous_owner = str(device.get("account_token", ""))\n')
        s = s.replace('    device["claimed"] = True\n',
            '    device["claimed"] = True\n'
            '    device.pop("setup_token_digest", None)\n'
            '    device.pop("setup_token_expires_at", None)\n', 1)
    return s
replace_function("device_claim", claim)
replace_function("device_auto_claim", claim)

replace_function("device_delete", lambda _: '''def device_delete(
    device_id: str,
    x_account_token: str = Header(default=""),
    x_device_binding: str = Header(default=""),
    x_delete_request_id: str = Header(default=""),
) -> Response:
    """Revoke one binding once; replay only its authenticated deletion receipt."""
    requested_binding = x_device_binding.strip()
    request_id = x_delete_request_id.strip()
    if bool(requested_binding) != bool(request_id):
        return JSONResponse(status_code=400, content={"error": "删除操作信息不完整，请重新检查设备", "code": "delete_identity_required"})
    if requested_binding and (not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", requested_binding)
                              or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", request_id)):
        return JSONResponse(status_code=400, content={"error": "删除操作信息无效", "code": "delete_identity_invalid"})
    devices_data = _devices()
    device = devices_data.get(device_id)
    # New bindings never accept an unscoped legacy delete or legacy receipt.
    if device and (requested_binding or not device.get("binding_id")):
        receipt = device_recovery.find_receipt(device, x_account_token, requested_binding, request_id)
        if receipt:
            return JSONResponse(status_code=202, content=device_recovery.receipt_response(receipt, replay=True))
    if not device or not device.get("claimed") or not _account_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    if device.get("binding_id") and not requested_binding:
        return JSONResponse(status_code=409, content={"error": "设备绑定已更新，请检查连接后重新确认删除", "code": "device_binding_required"})
    if requested_binding and requested_binding != device_recovery.binding_id(device):
        return JSONResponse(status_code=409, content={"error": "设备绑定已变化，未删除新绑定", "code": "device_binding_changed"})
    _remember_account(x_account_token)
    receipt = device_recovery.record_receipt(device, x_account_token, request_id)
    if _device_family(device) == DEVICE_FAMILY_WALNUTPI_19IN:
        receipt["reprovision_required"] = False
        devices_data[device_id] = device_recovery.tombstone(device)
    else:
        _queue_reprovision(device)
        devices_data[device_id] = device
    device_recovery.save_devices(devices_data)
    return JSONResponse(status_code=202, content=device_recovery.receipt_response(receipt, replay=False))
''')

replace_function("device_status", lambda s: s.replace(
    '        devices_data.pop(device_id, None)\n',
    '        devices_data[device_id] = device_recovery.tombstone(device)\n'))

# Only fast synchronous metadata handlers hold the short cross-process lock.
sync_writers = {"device_bootstrap", "device_claim", "device_auto_claim", "device_delete",
                "device_reprovision", "device_next", "device_status"}
for name in sync_writers:
    replace_function(name, lambda s: "@device_recovery.serialized\n" + s)

# Rendering and uploads stay outside the lock. Their final metadata commit
# rechecks identity/revision and merges wall fields into the current snapshot.
async_writers = {"device_publish", "device_publish_last_wall", "device_publish_july_calendar"}
def publication(s):
    s = s.replace('    if not device or not _account_auth(device, x_account_token):\n'
                  '        return JSONResponse(status_code=401, content={"error": "设备授权无效"})\n',
                  '    if not device or not _account_auth(device, x_account_token):\n'
                  '        return JSONResponse(status_code=401, content={"error": "设备授权无效"})\n'
                  '    publication_identity = device_recovery.publication_identity(device)\n', 1)
    for indent in ("        ", "    "):
        old = indent + 'devices_data[device_id] = device\n' + indent + 'store.save("eink_devices", devices_data)\n'
        new = indent + 'device = await asyncio.to_thread(device_recovery.commit_publication, device, publication_identity)\n'
        new += indent + 'if device is None:\n'
        new += indent + '    return JSONResponse(status_code=409, content={"error": "设备绑定或待展示内容已变化，请重新检查", "code": "device_binding_changed"})\n'
        s = s.replace(old, new)
    return s
for name in async_writers:
    replace_function(name, publication)
source = source.replace('store.save("eink_devices", devices_data)', 'device_recovery.save_devices(devices_data)')
assert 'store.save("eink_devices"' not in source
compile(source, "<candidate>", "exec")
candidate = OUT / "backend/server.py"
candidate.write_text(source)
patch = "".join(difflib.unified_diff(before.splitlines(True), source.splitlines(True),
                                   fromfile="a/backend/server.py", tofile="b/backend/server.py"))
helper = (OUT / "backend/device_recovery.py").read_text()
patch += "".join(difflib.unified_diff([], helper.splitlines(True),
                                    fromfile="/dev/null", tofile="b/backend/device_recovery.py"))
(OUT / "device-recovery.patch").write_text(patch)
old_nodes = {n.name: ast.dump(n, include_attributes=False) for n in ast.parse(before).body if hasattr(n, "name")}
new_nodes = {n.name: ast.dump(n, include_attributes=False) for n in ast.parse(source).body if hasattr(n, "name")}
manifest = {"base_sha256": EXPECTED, "candidate_sha256": hashlib.sha256(source.encode()).hexdigest(),
            "helper_sha256": hashlib.sha256(helper.encode()).hexdigest(),
            "changed_functions": sorted(k for k in old_nodes if old_nodes[k] != new_nodes[k]),
            "added_definitions": sorted(set(new_nodes) - set(old_nodes)),
            "synchronous_short_transaction_routes": sorted(sync_writers),
            "asynchronous_publication_commit_routes": sorted(async_writers),
            "deployed": False}
(OUT / "candidate-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))

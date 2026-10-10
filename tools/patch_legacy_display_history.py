"""Prepare, but never deploy, the display-history patch for the legacy service.

This deliberately preserves the legacy renderer, authentication implementation,
device-family handling and prior hotfixes. Deploy backend/display_history.py with
the resulting server candidate. No existing wall is inferred as a dated record.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path


CHANGED_FUNCTIONS = {
    "_queue_device_image", "device_publish", "device_publish_last_wall", "device_status",
}
ROUTE = '''@app.get("/api/devices/{device_id}/display-history")
def device_display_history(device_id: str, x_account_token: str = Header(default="")) -> Response:
    """Return actual display receipts from this device's current binding only."""
    device = _devices().get(device_id)
    if not device or not _account_auth(device, x_account_token):
        return JSONResponse(status_code=401, content={"error": "设备授权无效"})
    return JSONResponse({"records": display_history.records_for(device)})


'''


def _replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Legacy source shape changed: expected one {old[:80]!r}")
    return source.replace(old, new, 1)


def patch_source(source: str) -> str:
    original = ast.parse(source)
    if "display_history" in source:
        raise ValueError("Source already references display_history; review instead of applying twice")
    functions = {node.name: node for node in original.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if not CHANGED_FUNCTIONS <= functions.keys():
        raise ValueError("Missing required legacy publication/status function")
    lines = source.splitlines(keepends=True)
    replacements = []
    for name in CHANGED_FUNCTIONS:
        node = functions[name]
        body = "".join(lines[node.lineno - 1:node.end_lineno])
        if name == "_queue_device_image":
            body = _replace_once(body,
                "image_bytes: bytes) -> tuple[str, str]:",
                'image_bytes: bytes, *, title: str = "照片墙画面") -> tuple[str, str]:')
            body = _replace_once(body, "    return revision, preview_path",
                '    display_history.stage(device, revision, title=title, image_url=device["preview_url"])\n'
                "    return revision, preview_path")
        elif name == "device_publish":
            body = _replace_once(body, "    devices_data[device_id] = device",
                '    display_history.stage(device, revision, title="照片墙画面", image_url=device["preview_url"])\n'
                "    devices_data[device_id] = device")
        elif name == "device_publish_last_wall":
            body = _replace_once(body, "        devices_data[device_id] = device",
                '        display_history.stage(device, revision, title=wall.get("title", "照片墙画面"), image_url=image_url)\n'
                "        devices_data[device_id] = device")
            body = _replace_once(body,
                "_queue_device_image(device, image_file.read())",
                '_queue_device_image(device, image_file.read(), title=wall.get("title", "照片墙画面"))')
        else:
            body = _replace_once(body, '        device["displayed_revision"] = req.revision',
                '        device["displayed_revision"] = req.revision\n'
                "        if not req.error:\n"
                "            display_history.confirm(device, req.revision)")
        replacements.append((node.lineno - 1, node.end_lineno, body))
    for start, end, body in sorted(replacements, reverse=True):
        lines[start:end] = [body]
    candidate = "".join(lines)
    imports = [node for node in original.body if isinstance(node, ast.ImportFrom)
               and node.level == 1 and node.module is None
               and "store" in [item.name for item in node.names]]
    if len(imports) != 1:
        raise ValueError("Missing unique legacy backend import")
    anchor = source.splitlines(keepends=True)[imports[0].lineno - 1]
    candidate = _replace_once(candidate, anchor, "from . import display_history\n" + anchor)
    candidate = _replace_once(candidate, '@app.post("/api/devices/{device_id}/status")',
                              ROUTE + '@app.post("/api/devices/{device_id}/status")')
    validate_diff(source, candidate)
    return candidate


def validate_diff(source: str, candidate: str) -> None:
    """Reject accidental edits outside the four hooks, one import and one route."""
    before = ast.parse(source)
    after = ast.parse(candidate)
    additions = []
    remaining = []
    for node in after.body:
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module is None \
                and [name.name for name in node.names] == ["display_history"]:
            additions.append("import")
        elif isinstance(node, ast.FunctionDef) and node.name == "device_display_history":
            if ast.dump(node) != ast.dump(ast.parse(ROUTE).body[0]):
                raise ValueError("Unexpected history endpoint implementation")
            additions.append("route")
        else:
            remaining.append(node)
    if sorted(additions) != ["import", "route"] or len(remaining) != len(before.body):
        raise ValueError("Unexpected module-level changes")
    changed = set()
    for old, new in zip(before.body, remaining):
        if ast.dump(old) != ast.dump(new):
            if not isinstance(old, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                    or not isinstance(new, type(old)) or old.name != new.name:
                raise ValueError("Unexpected non-function change")
            changed.add(old.name)
    if changed != CHANGED_FUNCTIONS:
        raise ValueError(f"Unexpected changed functions: {sorted(changed)}")
    compile(candidate, "server-display-history-candidate.py", "exec")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    raw = args.source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.expected_sha256:
        parser.error("Source digest changed; read the current deployed source before preparing a patch")
    if args.source.resolve() == args.output.resolve() or args.output.exists():
        parser.error("Output must be a new file; source is never overwritten")
    candidate = patch_source(raw.decode("utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(candidate)
    print(json.dumps({"source_sha256": digest,
                      "candidate_sha256": hashlib.sha256(candidate.encode()).hexdigest(),
                      "changed_functions": sorted(CHANGED_FUNCTIONS),
                      "added_route": "/api/devices/{device_id}/display-history",
                      "requires_module": "backend/display_history.py",
                      "backfilled_records": 0, "deployed": False}, indent=2))


if __name__ == "__main__":
    main()

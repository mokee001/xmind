#!/usr/bin/env python3
"""Read-only integrity check for the user-approved album selection baseline."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASELINE_COMMIT = "c1c5683eb00c232123832a47f25ddd0d5e3e6e56"
BASELINE_VERSION = "recollections-rules-v1.0.0"
MANIFEST = "config/recollection_rules_v1.0.0.json"


def sha256(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def check_files(root, expected):
    issues = []
    for name, checksum in expected.items():
        path = root / name
        if not path.is_file():
            issues.append({"file": name, "problem": "missing"})
        elif sha256(path) != checksum:
            issues.append({"file": name, "problem": "changed"})
    return issues


def check_models(root, expected):
    runtime_path = root / "outputs/selection-lab/ente/runtime.json"
    if not runtime_path.is_file():
        return [{"model": "runtime", "problem": "missing"}]
    runtime = json.loads(runtime_path.read_text())
    issues = []
    for name, spec in expected.items():
        configured = runtime.get("models", {}).get(name)
        path = Path(configured) if configured else None
        if path is not None and not path.is_absolute():
            path = root / path
        if path is None or not path.is_file():
            issues.append({"model": name, "problem": "missing"})
        elif sha256(path) != spec["sha256"]:
            issues.append({"model": name, "problem": "changed"})
        if runtime.get("model_sha256", {}).get(name) != spec["sha256"]:
            issues.append({"model": name, "problem": "runtime_fingerprint_mismatch"})
    return issues


def verify(root=ROOT, models=False):
    # Read the immutable Git object, so editing the local checksum list cannot
    # accidentally turn a modified algorithm into a passing baseline check.
    source = subprocess.check_output(
        ["git", "show", f"{BASELINE_COMMIT}:{MANIFEST}"], cwd=root, stderr=subprocess.PIPE)
    manifest = json.loads(source)
    if manifest.get("version") != BASELINE_VERSION:
        raise ValueError("Git 基准清单版本不符")
    expected = {**manifest["files"], MANIFEST: hashlib.sha256(source).hexdigest()}
    issues = check_files(root, expected)
    model_issues = check_models(root, manifest["models"]) if models else []
    return {"ok": not issues and not model_issues, "commit": BASELINE_COMMIT,
            "version": BASELINE_VERSION, "rule_files": len(manifest["files"]),
            "manifest_verified": not any(i["file"] == MANIFEST for i in issues),
            "file_issues": issues, "models_checked": models,
            "model_count": len(manifest["models"]) if models else 0,
            "model_issues": model_issues}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", action="store_true", help="同时校验本地五个模型／词表及运行配置指纹")
    args = parser.parse_args(argv)
    try:
        result = verify(models=args.models)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError):
        result = {"ok": False, "commit": BASELINE_COMMIT,
                  "error": "无法读取 Git 基准、完整性清单或本地模型配置；未改动文件，也未切换到其他规则。"}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

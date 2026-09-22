#!/usr/bin/env python3
"""Freeze and reopen a complete memory preview without overwriting working code."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ROOT / "outputs/recollection-versions"


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))


def version_path(version):
    if not re.fullmatch(r"recollections-v\d+\.\d+\.\d+", version):
        raise ValueError("版本号格式：recollections-v1.0.0")
    return VERSIONS / version


def verify(path):
    manifest = json.loads((path / "manifest.json").read_text())
    for name, expected in manifest["files"].items():
        item = (path / name).resolve()
        item.relative_to(path.resolve())
        if sha(item) != expected:
            raise ValueError(f"版本文件校验失败：{name}")
    print(f"{manifest['version']}：{len(manifest['files'])} 个文件校验通过", flush=True)
    return manifest


def freeze(args):
    destination = version_path(args.version)
    if destination.exists():
        raise ValueError("版本已存在；不可覆盖，请使用新版本号")
    sys.path.insert(0, str(ROOT))
    from selection_lab.core import Lab
    from selection_lab.datasets import paths
    from selection_lab.recollection_feed import get_feed
    lab_paths = paths()
    lab = Lab(*lab_paths)
    local = get_feed(lab)
    if not local:
        raise ValueError("当前没有回忆结果")
    provenance = local["provenance"]
    expected = {"recollection_feed.py": provenance["code_revision"], **provenance["dependencies"]}
    if any(sha(ROOT / "selection_lab" / name) != checksum for name, checksum in expected.items()):
        raise ValueError("当前代码与结果快照不匹配，未创建版本")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def fetch(route):
        with opener.open(args.url.rstrip("/") + route, timeout=30) as response:
            return response.read()
    payload = json.loads(fetch("/api/recollections"))
    live = payload["result"]
    local_albums = {a["id"]: a for a in local["albums"]}
    for album in live["albums"]:
        if album["id"] not in local_albums or any(local_albums[album["id"]].get(k) != v for k, v in album.items()):
            raise ValueError("所见预览与本地快照不同，未创建版本")
    VERSIONS.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".freeze-", dir=VERSIONS))
    try:
        site = temporary / "site"
        site.mkdir()
        for route in ("/recollections", "/recollections.js", "/recollections.css"):
            body = fetch(route)
            if route == "/recollections":
                body = body.replace("局域网预览 · 仅供浏览".encode(), f"{args.version} · 已存档".encode())
            (site / route.lstrip("/")).write_bytes(body)
        # Capture the server's existing fixed order rather than recomputing by today's clock.
        write_json(site / "api/recollections", payload)
        for photo in live["photos"]:
            if not re.fullmatch(r"/media/[a-f0-9-]+", photo["image"]):
                raise ValueError("非法图片路径")
            path = site / photo["image"].lstrip("/")
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(fetch(photo["image"]))
        # Keep source for later extraction; rollback preview never overwrites shared modules.
        sources = list((ROOT / "selection_lab").rglob("*.py"))
        sources += [p for p in (ROOT / "selection_lab/static").rglob("*") if p.is_file()]
        sources += list((ROOT / "backend").rglob("*.py"))
        sources += [ROOT / p for p in ("tools/recollection_versions.py", "tools/selection_lab.py",
                    "tools/share_recollections.py", "tools/run_recollection_feed.py",
                    "tools/ente_ml_probe.rs", "tools/album_vision_features.swift",
                    "docs/recollection-feed.md", "打开回忆精选.command")]
        sources += list((ROOT / "tests").glob("test_*recollection*"))
        for source in sources:
            target = temporary / "source" / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        write_json(temporary / "result.json", local)
        # Inference caches and model checksums, not model weights or full-size originals.
        inputs = list(lab.cache_dir.glob("*.json"))
        inputs += [lab.state_dir / "album-features.json"]
        inputs += list((lab.state_dir / "ente").glob("*.json"))
        inputs += list((lab.state_dir / "recollections").glob("*.json"))
        run_id = provenance["ente_snapshot"]
        inputs += list((lab.state_dir / "runs" / run_id).rglob("*.json"))
        inputs += [lab.state_dir / "runs" / (run_id + ".json"), lab_paths[2],
                   ROOT / "outputs/selection-lab/active-dataset.json",
                   ROOT / "outputs/selection-lab/ente/runtime.json"]
        with tarfile.open(temporary / "inputs.tar.gz", "w:gz") as archive:
            for path in sorted(set(inputs)):
                if path.is_file():
                    archive.add(path, arcname=str(path.relative_to(ROOT)))
        manifest = {"version": args.version, "created_at": dt.datetime.now().astimezone().isoformat(),
                    "snapshot_id": local["id"], "dataset_id": lab.dataset_id,
                    "album_count": len(live["albums"]), "photo_count": len(live["photos"]),
                    "git_base": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                    "git_note": "Local version archive, not a Git tag; captures uncommitted source files.",
                    "limits": "Frozen preview is standalone. Regeneration requires original photos, model weights and runtime; these are not duplicated.",
                    "models": provenance["models"],
                    "files": {str(p.relative_to(temporary)): sha(p) for p in temporary.rglob("*") if p.is_file()}}
        write_json(temporary / "manifest.json", manifest)
        verify(temporary)
        os.rename(temporary, destination)
        print(destination)
    except BaseException:
        shutil.rmtree(temporary)
        raise


def serve(args):
    path = version_path(args.version)
    verify(path)
    class FrozenHandler(SimpleHTTPRequestHandler):
        def __init__(self, *pos, **kw):
            super().__init__(*pos, directory=str(path / "site"), **kw)
        def do_GET(self):
            allowed = {f"{args.host}:{self.server.server_port}"}
            if args.host == "127.0.0.1": allowed.add(f"localhost:{self.server.server_port}")
            if self.headers.get("Host") not in allowed or self.headers.get("Sec-Fetch-Site") == "cross-site":
                return self.send_error(403)
            if self.path == "/": self.path = "/recollections"
            return super().do_GET()
        def guess_type(self, name):
            if Path(name).name == "recollections":
                return "application/json" if Path(name).parent.name == "api" else "text/html; charset=utf-8"
            return super().guess_type(name)
        def list_directory(self, path):
            self.send_error(404)
        def log_message(self, *_args):
            pass
    with ThreadingHTTPServer((args.host, args.port), FrozenHandler) as server:
        print(f"http://{args.host}:{server.server_port}/recollections", flush=True)
        server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("freeze", "verify", "serve"))
    parser.add_argument("version")
    parser.add_argument("--url", default="http://10.23.53.163:8769")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    args = parser.parse_args()
    if args.action == "freeze": freeze(args)
    elif args.action == "verify": verify(version_path(args.version))
    else: serve(args)


if __name__ == "__main__":
    main()

"""Loopback-only HTTP surface; state lives in ignored outputs/selection-lab."""
from __future__ import annotations

import argparse
import io
import json
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageOps

from .core import Lab, LabError, ROOT

STATIC = Path(__file__).parent / "static"


class LabServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, lab):
        self.lab, self.token = lab, secrets.token_urlsafe(32)
        self.images, self.image_lock = {}, threading.Lock()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: LabServer

    def log_message(self, *_args):
        # Avoid writing asset identifiers, captions, paths, or annotations to logs.
        pass

    def allowed(self):
        port = self.server.server_port
        return (self.headers.get("Host") in {f"localhost:{port}", f"127.0.0.1:{port}"}
                and self.headers.get("Sec-Fetch-Site") not in {"cross-site"})

    def reply(self, value, status=200, kind="application/json; charset=utf-8", filename=None):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            return self.reply({"error": "仅允许本机同源访问"}, 403)
        route = urllib.parse.urlsplit(self.path).path
        lab = self.server.lab
        try:
            if route == "/api/health":
                return self.reply({"service": "photo-wall-selection-lab", "status": "ok"})
            if route == "/api/engine-comparison":
                from .core import read_json
                result = read_json(lab.state_dir / "engine-comparison.json", {})
                if result.get("dataset_id") != lab.dataset_id:
                    raise LabError("对照结果未生成或不是当前照片集")
                return self.reply(result)
            if route == "/api/bootstrap":
                return self.reply({**lab.metadata(), "token": self.server.token,
                                   "runs": lab.list_runs(), "annotations": lab.get_annotations()})
            if route == "/api/manifest":
                return self.reply(lab.manifest, filename="photo-wall-dataset-manifest.json")
            if route == "/api/runs":
                return self.reply(lab.list_runs())
            if route == "/api/ente":
                from .ente import status
                return self.reply(status(lab))
            if route == "/api/hybrid":
                from .hybrid import latest_hybrid
                return self.reply({"record": latest_hybrid(lab)})
            if route == "/api/stories":
                from .stories import latest_stories, previous_stories
                return self.reply({"record": latest_stories(lab), "previous": previous_stories(lab)})
            if route == "/api/memories":
                from .memories import latest_memories
                return self.reply({"record": latest_memories(lab)})
            if route == "/api/memory-experiment":
                from .memory_experiment import get_experiment, reviews
                return self.reply({"result": get_experiment(lab), "reviews": reviews(lab)})
            if route == "/api/wall-demo":
                from .wall_demo import manifest
                return self.reply(manifest(lab))
            if route.startswith("/wall-demo-image/"):
                from .wall_demo import image_path
                return self.reply(image_path(lab, route.split('/')[-1]).read_bytes(), kind="image/jpeg")
            if route == "/api/recollections-v2":
                from .recollection_v2 import get_feed
                return self.reply({"result": get_feed(lab), "token": self.server.token})
            if route == "/api/recollections":
                from .recollection_feed import get_feed
                return self.reply({"result": get_feed(lab), "token": self.server.token})
            if route.startswith("/api/runs/"):
                return self.reply(lab.get_run(route.removeprefix("/api/runs/")))
            if route.startswith("/api/export/"):
                return self.reply(lab.get_run(route.removeprefix("/api/export/")), filename="selection-lab-snapshot.json")
            if route.startswith("/person-preview/"):
                from .recollection_v2 import get_feed
                result = get_feed(lab)
                key = route.removeprefix("/person-preview/")
                group = next((g for g in (result or {}).get("preference_people", []) if g["id"] == key), None)
                if not group:
                    return self.reply({"error": "人物候选不存在"}, 404)
                face = group["portrait"]
                asset = lab.assets[face["asset_id"]]
                path = Path(asset["path"])
                stat = path.stat()
                if (stat.st_size, stat.st_mtime_ns) != lab.source_stamps[face["asset_id"]]:
                    raise LabError("原图已变化，请重新分析")
                cache_key = "person:" + result["id"] + ":" + key + ":" + face["face_id"]
                with self.server.image_lock:
                    body = self.server.images.get(cache_key)
                if body is None:
                    with Image.open(path) as source:
                        img = ImageOps.exif_transpose(source).convert("RGB")
                        w, h = img.size
                        x1,y1,x2,y2 = face["box"]
                        cx,cy = (x1+x2)*w/2,(y1+y2)*h/2
                        side = min(max((x2-x1)*w, (y2-y1)*h)*1.7, w, h)
                        left,top = max(0,min(w-side,cx-side/2)),max(0,min(h-side,cy-side/2))
                        img = img.crop((int(left),int(top),int(left+side),int(top+side))).resize((180,180))
                        buffer = io.BytesIO(); img.save(buffer,"JPEG",quality=85)
                        body = buffer.getvalue()
                    with self.server.image_lock:
                        self.server.images[cache_key] = body
                return self.reply(body, kind="image/jpeg")
            if route.startswith("/media/"):
                asset_id = route.removeprefix("/media/")
                item = lab.assets.get(asset_id)
                if not item:
                    return self.reply({"error": "照片不存在"}, 404)
                path = Path(item["path"])
                stat = path.stat()
                if (stat.st_size, stat.st_mtime_ns) != lab.source_stamps[asset_id]:
                    raise LabError("原图已变化，请重新分析")
                with self.server.image_lock:
                    body = self.server.images.get(asset_id)
                if body is None:
                    with Image.open(path) as source:
                        img = ImageOps.exif_transpose(source).convert("RGB")
                        img.thumbnail((1000, 1000))
                        buffer = io.BytesIO()
                        # No EXIF, GPS or other original metadata is exported in previews.
                        img.save(buffer, "JPEG", quality=85)
                        body = buffer.getvalue()
                    with self.server.image_lock:
                        self.server.images[asset_id] = body
                return self.reply(body, kind="image/jpeg")
            public = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/engine-comparison": ("engine-comparison.html", "text/html; charset=utf-8"),
                      "/engine-comparison.js": ("engine-comparison.js", "text/javascript; charset=utf-8"),
                      "/engine-comparison.css": ("engine-comparison.css", "text/css; charset=utf-8"),
                      "/wall-demo": ("wall-demo.html", "text/html; charset=utf-8"),
                      "/wall-demo.js": ("wall-demo.js", "text/javascript; charset=utf-8"),
                      "/wall-demo-state.js": ("wall-demo-state.js", "text/javascript; charset=utf-8"),
                      "/wall-demo.css": ("wall-demo.css", "text/css; charset=utf-8"),
                      "/recollections-v2": ("recollections-v2.html", "text/html; charset=utf-8"),
                      "/display-preferences.css": ("display-preferences.css", "text/css; charset=utf-8"),
                      "/recollections-v2.js": ("recollections-v2.js", "text/javascript; charset=utf-8"),
                      "/people-v2": ("people-v2.html", "text/html; charset=utf-8"),
                      "/people-v2.js": ("people-v2.js", "text/javascript; charset=utf-8"),
                      "/recollections": ("recollections.html", "text/html; charset=utf-8"),
                      "/recollections.js": ("recollections.js", "text/javascript; charset=utf-8"),
                      "/recollections.css": ("recollections.css", "text/css; charset=utf-8"),
                      "/memories": ("memory-experiment.html", "text/html; charset=utf-8"),
                      "/memory-experiment.js": ("memory-experiment.js", "text/javascript; charset=utf-8"),
                      "/memory-experiment.css": ("memory-experiment.css", "text/css; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/album-comparison.js": ("album-comparison.js", "text/javascript; charset=utf-8"),
                      "/story-albums.js": ("story-albums.js", "text/javascript; charset=utf-8"),
                      "/memory-albums.js": ("memory-albums.js", "text/javascript; charset=utf-8"),
                      "/collections.css": ("collections.css", "text/css; charset=utf-8"),
                      "/engines.css": ("engines.css", "text/css; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8")}
            if route in public:
                name, mime = public[route]
                return self.reply((STATIC / name).read_bytes(), kind=mime)
            return self.reply({"error": "未找到"}, 404)
        except (LabError, FileNotFoundError) as error:
            return self.reply({"error": str(error)}, 400)
        except (OSError, ValueError):
            return self.reply({"error": "本地文件读取失败，请检查文件和缓存"}, 500)

    def do_POST(self):
        port = self.server.server_port
        if (not self.allowed() or self.headers.get("X-Lab-Token") != self.server.token
                or self.headers.get("Origin") not in {None, f"http://127.0.0.1:{port}", f"http://localhost:{port}"}):
            return self.reply({"error": "本机请求验证失败，请刷新实验台"}, 403)
        if self.headers.get_content_type() != "application/json":
            return self.reply({"error": "只接受 JSON 请求"}, 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2 * 1024 * 1024:
                return self.reply({"error": "请求过大或为空（上限 2 MB）"}, 413)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise LabError("请求必须是 JSON 对象")
            route = urllib.parse.urlsplit(self.path).path
            lab = self.server.lab
            if route == "/api/ente-run":
                from .ente import start
                if data:
                    raise LabError("Ente 原版重跑不接受本项目选片参数")
                return self.reply(start(lab))
            if route == "/api/collections":
                from .collections import build_collections
                return self.reply(build_collections(lab, data.get("config", {})))
            if route == "/api/hybrid-run":
                from .hybrid import build_hybrid_collections, save_hybrid
                albums = build_hybrid_collections(lab, data.get("config", {}))
                return self.reply({"record": save_hybrid(lab, albums, data.get("name", "Ente 识别＋我的成册"))})
            if route == "/api/stories-run":
                from .stories import build_stories, save_stories
                albums = build_stories(lab, data.get("config", {}))
                return self.reply({"record": save_stories(lab, albums, data.get("name", "人物·旅程·活动 · 新聚合"))})
            if route == "/api/memories-run":
                from .memories import build_memories, save_memories
                albums = build_memories(lab, data.get("config", {}), album_settings=data.get("album_settings"))
                return self.reply({"record": save_memories(lab, albums, data.get("name", "回忆精选 · 统一成册"))})
            if route == "/api/memory-experiment-run":
                from .memory_experiment import build_experiment, save_experiment
                return self.reply({"result": save_experiment(lab, build_experiment(lab, data.get("config", {})))})
            if route == "/api/memory-experiment-review":
                from .memory_experiment import save_review
                return self.reply({"review": save_review(lab, data)})
            if route in {"/api/display-preferences", "/api/display-preferences-preview"}:
                from .display_preferences import update_preferences
                return self.reply(update_preferences(lab, data, preview=route.endswith("-preview")))
            if route == "/api/recollections-v2-run":
                from .recollection_v2 import build_feed, get_feed
                build_feed(lab)
                return self.reply({"result": get_feed(lab)})
            if route == "/api/recollections-v2-feedback":
                from .recollection_v2 import update_feedback
                return self.reply({"feedback": update_feedback(lab, data)})
            if route == "/api/recollections-run":
                from .recollection_feed import build_feed, get_feed
                build_feed(lab)
                return self.reply({"result": get_feed(lab)})
            if route == "/api/recollections-feedback":
                from .recollection_feed import update_feedback
                return self.reply({"feedback": update_feedback(lab, data)})
            if route == "/api/run":
                if data.get("engine", "photo-wall") != "photo-wall":
                    raise LabError("该引擎未安装；不会回退后冒充原引擎")
                return self.reply(lab.run(data.get("config", {})))
            if route == "/api/save":
                result = lab.run(data.get("config", {}))
                if result["id"] != data.get("expected_id"):
                    raise LabError("参数或引擎已变化，请先重新选片，再保存当前结果")
                if data.get("collection_id"):
                    from .collections import build_collections
                    albums = build_collections(lab, data.get("config", {}))
                    if albums["id"] != data["collection_id"]:
                        raise LabError("相册规则或内容索引已变化，请重新生成后保存")
                    result["collection_snapshot"] = albums
                return self.reply(lab.save_run(result, data.get("name")))
            if route == "/api/annotations":
                return self.reply(lab.annotate(data.get("asset_id"), data.get("mark"), data.get("note", "")))
            if route == "/api/ente-import":
                result = lab.import_ente(data.get("export"))
                return self.reply(lab.save_run(result, data.get("name", "Ente 导入结果")))
            return self.reply({"error": "未找到"}, 404)
        except (LabError, ValueError, TypeError, KeyError, AttributeError) as error:
            return self.reply({"error": str(error)}, 400)
        except OSError:
            return self.reply({"error": "本地保存失败，请检查目录权限和磁盘空间"}, 500)


def main():
    parser = argparse.ArgumentParser(description="本地选片实验台（不上传照片）")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--historical", type=Path)
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--view", choices=["collections", "memories", "recollections"], default="collections")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    open_url = url + ("/" + args.view if args.view != "collections" else "")
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=1) as response:
            active = json.load(response)
        if active.get("service") == "photo-wall-selection-lab":
            print(f"实验台已运行：{url}", flush=True)
            if args.open:
                webbrowser.open(open_url)
            return
    except (OSError, ValueError):
        pass
    from .datasets import paths
    lab = Lab(*paths(args.cache_dir, args.state_dir, args.historical))
    try:
        server = LabServer(("127.0.0.1", args.port), lab)
    except OSError as error:
        raise SystemExit(f"端口 {args.port} 不可用，可用 --port 指定其他端口；没有停止其他进程。") from error
    print(f"选片实验台：{url} · {len(lab.features)} 张缓存照片 · 仅本机访问", flush=True)
    if args.open:
        webbrowser.open(open_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

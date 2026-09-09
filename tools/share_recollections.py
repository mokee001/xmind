#!/usr/bin/env python3
"""Serve the current memory preview on an explicitly chosen LAN address."""
import argparse
import ipaddress
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from selection_lab.core import Lab
from selection_lab.datasets import paths
from selection_lab.recollection_feed import get_feed
from selection_lab.server import Handler, LabServer, STATIC


class PreviewHandler(Handler):
    def allowed(self):
        return (self.headers.get("Host") == self.server.preview_host
                and self.headers.get("Sec-Fetch-Site") != "cross-site")

    def do_GET(self):
        if not self.allowed():
            return self.reply({"error": "访问地址不匹配"}, 403)
        route = urlsplit(self.path).path
        if route == "/api/recollections":
            return self.reply({"result": self.server.preview_feed, "token": ""})
        if route in {"/", "/recollections"}:
            html = (STATIC / "recollections.html").read_text()
            html = html.replace("本机生成 · 照片未上传", "局域网预览 · 仅供浏览")
            html = html.replace('<a href="/memories">查看实验对照</a>', "")
            html = html.replace("喜欢的回忆可以收藏；“少推荐”可在列表下方撤回。已打开的回忆会影响下一次推荐。照片组合仍需你的反馈来改进。", "此链接支持浏览和播放，不记录观看或修改收藏。")
            return self.reply(html.encode(), kind="text/html; charset=utf-8")
        if route == "/recollections.js":
            script = (STATIC / "recollections.js").read_text()
            original = 'const preview=new URLSearchParams(location.search).has("preview");'
            if original not in script:
                return self.reply({"error": "预览脚本已变化，请更新分享入口"}, 503)
            script = script.replace(original, "const preview=true;")
            script = script.replace("预览检查模式：不记录观看或偏好。", "")
            return self.reply(script.encode(), kind="text/javascript; charset=utf-8")
        if route == "/recollections.css":
            css = (STATIC / "recollections.css").read_bytes()
            css += b"\n.card-favorite,#favorite,#hide{display:none!important}\n"
            return self.reply(css, kind="text/css; charset=utf-8")
        if route.startswith("/media/") and route[7:] in self.server.preview_ids:
            return super().do_GET()
        return self.reply({"error": "预览内容不存在"}, 404)

    def do_POST(self):
        return self.reply({"error": "局域网预览仅支持浏览"}, 405)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="This computer's LAN IPv4 address")
    parser.add_argument("--port", type=int, default=8769)
    args = parser.parse_args()
    address = ipaddress.IPv4Address(args.host)
    if not address.is_private or address.is_unspecified or address.is_multicast:
        parser.error("请指定本机的局域网 IPv4 地址")
    lab = Lab(*paths())
    feed = get_feed(lab)
    if not feed:
        parser.error("请先生成回忆精选")
    albums = [a for a in feed["albums"] if not feed["feedback"].get(a["id"], {}).get("hidden")]
    ids = {pid for a in albums for pid in a["photo_ids"]}
    fields = ("id", "title", "label", "year", "photo_ids", "cover", "subtitle")
    preview = {"albums": [{k: a[k] for k in fields} for a in albums],
               "photos": [{"id": p["id"], "image": p["image"]} for p in feed["photos"] if p["id"] in ids],
               "featured_ids": feed["featured_ids"], "feedback": {}}
    server = LabServer((args.host, args.port), lab)
    server.RequestHandlerClass = PreviewHandler
    server.preview_host = f"{args.host}:{args.port}"
    server.preview_feed, server.preview_ids = preview, ids
    print(f"http://{server.preview_host}/recollections · {len(albums)} 段回忆", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

"""Loopback-only Expo web preview with live wall fixtures proxied from the lab."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

ROOT=Path(__file__).resolve().parents[1]
EXPORT=ROOT/'outputs/wall-app-integration/web'
SHELL='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App · 整墙展示预览</title><style>body{margin:0;background:#e9ece5;font-family:system-ui;color:#52634b;display:flex;justify-content:center;align-items:center;height:100vh;overflow:hidden}.phone{width:414px;height:844px;flex-shrink:0;border:7px solid #273028;border-radius:35px;overflow:hidden;background:white;box-shadow:0 15px 55px #39433225}iframe{width:100%;height:100%;border:0}aside{width:220px;margin-right:50px;line-height:1.8}h1{font-size:22px;margin-bottom:10px}p{font-size:13px;color:#7a8575}a{color:inherit}@media(max-width:760px){aside{display:none}.phone{border:0;border-radius:0;width:100vw;height:100vh;max-height:none}}</style><aside><h1>照片墙 App</h1><p>当前展示 · 首次整墙预览<br>换一组 · 多留一会儿</p><p>真实 App 组件的网页预览。<br>设备操作为本地模拟。</p><a href="/?preview=wall">展开查看 App</a></aside><div class="phone"><iframe title="照片墙 App 预览" src="/?preview=wall"></iframe></div><script>function fit(){document.querySelector('.phone').style.transform=innerWidth>760?'scale('+Math.min(1,(innerHeight-36)/858)+')':'none'}addEventListener('resize',fit);fit()</script></html>'''
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(EXPORT),**kwargs)
    def log_message(self,*args):pass
    def do_GET(self):
        if self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:
            self.send_error(403);return
        if self.path=='/preview':
            body=SHELL.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(body);return
        if self.path=='/api/wall-demo' or (self.path.startswith('/wall-demo-image/') and self.path.removeprefix('/wall-demo-image/').isalnum()):
            try:
                with urlopen('http://127.0.0.1:8766'+self.path,timeout=15) as response:
                    body=response.read();self.send_response(200);self.send_header('Content-Type',response.headers.get('Content-Type'));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
            except (HTTPError,URLError):self.send_error(503,'Local wall preview unavailable')
            return
        super().do_GET()
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8771);args=p.parse_args()
    print(f'App preview: http://127.0.0.1:{args.port}/preview',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()

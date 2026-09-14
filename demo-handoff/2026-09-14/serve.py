from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import json, argparse
ROOT=Path(__file__).resolve().parent
FOLDER={1:'D01-current-display-v0.3',2:'D02-quiet-home-v0.2',3:'D03-onboarding-v2.2'}
p=argparse.ArgumentParser();p.add_argument('--demo',type=int,choices=[1,2,3],required=True);p.add_argument('--port',type=int);args=p.parse_args()
folder=ROOT/FOLDER[args.demo];port=args.port or 8780+args.demo
fixture=json.loads((folder/'fixture.json').read_text()) if args.demo==3 else None
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(folder),**kw)
 def reply(self,value,mime='application/json',code=200):
  body=value if isinstance(value,bytes) else json.dumps(value,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
 def do_GET(self):
  route=urlsplit(self.path).path
  if args.demo==3:
   if route=='/api/fixture':return self.reply(fixture)
   if route=='/sample-wall' or route.startswith('/wall/'):return self.reply((folder/'sample.svg').read_bytes(),'image/svg+xml')
   if route.startswith('/person/p'):
    try:i=int(route.removeprefix('/person/p'));assert 0<=i<6
    except (ValueError,AssertionError):return self.send_error(404)
    return self.reply(f'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="80" fill="#d9dfc9"/><circle cx="80" cy="60" r="28" fill="#f9f5e9"/><ellipse cx="80" cy="145" rx="53" ry="50" fill="#f9f5e9"/><text x="80" y="145" text-anchor="middle" fill="#536348">DEMO {i+1}</text></svg>'.encode(),'image/svg+xml')
   if route in ['/','/index.html','/onboarding.html']:
    html=(folder/'index.html').read_text().replace('本地精选照片组成的完整照片墙样本','演示照片墙').replace('已保存的照片墙样本','演示照片墙样张').replace('</body>','<p style="position:fixed;bottom:0;left:0;right:0;text-align:center;background:#f5eedc;font:12px sans-serif;padding:8px;margin:0">迁移预览 · 示意素材与占位人物 · 无私人照片或真实识别数据</p></body>');return self.reply(html.encode(),'text/html; charset=utf-8')
  return super().do_GET()
 def do_POST(self):
  if args.demo!=3 or self.path!='/api/walls':return self.send_error(404)
  if self.headers.get('Origin') not in [f'http://127.0.0.1:{port}',f'http://localhost:{port}']:return self.send_error(403)
  try:
   n=int(self.headers.get('Content-Length','0'));assert 0<n<=8192
   d=json.loads(self.rfile.read(n));assert d.get('scope')==fixture['scope'];v=d.get('variant',0);assert type(v)==int and 0<=v<=10000
   themes=d.get('theme_ids',[]);assert isinstance(themes,list) and all(t in [x['id'] for x in fixture['themes']] for t in themes)
   people=d.get('person_ids',[]);assert isinstance(people,list) and all(t in [x['id'] for x in fixture['people']] for t in people)
   assert d.get('mode') in ['all','include'] and (d['mode']=='all' or people)
  except (ValueError,AssertionError,TypeError,KeyError):return self.reply({'error':'演示请求无效'},code=400)
  return self.reply(dict(status='ready',scope=fixture['scope'],id=f'sample-{v}',image='/sample-wall',title='演示照片墙',photo_ids=fixture['photo_ids'][:8],visible_count=16,theme_ids=themes,variant_count=2,demo=True))
print(f'D0{args.demo}: http://127.0.0.1:{port}/',flush=True)
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()

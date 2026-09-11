"""An isolated, loopback-only onboarding demonstration. No upload or device APIs."""
import argparse
import hashlib
import io
import json
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'demos/onboarding'
sys.path.insert(0, str(ROOT))


class Fixture:
    """Read saved evidence; layout existing selected IDs without any new inference."""
    def __init__(self):
        from selection_lab.core import Lab
        from selection_lab.recollection_v2 import get_feed
        from selection_lab.display_preferences import first_layer_ids
        from tools.onboarding_preferences import VERSION, library_people, theme_options
        pointer_path = ROOT / 'outputs/selection-lab/active-dataset.json'
        pointer = json.loads(pointer_path.read_text())
        self.lab = Lab(Path(pointer['cache_dir']), Path(pointer['state_dir']))
        self.result = get_feed(self.lab)
        if not self.result:
            raise ValueError('缺少已保存的精选快照；本 Demo 不会自动运行选片')
        self.ids = first_layer_ids(self.result)
        if not self.ids or not set(self.ids) <= self.lab.assets.keys():
            raise ValueError('精选照片与本地原图不匹配')
        folder = self.lab.state_dir / 'recollections-preferences'
        watch = [pointer_path, folder / 'latest.json', folder / (self.result['id'] + '.json'),
                 folder / 'person-confirmations.json', folder / 'feedback.json',
                 self.lab.cache_dir / 'current-cache.json']
        self.stamps = {p: p.read_bytes() if p.exists() else None for p in watch}
        self.library_ids = [p['id'] for p in self.lab.features]
        if {p['id'] for p in self.result['photos']} != set(self.library_ids):
            raise ValueError('已保存人物索引不属于当前完整图库')
        self.preference_version = VERSION
        self.scope = hashlib.sha256(json.dumps([VERSION, self.lab.dataset_id, self.result['id'],
            self.result['identity_revision'], self.result.get('person_confirmation_revision'), self.ids]).encode()).hexdigest()
        self.people = library_people(self.result, self.library_ids, self.ids)
        self.themes = theme_options(self.result, self.ids)
        self.allowed_people = {g['id'] for g in self.people}
        self.images = OrderedDict()
        self.lock = threading.Lock()
        # Reuse only a saved sample that belongs to the same snapshot and first layer.
        folder = self.lab.state_dir / 'wall-interaction-demo-v1'
        manifest = json.loads((folder / 'manifest.json').read_text())
        sample = manifest['walls'][0]
        if manifest['snapshot_id'] != self.result['id'] or not set(sample['photo_ids']) <= set(self.ids):
            raise ValueError('已有整墙样本不属于当前精选快照')
        self.sample = (folder / (sample['id'] + '.jpg')).read_bytes()

    def check_current(self):
        for path, previous in self.stamps.items():
            if (path.read_bytes() if path.exists() else None) != previous:
                raise ValueError('精选或人物版本已变化，请重新启动演示并确认展示范围')
        self.lab.ensure_sources_current()

    def public(self):
        self.check_current()
        return {'demo': True, 'scope': self.scope, 'snapshot_id': self.result['id'],
                'dataset_id': self.lab.dataset_id, 'identity_revision': self.result['identity_revision'],
                'person_confirmation_revision': self.result.get('person_confirmation_revision'),
                'first_layer_count': len(self.ids), 'album_count': len(self.result['albums']),
                'library_count': len(self.library_ids), 'people_source': 'full-library-recognition',
                'preference_version': self.preference_version, 'themes': self.themes,
                'people': [{k: v for k, v in p.items() if k != 'portrait'} for p in self.people],
                'photo_ids': self.ids, 'photos_per_wall': 8,
                'note': '已保存的本地精选结果；没有在本次演示中重新扫描、推理或选片。'}

    def photo(self, pid, portrait=None):
        from PIL import Image, ImageOps
        if portrait:
            # Only exact indexed avatar crops may access non-selected library images.
            if not any(p['portrait'] == portrait and portrait['asset_id'] == pid for p in self.people):
                raise ValueError('只能读取当前人物索引中的头像')
        elif pid not in self.ids:
            raise ValueError('只能预览第一层已入选照片')
        self.check_current()
        with Image.open(self.lab.assets[pid]['path']) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            if portrait:
                box = portrait['box']
                w, h = image.size
                x0, y0, x1, y1 = box[0]*w, box[1]*h, box[2]*w, box[3]*h
                side = max(x1-x0, y1-y0)*1.5
                cx, cy = (x0+x1)/2, (y0+y1)/2
                image = image.crop((max(0, cx-side/2), max(0, cy-side/2), min(w, cx+side/2), min(h, cy+side/2)))
                image = ImageOps.fit(image, (180, 180))
            else:
                image.thumbnail((800, 800))
            buffer = io.BytesIO()
            image.save(buffer, 'JPEG', quality=85)
            return buffer.getvalue()

    def wall(self, data):
        from tools.onboarding_preferences import prioritize_themes
        from backend.template_packages import render, required_photo_count
        self.check_current()
        if data.get('scope') != self.scope:
            raise ValueError('数据版本已变化，请重新确认展示范围')
        mode, people, variant = data.get('mode'), data.get('person_ids'), data.get('variant', 0)
        theme_ids = data.get('theme_ids', [])
        if (mode not in {'all', 'include'} or not isinstance(people, list)
                or len(people) > len(self.people) or any(not isinstance(p, str) for p in people)
                or not set(people) <= self.allowed_people or type(variant) is not int or not 0 <= variant <= 10000):
            raise ValueError('展示范围无效；没有放宽范围')
        if (not isinstance(theme_ids, list) or len(theme_ids) > len(self.themes)
                or any(not isinstance(t, str) for t in theme_ids)
                or not set(theme_ids) <= {t['id'] for t in self.themes}):
            raise ValueError('主题偏好无效')
        theme_ids = sorted(set(theme_ids))
        matched = {pid for p in self.people if p['id'] in people for pid in p['photo_ids']}
        ids = list(self.ids) if mode == 'all' else [pid for pid in self.ids if pid in matched]
        ids = prioritize_themes(ids, self.themes, theme_ids)
        template = 'template_1'
        count = required_photo_count(template)
        if len(ids) < count:
            return {'status': 'insufficient', 'scope': self.scope, 'visible_count': len(ids),
                    'required_count': count, 'photo_ids': [], 'message': '当前范围不足以填满这个模板；未补入其他照片。'}
        offsets = list(dict.fromkeys([*range(0, len(ids)-count+1, count), len(ids)-count]))
        offset = offsets[variant % len(offsets)]
        template = ['template_1', 'template_2'][(variant // len(offsets)) % 2]
        members = ids[offset:offset+count]
        key = hashlib.sha256(json.dumps([self.scope, template, members]).encode()).hexdigest()[:24]
        with self.lock:
            if key not in self.images:
                image = render(template, [self.lab.assets[pid]['path'] for pid in members],
                               {'nickname': 'My', 'line1': '', 'line2': '', 'line3': '', 'tag': ''})
                image.thumbnail((750, 1000))
                buffer = io.BytesIO()
                image.save(buffer, 'JPEG', quality=88)
                self.images[key] = buffer.getvalue()
                while len(self.images) > 20:
                    self.images.popitem(last=False)
            else:
                self.images.move_to_end(key)
        return {'status': 'ready', 'scope': self.scope, 'id': key, 'image': '/wall/' + key,
                'title': '日常拼贴' if template == 'template_1' else '生活剪贴',
                'template_id': template, 'photo_ids': members, 'visible_count': len(ids),
                'variant_count': len(offsets)*2, 'theme_ids': theme_ids, 'demo': True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if (self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            self.send_error(403)
            return
        route = urlsplit(self.path).path
        allowed = {'/': ('index.html', 'text/html; charset=utf-8'),
                   '/onboarding.css': ('onboarding.css', 'text/css'),
                   '/onboarding-flow.css': ('onboarding-flow.css', 'text/css'),
                   '/onboarding.js': ('onboarding.js', 'application/javascript'),
                   '/v2.css': ('v2.css', 'text/css'),
                   '/v2.js': ('v2.js', 'application/javascript'),
                   '/v2-state.js': ('v2-state.js', 'application/javascript'),
                   '/onboarding-state.js': ('onboarding-state.js', 'application/javascript')}
        if route in allowed:
            name, mime = allowed[route]
            body = (STATIC / name).read_bytes()
        else:
            try:
                fixture = self.server.fixture
                fixture.check_current()
                mime = 'image/jpeg'
                if route == '/sample-wall':
                    body = fixture.sample
                elif route == '/api/fixture':
                    body = json.dumps(fixture.public(), ensure_ascii=False).encode()
                    mime = 'application/json; charset=utf-8'
                elif route.startswith('/person/') and route[8:] in fixture.allowed_people:
                    person = next(p for p in fixture.people if p['id'] == route[8:])
                    body = fixture.photo(person['portrait']['asset_id'], person['portrait'])
                elif route.startswith('/photo/') and route[7:] in fixture.ids:
                    body = fixture.photo(route[7:])
                elif route.startswith('/wall/') and route[6:] in fixture.images:
                    body = fixture.images[route[6:]]
                else:
                    self.send_error(404)
                    return
            except (ValueError, OSError) as error:
                self.reply(json.dumps({'error': str(error)}, ensure_ascii=False).encode(), 'application/json', 409)
                return
        self.reply(body, mime)

    def do_POST(self):
        expected = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
        if ('http://' + self.headers.get('Host', '')) not in expected or self.headers.get('Origin') not in expected:
            self.send_error(403)
            return
        if self.path != '/api/walls':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                raise ValueError('请求大小无效')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('请求格式无效')
            value = self.server.fixture.wall(data)
            self.reply(json.dumps(value, ensure_ascii=False).encode(), 'application/json; charset=utf-8')
        except (ValueError, OSError) as error:
            self.reply(json.dumps({'error': str(error)}, ensure_ascii=False).encode(), 'application/json', 409)

    def reply(self, body, mime, status=200):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8772)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.fixture = Fixture()
    print(f'Onboarding Demo: http://127.0.0.1:{args.port}/', flush=True)
    server.serve_forever()

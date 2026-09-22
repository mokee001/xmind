"""Read-only HTTP and fixture validation for the isolated Demo; no browser QA."""
import json
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from tools.preview_onboarding import Handler, Fixture


class DemoHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = Fixture()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.fixture = cls.fixture
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, data=None, **headers):
        if data is not None:
            data=json.dumps(data).encode()
            headers={'Origin': self.url, 'Content-Type': 'application/json', **headers}
        return urlopen(Request(self.url+path, data=data, headers=headers), timeout=30)

    def test_static_routes(self):
        for route in ['/', '/onboarding.css', '/onboarding-flow.css', '/onboarding.js', '/onboarding-state.js', '/sample-wall', '/v2.js', '/v2-state.js', '/v2.css']:
            with self.request(route) as r:
                self.assertEqual(r.status, 200)
                self.assertTrue(r.read())
                self.assertEqual(r.headers['Cross-Origin-Resource-Policy'], 'same-origin')

    def test_people_from_whole_library_but_display_matches_stay_first_layer(self):
        from selection_lab.display_preferences import effective_people
        f=self.fixture
        self.assertEqual({p['id'] for p in f.people}, {g['id'] for g in effective_people(f.result)[0]})
        self.assertTrue(any(p['selected_photo_count']==0 for p in f.people))
        self.assertTrue(all(set(p['photo_ids'])<=set(f.ids) for p in f.people))
        self.assertEqual([p['library_photo_count'] for p in f.people], sorted([p['library_photo_count'] for p in f.people], reverse=True))
        for p in f.people[:6]:
            self.assertIn(p['portrait']['asset_id'], f.library_ids)
            with self.request(p['image']) as r:
                self.assertEqual(r.headers['Content-Type'], 'image/jpeg')
                self.assertTrue(r.read().startswith(b'\xff\xd8'))
        self.assertEqual(f.public()['library_count'], len(f.lab.features))
        self.assertEqual(f.public()['people_source'], 'full-library-recognition')

    def test_non_selected_people_portrait_only_not_full_photo(self):
        f=self.fixture
        person=next(p for p in f.people if not p['selected_photo_count'])
        pid=person['portrait']['asset_id']
        with self.request(person['image']) as r:
            self.assertEqual(r.status,200)
        with self.assertRaises(HTTPError) as ctx:self.request('/photo/'+pid)
        self.assertEqual(ctx.exception.code,404)
        with self.assertRaises(ValueError):f.photo(pid)
        with self.assertRaises(ValueError):f.photo(pid, {'asset_id':pid,'box':[0,0,1,1]})
        with self.request('/api/walls', {'scope':f.scope,'mode':'include','person_ids':[person['id']]}) as r:
            result=json.load(r)
        self.assertEqual(result['status'],'insufficient')
        self.assertEqual(result['photo_ids'],[])
        self.assertEqual(result['visible_count'],0)

    def test_themes_prioritize_without_expanding_display_scope(self):
        f=self.fixture
        topic=next(t for t in f.themes if t['id']=='topic-pets')
        before={p:p.read_bytes() if p.exists() else None for p in f.stamps}
        request={'scope':f.scope,'mode':'all','person_ids':[], 'variant':0}
        normal=f.wall(request)
        preferred=f.wall({**request,'theme_ids':[topic['id']]})
        self.assertEqual(preferred['theme_ids'],[topic['id']])
        self.assertEqual(preferred['visible_count'],normal['visible_count'])
        self.assertTrue(set(preferred['photo_ids'])<=set(topic['photo_ids']))
        self.assertNotEqual(normal['photo_ids'],preferred['photo_ids'])
        person=next(p for p in f.people if len(p['photo_ids'])>=8)
        scoped=f.wall({**request,'mode':'include','person_ids':[person['id']],'theme_ids':[topic['id']]})
        self.assertTrue(set(scoped['photo_ids'])<=set(person['photo_ids']))
        self.assertEqual(before,{p:p.read_bytes() if p.exists() else None for p in f.stamps})

    def test_invalid_themes_are_rejected(self):
        for ids in [['foreign'], 'topic-pets', [None]]:
            with self.assertRaises(HTTPError) as ctx:
                self.request('/api/walls',{'scope':self.fixture.scope,'mode':'all','person_ids':[],'theme_ids':ids})
            self.assertEqual(ctx.exception.code,409)

    def test_scoped_wall_render_and_no_writes(self):
        f=self.fixture
        person=next(p for p in f.people if len(p['photo_ids'])>=8)
        before={p:p.read_bytes() if p.exists() else None for p in f.stamps}
        with self.request('/api/walls', {'scope':f.scope, 'mode':'include', 'person_ids':[person['id']], 'variant':0}) as response:
            wall=json.load(response)
        self.assertEqual(wall['status'], 'ready')
        self.assertEqual(len(set(wall['photo_ids'])),8)
        self.assertTrue(set(wall['photo_ids'])<=set(person['photo_ids']))
        with self.request(wall['image']) as r:
            self.assertTrue(r.read().startswith(b'\xff\xd8'))
        self.assertEqual(before,{p:p.read_bytes() if p.exists() else None for p in f.stamps})

    def test_insufficient_never_backfills(self):
        f=self.fixture
        result=f.wall({'scope':f.scope,'mode':'include','person_ids':[], 'variant':0})
        self.assertEqual(result['status'],'insufficient')
        self.assertEqual(result['visible_count'],0)
        self.assertEqual(result['photo_ids'],[])

    def test_all_and_next_remain_selected_and_change_members(self):
        f=self.fixture
        walls=[f.wall({'scope':f.scope, 'mode':'all', 'person_ids':[], 'variant':v}) for v in [0,1]]
        self.assertTrue(all(set(w['photo_ids'])<=set(f.ids) for w in walls))
        self.assertNotEqual(walls[0]['photo_ids'],walls[1]['photo_ids'])

    def test_foreign_person_and_revision_rejected(self):
        for data in [{'scope':'foreign','mode':'all','person_ids':[]}, {'scope':self.fixture.scope,'mode':'include','person_ids':['foreign']}]:
            with self.assertRaises(HTTPError) as ctx:self.request('/api/walls',data)
            self.assertEqual(ctx.exception.code,409)

    def test_origin_and_file_allowlist(self):
        for path,headers in [('/api/fixture',{'Host':'attacker.test'}),('/sample-wall',{'Sec-Fetch-Site':'cross-site'}),('/../../AGENTS.md',{})]:
            with self.assertRaises(HTTPError) as ctx:self.request(path,**headers)
            self.assertIn(ctx.exception.code,[403,404])
        with self.assertRaises(HTTPError) as ctx:self.request('/api/walls',{},Origin='https://attacker.test')
        self.assertEqual(ctx.exception.code,403)

    def test_no_device_or_preference_write_api(self):
        for path in ['/api/publish','/api/display-preferences','/api/upload']:
            with self.assertRaises(HTTPError) as ctx:self.request(path,{})
            self.assertEqual(ctx.exception.code,404)

    def test_snapshot_changed_fails_closed(self):
        key=next(iter(self.fixture.stamps))
        with patch.dict(self.fixture.stamps,{key:b'foreign'}):
            with self.assertRaises(ValueError):self.fixture.public()


if __name__=='__main__':unittest.main()

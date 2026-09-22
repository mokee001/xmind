"""Contract tests with isolated synthetic metadata, not inference accuracy tests."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from backend.routers.selection import register


class SelectionApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        runtime = self.root/'runtime'
        (runtime/'selection_lab').mkdir(parents=True)
        (runtime/'selection_lab/recollection_feed.py').touch()
        (runtime/'production-ready.json').write_text('{}')
        self.env = patch.dict(os.environ,{'PHOTOWALL_SELECTION_DIR':str(self.root/'accounts'),
                                        'PHOTOWALL_RECOLLECTION_ROOT':str(runtime)})
        self.env.start()
        self.app=FastAPI()
        register(self.app,lambda token:hashlib.sha256(token.encode()).hexdigest()[:24],lambda token:token=='test-owner')

    def tearDown(self):
        self.env.stop(); self.temp.cleanup()

    def request(self,method,path,**kwargs):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test') as client:
                return await client.request(method,path,**kwargs)
        return asyncio.run(run())

    def test_session_requires_real_binding(self):
        self.assertEqual(self.request('POST','/api/selection/session',json={}).status_code,401)
        self.assertEqual(self.request('POST','/api/selection/session',json={},headers={'X-Account-Token':'unknown'}).status_code,403)

    def test_source_scopes_stay_separate(self):
        headers={'X-Account-Token':'test-owner'}
        with patch('backend.unified_selection.enqueue'):
            a=self.request('POST','/api/selection/session',json={'sources':['all']},headers=headers).json()
            b=self.request('POST','/api/selection/session',json={'sources':['private']},headers=headers).json()
        self.assertNotEqual(a['scope'],b['scope'])

    def test_unverified_runtime_is_not_advertised(self):
        (self.root/'runtime/production-ready.json').unlink()
        self.assertFalse(self.request('GET','/api/selection/capabilities').json()['ready'])
        r=self.request('POST','/api/selection/session',json={},headers={'X-Account-Token':'test-owner'})
        self.assertEqual(r.status_code,503)

    def test_fake_or_missing_observations_do_not_ingest(self):
        with patch('backend.unified_selection.ingest') as ingest:
            r=self.request('POST','/api/selection/upload',headers={'X-Account-Token':'test-owner'},
                files={'files':('test.jpg',b'not-an-image','image/jpeg')},
                data={'metadata':json.dumps([{'local_engine':'mock','vision':{}}])})
        self.assertEqual(r.status_code,422)
        ingest.assert_not_called()

    def test_thumbnail_requires_same_account(self):
        r=self.request('GET','/api/selection/thumb/another-account/'+'a'*64,headers={'X-Account-Token':'test-owner'})
        self.assertEqual(r.status_code,403)

    def test_corrupt_photo_is_rejected_before_ingest(self):
        observation={'version':1,'labels':[{'identifier':'nature','confidence':0.9}], 'faces':0}
        with patch('backend.unified_selection.ingest') as ingest:
            r=self.request('POST','/api/selection/upload',headers={'X-Account-Token':'test-owner'},
                files={'files':('bad.jpg',b'not-an-image','image/jpeg')},
                data={'metadata':json.dumps([{'local_engine':'apple-vision-local-v1','vision':observation}])})
        self.assertEqual(r.status_code,422)
        ingest.assert_not_called()


if __name__=='__main__':unittest.main()

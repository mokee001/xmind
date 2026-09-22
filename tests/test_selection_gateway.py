"""Exercise real template rendering and rollout contract without live devices.

Candidate metadata is a test fixture, not evidence of model accuracy.
"""
import asyncio
import hashlib
import importlib
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import httpx
from PIL import Image
from backend import template_packages, unified_selection as selection


class GatewayTests(unittest.TestCase):
    def test_generate_uses_only_snapshot_and_does_not_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'runtime/selection_lab').mkdir(parents=True)
            (root/'runtime/selection_lab/recollection_feed.py').touch()
            (root/'runtime/production-ready.json').write_text('{}')
            stored={}
            server=types.ModuleType('backend.server')
            server._account_scope=lambda token:'a'
            server._account_auth=lambda device,token:token=='owner'
            server._devices=lambda:{'test-device':{}}
            # Empty dict is intentionally not a valid device record.
            server._devices=lambda:{'test-device':{'id':'test-device'}}
            server._scoped_store_name=lambda name,scope:name+'_'+scope
            server.store=types.SimpleNamespace(load=lambda key,default:stored.get(key,default),save=lambda key,value:stored.update({key:value}))
            server.template_packages=template_packages
            server.OUTPUT_DIR=str(root)
            with patch.dict(os.environ,{'PHOTOWALL_SELECTION_DIR':str(root/'accounts'),'PHOTOWALL_RECOLLECTION_ROOT':str(root/'runtime')}), patch.dict(sys.modules,{'backend.server':server}):
                import backend
                with patch.object(backend,'server',server,create=True):
                    sys.modules.pop('backend.selection_gateway',None)
                    gateway=importlib.import_module('backend.selection_gateway')
                scope=selection.library_scope('a',['all'])
                photos=[]
                for i in range(16):
                    path=selection.directory(scope)/f'{i}.png'
                    Image.new('RGB',(600,800),(20+i*10,80,120)).save(path)
                    photos.append({'id':str(i),'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                                   'filename':path.name,'quality':.8,'tags':[]})
                library={'scope':scope,'revision':'a'*64,'photos':{p['sha256']:p for p in photos}}
                selection.atomic(selection.directory(scope)/'library.json',library)
                selection.publish(scope,{'scope':scope,'input_revision':'a'*64,'baseline_commit':selection.BASELINE,
                    'engine':'recollection-feed-v1','albums':[{'id':'album','photo_ids':[p['id'] for p in photos]}],'photos':photos},library)
                async def exercise():
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app),base_url='http://test') as client:
                        body={'selection_contract':selection.CONTRACT,'device_id':'test-device'}
                        denied=await client.post('/api/generate',json=body,headers={'X-Account-Token':'wrong'})
                        self.assertEqual(denied.status_code,403)
                        response=await client.post('/api/generate',json=body,headers={'X-Account-Token':'owner'})
                        self.assertEqual(response.status_code,200,response.text)
                        result=response.json()
                        self.assertEqual(result['selection_provenance']['phase'],'canonical')
                        self.assertEqual(len(result['chosen']),8)
                        self.assertTrue((root/Path(result['image_url']).name).is_file())
                        self.assertEqual(set(stored),{'last_wall_a','recent_shown_a'})
                asyncio.run(exercise())
                sys.modules.pop('backend.selection_gateway',None)


if __name__=='__main__':unittest.main()

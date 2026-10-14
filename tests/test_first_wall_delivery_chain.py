"""Real API/render/frame/history integration using generated fixtures, no live screen.

The model output and hardware acknowledgement are explicit test inputs. This
verifies delivery plumbing, not recognition accuracy or a physical refresh.
"""
import asyncio
import hashlib
import importlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx
from PIL import Image
from backend import server, store, unified_selection as selection


class FirstWallDeliveryChainTests(unittest.TestCase):
    def test_wait_generate_download_ack_then_calendar(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root/'runtime'
            (runtime/'selection_lab').mkdir(parents=True)
            (runtime/'selection_lab/recollection_feed.py').touch()
            (runtime/'production-ready.json').write_text('{}')
            output = root/'output'
            output.mkdir()
            (root/'store').mkdir()
            device_id, owner, device_token = 'fixture-first-wall', 'fixture-owner', 'fixture-device-token'
            with (
                patch.dict(os.environ, {'PHOTOWALL_SELECTION_DIR':str(root/'selection'),
                                       'PHOTOWALL_RECOLLECTION_ROOT':str(runtime)}),
                patch.object(store, '_BASE', str(root/'store')),
                patch.object(server, 'OUTPUT_DIR', str(output)),
                patch.object(server, 'DEVICE_FRAMES_DIR', str(root/'frames')),
            ):
                gateway = importlib.reload(importlib.import_module('backend.selection_gateway'))
                gateway._generation_lock = None
                store.save('eink_devices', {device_id:{'device_id':device_id, 'account_token':owner,
                    'device_token':device_token, 'claimed':True, 'created_at':123,
                    'device_family':'esp32_e6', 'last_seen':time.time(), 'state':'online',
                    'revision':'', 'displayed_revision':''}})
                scope = selection.library_scope(server._account_scope(owner), ['all'])
                folder = selection.directory(scope)
                photos = []
                for index in range(16):
                    path = folder/f'{index}.png'
                    Image.new('RGB', (600,800), (30+index*11,90,140)).save(path)
                    photos.append({'id':str(index), 'path':str(path), 'filename':path.name,
                        'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'quality':.8, 'tags':[]})
                entries = {p['sha256']:p for p in photos}
                revision = hashlib.sha256(json.dumps(entries,sort_keys=True).encode()).hexdigest()
                library = {'scope':scope, 'revision':revision, 'photos':entries}
                selection.atomic(folder/'library.json', library)
                job = folder/'jobs'/revision
                selection.atomic(job/'input.json', library)
                selection.atomic(job/'provisional.json', {'scope':scope, 'input_revision':revision,
                    'baseline_commit':selection.BASELINE, 'engine':'strong-rules-provisional-v1',
                    'albums':[], 'photos':photos})
                selection.atomic(folder/'provisional-current.json', {'scope':scope,'revision':revision})
                selection.atomic(folder/'status.json', {'state':'running','phase':'canonical','revision':revision})

                async def exercise():
                    async with (
                        httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway.app),base_url='http://test') as select_api,
                        httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),base_url='http://test') as device_api,
                    ):
                        headers = {'X-Account-Token':owner}
                        body = {'selection_contract':selection.CONTRACT,'device_id':device_id,
                                'template':'auto','title':'Fixture first memory','filters':['person_fixture']}
                        for _ in range(30):
                            waiting = await select_api.post('/api/selection/readiness',json=body,headers=headers)
                            self.assertEqual(waiting.status_code,200)
                            self.assertEqual(waiting.json()['action'],'wait')
                        self.assertEqual(store.load('eink_devices',{})[device_id]['revision'],'')
                        # A successful model snapshot for exactly this input, not a fabricated live result.
                        selection.publish(scope, {'scope':scope,'input_revision':revision,
                            'baseline_commit':selection.BASELINE,'engine':'recollection-feed-v1',
                            'albums':[{'id':'fixture-album','photo_ids':[p['id'] for p in photos]}],
                            'photos':[{**p,'tags':['person_fixture']} for p in photos]}, library)
                        selection.atomic(folder/'status.json', {'state':'ready','phase':'canonical',
                            'revision':revision,'completed_revision':revision})
                        ready = await select_api.post('/api/selection/readiness',json=body,headers=headers)
                        self.assertTrue(ready.json()['ready'])
                        generated = await select_api.post('/api/generate',json=body,headers=headers)
                        self.assertEqual(generated.status_code,200,generated.text)
                        wall = generated.json()
                        self.assertEqual(len(wall['chosen']),8)
                        published = await device_api.post(f'/api/devices/{device_id}/publish-last-wall',
                            json={'wall_id':wall['wall_id']},headers=headers)
                        self.assertEqual(published.status_code,200,published.text)
                        target = published.json()['revision']
                        history = f'/api/devices/{device_id}/display-history'
                        self.assertEqual((await device_api.get(history,headers=headers)).json()['records'],[])
                        command = await device_api.get(f'/api/devices/{device_id}/next',params={'token':device_token})
                        self.assertEqual(command.json()['revision'],target)
                        frame = await device_api.get(command.json()['frame_url'])
                        self.assertEqual(frame.status_code,200)
                        self.assertTrue(frame.content.startswith(b'PWE6'))
                        self.assertEqual(len(frame.content),server.eink_push.FRAME_HEADER.size+1200*1600//2)
                        for state,ack_revision,expected in [('refreshing',target,0),('displayed','stale',0),
                                                           ('displayed',target,1),('displayed',target,1)]:
                            ack = await device_api.post(f'/api/devices/{device_id}/status',params={'token':device_token},
                                json={'state':state,'revision':ack_revision})
                            self.assertEqual(ack.status_code,200)
                            records = (await device_api.get(history,headers=headers)).json()['records']
                            self.assertEqual(len(records),expected)
                        self.assertEqual(records[0]['title'],'Fixture first memory')
                        self.assertEqual(records[0]['revision'],target)
                        self.assertTrue(records[0]['confirmedAt'])
                asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()

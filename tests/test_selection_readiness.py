"""First-wall readiness uses real selection restrictions, never a photo count."""
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
from backend import template_packages, unified_selection as selection


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        runtime = self.root/'runtime'
        (runtime/'selection_lab').mkdir(parents=True)
        (runtime/'selection_lab/recollection_feed.py').touch()
        (runtime/'production-ready.json').write_text('{}')
        env = patch.dict(os.environ, {
            'PHOTOWALL_SELECTION_DIR': str(self.root/'accounts'),
            'PHOTOWALL_RECOLLECTION_ROOT': str(runtime),
        })
        env.start(); self.addCleanup(env.stop)
        self.stored = {}
        self.server = types.ModuleType('backend.server')
        self.server._account_scope = lambda token: 'owner-scope'
        self.server._account_auth = lambda device, token: token in ('owner', 'viewer')
        self.server._device_publish_auth = lambda device, token: token == 'owner'
        self.server._devices = lambda: {'test-device': {'device_id': 'test-device'}}
        self.server._scoped_store_name = lambda name, scope: name+'_'+scope
        self.server.store = types.SimpleNamespace(
            load=lambda key, default: self.stored.get(key, default),
            save=lambda key, value: self.stored.update({key: value}))
        self.server.template_packages = template_packages
        self.server.OUTPUT_DIR = str(self.root/'output')
        import backend
        with patch.dict(sys.modules, {'backend.server': self.server}), patch.object(backend, 'server', self.server, create=True):
            sys.modules.pop('backend.selection_gateway', None)
            self.gateway = importlib.import_module('backend.selection_gateway')
        self.addCleanup(lambda: sys.modules.pop('backend.selection_gateway', None))
        self.scope = selection.library_scope('owner-scope', ['all'])
        folder = selection.directory(self.scope)
        photos = []
        for index in range(16):
            path = folder/f'{index}.jpg'
            path.write_bytes(f'synthetic-not-a-photo-{index}'.encode())
            photos.append({'id': str(index), 'path': str(path), 'filename': path.name,
                           'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'quality': .8, 'tags': ['person_a' if index < 6 else 'person_b']})
        self.library = {'scope': self.scope, 'revision': 'a'*64,
                        'photos': {p['sha256']: p for p in photos}}
        selection.atomic(folder/'library.json', self.library)
        selection.publish(self.scope, {
            'scope': self.scope, 'input_revision': 'a'*64,
            'baseline_commit': selection.BASELINE, 'engine': 'recollection-feed-v1',
            'albums': [{'id': 'album', 'photo_ids': [p['id'] for p in photos]}],
            'photos': photos,
        }, self.library)
        self.body = {'selection_contract': selection.CONTRACT, 'device_id': 'test-device'}

    def request(self, *, body=None, token='owner', path='/api/selection/readiness'):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.gateway.app), base_url='http://test') as client:
                return await client.post(path, json=body or self.body, headers={'X-Account-Token': token})
        return asyncio.run(call())

    def test_ready_does_not_render_write_history_or_publish(self):
        with patch.object(template_packages, 'render') as render:
            result = self.request()
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()['ready'])
        self.assertEqual(result.json()['input_revision'], 'a'*64)
        self.assertEqual(result.json()['contract'], selection.CONTRACT)
        self.assertNotIn('photos', result.json())
        render.assert_not_called()
        self.assertEqual(self.stored, {})
        self.assertFalse((self.root/'output').exists())

    def test_raw_count_is_not_enough_for_selected_person(self):
        result = self.request(body={**self.body, 'filters': ['person_a']}).json()
        self.assertFalse(result['ready'])
        self.assertTrue(result['retryable'])
        self.assertTrue(self.request(body={**self.body, 'filters': ['person_b']}).json()['ready'])

    def test_excluded_people_are_not_used_to_reach_template_minimum(self):
        result = self.request(body={**self.body, 'exclude_filters': ['person_b']}).json()
        self.assertFalse(result['ready'])
        self.assertTrue(result['retryable'])

    def test_changed_people_are_blocked_not_silently_ignored(self):
        result = self.request(body={**self.body, 'filters': ['person_unknown']}).json()
        self.assertFalse(result['ready'])
        self.assertFalse(result['retryable'])

    def test_provisional_people_wait_for_canonical_without_ignoring_preferences(self):
        canonical = selection.candidates(self.scope)
        provisional = {**canonical, 'phase': 'provisional',
                       'photos': [{**photo, 'tags': []} for photo in canonical['photos']]}
        for preference in ('filters', 'exclude_filters'):
            with self.subTest(preference=preference), patch.object(selection, 'candidates', return_value=provisional) as candidates:
                result = self.request(body={**self.body, preference: ['person_b']}).json()
                self.assertFalse(result['ready'])
                self.assertTrue(result['retryable'])
                candidates.assert_called_once_with(self.scope)
        self.assertTrue(self.request(body={**self.body, 'filters': ['person_b']}).json()['ready'])
        self.assertFalse(self.request(body={**self.body, 'filters': ['person_unknown']}).json()['retryable'])

    def test_different_source_does_not_reuse_current_source_candidates(self):
        result = self.request(body={**self.body, 'selection_sources': ['private']}).json()
        self.assertFalse(result['ready'])
        self.assertTrue(result['retryable'])

    def test_publish_permission_is_required(self):
        for token in ('wrong', '', 'viewer'):
            with self.subTest(token=token):
                self.assertEqual(self.request(token=token).status_code, 403)
        self.assertEqual(self.request(body={**self.body, 'device_id': 'other-device'}).status_code, 403)

    def test_contract_and_template_must_match_generation(self):
        for key, value in [('selection_contract', 'old-contract'), ('template', 'retired-layout')]:
            with self.subTest(key=key):
                self.assertEqual(self.request(body={**self.body, key: value}).status_code, 409)

    def test_invalid_sources_do_not_report_ready(self):
        self.assertEqual(self.request(body={**self.body, 'selection_sources': []}).status_code, 422)

    def test_unverified_runtime_is_rejected(self):
        (self.root/'runtime/production-ready.json').unlink()
        self.assertEqual(self.request().status_code, 503)

    def test_unknown_integrity_failure_is_not_retryable_readiness(self):
        with patch.object(selection, 'candidates', side_effect=selection.SelectionUnavailable('输入归属不符')):
            result = self.request().json()
        self.assertFalse(result['ready'])
        self.assertFalse(result['retryable'])

    def test_generation_rechecks_after_library_changes(self):
        self.assertTrue(self.request().json()['ready'])
        folder = selection.directory(self.scope)
        selection.atomic(folder/'library.json', {**self.library, 'photos': {}})
        with patch.object(template_packages, 'render') as render:
            result = self.request(path='/api/generate')
        self.assertEqual(result.status_code, 409)
        render.assert_not_called()
        self.assertEqual(self.stored, {})


if __name__ == '__main__':
    unittest.main()

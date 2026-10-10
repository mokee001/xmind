"""Synthetic scheduling regressions; these do not run models or read a photo library."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import unified_selection as s


class InlineThread:
    def __init__(self, *, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


class SelectionSchedulingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'PHOTOWALL_SELECTION_DIR':self.temp.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.scope = s.library_scope('test-account', ['all'])
        self.root = s.directory(self.scope)
        self.photos = []
        for i in range(24):
            path = self.root/f'{i}.synthetic'
            path.write_bytes(f'fixture {i}'.encode())
            self.photos.append({'id':str(i), 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                'path':str(path), 'filename':path.name, 'quality':.8, 'tags':[]})
        self.calls = []
        self.eligible = lambda source: list(source['photos'].values())
        self.on_phase = lambda phase, source: None

    def library(self, count):
        photos = {p['sha256']:p for p in self.photos[:count]}
        revision = hashlib.sha256(json.dumps(photos, sort_keys=True).encode()).hexdigest()
        value = {'scope':self.scope, 'revision':revision, 'photos':photos}
        s.atomic(self.root/'library.json', value)
        return value

    def quick(self, library, photos=None):
        job = self.root/'jobs'/library['revision']
        s.atomic(job/'input.json', library)
        value = {'scope':self.scope, 'input_revision':library['revision'], 'baseline_commit':s.BASELINE,
            'engine':'strong-rules-provisional-v1', 'albums':[],
            'photos':list(library['photos'].values()) if photos is None else photos}
        s.atomic(job/'provisional.json', value)
        return value

    def inference(self, cmd, log):
        job = Path(cmd[cmd.index('--job')+1])
        phase = cmd[cmd.index('--phase')+1]
        source = s.read(job/'input.json')
        self.calls.append((phase, len(source['photos'])))
        # Both phases retain the same global model-process resource cap.
        self.assertFalse(s._inference.acquire(blocking=False))
        if phase == 'provisional':
            self.quick(source, self.eligible(source))
        else:
            photos = self.eligible(source)
            photos = photos[:24] if len(photos) >= 12 else []
            s.atomic(job/'result.json', {'scope':self.scope, 'input_revision':source['revision'],
                'baseline_commit':s.BASELINE, 'engine':'recollection-feed-v1', 'photos':photos,
                'albums':[{'id':'synthetic-album', 'photo_ids':[p['id'] for p in photos]}] if photos else []})
        self.on_phase(phase, source)

    def run_worker(self):
        with patch.object(s.threading, 'Thread', InlineThread), patch.object(s, 'runtime', return_value=self.root), \
                patch.object(s, 'run_inference', side_effect=self.inference):
            s.enqueue(self.scope)
        self.assertNotIn(self.scope, s._running)

    def test_new_uploads_get_initial_filtering_before_old_complete_album_job(self):
        first = self.library(8)
        self.eligible = lambda source: list(source['photos'].values())[:6 if len(source['photos']) == 8 else 16]
        def upload_during_initial_filter(phase, source):
            if phase == 'provisional' and source['revision'] == first['revision']:
                self.library(16)
                s.enqueue(self.scope)
        self.on_phase = upload_during_initial_filter
        self.run_worker()
        self.assertEqual(self.calls, [('provisional',8), ('provisional',16), ('canonical',16)])
        self.assertEqual(s.candidates(self.scope)['phase'], 'canonical')

    def test_insufficient_initial_set_waits_for_upload_not_full_album_or_busy_retry(self):
        self.library(8)
        self.eligible = lambda source: list(source['photos'].values())[:6 if len(source['photos']) == 8 else 16]
        self.run_worker()
        self.assertEqual(self.calls, [('provisional',8)])
        status = s.read(self.root/'status.json')
        self.assertEqual(status['state'], 'awaiting_photos')
        self.assertNotIn('completed_revision', status)
        self.assertFalse((self.root/'current.json').exists())
        self.run_worker()
        self.assertEqual(len(self.calls), 1)
        self.library(16)
        self.run_worker()
        self.assertEqual(self.calls[-2:], [('provisional',16), ('canonical',16)])

    def test_large_template_does_not_prevent_valid_twelve_photo_albums(self):
        self.library(12)
        with patch('backend.template_packages.required_photo_count', return_value=15):
            self.run_worker()
        self.assertEqual(self.calls, [('provisional',12), ('canonical',12)])

    def test_continuing_uploads_do_not_starve_canonical_once_initial_wall_is_ready(self):
        self.library(8)
        def keep_uploading(phase, source):
            if phase == 'provisional' and len(source['photos']) < 24:
                self.library(len(source['photos'])+8)
                s.enqueue(self.scope)
        self.on_phase = keep_uploading
        self.run_worker()
        self.assertEqual(self.calls, [('provisional',8), ('canonical',8),
            ('provisional',16), ('canonical',16), ('provisional',24), ('canonical',24)])

    def test_ready_or_too_small_source_does_not_reenqueue_forever(self):
        self.library(7)
        self.run_worker()
        self.assertEqual(self.calls, [])
        self.library(16)
        self.run_worker()
        count = len(self.calls)
        self.run_worker()
        self.assertEqual(len(self.calls), count)

    def test_upload_racing_wait_transition_is_not_lost(self):
        self.library(8)
        self.eligible = lambda source: list(source['photos'].values())[:6 if len(source['photos']) == 8 else 16]
        atomic = s.atomic
        def upload_at_wait(path, value):
            atomic(path, value)
            if path == self.root/'status.json' and value.get('state') == 'awaiting_photos':
                self.library(16)
                s.enqueue(self.scope)
        with patch.object(s, 'atomic', side_effect=upload_at_wait):
            self.run_worker()
        self.assertEqual(self.calls, [('provisional',8), ('provisional',16), ('canonical',16)])

    def test_canonical_failure_retains_verified_initial_snapshot(self):
        original = self.library(16)
        def fail_canonical(phase, source):
            if phase == 'canonical':
                raise RuntimeError('synthetic canonical failure')
        self.on_phase = fail_canonical
        self.run_worker()
        self.assertEqual(s.read(self.root/'status.json')['state'], 'failed')
        result = s.candidates(self.scope)
        self.assertEqual(result['phase'], 'provisional')
        self.assertEqual(result['input_revision'], original['revision'])
        self.assertFalse((self.root/'current.json').exists())

    def test_previous_provisional_stays_visible_while_new_revision_is_filtering(self):
        original = self.library(8)
        self.quick(original)
        s.atomic(self.root/'provisional-current.json', {'scope':self.scope, 'revision':original['revision']})
        latest = self.library(16)
        s.atomic(self.root/'status.json', {'state':'running', 'revision':latest['revision']})
        result = s.candidates(self.scope)
        self.assertEqual(len(result['photos']), 8)
        self.assertEqual(result['input_revision'], original['revision'])
        self.assertNotEqual(result['input_revision'], latest['revision'])

    def test_incomplete_new_snapshot_does_not_hide_verified_previous_snapshot(self):
        original = self.library(8)
        self.quick(original)
        s.atomic(self.root/'provisional-current.json', {'scope':self.scope, 'revision':original['revision']})
        latest = self.library(16)
        self.quick(latest)
        s.atomic(self.root/'status.json', {'state':'running', 'revision':latest['revision']})
        (self.root/'jobs'/latest['revision']/'provisional.json').write_text('{')
        self.assertEqual(s.candidates(self.scope)['input_revision'], original['revision'])

    def test_deleted_source_is_not_resurrected_by_provisional_pointer(self):
        original = self.library(8)
        self.quick(original)
        s.atomic(self.root/'provisional-current.json', {'scope':self.scope, 'revision':original['revision']})
        self.library(16)
        Path(self.photos[0]['path']).unlink()
        self.assertEqual(len(s.candidates(self.scope)['photos']), 7)

    def test_pointer_for_other_account_cannot_supply_initial_candidates(self):
        original = self.library(8)
        self.quick(original)
        self.library(16)
        s.atomic(self.root/'provisional-current.json', {'scope':'other-account', 'revision':original['revision']})
        with self.assertRaises(s.SelectionUnavailable):
            s.candidates(self.scope)

    def test_invalid_snapshot_members_or_identity_are_rejected(self):
        original = self.library(8)
        valid = self.quick(original)
        path = self.root/'jobs'/original['revision']/'provisional.json'
        invalid = []
        for field, value in [('scope','other-account'), ('baseline_commit','changed'),
                             ('input_revision','a'*64), ('engine','fallback')]:
            invalid.append({**valid, field:value})
        invalid.append({**valid, 'photos':valid['photos']+[self.photos[16]]})
        invalid.append({**valid, 'photos':valid['photos']+[valid['photos'][0]]})
        foreign_path = copy.deepcopy(valid)
        foreign_path['photos'][0]['path'] = '/other-account/photo.jpg'
        invalid.append(foreign_path)
        zero_quality = copy.deepcopy(valid)
        zero_quality['photos'][0]['quality'] = 0
        invalid.append(zero_quality)
        for value in invalid:
            with self.subTest(value=value):
                s.atomic(path, value)
                self.assertIsNone(s.provisional_snapshot(self.scope, original, original['revision']))

    def test_mutated_job_input_manifest_is_rejected(self):
        original = self.library(8)
        self.quick(original)
        changed = copy.deepcopy(original)
        changed['photos'][self.photos[0]['sha256']]['filename'] = 'mutated'
        s.atomic(self.root/'jobs'/original['revision']/'input.json', changed)
        self.assertIsNone(s.provisional_snapshot(self.scope, original, original['revision']))

    def test_restart_recovers_immutable_initial_job_without_fake_completion(self):
        original = self.library(8)
        self.quick(original)
        s.atomic(self.root/'status.json', {'state':'running', 'phase':'provisional', 'revision':original['revision']})
        self.assertEqual(s.candidates(self.scope)['input_revision'], original['revision'])
        self.run_worker()
        self.assertEqual(self.calls, [('provisional',8), ('canonical',8)])
        self.assertEqual(s.read(self.root/'status.json')['completed_revision'], original['revision'])


if __name__ == '__main__':
    unittest.main()

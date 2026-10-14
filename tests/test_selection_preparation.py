"""Current/stale/failed worker evidence with isolated on-disk snapshot fixtures."""
import hashlib
import json
import time
from pathlib import Path
import unittest
from unittest.mock import patch

from backend import unified_selection as selection
import test_selection_readiness as support


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = support.ReadinessTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.scope = self.fixture.scope
        self.root = selection.directory(self.scope)
        self.photos = list(self.fixture.library['photos'].values())
        self.body = {**self.fixture.body, 'filters': ['person_saved-from-previous-recognition']}
        self.addCleanup(selection._running.discard, self.scope)

    def source(self, count=16):
        photos = {p['sha256']: p for p in self.photos[:count]}
        revision = hashlib.sha256(json.dumps(photos, sort_keys=True).encode()).hexdigest()
        library = {'scope': self.scope, 'revision': revision, 'photos': photos}
        selection.atomic(self.root/'library.json', library)
        return library

    def quick(self, library, eligible=None):
        job = self.root/'jobs'/library['revision']
        selection.atomic(job/'input.json', library)
        selection.atomic(job/'provisional.json', {
            'scope': self.scope, 'input_revision': library['revision'],
            'baseline_commit': selection.BASELINE, 'engine': 'strong-rules-provisional-v1',
            'albums': [], 'photos': [{**p, 'tags': []} for p in
                list(library['photos'].values())[:eligible]],
        })
        selection.atomic(self.root/'provisional-current.json', {
            'scope': self.scope, 'revision': library['revision']})

    def empty(self, library, state='ready'):
        selection.publish(self.scope, {
            'scope': self.scope, 'input_revision': library['revision'],
            'baseline_commit': selection.BASELINE, 'engine': 'recollection-feed-v1',
            'photos': [], 'albums': [],
        }, library)
        self.status(library, state, 'canonical')

    def status(self, library, state, phase):
        value = {'state': state, 'revision': library['revision'], 'phase': phase}
        if state == 'ready':
            value['completed_revision'] = library['revision']
        if state == 'failed':
            value['error'] = '/private/library secret-token'
            value['retry_after'] = time.time() + 60
        selection.atomic(self.root/'status.json', value)

    def readiness(self):
        result = self.fixture.request(body=self.body)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def content(self):
        result = self.fixture.request(body={'sources': ['all']}, path='/api/selection/content')
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def test_running_people_wait_without_upload_or_mutation(self):
        source = self.source()
        self.quick(source)
        self.empty(source, 'running')
        selection._running.add(self.scope)
        with patch.object(selection, 'enqueue') as enqueue:
            result = self.readiness()
        self.assertEqual(result['action'], 'wait')
        self.assertEqual(result['code'], 'people_pending')
        self.assertEqual(result['stage'], 'people')
        self.assertTrue(result['workerActive'])
        self.assertFalse(result['currentRevisionComplete'])
        self.assertFalse(result['resumeRequired'])
        enqueue.assert_not_called()

    def test_current_completed_empty_people_are_actionable_not_endless_pending(self):
        source = self.source()
        self.quick(source)
        self.empty(source)
        result = self.readiness()
        self.assertEqual(result['action'], 'review')
        self.assertEqual(result['code'], 'people_selection_changed')
        self.assertFalse(result['retryable'])
        self.assertTrue(result['currentRevisionComplete'])
        content = self.content()
        self.assertTrue(content['peopleAvailable'])
        self.assertEqual(content['people'], [])
        self.assertEqual(content['albums'], [])
        # Current quick candidates remain valid for the existing natural first-wall policy.
        natural = self.fixture.request().json()
        self.assertTrue(natural['ready'])
        self.assertEqual(natural['action'], 'generate')
        rejection = self.fixture.request(body=self.body, path='/api/generate')
        self.assertEqual(rejection.status_code, 409)
        self.assertEqual(rejection.json()['code'], result['code'])

    def test_less_than_baseline_album_minimum_cannot_prove_people_changed(self):
        source = self.source(8)
        self.quick(source)
        self.empty(source)
        result = self.readiness()
        self.assertEqual(result['action'], 'upload')
        self.assertEqual(result['code'], 'people_pending')
        self.assertTrue(result['retryable'])

    def test_old_empty_result_never_finishes_new_running_revision(self):
        older = self.source(12)
        self.quick(older)
        self.empty(older)
        latest = self.source(16)
        self.quick(latest)
        self.status(latest, 'running', 'canonical')
        selection._running.add(self.scope)
        result = self.readiness()
        self.assertEqual(result['action'], 'wait')
        self.assertFalse(result['currentRevisionComplete'])
        self.assertEqual(result['code'], 'people_pending')
        self.assertFalse(self.content()['peopleAvailable'])

    def test_failed_empty_result_is_not_success_and_does_not_request_uploads(self):
        source = self.source()
        self.quick(source)
        self.empty(source, 'failed')
        result = self.readiness()
        self.assertEqual(result['action'], 'review')
        self.assertEqual(result['code'], 'selection_worker_failed')
        self.assertFalse(result['retryable'])
        self.assertFalse(result['currentRevisionComplete'])
        self.assertFalse(self.content()['peopleAvailable'])
        self.assertNotIn('secret-token', json.dumps(result))
        self.assertNotIn('/private/library', json.dumps(result))

    def test_failed_worker_can_resume_after_backoff_without_new_uploads(self):
        source = self.source()
        self.quick(source)
        self.empty(source, 'failed')
        before = self.readiness()
        self.assertEqual(before['action'], 'review')
        self.assertFalse(before['resumeRequired'])
        status = selection.read(self.root/'status.json')
        selection.atomic(self.root/'status.json', {**status, 'retry_after': time.time() - 1})
        with patch.object(selection, 'enqueue') as enqueue:
            after = self.readiness()
            self.assertEqual(after['action'], 'wait')
            self.assertEqual(after['code'], 'people_pending')
            self.assertTrue(after['resumeRequired'])
            self.assertFalse(after['currentRevisionComplete'])
            enqueue.assert_not_called()
            response = self.fixture.request(body={'sources': ['all']}, path='/api/selection/session')
            self.assertEqual(response.status_code, 200)
            enqueue.assert_called_once_with(self.scope)

    def test_persisted_running_job_requests_resume_without_starting_on_read(self):
        source = self.source()
        self.quick(source)
        self.empty(source, 'running')
        with patch.object(selection, 'enqueue') as enqueue:
            result = self.readiness()
        self.assertEqual(result['action'], 'wait')
        self.assertEqual(result['stage'], 'queued')
        self.assertFalse(result['workerActive'])
        self.assertTrue(result['resumeRequired'])
        enqueue.assert_not_called()

    def test_queue_is_not_reported_as_active_people_inference(self):
        source = self.source()
        self.quick(source)
        self.empty(source, 'queued')
        selection._running.add(self.scope)
        result = self.readiness()
        self.assertEqual(result['action'], 'wait')
        self.assertEqual(result['stage'], 'queued')
        self.assertFalse(result['resumeRequired'])

    def test_verified_insufficient_initial_set_requests_upload(self):
        source = self.source(8)
        self.quick(source, eligible=6)
        self.empty(source, 'awaiting_photos')
        result = self.readiness()
        self.assertEqual(result['action'], 'upload')
        self.assertEqual(result['stage'], 'needs_photos')
        self.assertFalse(result['resumeRequired'])

    def test_fresh_scope_requests_upload_and_cannot_use_other_scope(self):
        result = self.fixture.request(body={**self.body, 'selection_sources': ['new-source']}).json()
        self.assertEqual(result['action'], 'upload')
        self.assertFalse(result['currentRevisionComplete'])
        self.assertFalse(result['resumeRequired'])
        self.assertFalse(result['workerActive'])
        for private in (self.scope, 'person_saved', 'secret-token', 'photos'):
            self.assertNotIn(private, json.dumps({k: v for k, v in result.items() if k not in ('reason', 'stage')}))

    def test_deleted_source_does_not_count_as_successful_empty_analysis(self):
        # Unlike an explicitly empty result, a snapshot emptied by deleted files
        # is not evidence that recognition ran on the currently usable input.
        original = self.fixture.library
        self.status(original, 'ready', 'canonical')
        for photo in self.photos:
            Path(photo['path']).unlink()
        self.assertFalse(selection.preparation(self.scope)['currentRevisionComplete'])
        self.assertFalse(self.content()['peopleAvailable'])

    def test_invalid_library_ownership_is_terminal_before_worker_state_is_used(self):
        selection.atomic(self.root/'library.json', {**self.fixture.library, 'scope': 'other-owner'})
        result = self.readiness()
        self.assertEqual(result['action'], 'review')
        self.assertEqual(result['code'], 'selection_invalid')
        self.assertFalse(result['resumeRequired'])
        self.assertFalse(result['currentRevisionComplete'])
        response = self.fixture.request(body=self.body, path='/api/generate')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['code'], 'selection_invalid')

    def test_unknown_integrity_failure_is_review_not_upload_or_wait(self):
        with patch.object(selection, 'candidates', side_effect=selection.SelectionUnavailable('输入归属不符')):
            result = self.readiness()
        self.assertEqual(result['action'], 'review')
        self.assertEqual(result['code'], 'selection_invalid')
        self.assertFalse(result['retryable'])


if __name__ == '__main__':
    unittest.main()

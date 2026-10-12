"""Synthetic rejection contracts: no private input, live requests or inference."""
import json
import unittest
from unittest.mock import patch

from backend import unified_selection as selection
import test_selection_readiness as support


class SelectionErrorContractTests(unittest.TestCase):
    def setUp(self):
        self.fixture = support.ReadinessTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.gateway = self.fixture.gateway

    def reject(self, **kwargs):
        with self.assertLogs('backend.selection_gateway', level='WARNING') as logs:
            response = self.fixture.request(path='/api/generate', **kwargs)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.fixture.stored, {})
        payload = json.loads(logs.records[-1].getMessage().split('Generation rejected: ', 1)[1])
        self.assertEqual(payload['code'], response.json()['code'])
        self.assertEqual(payload['retryable'], response.json()['retryable'])
        return response.json(), payload, '\n'.join(logs.output)

    def test_known_pending_failures_agree_with_readiness(self):
        cases = [
            ('尚无当前账户的合格照片', 'selection_pending'),
            ('照片尚未完成初筛，请稍后重试', 'selection_pending'),
            ('当前展示范围内合格照片不足；不会补入未入选或被排除的照片', 'insufficient_candidates'),
        ]
        for reason, code in cases:
            with self.subTest(code=code, reason=reason), patch.object(selection, 'candidates', side_effect=selection.SelectionUnavailable(reason)):
                result, _, _ = self.reject()
                readiness = self.fixture.request().json()
                self.assertEqual(result, {'detail': reason, 'code': code, 'retryable': True})
                self.assertEqual(readiness['code'], code)
                self.assertTrue(readiness['retryable'])

    def test_provisional_people_wait_without_clearing_the_requested_person(self):
        snapshot = selection.candidates(self.fixture.scope)
        provisional = {**snapshot, 'phase': 'provisional',
                       'photos': [{**p, 'tags': []} for p in snapshot['photos']]}
        body = {**self.fixture.body, 'filters': ['person_private-selection']}
        with patch.object(selection, 'candidates', return_value=provisional):
            result, log, text = self.reject(body=body)
            readiness = self.fixture.request(body=body).json()
        self.assertEqual(result['code'], 'people_pending')
        self.assertTrue(result['retryable'])
        self.assertEqual(readiness['code'], result['code'])
        self.assertTrue(readiness['retryable'])
        self.assertEqual(log['phase'], 'provisional')
        self.assertEqual(log['candidate_count'], 16)
        self.assertEqual(log['required_count'], 8)
        self.assertEqual(log['preferred_person_count'], 1)
        self.assertNotIn('person_private-selection', text)

    def test_unknown_canonical_people_are_terminal(self):
        body = {**self.fixture.body, 'filters': ['person_private-selection']}
        result, log, _ = self.reject(body=body)
        readiness = self.fixture.request(body=body).json()
        self.assertEqual(result['code'], 'people_selection_changed')
        self.assertFalse(result['retryable'])
        self.assertEqual(readiness['code'], result['code'])
        self.assertFalse(readiness['retryable'])
        self.assertEqual(log['phase'], 'canonical')

    def test_actual_insufficient_selection_is_retryable_and_reports_only_counts(self):
        body = {**self.fixture.body, 'filters': ['person_a']}
        result, log, _ = self.reject(body=body)
        self.assertEqual(result['code'], 'insufficient_candidates')
        self.assertTrue(result['retryable'])
        self.assertEqual(log['candidate_count'], 16)
        self.assertEqual(log['required_count'], 8)

    def test_unrecognized_integrity_error_is_terminal_and_redacted_from_logs(self):
        reason = 'private-user /private/photo-name.jpg token-secret'
        with patch.object(selection, 'candidates', side_effect=selection.SelectionUnavailable(reason)):
            result, _, text = self.reject()
            readiness = self.fixture.request().json()
        self.assertEqual(result, {'detail': reason, 'code': 'selection_invalid', 'retryable': False})
        self.assertFalse(readiness['retryable'])
        self.assertNotIn(reason, text)
        self.assertNotIn('photo-name', text)

    def test_render_failures_are_terminal_without_logging_the_error_or_request(self):
        for error, code in [(ValueError('private-photo-path-and-title'), 'render_failed'),
                            (FileNotFoundError('/private/photo.jpg'), 'render_dependency_missing')]:
            with self.subTest(code=code):
                body = {**self.fixture.body, 'title': 'private-user-title',
                        'filters': ['collection_private-album', 'private-theme'],
                        'exclude_filters': ['private-exclusion']}
                with patch.object(self.gateway.existing.template_packages, 'render', side_effect=error):
                    result, log, text = self.reject(body=body)
                self.assertEqual(result, {'detail': str(error), 'code': code, 'retryable': False})
                self.assertEqual(log['stage'], 'render')
                self.assertEqual(log['preferred_count'], 2)
                self.assertEqual(log['excluded_count'], 1)
                self.assertEqual(log['preferred_person_count'], 0)
                for private in ('private', str(error), 'test-device', 'owner-scope', 'token'):
                    self.assertNotIn(private, text)

    def test_invalid_contract_and_template_preserve_detail_and_stop_retrying(self):
        for field, value, code, detail in [
            ('selection_contract', 'private-contract', 'selection_contract_invalid', '不支持的选片链路版本'),
            ('template', 'private-layout', 'template_unavailable', '模板不适用于此生成链路'),
        ]:
            with self.subTest(code=code):
                result, log, text = self.reject(body={**self.fixture.body, field: value})
                self.assertEqual(result, {'detail': detail, 'code': code, 'retryable': False})
                self.assertEqual(log['stage'], 'request')
                self.assertNotIn(value, text)

    def test_auth_failure_keeps_existing_status_and_does_not_log_request(self):
        with self.assertNoLogs('backend.selection_gateway', level='WARNING'):
            response = self.fixture.request(path='/api/generate', token='private-wrong-token')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {'detail': '设备授权无效'})
        self.assertEqual(self.fixture.stored, {})


if __name__ == '__main__':
    unittest.main()

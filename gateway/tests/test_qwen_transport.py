import io
import json
import socket
import ssl
import unittest
import urllib.error
from unittest.mock import patch

from echoo_gateway.providers import ProviderError, QwenProvider
from echoo_gateway.qwen_stream import read_completion
from echoo_gateway.blue_sky import BlueSkyQwenProvider, validate_batch
from test_blue_sky import payload, complete


def event(delta=None, finish=None, **extra):
    value = {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}], **extra}
    return b"data: " + json.dumps(value, ensure_ascii=False).encode() + b"\r\n\r\n"


def decode(raw, clock=lambda: 1):
    diagnostics = {"events": 0, "receivedBytes": 0, "contentBytes": 0, "firstDataMS": None}
    return read_completion(io.BytesIO(raw), diagnostics, deadline=10, clock=clock), diagnostics


class QwenTransportTests(unittest.TestCase):
    def test_stream_joins_unicode_fragments_and_usage_only_event(self):
        raw = b": keepalive\r\n\r\n" + event({"role": "assistant"})
        raw += event({"content": '{"a":"猫'}) + event({"content": '咪"}'}, "stop")
        raw += b'data: {"choices": [], "usage": {"total_tokens": 33, "private": "SECRET"}}\n\n'
        raw += b"data: [DONE]\n\n"
        result, diagnostics = decode(raw)
        self.assertEqual(json.loads(result["choices"][0]["message"]["content"]), {"a": "猫咪"})
        self.assertEqual(result["usage"], {"total_tokens": 33})
        self.assertEqual(diagnostics["contentBytes"], len('{"a":"猫咪"}'.encode()))
        self.assertNotIn("猫", json.dumps(diagnostics, ensure_ascii=False))
        self.assertNotIn("SECRET", json.dumps(result))

    def test_missing_done_finish_and_invalid_data_fail_closed(self):
        for raw, code in [(event({"content": "{}"}, "stop"), "qwen_stream_incomplete"),
                          (event({"content": "{}"}) + b"data: [DONE]\n\n", "qwen_stream_incomplete"),
                          (b"data: invalid-SECRET\n\n", "qwen_invalid_stream"),
                          (b'data: {"error":{"message":"SECRET"}}\n\n', "qwen_stream_error"),
                          (b"data: \xff\n\n", "qwen_invalid_stream"),
                          (b"data: " + b"x" * 65536 + b"\n\n", "qwen_response_too_large")]:
            with self.subTest(code=code), self.assertRaisesRegex(ProviderError, "^" + code + "$"):
                decode(raw)

    def test_total_deadline_and_content_limit(self):
        with self.assertRaisesRegex(ProviderError, "qwen_total_timeout"):
            decode(event({"content": "{}"}), clock=lambda: 11)
        raw = b"".join(event({"content": "x" * 60000}) for _ in range(5))
        with self.assertRaisesRegex(ProviderError, "qwen_response_too_large"):
            decode(raw)

    def test_finished_length_or_refusal_cannot_become_a_score(self):
        for finish, refusal in [("length", False), ("stop", True)]:
            raw = event({"content": json.dumps(complete(["p01", "p02"])), "refusal": refusal}, finish)
            result, _ = decode(raw + b"data: [DONE]\n\n")
            provider = BlueSkyQwenProvider(api_key="synthetic", transport=lambda body: result)
            with self.assertRaisesRegex(ProviderError, "qwen_incomplete"):
                provider.evaluate(validate_batch(payload()), "test")

    def test_post_stream_path_preserves_safe_diagnostics(self):
        response = io.BytesIO(event({"content": "{}"}, "stop") + b"data: [DONE]\n\n")
        provider = QwenProvider(api_key="SYNTHETIC_SECRET")
        with patch("urllib.request.OpenerDirector.open", return_value=response):
            result = provider._post({"stream": True})
        self.assertEqual(result["choices"][0]["message"]["content"], "{}")
        self.assertEqual(provider.last_transport["phase"], "completed")
        self.assertEqual(provider.last_transport["mode"], "stream")
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(provider.last_transport))

    def test_transport_errors_have_specific_safe_codes(self):
        failures = [(TimeoutError("SECRET"), "qwen_timeout"),
                    (urllib.error.URLError(socket.gaierror("SECRET")), "qwen_dns_failed"),
                    (urllib.error.URLError(ssl.SSLError("SECRET")), "qwen_tls_failed"),
                    (ConnectionResetError("SECRET"), "qwen_connection_failed"),
                    (urllib.error.HTTPError("https://test", 401, "SECRET", {}, None), "qwen_http_401")]
        for error, code in failures:
            provider = QwenProvider(api_key="SECRET")
            with self.subTest(code=code), patch("urllib.request.OpenerDirector.open", side_effect=error):
                with self.assertRaisesRegex(ProviderError, "^" + code + "$"):
                    provider._post({"stream": True})
            self.assertEqual(provider.last_transport["phase"], "connecting")
            self.assertNotIn("SECRET", json.dumps(provider.last_transport))

    def test_timeout_during_stream_is_distinct_from_before_headers(self):
        class Interrupted(io.BytesIO):
            def readline(self, *args):
                raise TimeoutError("SECRET")
        provider = QwenProvider(api_key="test")
        with patch("urllib.request.OpenerDirector.open", return_value=Interrupted()):
            with self.assertRaisesRegex(ProviderError, "qwen_timeout"):
                provider._post({"stream": True})
        self.assertEqual(provider.last_transport["phase"], "receiving")

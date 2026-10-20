import base64
import copy
import hashlib
import json
import io
import unittest
from unittest.mock import patch

from echoo_gateway.contracts import (
    CHECKS, THEME_FACTS, ContractError, jpeg_dimensions, validate_request,
    validate_semantics, unknown_result,
)
from echoo_gateway.providers import QwenProvider, ProviderError, moderation_findings
from echoo_gateway.server import make_handler
from echoo_gateway.service import AnalysisService, reconcile


def jpeg_fixture():
    # Framing fixture for contract tests. Image decode/metadata tests run against actual ImageIO JPEGs in Swift.
    return bytes.fromhex("ffd8 ffc0 000b 08 0002 0003 01 01 1100 ffda 0008 01 01 00 00 3f 00 01 ffd9")


def request_fixture():
    image = jpeg_fixture()
    return {
        "schemaVersion": "echoo-analysis-v1", "policyVersion": "echoo-policy-v1",
        "photoID": "test-photo", "contentDigest": hashlib.sha256(image).hexdigest(),
        "jpegBase64": base64.b64encode(image).decode(), "width": 3, "height": 2,
        "native": {"revision": "test", "labels": [], "animals": [], "privacyFinding": "unknown"},
    }


def clear_semantics():
    return {"findings": dict.fromkeys(CHECKS, "absent"), "themeFacts": dict.fromkeys(THEME_FACTS, "absent")}


class FakeModeration:
    def __init__(self, label="nonLabel", fail=False):
        self.label, self.fail, self.calls = label, fail, 0

    def analyze(self, image):
        self.calls += 1
        if self.fail:
            raise ProviderError("test_moderation_failure")
        return {"Code": 200, "Data": {"Result": [{"Label": self.label}]}}


class FakeSemantic:
    def __init__(self, values=None):
        self.values = values or [clear_semantics()]
        self.models = []

    def analyze(self, image, native, model):
        self.models.append(model)
        value = self.values[min(len(self.models) - 1, len(self.values) - 1)]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


class ContractTests(unittest.TestCase):
    def test_valid_preview_binds_digest_and_dimensions(self):
        image, native = validate_request(request_fixture())
        self.assertEqual(jpeg_dimensions(image), (3, 2))
        self.assertEqual(native["revision"], "test")

    def test_invalid_identity_digest_dimensions_and_schema_are_rejected(self):
        for key, value in (
            ("photoID", "private/path/name"), ("policyVersion", "old"),
            ("schemaVersion", "old"), ("contentDigest", "wrong"), ("width", True),
            ("width", 99), ("jpegBase64", "not base64"),
        ):
            with self.subTest(key=key):
                request = request_fixture()
                request[key] = value
                with self.assertRaises(ContractError):
                    validate_request(request)

    def test_exif_payload_is_not_forwarded(self):
        image = jpeg_fixture()
        image = image[:2] + bytes.fromhex("ffe1 0008") + b"Exif\x00\x00" + image[2:]
        with self.assertRaises(ContractError):
            jpeg_dimensions(image)

    def test_unknown_values_and_missing_keys_cannot_pass_validation(self):
        for result in ({}, {"findings": {}, "themeFacts": {}}, clear_semantics()):
            if result.get("findings"):
                result["findings"]["highRiskPrivacy"] = False
            with self.assertRaises(ContractError):
                validate_semantics(result)

    def test_raw_ocr_and_location_are_not_in_native_model_payload(self):
        request = request_fixture()
        request["native"].update({"ocrText": "SYNTHETIC_PRIVATE_VALUE", "gps": "synthetic"})
        _, native = validate_request(request)
        self.assertNotIn("ocrText", native)
        self.assertNotIn("gps", native)


class ModerationTests(unittest.TestCase):
    def test_swimwear_fitness_and_out_of_scope_vendor_labels_do_not_reject(self):
        for label in ("sexual_femaleUnderwear", "sexual_maleTopless", "sexual_femaleLeg", "political_CNFlag", "inappropriate_drinking"):
            findings = moderation_findings({"Code": 200, "Data": {"Result": [{"Label": label}]}})
            self.assertEqual(findings, {"intimateExposure": "absent", "bloodyViolence": "absent"})

    def test_broad_porn_and_blood_alerts_need_clarification(self):
        for label, key in (("pornographic_adultContent", "intimateExposure"), ("violent_bloody", "bloodyViolence")):
            findings = moderation_findings({"Code": 200, "Data": {"Result": [{"Label": label}]}})
            self.assertEqual(findings[key], "unknown")

    def test_failed_empty_or_exempt_moderation_is_not_a_clearance(self):
        for response in (
            {"Code": 500}, {"Code": 200, "Data": {"Result": []}},
            {"Code": 200, "Data": {"Result": [{"Label": "nonLabel_lib"}]}},
        ):
            with self.assertRaises(ProviderError):
                moderation_findings(response)


class QwenTests(unittest.TestCase):
    def test_payload_uses_fixed_model_nonthinking_json_and_a_single_preview(self):
        bodies = []
        def transport(body):
            bodies.append(body)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(clear_semantics())}}]}
        provider = QwenProvider(api_key="synthetic-test-key", transport=transport)
        self.assertEqual(provider.analyze(jpeg_fixture(), {}, "test-model"), clear_semantics())
        self.assertEqual(bodies[0]["model"], "test-model")
        self.assertIs(bodies[0]["enable_thinking"], False)
        self.assertEqual(bodies[0]["response_format"], {"type": "json_object"})
        self.assertEqual(len(bodies[0]["messages"][1]["content"]), 2)

    def test_refusal_truncation_and_invalid_json_cannot_be_success(self):
        for response in (
            {"choices": [{"finish_reason": "length", "message": {"content": "{}"}}]},
            {"choices": [{"finish_reason": "stop", "message": {"refusal": "refused", "content": "{}"}}]},
            {"choices": [{"finish_reason": "stop", "message": {"content": "invalid JSON"}}]},
        ):
            provider = QwenProvider(api_key="synthetic", transport=lambda body: response)
            with self.assertRaises(ProviderError):
                provider.analyze(jpeg_fixture(), {}, "test")

    def test_no_key_does_not_call_transport(self):
        provider = QwenProvider(api_key="", transport=lambda body: self.fail("must not call"))
        with self.assertRaises(ProviderError):
            provider.analyze(jpeg_fixture(), {}, "test")


class ServiceTests(unittest.TestCase):
    def test_complete_flash_result_does_not_call_plus(self):
        semantic = FakeSemantic()
        result = AnalysisService(FakeModeration(), semantic).analyze(request_fixture())
        self.assertEqual(result["findings"], clear_semantics()["findings"])
        self.assertEqual(semantic.models, ["qwen3.8-flash"])

    def test_initial_and_review_use_requested_model_even_with_stale_environment(self):
        with patch.dict("os.environ", {"ECHOO_FLASH_MODEL": "stale-initial", "ECHOO_PLUS_MODEL": "stale-review"}):
            semantic = FakeSemantic()
            AnalysisService(FakeModeration(label="pornographic_adultContent"), semantic).analyze(request_fixture())
        self.assertEqual(semantic.models, ["qwen3.8-flash", "qwen3.8-flash"])

    def test_native_private_hit_does_not_call_any_provider(self):
        moderation, semantic = FakeModeration(), FakeSemantic()
        request = request_fixture()
        request["native"]["privacyFinding"] = "present"
        result = AnalysisService(moderation, semantic).analyze(request)
        self.assertEqual(result["findings"]["highRiskPrivacy"], "present")
        self.assertEqual(moderation.calls, 0)
        self.assertEqual(semantic.models, [])

    def test_moderation_failure_leaves_every_check_unknown(self):
        semantic = FakeSemantic()
        result = AnalysisService(FakeModeration(fail=True), semantic).analyze(request_fixture())
        self.assertTrue(all(value == "unknown" for value in result["findings"].values()))
        self.assertEqual(semantic.models, [])

    def test_broad_alert_runs_plus_for_narrow_user_policy(self):
        semantic = FakeSemantic()
        result = AnalysisService(FakeModeration(label="pornographic_adultContent"), semantic).analyze(request_fixture())
        self.assertEqual(result["findings"]["intimateExposure"], "absent")
        self.assertEqual(len(semantic.models), 2)

    def test_plus_failure_does_not_clear_a_broad_safety_alert(self):
        semantic = FakeSemantic([clear_semantics(), ProviderError("test_plus_error")])
        result = AnalysisService(FakeModeration(label="violent_bloody"), semantic).analyze(request_fixture())
        self.assertEqual(result["findings"]["bloodyViolence"], "unknown")

    def test_disagreement_stays_unknown_and_does_not_override_rejection_with_pass(self):
        first, second = clear_semantics(), clear_semantics()
        first["findings"]["highRiskPrivacy"] = "present"
        first["themeFacts"]["zooScene"] = "unknown"
        result = AnalysisService(FakeModeration(), FakeSemantic([first, second])).analyze(request_fixture())
        self.assertEqual(result["findings"]["highRiskPrivacy"], "unknown")

    def test_unknowns_can_be_completed_by_plus(self):
        result = reconcile(unknown_result(), clear_semantics())
        self.assertEqual(result, clear_semantics())

    def test_cache_rebinds_photo_id_and_isolated_by_scope(self):
        moderation, semantic = FakeModeration(), FakeSemantic()
        service = AnalysisService(moderation, semantic)
        service.analyze(request_fixture(), scope="a")
        request = request_fixture()
        request["photoID"] = "second-photo"
        result = service.analyze(request, scope="a")
        self.assertEqual(result["photoID"], "second-photo")
        self.assertEqual(moderation.calls, 1)
        service.analyze(request, scope="b")
        self.assertEqual(moderation.calls, 2)

    def test_failures_are_not_cached(self):
        moderation = FakeModeration(fail=True)
        service = AnalysisService(moderation, FakeSemantic())
        service.analyze(request_fixture())
        moderation.fail = False
        result = service.analyze(request_fixture())
        self.assertEqual(moderation.calls, 2)
        self.assertEqual(result["findings"]["highRiskPrivacy"], "absent")

    def test_expired_cache_runs_providers_again(self):
        now = [0]
        moderation = FakeModeration()
        service = AnalysisService(moderation, FakeSemantic(), clock=lambda: now[0])
        service.analyze(request_fixture())
        now[0] = 86401
        service.analyze(request_fixture())
        self.assertEqual(moderation.calls, 2)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.service = AnalysisService(FakeModeration(), FakeSemantic())
        self.handler = make_handler(self.service, "synthetic-token-for-tests")

    def send(self, *, authorized=True, body=None):
        data = json.dumps(body if body is not None else request_fixture()).encode()
        headers = "POST /v1/analyze HTTP/1.0\r\nContent-Type: application/json\r\n"
        if authorized:
            headers += "Authorization: Bearer synthetic-token-for-tests\r\n"
        headers += "Content-Length: " + str(len(data)) + "\r\n\r\n"
        socket = InMemorySocket(headers.encode() + data)
        self.handler(socket, ("127.0.0.1", 0), object())
        head, response = bytes(socket.output).split(b"\r\n\r\n", 1)
        return int(head.split(b" ")[1]), json.loads(response)

    def test_unauthenticated_request_is_rejected(self):
        status, result = self.send(authorized=False)
        self.assertEqual(status, 401)
        self.assertEqual(result, {"error": "unauthorized"})

    def test_authenticated_request_returns_bound_contract(self):
        status, result = self.send()
        self.assertEqual(status, 200)
        self.assertEqual(result["photoID"], "test-photo")
        self.assertEqual(result["schemaVersion"], "echoo-analysis-v1")

    def test_invalid_contract_is_rejected_before_provider_calls(self):
        request = request_fixture()
        request["contentDigest"] = "wrong"
        status, result = self.send(body=request)
        self.assertEqual(status, 400)
        self.assertEqual(result, {"error": "invalid_analysis_request"})


class InMemorySocket:
    """Exercise the real HTTP parser/auth/body handling without opening a network socket."""
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, mode, buffering=-1):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, value):
        pass


if __name__ == "__main__":
    unittest.main()

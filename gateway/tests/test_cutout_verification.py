import base64
import copy
import hashlib
import json
import types
import unittest

from echoo_gateway.cutout_verification import (
    FACTS, SCHEMA, VERSION, QwenCutoutProvider, CutoutVerificationService, validate_request,
)
from echoo_gateway.contracts import ContractError
from echoo_gateway.providers import ProviderError
from echoo_gateway.server import make_handler
from test_blue_sky import jpeg
from test_gateway import InMemorySocket


def payload(ids=("a", "b")):
    image = jpeg()
    records = []
    for identifier in ids:
        record = {"photoID": identifier, "cutoutDigest": "c" * 64, "nativePrivacyFinding": "unknown"}
        for prefix in ("original", "masked"):
            record.update({prefix + "JPEGBase64": base64.b64encode(image).decode(),
                           prefix + "Digest": hashlib.sha256(image).hexdigest(),
                           prefix + "Width": 32, prefix + "Height": 16})
        records.append(record)
    return {"schemaVersion": SCHEMA, "verificationVersion": VERSION, "policyVersion": "echoo-policy-v1",
            "requestID": "cutout-request", "mode": "calibration", "sampleReviewed": True, "photos": records}


def complete(ids=("a", "b")):
    return {"evaluations": [{"photoID": identifier, "facts": dict.fromkeys(FACTS, "present")} for identifier in ids]}


class FakeProvider:
    def __init__(self, result=None):
        self.result = complete() if result is None else result
        self.calls = []
    def verify(self, photos, model):
        self.calls.append((list(p["photoID"] for p in photos), model))
        if isinstance(self.result, Exception):
            raise self.result
        return copy.deepcopy(self.result), {"total_tokens": 50}


class CutoutVerificationTests(unittest.TestCase):
    def test_admission_privacy_and_sample_review_are_required_before_provider_calls(self):
        provider = FakeProvider()
        service = CutoutVerificationService(provider)
        with self.assertRaisesRegex(ContractError, "calibration_disabled"):
            service.verify(payload())
        request = payload()
        request["mode"] = "production"
        with self.assertRaisesRegex(ContractError, "admitted_pet_required"):
            service.verify(request)
        for photo in request["photos"]:
            photo.update(admissionState="passed", themes=["pets"])
        request["photos"][0]["nativePrivacyFinding"] = "present"
        with self.assertRaises(ContractError):
            service.verify(request)
        self.assertEqual(provider.calls, [])

    def test_two_image_digests_dimensions_metadata_and_batch_limits_are_validated(self):
        for field, value in [("originalDigest", "wrong"), ("maskedWidth", 999), ("cutoutDigest", "x"),
                             ("originalWidth", True), ("maskedJPEGBase64", "bad-base64")]:
            request = payload()
            request["photos"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ContractError):
                validate_request(request)
        with self.assertRaises(ContractError):
            validate_request(payload([str(i) for i in range(6)]))
        request = payload()
        request["photos"][1]["photoID"] = "a"
        with self.assertRaises(ContractError):
            validate_request(request)

    def test_only_selected_pairs_use_requested_model_and_preserve_digest_binding(self):
        provider = FakeProvider()
        result = CutoutVerificationService(provider, allow_calibration=True).verify(payload())
        self.assertEqual(provider.calls, [(["a", "b"], "qwen3.8-flash")])
        self.assertEqual(result["photoDigests"]["a"]["cutout"], "c" * 64)
        self.assertEqual(result["calls"][0]["stage"], "postCutout")
        self.assertEqual(set(result["evaluations"][0]["facts"]), set(FACTS))
        self.assertNotIn("scores", result["evaluations"][0])

    def test_failure_is_unknown_not_pass_and_never_cached(self):
        provider = FakeProvider(ProviderError("qwen_transport_failed"))
        service = CutoutVerificationService(provider, allow_calibration=True)
        result = service.verify(payload())
        service.verify(payload())
        self.assertEqual(len(provider.calls), 2)
        self.assertTrue(all(v == "unknown" for item in result["evaluations"] for v in item["facts"].values()))
        self.assertEqual(result["calls"][0]["errorCode"], "qwen_transport_failed")

    def test_missing_mismatched_or_private_free_text_cannot_pass(self):
        for result in [{}, complete(["a", "wrong"]), complete()]:
            if result == complete():
                result["evaluations"][0]["facts"]["topComplete"] = "SYNTHETIC_PRIVATE_TEXT"
            service = CutoutVerificationService(FakeProvider(result), allow_calibration=True)
            response = service.verify(payload())
            self.assertTrue(all(v == "unknown" for item in response["evaluations"] for v in item["facts"].values()))
            self.assertNotIn("SYNTHETIC_PRIVATE_TEXT", json.dumps(response))

    def test_completed_evidence_cache_is_bound_to_asset_digest_and_scope(self):
        provider = FakeProvider()
        service = CutoutVerificationService(provider, allow_calibration=True)
        service.verify(payload(), scope="one")
        cached = service.verify(payload(), scope="one")
        self.assertEqual(cached["calls"], [])
        self.assertEqual(len(provider.calls), 1)
        service.verify(payload(), scope="two")
        modified = payload()
        modified["photos"][0]["cutoutDigest"] = "d" * 64
        provider.result = complete(["a"])
        service.verify(modified, scope="one")
        self.assertEqual(provider.calls[-1][0], ["a"])

    def test_provider_sends_full_frame_pair_json_with_aliases_no_source_paths(self):
        seen = []
        def transport(body):
            seen.append(body)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(complete(["p01", "p02"]))}}],
                    "usage": {"total_tokens": 40}}
        provider = QwenCutoutProvider(api_key="SYNTHETIC_ONLY", transport=transport)
        result, usage = provider.verify(validate_request(payload()), "qwen3.8-flash")
        self.assertEqual([p["photoID"] for p in result["evaluations"]], ["a", "b"])
        self.assertEqual(usage["total_tokens"], 40)
        self.assertEqual(sum(item["type"] == "image_url" for item in seen[0]["messages"][1]["content"]), 4)
        self.assertFalse(seen[0]["enable_thinking"])
        self.assertEqual(seen[0]["model"], "qwen3.8-flash")
        self.assertNotIn("sourcePath", json.dumps(seen[0]))

    def test_truncation_and_refusal_cannot_be_verification_success(self):
        for choice in [{"finish_reason": "length", "message": {"content": "{}"}},
                       {"finish_reason": "stop", "message": {"refusal": "refused", "content": "{}"}}]:
            provider = QwenCutoutProvider(api_key="SYNTHETIC_ONLY", transport=lambda body: {"choices": [choice]})
            with self.assertRaises(ProviderError):
                provider.verify(validate_request(payload()), "qwen3.8-flash")

    def test_authenticated_production_route_cannot_enable_calibration(self):
        request = payload()
        request["mode"] = "production"
        for photo in request["photos"]:
            photo.update(admissionState="passed", themes=["pets"])
        service = CutoutVerificationService(FakeProvider())
        handler = make_handler(None, "test-token", cutout_service=service)
        def send(body, authorization):
            data = json.dumps(body).encode()
            headers = "POST /v1/templates/blue-sky/verify-cutouts HTTP/1.0\r\nContent-Type: application/json\r\n"
            headers += "Authorization: " + authorization + "\r\nContent-Length: " + str(len(data)) + "\r\n\r\n"
            socket = InMemorySocket(headers.encode() + data)
            handler(socket, ("127.0.0.1", 0), types.SimpleNamespace())
            head, result = bytes(socket.output).split(b"\r\n\r\n", 1)
            return int(head.split(b" ")[1]), json.loads(result)
        self.assertEqual(send(request, "Bearer test-token")[0], 200)
        self.assertEqual(send(request, "wrong")[0], 401)
        self.assertEqual(send(payload(), "Bearer test-token")[0], 400)

import base64
import copy
import hashlib
import itertools
import json
import unittest
from unittest.mock import patch

from echoo_gateway.blue_sky import (
    FACTS, REASONS, SCHEMA, VERSION, BlueSkyQwenProvider, BlueSkyService,
    unknown_result, validate_batch, validate_result,
)
from echoo_gateway.contracts import ContractError
from echoo_gateway.providers import ProviderError


def jpeg():
    return b"\xff\xd8\xff\xc0\x00\x0b\x08\x00\x10\x00\x20\x01\x01\x11\x00\xff\xda\x00\x02\xff\xd9"


def payload(ids=("a", "b")):
    image = jpeg()
    return {"schemaVersion": SCHEMA, "templateVersion": VERSION, "policyVersion": "echoo-policy-v1",
            "requestID": "request-1", "mode": "calibration", "sampleReviewed": True,
            "photos": [{"photoID": p, "jpegBase64": base64.b64encode(image).decode(),
                        "contentDigest": hashlib.sha256(image).hexdigest(), "width": 32, "height": 16,
                        "nativePrivacyFinding": "unknown"} for p in ids]}


def complete(ids=("a", "b")):
    result = unknown_result(ids)
    for photo in result["evaluations"]:
        photo["facts"] = dict.fromkeys(FACTS, "present")
        photo["scores"] = {k: {"value": 3, "reason": values[0]} for k, values in REASONS.items()}
    for pair in result["identity"]:
        pair.update(relation="same", reason="matchingDistinctiveFeatures")
    return result


class FakeProvider:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []
    def evaluate(self, photos, model):
        self.calls.append(model)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return copy.deepcopy(answer), {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}


class BlueSkyTests(unittest.TestCase):
    def test_empty_request_never_calls_provider_or_requires_key(self):
        provider = FakeProvider()
        result = BlueSkyService(provider, allow_calibration=True).evaluate(payload([]))
        self.assertEqual(result["evaluations"], [])
        self.assertEqual(result["identity"], [])
        self.assertEqual(result["calls"], [])
        self.assertEqual(provider.calls, [])

    def test_species_inapplicable_preferences_are_explicit_and_cannot_mask_positive_facts(self):
        result = complete(["fish"])
        photo = result["evaluations"][0]
        photo["notApplicablePreferences"] = ["curled", "frontStandingOrSitting"]
        for key in photo["notApplicablePreferences"]: photo["facts"][key] = "absent"
        validate_result(result, ["fish"])
        photo["facts"]["curled"] = "present"
        with self.assertRaises(ContractError): validate_result(result, ["fish"])
        self.assertIn("isPet", FACTS)
        self.assertNotIn("isCat", FACTS)

    def test_old_cat_contract_is_not_silently_relabelled(self):
        request = payload()
        request["templateVersion"] = "blue-sky-cat-v1"
        with self.assertRaises(ContractError): validate_batch(request)

    def test_calibration_requires_review_and_production_requires_admitted_pets(self):
        request = payload()
        request["sampleReviewed"] = False
        with self.assertRaises(ContractError):
            validate_batch(request)
        request.update(mode="production", sampleReviewed=False)
        with self.assertRaises(ContractError):
            validate_batch(request)
        for photo in request["photos"]:
            photo.update(admissionState="passed", themes=["pets"])
        self.assertEqual(len(validate_batch(request)), 2)

    def test_private_digest_dimensions_and_duplicate_ids_cannot_upload(self):
        for field, value in [("nativePrivacyFinding", "present"), ("contentDigest", "wrong"), ("width", 99)]:
            request = payload()
            request["photos"][0][field] = value
            with self.assertRaises(ContractError):
                validate_batch(request)
        request = payload()
        request["photos"][1]["photoID"] = "a"
        with self.assertRaises(ContractError):
            validate_batch(request)

    def test_unknown_scores_are_not_zero_and_boolean_scores_are_invalid(self):
        self.assertIsNone(validate_result(unknown_result(["a"]), ["a"])["evaluations"][0]["scores"]["sharpness"]["value"])
        for rating in (0, 6, True, "5"):
            result = complete(["a"])
            result["evaluations"][0]["scores"]["sharpness"]["value"] = rating
            with self.assertRaises(ContractError):
                validate_result(result, ["a"])

    def test_missing_fields_raw_private_reasons_and_missing_pairs_are_rejected(self):
        result = complete()
        del result["evaluations"][0]["facts"]["topComplete"]
        with self.assertRaises(ContractError):
            validate_result(result, ["a", "b"])
        result = complete()
        result["evaluations"][0]["scores"]["sharpness"]["reason"] = "arbitrary image text"
        with self.assertRaises(ContractError):
            validate_result(result, ["a", "b"])
        result = complete()
        result["identity"] = []
        with self.assertRaises(ContractError):
            validate_result(result, ["a", "b"])

    def test_pairwise_identity_is_complete_and_cannot_duplicate_reversed_pair(self):
        result = complete(["a", "b", "c"])
        result["identity"][-1] = dict(result["identity"][0])
        with self.assertRaises(ContractError):
            validate_result(result, ["a", "b", "c"])

    def test_complete_flash_result_is_cached_and_bound_to_request(self):
        provider = FakeProvider(complete())
        service = BlueSkyService(provider, allow_calibration=True)
        first = service.evaluate(payload())
        second_request = payload()
        second_request["requestID"] = "second"
        second = service.evaluate(second_request)
        self.assertEqual(len(provider.calls), 1)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(second["requestID"], "second")
        self.assertEqual(second["calls"], [])
        self.assertTrue(first["evaluations"][0]["provenance"])

    def test_plus_review_keeps_conflicting_hard_facts_and_identity_unknown(self):
        first, second = complete(), complete()
        first["evaluations"][0]["facts"]["curled"] = "unknown"
        second["evaluations"][0]["facts"]["topComplete"] = "absent"
        second["identity"][0].update(relation="different", reason="conflictingDistinctiveFeatures")
        result = BlueSkyService(FakeProvider(first, second), allow_calibration=True).evaluate(payload())
        self.assertEqual(result["evaluations"][0]["facts"]["topComplete"], "unknown")
        self.assertEqual(result["identity"][0]["relation"], "unknown")
        self.assertEqual(result["evaluations"][0]["scores"]["expression"]["value"], 3)

    def test_provider_failure_stays_pending_and_is_not_cached(self):
        provider = FakeProvider(*[ProviderError("unavailable") for _ in range(4)])
        service = BlueSkyService(provider, allow_calibration=True)
        result = service.evaluate(payload())
        self.assertIsNone(result["evaluations"][0]["scores"]["sharpness"]["value"])
        self.assertEqual(result["identity"][0]["relation"], "unknown")
        service.evaluate(payload())
        self.assertEqual(len(provider.calls), 4)

    def test_invalid_provider_result_cannot_become_a_success(self):
        result = BlueSkyService(FakeProvider({}, {}), allow_calibration=True).evaluate(payload())
        self.assertTrue(all(p["relation"] == "unknown" for p in result["identity"]))

    def test_new_prompt_cannot_reuse_cached_old_viewpoint_judgments(self):
        provider = FakeProvider(complete(), complete())
        service = BlueSkyService(provider, allow_calibration=True)
        with patch("echoo_gateway.blue_sky.PROMPT_VERSION", "old-prompt"):
            service.evaluate(payload())
        with patch("echoo_gateway.blue_sky.PROMPT_VERSION", "new-prompt"):
            result = service.evaluate(payload())
        self.assertEqual(len(provider.calls), 2)
        self.assertFalse(result["cacheHit"])
        self.assertIn("new-prompt", result["evaluations"][0]["provenance"][0])

    def test_provider_uses_original_images_json_mode_and_captures_usage(self):
        seen = []
        def transport(body):
            seen.append(body)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(complete(["p01", "p02"]))}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}
        provider = BlueSkyQwenProvider(api_key="test-only", transport=transport)
        assessed, usage = provider.evaluate(validate_batch(payload()), "test-model")
        self.assertEqual(usage["total_tokens"], 30)
        self.assertFalse(seen[0]["enable_thinking"])
        self.assertTrue(seen[0]["stream"])
        self.assertEqual(seen[0]["stream_options"], {"include_usage": True})
        self.assertEqual(seen[0]["response_format"], {"type": "json_object"})
        self.assertEqual(sum(p["type"] == "image_url" for p in seen[0]["messages"][1]["content"]), 2)
        self.assertNotIn("sourcePath", json.dumps(seen[0]))
        self.assertEqual(assessed["identity"][0]["leftID"], "a")

    def test_truncation_cannot_be_treated_as_completed(self):
        provider = BlueSkyQwenProvider(api_key="test-only", transport=lambda body: {
            "choices": [{"finish_reason": "length", "message": {"content": json.dumps(complete())}}]})
        with self.assertRaises(ProviderError):
            provider.evaluate(validate_batch(payload()), "test-model")

    def test_permission_error_stops_redundant_review_and_preserves_diagnostics(self):
        provider = FakeProvider(ProviderError("qwen_http_401"))
        provider.transport_diagnostics = {"mode": "stream", "phase": "connecting", "receivedBytes": 0}
        result = BlueSkyService(provider, allow_calibration=True).evaluate(payload())
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(result["calls"][0]["transport"]["phase"], "connecting")
        self.assertTrue(all(p["relation"] == "unknown" for p in result["identity"]))

    def test_production_service_disables_calibration_by_default(self):
        provider = FakeProvider(complete())
        with self.assertRaises(ContractError):
            BlueSkyService(provider).evaluate(payload())
        self.assertEqual(provider.calls, [])

    def test_all_template_stages_use_requested_model_despite_stale_environment(self):
        first, second = complete(), complete()
        first["evaluations"][0]["facts"]["curled"] = "unknown"
        provider = FakeProvider(first, second)
        with patch.dict("os.environ", {"ECHOO_FLASH_MODEL": "stale-initial", "ECHOO_PLUS_MODEL": "stale-review"}):
            result = BlueSkyService(provider, allow_calibration=True).evaluate(payload())
        self.assertEqual(provider.calls, ["qwen3.8-flash", "qwen3.8-flash"])
        self.assertEqual([call["stage"] for call in result["calls"]], ["initial", "review"])
        self.assertTrue(all(call["model"] == "qwen3.8-flash" for call in result["calls"]))


if __name__ == "__main__":
    unittest.main()

import copy
import hashlib
import threading
import time
from collections import OrderedDict

from .contracts import (
    CHECKS, THEME_FACTS, SCHEMA_VERSION, canonical_json,
    unknown_result, validate_request, validate_semantics,
)
from .providers import PROMPT_VERSION, ProviderError, moderation_findings
from .models import QWEN_MODEL


def reconcile(first: dict, second: dict) -> dict:
    """Fill unknowns; contradictory positive/negative findings stay pending."""
    result = unknown_result()
    for section, fields in (("findings", CHECKS), ("themeFacts", THEME_FACTS)):
        for field in fields:
            left, right = first[section][field], second[section][field]
            result[section][field] = right if left == "unknown" else left if right == "unknown" or left == right else "unknown"
    return result


class AnalysisService:
    def __init__(self, moderation, semantic, *, clock=time.monotonic):
        self.moderation, self.semantic = moderation, semantic
        self.model = QWEN_MODEL
        self.clock = clock
        self._cache = OrderedDict()
        # A bounded serial gateway avoids duplicate billed requests in the local validation server.
        # The production host can inject a per-key/concurrency-aware scheduler later.
        self._lock = threading.Lock()

    def analyze(self, payload: dict, *, scope="local-development") -> dict:
        image, native = validate_request(payload)
        fingerprint = {
            "policy": payload["policyVersion"], "schema": SCHEMA_VERSION,
            "image": payload["contentDigest"], "native": native,
            "prompt": PROMPT_VERSION, "model": self.model, "review": "same-model-v1",
            "moderation": "postImageCheckByVL:echoo-map-v1",
            "scope": scope,
        }
        key = hashlib.sha256(canonical_json(fingerprint)).hexdigest()
        with self._lock:
            if payload["native"]["privacyFinding"] == "present":
                result = unknown_result()
                result["findings"]["highRiskPrivacy"] = "present"
                return self._envelope(payload, result, ["native-private-exclusion"])
            entry = self._cache.get(key)
            if entry and entry[0] > self.clock():
                self._cache.move_to_end(key)
                return self._envelope(payload, copy.deepcopy(entry[1]), entry[2])
            if entry:
                self._cache.pop(key)
            result, provenance = self._evaluate(image, native)
            # Never cache incomplete analysis or provider failures as successful results.
            if all(v != "unknown" for section in result.values() for v in section.values()):
                self._cache[key] = (self.clock() + 86400, copy.deepcopy(result), list(provenance))
                while len(self._cache) > 200:
                    self._cache.popitem(last=False)
            return self._envelope(payload, result, provenance)

    def _evaluate(self, image: bytes, native: dict) -> tuple[dict, list]:
        provenance = []
        try:
            safety = moderation_findings(self.moderation.analyze(image))
            provenance.append("aliyun:postImageCheckByVL:echoo-map-v1")
        except ProviderError as error:
            return unknown_result(), ["aliyun:" + str(error)]

        first = unknown_result()
        try:
            first = validate_semantics(self.semantic.analyze(image, native, self.model))
            provenance.append("qwen:" + self.model + ":" + PROMPT_VERSION)
        except ProviderError as error:
            provenance.append("qwen-initial:" + str(error))
        except ValueError:
            provenance.append("qwen-initial:invalid_schema")

        needs_review = any(v == "unknown" for section in first.values() for v in section.values()) or any(v == "unknown" for v in safety.values())
        second = None
        if needs_review:
            try:
                second = validate_semantics(self.semantic.analyze(image, native, self.model))
                provenance.append("qwen:" + self.model + ":" + PROMPT_VERSION)
            except ProviderError as error:
                provenance.append("qwen-review:" + str(error))
            except ValueError:
                provenance.append("qwen-review:invalid_schema")
        result = reconcile(first, second) if second is not None else copy.deepcopy(first)
        for field, status in safety.items():
            value = result["findings"][field]
            if value == "present":
                continue
            if status == "unknown":
                # A broad vendor alert requires completed review. A disagreement stays unknown.
                if second is None or second["findings"][field] != "absent" or value != "absent":
                    result["findings"][field] = "unknown"
        return result, provenance

    @staticmethod
    def _envelope(payload: dict, result: dict, provenance: list) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "policyVersion": payload["policyVersion"], "photoID": payload["photoID"],
            "contentDigest": payload["contentDigest"], **result,
            "provenance": list(provenance),
        }

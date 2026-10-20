import base64
import hashlib
import json
import re

SCHEMA_VERSION = "echoo-analysis-v1"
POLICY_VERSION = "echoo-policy-v1"
FINDING_VALUES = {"present", "absent", "unknown"}
CHECKS = (
    "screenshot", "unreadableImage", "extremeBlur", "extremeExposure",
    "informationDominant", "surveillance", "highRiskPrivacy",
    "intimateExposure", "bloodyViolence",
)
THEME_FACTS = (
    "companionAnimalIsSignificant", "zooScene", "preparedFoodOrDrink",
    "wildMushroomsOnDiningTable", "environmentHasDisplayValue",
)
MAX_JPEG_BYTES = 6 * 1024 * 1024
MAX_BODY_BYTES = 9 * 1024 * 1024


class ContractError(ValueError):
    pass


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Validate JPEG framing/dimensions and reject EXIF/XMP instead of forwarding metadata."""
    if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
        raise ContractError("invalid_jpeg")
    index, dimensions = 2, None
    while index < len(data) - 2:
        if data[index] != 0xFF:
            raise ContractError("invalid_jpeg_segment")
        while index < len(data) and data[index] == 0xFF:
            index += 1
        if index >= len(data):
            raise ContractError("invalid_jpeg_segment")
        marker = data[index]
        index += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            continue
        if index + 2 > len(data):
            raise ContractError("invalid_jpeg_segment")
        length = int.from_bytes(data[index:index + 2], "big")
        if length < 2 or index + length > len(data):
            raise ContractError("invalid_jpeg_segment")
        segment = data[index + 2:index + length]
        if marker == 0xE1:
            raise ContractError("metadata_not_allowed")
        if marker in (0xC0, 0xC1, 0xC2):
            if len(segment) < 6:
                raise ContractError("invalid_jpeg_dimensions")
            dimensions = (int.from_bytes(segment[3:5], "big"), int.from_bytes(segment[1:3], "big"))
        if marker == 0xDA:
            break
        index += length
    if dimensions is None or min(dimensions) <= 0 or max(dimensions) > 4096:
        raise ContractError("invalid_jpeg_dimensions")
    return dimensions


def validate_request(payload: dict) -> tuple[bytes, dict]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("unsupported_schema")
    if payload.get("policyVersion") != POLICY_VERSION:
        raise ContractError("unsupported_policy")
    photo_id = payload.get("photoID")
    if not isinstance(photo_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", photo_id):
        raise ContractError("invalid_photo_id")
    encoded = payload.get("jpegBase64")
    if not isinstance(encoded, str) or len(encoded) > 8 * 1024 * 1024:
        raise ContractError("invalid_image_size")
    try:
        image = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ContractError("invalid_base64") from error
    if len(image) > MAX_JPEG_BYTES:
        raise ContractError("invalid_image_size")
    digest = hashlib.sha256(image).hexdigest()
    if payload.get("contentDigest") != digest:
        raise ContractError("digest_mismatch")
    width, height = jpeg_dimensions(image)
    if type(payload.get("width")) is not int or type(payload.get("height")) is not int:
        raise ContractError("invalid_dimensions")
    if (payload["width"], payload["height"]) != (width, height):
        raise ContractError("dimension_mismatch")
    native = payload.get("native")
    if not isinstance(native, dict) or not isinstance(native.get("revision"), str):
        raise ContractError("missing_native_analysis")
    if native.get("privacyFinding") not in FINDING_VALUES:
        raise ContractError("invalid_privacy_finding")
    # Build an explicit allowlist. No raw OCR, paths, timestamps, GPS, or user data goes to a model.
    safe_native = {"revision": native["revision"][:128]}
    for key in ("labels", "animals"):
        entries = native.get(key, [])
        if not isinstance(entries, list) or len(entries) > 64:
            raise ContractError("invalid_native_labels")
        safe_entries = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("identifier"), str):
                raise ContractError("invalid_native_label")
            confidence = entry.get("confidence")
            if type(confidence) not in (int, float) or not 0 <= confidence <= 1:
                raise ContractError("invalid_confidence")
            safe_entries.append({"identifier": entry["identifier"][:100], "confidence": confidence})
        safe_native[key] = safe_entries
    return image, safe_native


def validate_semantics(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {"findings", "themeFacts"}:
        raise ContractError("invalid_semantic_result")
    for section, fields in (("findings", CHECKS), ("themeFacts", THEME_FACTS)):
        values = value[section]
        if not isinstance(values, dict) or set(values) != set(fields):
            raise ContractError("missing_semantic_fields")
        if any(not isinstance(v, str) or v not in FINDING_VALUES for v in values.values()):
            raise ContractError("invalid_semantic_finding")
    return value


def unknown_result() -> dict:
    return {
        "findings": dict.fromkeys(CHECKS, "unknown"),
        "themeFacts": dict.fromkeys(THEME_FACTS, "unknown"),
    }


def canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

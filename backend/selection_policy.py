"""Load selection profiles without coupling photo analysis to visual templates."""

from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(os.environ.get("PHOTOWALL_SELECTION_PROFILES", ROOT / "config" / "selection_profiles.json"))
SCORE_KEYS = ("quality", "aesthetic", "preference", "memory")
FALLBACK = {
    "name": "default",
    "weights": {"quality": 0.25, "aesthetic": 0.20, "preference": 0.35, "memory": 0.20},
    "semantic_diversity": 0.35,
    "event_diversity": 0.12,
}


def _normalized(profile: dict, name: str) -> dict:
    weights = profile.get("weights", {})
    clean = {key: max(0.0, float(weights.get(key, 0.0))) for key in SCORE_KEYS}
    total = sum(clean.values())
    if total <= 0:
        clean, total = dict(FALLBACK["weights"]), 1.0
    return {
        "name": name,
        "weights": {key: value / total for key, value in clean.items()},
        "semantic_diversity": max(0.0, min(1.0, float(profile.get("semantic_diversity", 0.35)))),
        "event_diversity": max(0.0, min(1.0, float(profile.get("event_diversity", 0.12)))),
    }


def load_config() -> dict:
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as source:
            value = json.load(source)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def resolve(template_id: str = "", profile_name: str | None = None) -> dict:
    """Resolve an explicit profile, a template binding, or the global default."""
    config = load_config()
    profiles = config.get("profiles", {})
    bindings = config.get("template_bindings", {})
    name = profile_name or bindings.get(template_id) or config.get("default_profile", "default")
    profile = profiles.get(name)
    if not isinstance(profile, dict):
        return dict(FALLBACK)
    return _normalized(profile, str(name))

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _default_rules_path() -> Path:
    candidates = [
        PROJECT_ROOT / "rules" / "monthly_art_direction_rules_v1.json",
        PROJECT_ROOT
        / "calendar_engine"
        / "rules"
        / "monthly_art_direction_rules_v1.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


DEFAULT_RULES_PATH = _default_rules_path()


def load_art_direction_rules(path: Path | None = None) -> dict[str, Any]:
    source = path or DEFAULT_RULES_PATH
    return json.loads(source.read_text(encoding="utf-8"))


def _contains_any(text: str, keywords: list[str]) -> bool:
    return any(keyword.lower() in text.lower() for keyword in keywords)


def _semantic_text(selected: dict[str, Any], decision: dict[str, Any]) -> str:
    analysis = selected.get("analysis_context", {})
    parts = [
        decision.get("content_type", ""),
        decision.get("main_subject", ""),
        analysis.get("content_type", ""),
        analysis.get("main_subject_hint", ""),
    ]
    return " ".join(str(part) for part in parts if part)


def _text_evidence(selected: dict[str, Any], decision: dict[str, Any]) -> str:
    candidates = selected.get("analysis_context", {}).get("text_candidates", [])
    candidate_text = " ".join(str(item.get("text", "")) for item in candidates)
    return " ".join(
        part
        for part in [
            str(decision.get("short_text", "")),
            str(decision.get("text_source_excerpt", "")),
            candidate_text,
        ]
        if part
    )


def _profile_box(rules: dict[str, Any], profile: str) -> list[float] | None:
    value = rules.get("placement_profiles", {}).get(profile, {}).get("box")
    return list(value) if value else None


def direct_day(
    selected: dict[str, Any],
    decision: dict[str, Any],
    rules: dict[str, Any],
) -> dict[str, Any]:
    original_mode = str(decision.get("treatment_mode", "blank"))
    directive: dict[str, Any] = {
        "treatment_mode": original_mode,
        "placement_profile": "default_cutout" if "cutout" in original_mode else "",
        "reason": "保留单日模型判断。",
        "rule_id": "daily_model_default",
        "overridden": False,
    }

    if not selected.get("sources"):
        evidence = _text_evidence(selected, decision)
        no_photo = rules["no_photo_art_direction"]
        third_party = no_photo["third_party_report_without_personal_emotion"]
        has_third_party_signal = _contains_any(evidence, third_party["signals"])
        has_personal_signal = _contains_any(
            evidence,
            third_party["missing_personal_signals"],
        )
        if has_third_party_signal and not has_personal_signal:
            return {
                "treatment_mode": "blank",
                "placement_profile": "",
                "reason": third_party["reason"],
                "rule_id": "no_photo.third_party_report_without_personal_emotion",
                "overridden": original_mode != "blank",
                "omit_from_render_plan": True,
            }

        health = no_photo["personal_health_state"]
        if _contains_any(evidence, health["signals"]):
            return {
                "treatment_mode": health["treatment_mode"],
                "placement_profile": health["placement_profile"],
                "reason": health["reason"],
                "rule_id": "no_photo.personal_health_state",
                "overridden": original_mode != health["treatment_mode"],
                "illustration_category": health["illustration_category"],
                "illustration_role": health["illustration_role"],
                "illustration_brief": health["illustration_brief"],
                "illustration_asset": f"assets/illustrations/day{int(selected['day']):02d}_health_comfort.png",
            }
        return directive

    semantic = _semantic_text(selected, decision)
    for profile in rules["semantic_profiles"]:
        if not _contains_any(semantic, profile["keywords"]):
            continue
        mode = profile["treatment_mode"]
        placement_profile = profile["placement_profile"]
        result = {
            "treatment_mode": mode,
            "placement_profile": placement_profile,
            "reason": profile["reason"],
            "rule_id": f"semantic.{profile['id']}",
            "overridden": mode != original_mode,
        }
        box = _profile_box(rules, placement_profile)
        if box:
            result["box"] = box
        return result
    return directive


def _family(mode: str, rules: dict[str, Any]) -> str:
    for family, modes in rules["visual_families"].items():
        if mode in modes:
            return family
    return "other"


def _consecutive_rectangular_runs(
    directives: dict[int, dict[str, Any]],
    rules: dict[str, Any],
) -> list[list[int]]:
    maximum = int(rules["monthly_rhythm"]["maximum_consecutive_rectangular_cells"])
    runs: list[list[int]] = []
    current: list[int] = []
    for day in range(1, 32):
        directive = directives.get(day)
        if directive and _family(directive["treatment_mode"], rules) == "rectangular":
            current.append(day)
        else:
            if len(current) > maximum:
                runs.append(current)
            current = []
    if len(current) > maximum:
        runs.append(current)
    return runs


def direct_month(
    selection_days: list[dict[str, Any]],
    decisions: dict[int, dict[str, Any]],
    rules: dict[str, Any] | None = None,
) -> tuple[dict[int, dict[str, Any]], dict[str, Any]]:
    registry = rules or load_art_direction_rules()
    directives = {
        int(selected["day"]): direct_day(
            selected,
            decisions[int(selected["day"])],
            registry,
        )
        for selected in selection_days
    }
    runs = _consecutive_rectangular_runs(directives, registry)
    family_counts = {"rectangular": 0, "organic": 0, "quiet": 0, "other": 0}
    for directive in directives.values():
        family_counts[_family(directive["treatment_mode"], registry)] += 1
    summary = {
        "rules_version": registry["version"],
        "overridden_days": sorted(
            day for day, directive in directives.items() if directive["overridden"]
        ),
        "omitted_blank_days": sorted(
            day
            for day, directive in directives.items()
            if directive.get("omit_from_render_plan")
        ),
        "visual_family_counts": family_counts,
        "consecutive_rectangular_runs_over_limit": runs,
        "status": "PASS" if not runs else "REVIEW",
    }
    return directives, summary

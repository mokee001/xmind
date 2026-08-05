from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.art_direction import direct_month, load_art_direction_rules


PHOTO_LAYOUTS: dict[str, dict[str, Any]] = {
    "proportional_full_image": {
        "kind": "photo",
        "fit": "cover",
        "box": [0.01, 0.01, 0.98, 0.98],
    },
    "non_cell_ratio_image": {
        "kind": "photo",
        "fit": "contain",
        "box": [0.05, 0.03, 0.90, 0.94],
    },
    "circle_image": {
        "kind": "circle",
        "fit": "cover",
        "box": [0.03, 0.06, 0.94, 0.88],
    },
    "oval_image_with_cutout": {
        "kind": "oval",
        "fit": "cover",
        "box": [0.02, 0.09, 0.96, 0.82],
    },
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def clamp(value: float, lower: float, upper: float) -> float:
    return min(upper, max(lower, value))


def focal_from_bbox(decision: dict[str, Any]) -> list[float]:
    bbox = decision.get("subject_bbox") or [0.0, 0.0, 1.0, 1.0]
    if len(bbox) != 4:
        return [0.5, 0.5]
    return [
        round(clamp((float(bbox[0]) + float(bbox[2])) / 2, 0.15, 0.85), 3),
        round(clamp((float(bbox[1]) + float(bbox[3])) / 2, 0.15, 0.85), 3),
    ]


def concise_reason(
    selected: dict[str, Any],
    decision: dict[str, Any],
    directive: dict[str, Any] | None = None,
) -> str:
    reasons = decision.get("reasons") or []
    model_reason = str(reasons[0]).strip() if reasons else ""
    selection_reason = str(selected.get("reason", "")).strip()
    if selection_reason and model_reason:
        reason = f"{selection_reason} Qwen 决策：{model_reason}"
    else:
        reason = selection_reason or model_reason
    if directive and directive.get("overridden"):
        reason += f" 全月艺术指导：{directive['reason']}"
    return reason


def build_photo_day(
    selected: dict[str, Any],
    decision: dict[str, Any],
    directive: dict[str, Any],
) -> dict[str, Any]:
    day = int(selected["day"])
    mode = str(directive["treatment_mode"])
    rotation = round(clamp(float(decision.get("rotation_degrees", 0)), -10, 10), 2)
    if directive.get("overridden") and abs(rotation) < 0.1 and mode in {
        "irregular_cutout",
        "oval_image_with_cutout",
    }:
        rotation = -2.0 if day % 2 else 2.0
    sources = list(selected.get("sources", []))

    if mode in {"irregular_cutout", "irregular_cutout_with_text"}:
        placements: list[dict[str, Any]] = [
            {
                "kind": "cutout",
                "asset": f"assets/cutouts/day{day:02d}.png",
                "box": list(directive.get("box", [-0.06, -0.03, 1.12, 1.06])),
                "rotation": rotation,
            }
        ]
    elif mode == "multi_irregular_cutout":
        placements = []
        boxes = [
            [0.02, 0.05, 0.62, 0.72],
            [0.38, 0.25, 0.60, 0.70],
            [0.18, 0.45, 0.60, 0.52],
        ]
        for index, _source in enumerate(sources[:3]):
            placements.append(
                {
                    "kind": "cutout",
                    "asset": f"assets/cutouts/day{day:02d}_{index + 1}.png",
                    "source_index": index,
                    "box": boxes[index],
                    "rotation": rotation if index == 0 else -rotation,
                }
            )
    else:
        layout = dict(PHOTO_LAYOUTS.get(mode, PHOTO_LAYOUTS["proportional_full_image"]))
        if directive.get("box"):
            layout["box"] = list(directive["box"])
        layout.update(
            {
                "focal": focal_from_bbox(decision),
                "rotation": rotation,
            }
        )
        placements = [layout]
        if mode not in PHOTO_LAYOUTS:
            mode = "proportional_full_image"

    result = {
        "day": day,
        "sources": sources,
        "treatment": mode,
        "reason": concise_reason(selected, decision, directive),
        "qwen_confidence": decision.get("confidence"),
        "qwen_fallback_treatment": decision.get("fallback_treatment_mode"),
        "placements": placements,
        "art_direction": {
            "rule_id": directive["rule_id"],
            "overridden": directive["overridden"],
            "placement_profile": directive.get("placement_profile", ""),
        },
    }
    if mode == "irregular_cutout_with_text":
        result["placements"].append(
            {
                "kind": "text",
                "text": str(decision.get("short_text", ""))[:14],
                "design_font_size": 8,
                "font_size": 22,
                "maximum_lines": 2,
                "box": [0.05, 0.72, 0.90, 0.20],
                "rotation": 0,
            }
        )
    return result


def build_no_photo_day(
    selected: dict[str, Any],
    decision: dict[str, Any],
    directive: dict[str, Any],
) -> dict[str, Any]:
    day = int(selected["day"])
    mode = str(directive["treatment_mode"])
    text = str(decision.get("short_text", "")).strip()
    result: dict[str, Any] = {
        "day": day,
        "sources": [],
        "evidence_sources": list(selected.get("evidence_sources", [])),
        "treatment": mode,
        "reason": concise_reason(selected, decision, directive),
        "qwen_confidence": decision.get("confidence"),
        "qwen_fallback_treatment": decision.get("fallback_treatment_mode"),
        "art_direction": {
            "rule_id": directive["rule_id"],
            "overridden": directive["overridden"],
            "placement_profile": directive.get("placement_profile", ""),
        },
    }
    if mode == "illustration_with_text":
        result.update(
            {
                "illustration_style_id": "journal_line_doodle_v1",
                "illustration_framing": "close_up_or_single_focus",
                "human_full_body": False,
                "illustration_role": directive.get(
                    "illustration_role",
                    decision.get("illustration_role", "event"),
                ),
                "illustration_category": directive.get(
                    "illustration_category",
                    decision.get("illustration_category", ""),
                ),
                "illustration_brief": directive.get(
                    "illustration_brief",
                    decision.get("illustration_brief", ""),
                ),
                "illustration_backend": "pending_asset_generation",
                "illustration_api_note": "实际插画提供方由后续资产生成步骤记录；本字段不预判 API 成功或本地回退。",
                "placements": [
                    {
                        "kind": "illustration",
                        "asset": directive.get(
                            "illustration_asset",
                            f"assets/illustrations/day{day:02d}_cat_closeup.png",
                        ),
                        "box": [0.08, 0.03, 0.84, 0.60],
                        "rotation": 0,
                    },
                    {
                        "kind": "text",
                        "text": text[:14],
                        "design_font_size": 8,
                        "font_size": 22,
                        "maximum_lines": 2,
                        "box": [0.05, 0.70, 0.90, 0.22],
                        "rotation": 0,
                    },
                ],
            }
        )
        return result

    if mode == "illustration_only":
        result.update(
            {
                "illustration_style_id": "journal_line_doodle_v1",
                "illustration_framing": "close_up_or_single_focus",
                "human_full_body": False,
                "illustration_role": decision.get("illustration_role", "decorative"),
                "placements": [
                    {
                        "kind": "illustration",
                        "asset": f"assets/illustrations/day{day:02d}.png",
                        "box": [0.08, 0.06, 0.84, 0.84],
                        "rotation": 0,
                    }
                ],
            }
        )
        return result

    result["treatment"] = "text_only"
    result["placements"] = [
        {
            "kind": "text",
            "text": text[:24],
            "design_font_size": 10,
            "font_size": 26,
            "maximum_lines": 5,
            "box": [0.06, 0.08, 0.88, 0.84],
            "rotation": 0,
        }
    ]
    return result


def build_plan(run_dir: Path) -> dict[str, Any]:
    selection = read_json(run_dir / "selection.json")
    decisions: dict[int, dict[str, Any]] = {}
    payloads: dict[int, dict[str, Any]] = {}
    for selected in selection["days"]:
        day = int(selected["day"])
        payload = read_json(run_dir / "api_decisions" / f"day{day:02d}.json")
        payloads[day] = payload
        decisions[day] = payload["decision"]

    art_rules = load_art_direction_rules()
    directives, art_summary = direct_month(selection["days"], decisions, art_rules)
    days: list[dict[str, Any]] = []
    for selected in selection["days"]:
        day = int(selected["day"])
        payload = payloads[day]
        decision = decisions[day]
        directive = directives[day]
        if directive.get("omit_from_render_plan"):
            continue
        if selected.get("sources"):
            day_plan = build_photo_day(selected, decision, directive)
        else:
            day_plan = build_no_photo_day(selected, decision, directive)
        day_plan["qwen_metadata"] = {
            "response_id": payload.get("metadata", {}).get("response_id"),
            "model": payload.get("metadata", {}).get("model"),
            "rules_version": payload.get("metadata", {}).get("rules_version"),
        }
        days.append(day_plan)

    return {
        "schema_version": "1.2",
        "calendar": {
            "year": 2026,
            "month": 7,
            "week_start": "sunday",
            "template": "../../calendar_engine/templates/calendar_template_v1",
        },
        "decision": {
            "backend": "qwen3.8-max_then_gpt_style_art_direction",
            "api_used": True,
            "processing": "selected_work_copies_and_text_context_only",
            "treatment_rules_version": "2.0",
            "monthly_art_direction_rules_version": art_rules["version"],
            "primary_goal": "aesthetic_life_journal",
            "cutout_style": {"white_outline": False, "shadow": False},
            "illustration_backend": "pending_asset_generation",
            "art_direction_summary": art_summary,
        },
        "days": sorted(days, key=lambda item: item["day"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    run_dir = args.run_dir.expanduser().resolve()
    output = run_dir / "treatment_plan.json"
    plan = build_plan(run_dir)
    write_json(output, plan)
    write_json(
        run_dir / "art_direction_summary.json",
        plan["decision"]["art_direction_summary"],
    )
    print(output)


if __name__ == "__main__":
    main()

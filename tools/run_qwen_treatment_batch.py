from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.analyzer import analyze_day  # noqa: E402


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="只将 selection.json 中已入选的素材逐日发送给已配置决策后端。"
    )
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    run_dir = args.run_dir.expanduser().resolve()
    selection = read_json(run_dir / "selection.json")
    output_dir = run_dir / "api_decisions"
    completed: list[int] = []
    actual_backend = ""
    actual_model = ""
    actual_mode = ""

    for item in sorted(selection["days"], key=lambda entry: entry["day"]):
        day = int(item["day"])
        output_path = output_dir / f"day{day:02d}.json"
        if args.resume and output_path.exists():
            existing = read_json(output_path).get("metadata", {})
            actual_backend = str(existing.get("backend", actual_backend))
            actual_model = str(existing.get("model", actual_model))
            actual_mode = str(existing.get("decision_mode", actual_mode))
            completed.append(day)
            print(f"7/{day}: 已存在，跳过")
            continue

        image_paths = [run_dir / source for source in item.get("sources", [])]
        decision, metadata = analyze_day(
            image_paths,
            PROJECT_ROOT,
            existing_analysis=item.get("analysis_context"),
        )
        actual_backend = str(metadata.get("backend", actual_backend))
        actual_model = str(metadata.get("model", actual_model))
        actual_mode = str(metadata.get("decision_mode", actual_mode))
        write_json(
            output_path,
            {
                "metadata": metadata,
                "selection": {
                    "day": day,
                    "sources": item.get("sources", []),
                    "evidence_sources": item.get("evidence_sources", []),
                    "reason": item.get("reason", ""),
                },
                "decision": decision.model_dump(mode="json"),
            },
        )
        completed.append(day)
        print(
            f"7/{day}: {decision.treatment_mode.value} "
            f"(confidence={decision.confidence:.2f})"
        )

    write_json(
        output_dir / "batch_summary.json",
        {
            "backend": actual_backend,
            "model": actual_model,
            "mode": actual_mode,
            "selected_only": True,
            "completed_days": completed,
            "completed_count": len(completed),
        },
    )


if __name__ == "__main__":
    main()

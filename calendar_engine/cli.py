from __future__ import annotations

import argparse
import json
from pathlib import Path

from .generator import GenerationError, generate_july_calendar


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="calendar-engine",
        description="从已准备好的决策计划生成 2026 年 7 月手帐日历",
    )
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--template-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--final-name",
        default="2026年7月_AI手帐日历.png",
    )
    parser.add_argument(
        "--preview-name",
        default="2026年7月_AI手帐日历_预览.jpg",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = generate_july_calendar(
            args.run_dir,
            template_dir=args.template_dir,
            output_path=args.output,
            final_name=args.final_name,
            preview_name=args.preview_name,
        )
    except GenerationError as error:
        print(json.dumps({"status": "FAIL", "error": str(error)}, ensure_ascii=False))
        return 1

    print(
        json.dumps(
            {
                "status": "PASS",
                "calendar_path": str(result.calendar_path),
                "preview_path": str(result.preview_path),
                "qa_report_path": str(result.qa_report_path),
            },
            ensure_ascii=False,
        )
    )
    return 0

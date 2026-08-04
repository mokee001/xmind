from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.qwen_image import generate_calendar_illustration  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生成一个 journal_line_doodle_v1 日历格插画。"
    )
    parser.add_argument("brief", help="来自处理决策的 illustration_brief")
    parser.add_argument(
        "--reference",
        action="append",
        default=[],
        type=Path,
        help="可选参考图，最多传 3 次。",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "outputs" / "generated_illustration.png",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = generate_calendar_illustration(
        args.brief,
        args.output,
        PROJECT_ROOT,
        reference_paths=args.reference,
    )
    print()
    print(f"模型：{result.model}")
    print(f"尺寸：{result.size[0]} x {result.size[1]}")
    print(f"结果：{result.output_path}")
    print()


if __name__ == "__main__":
    main()

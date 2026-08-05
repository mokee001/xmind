from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_engine.decoration import build_decoration_plan


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a sparse semantic dynamic-sticker plan for a prepared July run."
    )
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--maximum-decorated-cells", type=int, default=5)
    parser.add_argument(
        "--no-abstract-blank",
        action="store_true",
        help="Do not add one generic abstract sticker to an eligible blank date.",
    )
    args = parser.parse_args()
    plan = build_decoration_plan(
        args.run_dir,
        maximum_decorated_cells=args.maximum_decorated_cells,
        include_abstract_blank=not args.no_abstract_blank,
    )
    print(args.run_dir.expanduser().resolve() / "decoration_plan.json")
    print(
        "dynamic sticker days:",
        [item["owner_day"] for item in plan["dynamic_layer"]["items"]],
    )


if __name__ == "__main__":
    main()

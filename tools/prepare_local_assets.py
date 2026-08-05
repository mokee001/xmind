from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_engine.local_assets import prepare_local_assets  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        description="使用 macOS Vision 和内置线描种子准备本地日历执行资产。"
    )
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    report = prepare_local_assets(args.run_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

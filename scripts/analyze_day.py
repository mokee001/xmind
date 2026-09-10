from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

from openai import AuthenticationError, RateLimitError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.analyzer import analyze_day  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="为一个日期的 0-3 张素材、文字线索和布局上下文生成处理计划。"
    )
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument(
        "--analysis-json",
        type=Path,
        help="可选：原有视觉理解结果 JSON。",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "outputs" / "day_treatment_decision.json",
    )
    return parser.parse_args()


def load_existing_analysis(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    args = parse_args()
    if len(args.images) > 3:
        raise SystemExit("\n一个日期最多只能输入 3 张已入选素材。\n")
    if not args.images and not args.analysis_json:
        raise SystemExit(
            "\n无图片日期必须通过 --analysis-json 提供文字线索或布局上下文。\n"
        )

    existing_analysis = (
        load_existing_analysis(args.analysis_json)
        if args.analysis_json
        else None
    )
    try:
        decision, metadata = analyze_day(
            args.images,
            PROJECT_ROOT,
            existing_analysis=existing_analysis,
        )
    except AuthenticationError:
        raise SystemExit(
            "\n密钥未通过验证。请重新运行对应的密钥配置文件。\n"
        )
    except RateLimitError as exc:
        if "insufficient_quota" in str(exc):
            raise SystemExit(
                "\n密钥已读取，但 API 账户没有可用额度。"
                "\n请在对应平台检查额度，等待几分钟后再试。\n"
            )
        raise SystemExit("\n请求频率暂时受限，请稍后重试。\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": metadata,
        "decision": decision.model_dump(mode="json"),
    }
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print()
    print(f"建议处理：{decision.treatment_mode.value}")
    print(f"备选处理：{decision.fallback_treatment_mode.value}")
    print(f"素材数量：{len(decision.selected_asset_indices)}")
    print(f"置信度：{decision.confidence:.2f}")
    print(f"结果：{args.output}")
    print()


if __name__ == "__main__":
    main()

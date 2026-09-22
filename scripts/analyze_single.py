from __future__ import annotations

import json
import argparse
import sys
from pathlib import Path

from openai import AuthenticationError, RateLimitError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.analyzer import analyze_image  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="分析一张代表性照片的处理方式。")
    parser.add_argument("image", type=Path)
    return parser.parse_args()


def main() -> None:
    image_path = parse_args().image.expanduser()
    try:
        decision, metadata = analyze_image(image_path, PROJECT_ROOT)
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

    output_dir = PROJECT_ROOT / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "single_image_decision.json"
    payload = {
        "metadata": metadata,
        "decision": decision.model_dump(mode="json"),
    }
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print()
    print(f"照片：{image_path.name}")
    print(f"建议处理：{decision.treatment_mode.value}")
    print(f"备选处理：{decision.fallback_treatment_mode.value}")
    print(f"置信度：{decision.confidence:.2f}")
    print(f"结果：{output_path}")
    print()


if __name__ == "__main__":
    main()

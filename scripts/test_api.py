from __future__ import annotations

import os
import sys
from pathlib import Path

from openai import APIConnectionError, AuthenticationError, OpenAI, RateLimitError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_ai.keychain import load_api_key  # noqa: E402
from calendar_ai.analyzer import load_config  # noqa: E402


def main() -> None:
    config = load_config(PROJECT_ROOT)
    backend = str(config.get("decision_backend", "qwen")).strip().lower()
    if backend == "qwen":
        model = config["qwen_decision_model"]
        base_url = (
            os.environ.get("QWEN_DECISION_BASE_URL", "").strip()
            or config["qwen_decision_base_url"]
        )
        client = OpenAI(
            api_key=load_api_key("qwen_decision"),
            base_url=base_url,
            timeout=float(config.get("api_timeout_seconds", 180)),
        )
    else:
        model = config["openai_decision_model"]
        client = OpenAI(api_key=load_api_key("openai"))
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "user", "content": "只回复：API 连接成功"},
            ],
            extra_body={"enable_thinking": False} if backend == "qwen" else {},
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
    except APIConnectionError as exc:
        raise SystemExit(f"\n无法连接 API 服务：{exc}\n")
    print()
    print(f"后端：{backend}")
    print(f"模型：{model}")
    print((response.choices[0].message.content or "").strip())
    print()


if __name__ == "__main__":
    main()

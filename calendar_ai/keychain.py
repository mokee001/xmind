from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class CredentialSpec:
    environment_variable: str
    keychain_service: str
    setup_command: str


CREDENTIALS = {
    "openai": CredentialSpec(
        environment_variable="OPENAI_API_KEY",
        keychain_service="AI手帐日历 OpenAI API",
        setup_command="配置OpenAI密钥.command",
    ),
    "qwen_decision": CredentialSpec(
        environment_variable="QWEN_DECISION_API_KEY",
        keychain_service="AI手帐日历 Qwen Decision API",
        setup_command="配置Qwen密钥.command",
    ),
    "qwen_image": CredentialSpec(
        environment_variable="QWEN_IMAGE_API_KEY",
        keychain_service="AI手帐日历 Qwen Image API",
        setup_command="配置Qwen密钥.command",
    ),
}


def load_api_key(provider: str = "openai") -> str:
    try:
        credential = CREDENTIALS[provider]
    except KeyError as error:
        raise ValueError(f"未知 API 凭证类型：{provider}") from error

    env_key = os.environ.get(credential.environment_variable, "").strip()
    if env_key:
        return env_key

    result = subprocess.run(
        [
            "security",
            "find-generic-password",
            "-a",
            os.environ.get("USER", ""),
            "-s",
            credential.keychain_service,
            "-w",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise RuntimeError(
            f"尚未找到 {provider} API Key。"
            f"请先双击“{credential.setup_command}”。"
        )
    return key

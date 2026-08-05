#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo
echo "正在安装 AI 手帐日历 API 运行环境..."
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

echo
echo "安装完成。"
echo "本地模型不需要 API Key：请启动 Ollama 后双击“测试API连接.command”。"
echo "只有切换到云端 Qwen 时，才需要双击“配置Qwen密钥.command”。"
echo
read -r "?按回车关闭窗口..."

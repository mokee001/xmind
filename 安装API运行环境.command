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
echo "安装完成。下一步请双击“配置Qwen密钥.command”。"
echo
read -r "?按回车关闭窗口..."

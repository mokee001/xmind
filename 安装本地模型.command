#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

MODEL="qwen3-vl:4b-instruct"

echo
echo "正在准备 AI 手帐日历本地模型环境..."

if ! command -v brew >/dev/null 2>&1; then
  echo "没有检测到 Homebrew。请先安装 Homebrew，再重新运行此文件。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "正在安装 Ollama..."
  brew install ollama
fi

echo "正在启动 Ollama..."
brew services start ollama >/dev/null

echo "正在下载本地视觉模型 ${MODEL}。首次下载约 3.3 GB..."
ollama pull "$MODEL"

echo "正在创建项目独立 Python 环境..."
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

echo
echo "正在执行连接自检..."
.venv/bin/python scripts/test_api.py

echo "本地模型工作流安装完成。模型权重保存在 Ollama 中，不在 Git 仓库内。"
echo
read -r "?按回车关闭窗口..."

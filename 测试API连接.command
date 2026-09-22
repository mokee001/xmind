#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "请先双击“安装API运行环境.command”。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

.venv/bin/python scripts/test_api.py
read -r "?按回车关闭窗口..."

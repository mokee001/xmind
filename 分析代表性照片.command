#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "请先双击“安装API运行环境.command”。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

echo
echo "请把一张代表性照片拖入此窗口，然后按回车。"
read -r "?照片路径: " IMAGE_PATH
IMAGE_PATH=${(Q)IMAGE_PATH}

if [[ -z "$IMAGE_PATH" || ! -f "$IMAGE_PATH" ]]; then
  echo "没有找到这张照片。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

.venv/bin/python scripts/analyze_single.py "$IMAGE_PATH"
read -r "?按回车关闭窗口..."

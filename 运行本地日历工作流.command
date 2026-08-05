#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "请先双击“安装本地模型.command”。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

RUN_DIR="${1:-}"
if [[ -z "$RUN_DIR" ]]; then
  echo "请输入已包含 manifest.json 和 selection.json 的运行目录："
  read -r RUN_DIR
fi

.venv/bin/python scripts/run_local_calendar_workflow.py \
  --run-dir "$RUN_DIR" \
  --resume

echo
read -r "?按回车关闭窗口..."

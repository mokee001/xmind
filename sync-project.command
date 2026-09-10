#!/usr/bin/env bash

COMMAND_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
"$COMMAND_DIR/scripts/sync-project.sh"
RESULT=$?

echo
if [[ $RESULT -eq 0 ]]; then
  echo "项目已同步。"
else
  echo "项目未同步，退出代码：$RESULT"
fi

if [[ -t 0 ]]; then
  read -r -p "按回车键关闭窗口…" _
fi

exit "$RESULT"

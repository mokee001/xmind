#!/bin/zsh
set -euo pipefail

DECISION_SERVICE="AI手帐日历 Qwen Decision API"
IMAGE_SERVICE="AI手帐日历 Qwen Image API"

echo
echo "请输入刚刚轮换后的 Qwen3.8-Max API Key。输入过程不会显示字符。"
read -rs "?决策 Key: " DECISION_KEY
echo

if [[ -z "$DECISION_KEY" ]]; then
  echo "没有输入决策 Key，已取消。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

echo
echo "请输入刚刚轮换后的 Qwen-Image-3.0-Pro API Key。"
read -rs "?插画 Key: " IMAGE_KEY
echo

if [[ -z "$IMAGE_KEY" ]]; then
  echo "没有输入插画 Key，已取消；未写入任何密钥。"
  unset DECISION_KEY
  read -r "?按回车关闭窗口..."
  exit 1
fi

security add-generic-password \
  -U \
  -a "$USER" \
  -s "$DECISION_SERVICE" \
  -w "$DECISION_KEY" >/dev/null

security add-generic-password \
  -U \
  -a "$USER" \
  -s "$IMAGE_SERVICE" \
  -w "$IMAGE_KEY" >/dev/null

unset DECISION_KEY IMAGE_KEY
echo
echo "两枚密钥已安全保存到 macOS 钥匙串，不会写入项目文件。"
echo "下一步请双击“测试API连接.command”测试决策模型。"
echo
read -r "?按回车关闭窗口..."

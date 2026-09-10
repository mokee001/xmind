#!/usr/bin/env bash

set -u

TARGET_BRANCH="${PHOTO_WALL_BRANCH:-hardware/waveshare-eink-spectra6}"
REMOTE_NAME="${PHOTO_WALL_REMOTE:-origin}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"

if [[ -z "$REPO_ROOT" ]]; then
  echo "错误：没有找到 photo-wall Git 仓库。"
  exit 1
fi

cd "$REPO_ROOT" || exit 1

echo "Photo Wall 项目同步"
echo "仓库：$REPO_ROOT"
echo "目标：$REMOTE_NAME/$TARGET_BRANCH"
echo

echo "1/4 获取 GitHub 最新记录…"
if ! git fetch --prune "$REMOTE_NAME"; then
  echo
  echo "同步失败：无法访问 GitHub。请检查网络或 GitHub 登录状态。"
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
DIRTY_STATUS="$(git status --porcelain)"

if [[ "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
  if [[ -n "$DIRTY_STATUS" ]]; then
    echo
    echo "检测到未提交内容，已停止切换分支，任何文件都没有被覆盖："
    git status --short
    echo
    echo "请先提交修改，或让 Codex 创建可恢复快照后再同步。"
    exit 2
  fi

  echo "2/4 切换到统一分支 $TARGET_BRANCH…"
  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    git switch "$TARGET_BRANCH" || exit 1
  else
    git switch --track -c "$TARGET_BRANCH" "$REMOTE_NAME/$TARGET_BRANCH" || exit 1
  fi
else
  echo "2/4 当前已经位于统一分支。"
fi

DIRTY_STATUS="$(git status --porcelain)"
if [[ -n "$DIRTY_STATUS" ]]; then
  echo
  echo "检测到未提交内容，已获取远端记录但没有合并："
  git status --short
  echo
  echo "请先提交修改，或让 Codex 创建可恢复快照后再同步。"
  exit 2
fi

echo "3/4 安全快进到远端最新提交…"
if ! git merge --ff-only "$REMOTE_NAME/$TARGET_BRANCH"; then
  echo
  echo "同步停止：本地和远端已经分叉，需要先检查提交，未执行强制覆盖。"
  exit 3
fi

echo "4/4 检查结果…"
echo
git status --short --branch
echo
echo "当前提交："
git log -1 --format='%H%n%s%n%ci'

STASH_COUNT="$(git stash list | wc -l | tr -d ' ')"
if [[ "$STASH_COUNT" != "0" ]]; then
  echo
  echo "提醒：本机还有 $STASH_COUNT 个可恢复快照（stash），它们不会同步到其他电脑。"
fi

echo
echo "最近 5 次提交："
git log -5 --oneline --decorate

if [[ -f "$REPO_ROOT/docs/PROJECT_STATUS.md" ]]; then
  echo
  echo "项目状态文件：$REPO_ROOT/docs/PROJECT_STATUS.md"
fi

echo
echo "同步完成，可以开始工作。"

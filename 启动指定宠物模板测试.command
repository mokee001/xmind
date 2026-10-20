#!/bin/zsh
set -eu
umask 077
ENGINE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$ENGINE_DIR"
CONFIGURATION="$ENGINE_DIR/local-data/target-pet-test.json"
if [ ! -f "$CONFIGURATION" ]; then
  echo "尚未配置本轮目标宠物测试，请先准备本地测试配置。"
  exit 1
fi
mkdir -p .build/module-cache
export CLANG_MODULE_CACHE_PATH="$ENGINE_DIR/.build/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ENGINE_DIR/.build/module-cache"
swift build --product echoo-calibrate --scratch-path .build --cache-path .build/cache --config-path .build/config --security-path .build/security --disable-sandbox
cd gateway
python3 -B -m echoo_gateway.target_pet --configuration "$CONFIGURATION"

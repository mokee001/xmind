#!/bin/zsh
set -eu
umask 077
ENGINE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$ENGINE_DIR"
OUTPUT_PATH="$ENGINE_DIR/local-data/blue-sky-calibration"
if [ "$#" -ge 1 ]; then
  LIBRARY_PATH="$1"
elif [ -f "$ENGINE_DIR/local-data/calibration-source.txt" ]; then
  IFS= read -r LIBRARY_PATH < "$ENGINE_DIR/local-data/calibration-source.txt"
else
  read -r "LIBRARY_PATH?请输入本次测试照片文件夹的完整路径："
fi
if [ "$#" -ge 2 ]; then OUTPUT_PATH="$2"; fi
mkdir -p .build/module-cache
export CLANG_MODULE_CACHE_PATH="$ENGINE_DIR/.build/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ENGINE_DIR/.build/module-cache"
echo "正在准备蓝天绿地选片测试。照片只读；本地预览准备完成前不会调用 API。"
swift build --product echoo-calibrate --scratch-path .build --cache-path .build/cache --config-path .build/config --security-path .build/security --disable-sandbox
cd gateway
python3 -B -m echoo_gateway.calibration --library "$LIBRARY_PATH" --output "$OUTPUT_PATH"

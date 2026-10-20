#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENGINE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ENGINE_DIR"
mkdir -p .build/module-cache
export CLANG_MODULE_CACHE_PATH="$ENGINE_DIR/.build/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ENGINE_DIR/.build/module-cache"
# This disables SwiftPM's nested manifest sandbox, not the host's workspace sandbox.
swift test --scratch-path .build --cache-path .build/cache --config-path .build/config --security-path .build/security --disable-sandbox

#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENGINE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ENGINE_DIR"
SDK_PATH=$(xcrun --sdk iphonesimulator --show-sdk-path)
mkdir -p .build/ios-check .build/module-cache
swiftc -swift-version 5 -target arm64-apple-ios17.0-simulator -sdk "$SDK_PATH" -module-cache-path .build/module-cache -emit-module -module-name EchooCore Sources/EchooCore/*.swift -emit-module-path .build/ios-check/EchooCore.swiftmodule
swiftc -swift-version 5 -target arm64-apple-ios17.0-simulator -sdk "$SDK_PATH" -module-cache-path .build/module-cache -I .build/ios-check -emit-module -module-name EchooApple Sources/EchooApple/*.swift -emit-module-path .build/ios-check/EchooApple.swiftmodule
swiftc -swift-version 5 -target arm64-apple-ios17.0-simulator -sdk "$SDK_PATH" -module-cache-path .build/module-cache -I .build/ios-check -emit-module -module-name EchooGateway Sources/EchooGateway/*.swift -emit-module-path .build/ios-check/EchooGateway.swiftmodule
printf '%s\n' 'iOS 17 simulator module compilation passed.'

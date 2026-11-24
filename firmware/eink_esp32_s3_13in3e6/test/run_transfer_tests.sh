#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build=$(mktemp -d "${TMPDIR:-/tmp}/photowall-transfer.XXXXXX")
trap 'rm -rf "$build"' EXIT HUP INT TERM
compile() {
  "${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -fno-omit-frame-pointer -Itest/native -Isrc "$@"
}
for test in test_device_buttons test_device_button_matrix; do
  compile "test/native/$test.cpp" src/device_buttons.cpp -o "$build/$test"
  "$build/$test"
done
compile -DPHOTOWALL_AUDIO_BACKEND=4 -DPHOTOWALL_AUDIO_VOLUME_PERCENT=64 \
  test/native/test_i2s_audio.cpp src/device_audio.cpp src/board_es8311.cpp -o "$build/audio"
"$build/audio"
compile ../../tests/frame_reader_test.cpp -o "$build/frame"
"$build/frame"
node test/extract_control_functions.mjs src/main.cpp test/native/test_transfer_controls.cpp "$build/controls.cpp"
compile "$build/controls.cpp" src/device_buttons.cpp -o "$build/controls"
"$build/controls"
node test/extract_control_functions.mjs src/ble_provisioning.cpp test/native/test_ble_confirmation.cpp "$build/ble.cpp"
compile -I"${ARDUINOJSON_DIR:-.pio/libdeps/waveshare_e6/ArduinoJson}/src" "$build/ble.cpp" -o "$build/ble"
"$build/ble"
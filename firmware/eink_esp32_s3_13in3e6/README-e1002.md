# PhotoWall on Seeed reTerminal E1002

Version `0.3.7-e1002.1`, based on hardware branch commit
`82d194c19df5698ebf7d5e3880d3ec3496a24597` (PhotoWall `0.3.6`).

## Hardware

- ESP32-S3, 32MB QSPI Flash, 8MB octal PSRAM, USB UART logging at 115200.
- 800×480 six-color ED2208 panel: SCK 7, MOSI 9, CS 10, DC 11, RESET 12, BUSY 13.
- Hold the **green button (GPIO3)** when the App requests physical confirmation.
  Holding this button for 8 seconds during startup resets only PhotoWall settings.
- Original Waveshare target stays available as `waveshare_e6`; this driver and
  hardware profile are selected only by the `reterminal_e1002` build environment.

Driver initialization follows [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX)
commit `0dfdd7135425be82b5bb4b4b58d74dd51ab29a59`, specifically
`User_Setups/Setup521_Seeed_reTerminal_E1002.h` and `TFT_Drivers/ED2208_Init.h`.
See `licenses/Seeed_GFX.txt` for retained upstream notices.
The green button mapping is documented in
[Seeed's peripheral cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_esphome_advanced/).

## Protocol compatibility

Existing BLE UUIDs, device identity, bootstrap/claim, Wi-Fi configuration, cloud
polling and local HTTP endpoints are retained. The E1002 recognizes both:

- Native PWE6 v1: 800×480, 192000 payload bytes + 45-byte header.
- Existing App/cloud PWE6 v1: 1200×1600, 960000 payload bytes + 45-byte header.

Dimensions, payload length, SHA-256 and all six valid palette codes are checked.
Portrait legacy frames are scaled to 360×480 centered with 220px white margins
on each side. Nearest-neighbor sampling preserves the already-quantized palette;
it cannot reproduce the quality of dithering directly at native resolution.
Pixels are converted from PWE6's low-nibble-first order to the controller's
high-nibble-first order. Native frames preserve all 800×480 pixels.

`GET /status` adds `model`, `width`, and `height`. Screen success is reported only
after BUSY has asserted and released during refresh. Timeout returns an error.
This firmware retains the existing always-on Wi-Fi/BLE workflow; it does not
implement the factory firmware's battery-saving deep-sleep scheduler.
Factory SenseCraft Wi-Fi credentials are retained in flash but are not imported
into PhotoWall; first PhotoWall use requires pairing/provisioning in the App.

## Build and flash

```sh
python3 -m platformio run -e reterminal_e1002
```

This device's factory partition layout uses NVS at `0x9000..0xefff`. PlatformIO's
usual upload writes `boot_app0.bin` at `0xe000`, so the E1002 environment explicitly
blocks ordinary upload/erase commands. **Use the guarded uploader**, passing the
actual device MAC, port, complete 32MB pre-flash backup and its recorded checksum:

```sh
python3 tools/flash_e1002.py --port /dev/cu.usbserial-10 \
  --mac dc:b4:d9:38:8a:8c --backup /absolute/path/before-flash-32mb.bin \
  --backup-sha256 CHECKSUM_FROM_BACKUP_RECORD \
  --esptool /absolute/path/to/esptool.py
```

The tool verifies the backup, device MAC, flash capacity and live partition
layout. It writes only bootloader at `0x0` and application at `0x10000`, validates
the written hashes, and leaves the chip in its loader for a monitored reset.
The original partition table, NVS, PHY and storage remain intact. Preserve the
backup locally; it contains device credentials. To restore, use the verified
original complete backup with esptool at address `0x0` for this same MAC.

## Verification

Host regression checks (from repository root):

```sh
c++ -std=c++17 -fsanitize=address,undefined -DPHOTOWALL_RETERMINAL_E1002=1 \
  -I firmware/eink_esp32_s3_13in3e6/src tests/e1002_frame_format_test.cpp \
  -o /tmp/e1002-frame-test && /tmp/e1002-frame-test
```

Repeat without `-DPHOTOWALL_RETERMINAL_E1002=1` to verify the legacy target
rejects E1002 dimensions. Build `waveshare_e6` to check source compatibility.

E1002 USB UART maintenance commands (115200 baud, newline terminated):

- `PHOTOWALL STATUS`: print mode, frame state, PSRAM size and green button level.
- `PHOTOWALL TEST`: queue one full-screen six-color test, black / white / yellow /
  red / blue / green from top to bottom. It runs only on explicit command and
  never automatically at boot. Avoid repeated e-paper refreshes.

The local release record in `outputs/e1002-release-20260922/` distinguishes build,
write verification, boot, panel BUSY evidence, and any remaining App-level tests.

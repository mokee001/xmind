#pragma once
#include <stdint.h>

namespace photowall {
#ifdef PHOTOWALL_RETERMINAL_E1002
constexpr uint8_t kConfirmationButton = 3;
constexpr char kConfirmationPrompt[] = "请按住设备绿色键确认配网";
constexpr char kHardwareModel[] = "seeed-reterminal-e1002";
constexpr char kFirmwareVersion[] = "0.3.7-e1002.1";
#else
constexpr uint8_t kConfirmationButton = 0;
constexpr char kConfirmationPrompt[] = "请按住设备 BOOT 键确认配网";
constexpr char kHardwareModel[] = "waveshare-13in3e6";
constexpr char kFirmwareVersion[] = "0.3.6";
#endif
}

#pragma once

#include <Arduino.h>

namespace photowall {

constexpr uint8_t kExternalButtonPin = 40;
constexpr uint8_t kBootButtonPin = 0;
constexpr uint32_t kButtonDebounceMs = 30;
constexpr uint32_t kPowerOnHoldMs = 2000;
constexpr uint32_t kPowerOffHoldMs = 3000;

enum class DeviceButtonEvent : uint8_t { None, PowerOn, PowerOff, Confirm };

struct ButtonClick {
	uint32_t pressedAt;
	uint32_t releasedAt;
};

void beginDeviceButtons(bool poweredOn = false);
void pollDeviceButtons();
bool deviceButtonPressed();
bool externalButtonPressed();
bool bootButtonPressed();
void setDeviceButtonsPoweredOn(bool poweredOn);
DeviceButtonEvent takeDeviceButtonEvent(ButtonClick* click = nullptr);
bool devicePowerOffPending();
bool deviceConfirmationPending();

}  // namespace photowall

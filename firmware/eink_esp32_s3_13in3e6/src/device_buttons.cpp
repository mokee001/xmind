#include "device_buttons.h"

#include <cstddef>

#if defined(ARDUINO_ARCH_ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#endif

namespace photowall {
namespace {

class ButtonLock {
 public:
  ButtonLock() {
#if defined(ARDUINO_ARCH_ESP32)
    portENTER_CRITICAL(&mux_);
#endif
  }
  ~ButtonLock() {
#if defined(ARDUINO_ARCH_ESP32)
    portEXIT_CRITICAL(&mux_);
#endif
  }

 private:
#if defined(ARDUINO_ARCH_ESP32)
  static portMUX_TYPE mux_;
#endif
};

#if defined(ARDUINO_ARCH_ESP32)
portMUX_TYPE ButtonLock::mux_ = portMUX_INITIALIZER_UNLOCKED;
#endif

struct ButtonState {
  uint8_t pin;
  const char* name;
  bool rawPressed = false;
  bool pressed = false;
  bool ignoreUntilReleased = false;
  bool longPressSent = false;
  bool releasePending = false;
  uint32_t changedAt = 0;
  uint32_t downEdge = 0;
  uint32_t pressedAt = 0;
  uint32_t releasedAt = 0;
  uint32_t pressCount = 0;
};

struct ButtonLog {
  bool changed = false;
  bool pressed = false;
  uint32_t count = 0;
  uint32_t heldMs = 0;
};

ButtonState buttons[] = {
    {kExternalButtonPin, "external"},
    {kBootButtonPin, "BOOT"},
};
bool devicePoweredOn = false;
uint8_t pendingEvents = 0;
ButtonClick pendingClick{};

uint8_t eventBit(DeviceButtonEvent event) {
  return static_cast<uint8_t>(1U << static_cast<uint8_t>(event));
}

void queueLongPress(ButtonState& button) {
  button.longPressSent = true;
  pendingEvents |= eventBit(devicePoweredOn ? DeviceButtonEvent::PowerOff
                                            : DeviceButtonEvent::PowerOn);
}

bool pressedNow(const ButtonState& button) {
  return button.pressed && digitalRead(button.pin) == LOW;
}

}  // namespace

void beginDeviceButtons(bool poweredOn) {
  devicePoweredOn = poweredOn;
  pendingEvents = 0;
  const uint32_t now = millis();
  for (auto& button : buttons) {
    pinMode(button.pin, INPUT_PULLUP);
    button.rawPressed = digitalRead(button.pin) == LOW;
    button.pressed = button.rawPressed;
    button.ignoreUntilReleased = false;
    button.longPressSent = false;
    button.releasePending = false;
    button.changedAt = now;
    button.downEdge = now;
    button.pressedAt = now;
    button.releasedAt = now;
    button.pressCount = 0;
    Serial.printf("Button ready: %s GPIO%u=%s; INPUT_PULLUP, active LOW, debounce=%lums\n",
                  button.name, button.pin, button.pressed ? "PRESSED" : "RELEASED",
                  static_cast<unsigned long>(kButtonDebounceMs));
  }
}

void pollDeviceButtons() {
  ButtonLog logs[2];
  {
    const ButtonLock lock;
    const uint32_t now = millis();
    for (size_t index = 0; index < 2; ++index) {
      auto& button = buttons[index];
      auto& log = logs[index];
      const bool pressed = digitalRead(button.pin) == LOW;
      if (pressed != button.rawPressed) {
        button.rawPressed = pressed;
        button.changedAt = now;
        if (!pressed && button.pressed && !button.releasePending) {
          button.releasePending = true;
          button.releasedAt = now;
        }
      }
      if (pressed && now - button.changedAt >= kButtonDebounceMs) {
        // A stable LOW resumes the hold; a shorter rebound cannot extend it.
        button.releasePending = false;
      }
      const uint32_t longHoldMs = devicePoweredOn ? kPowerOffHoldMs : kPowerOnHoldMs;
      if (pressed != button.pressed && now - button.changedAt >= kButtonDebounceMs) {
        button.pressed = pressed;
        log.changed = true;
        log.pressed = pressed;
        if (pressed) {
          button.downEdge = button.changedAt;
          button.pressedAt = now;
          button.longPressSent = false;
          ++button.pressCount;
        } else {
          log.heldMs = now - button.pressedAt;
          // Use the physical release edge, not its later debounce confirmation.
          const uint32_t heldMs = button.releasedAt - button.pressedAt;
          if (!button.ignoreUntilReleased && !button.longPressSent) {
            if (button.pin == kExternalButtonPin && heldMs >= longHoldMs) {
              queueLongPress(button);
            } else if (button.pin == kExternalButtonPin && devicePoweredOn && heldMs < kPowerOffHoldMs) {
              pendingClick = {button.downEdge, button.releasedAt};
              pendingEvents |= eventBit(DeviceButtonEvent::Pair);
            }
          }
          button.ignoreUntilReleased = false;
        }
        log.count = button.pressCount;
      }
      if (button.pin == kExternalButtonPin && pressed && button.pressed &&
          !button.releasePending &&
          !button.ignoreUntilReleased && !button.longPressSent &&
          now - button.pressedAt >= longHoldMs) {
        queueLongPress(button);
      }
    }
  }
  // Serial output must not run inside a FreeRTOS critical section.
  for (size_t index = 0; index < 2; ++index) {
    const auto& button = buttons[index];
    const auto& log = logs[index];
    if (!log.changed) continue;
    if (log.pressed) {
      Serial.printf("Button %s GPIO%u: PRESSED (LOW), count=%lu\n", button.name, button.pin,
                    static_cast<unsigned long>(log.count));
    } else {
      Serial.printf("Button %s GPIO%u: RELEASED (HIGH), held_ms=%lu\n", button.name,
                    button.pin, static_cast<unsigned long>(log.heldMs));
    }
  }
}

bool deviceButtonPressed() {
  const ButtonLock lock;
  for (const auto& button : buttons) {
    if (pressedNow(button)) return true;
  }
  return false;
}

bool externalButtonPressed() {
  const ButtonLock lock;
  return pressedNow(buttons[0]);
}

bool bootButtonPressed() {
  const ButtonLock lock;
  return pressedNow(buttons[1]);
}

void setDeviceButtonsPoweredOn(bool poweredOn) {
  const ButtonLock lock;
  devicePoweredOn = poweredOn;
  pendingEvents = 0;
  for (auto& button : buttons) {
    // The power-on hold must not become a power-off hold or a pairing click.
    button.ignoreUntilReleased = button.pressed || button.rawPressed;
  }
}

DeviceButtonEvent takeDeviceButtonEvent(ButtonClick* click) {
  const ButtonLock lock;
  constexpr DeviceButtonEvent priority[] = {
      DeviceButtonEvent::PowerOff, DeviceButtonEvent::PowerOn, DeviceButtonEvent::Pair};
  for (const auto event : priority) {
    if ((pendingEvents & eventBit(event)) == 0) continue;
    if (click && event == DeviceButtonEvent::Pair) *click = pendingClick;
    if (event == DeviceButtonEvent::PowerOff) pendingEvents = 0;
    else pendingEvents &= static_cast<uint8_t>(~eventBit(event));
    return event;
  }
  return DeviceButtonEvent::None;
}

bool devicePowerOffPending() {
  const ButtonLock lock;
  return (pendingEvents & eventBit(DeviceButtonEvent::PowerOff)) != 0;
}

bool devicePairingPending() {
  const ButtonLock lock;
  return (pendingEvents & eventBit(DeviceButtonEvent::Pair)) != 0;
}

}  // namespace photowall

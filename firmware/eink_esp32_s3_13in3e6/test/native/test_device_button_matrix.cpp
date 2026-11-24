#include "device_buttons.h"

#include <array>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

namespace {

using Event = photowall::DeviceButtonEvent;
constexpr uint8_t kExternal = photowall::kExternalButtonPin;
constexpr uint8_t kBoot = photowall::kBootButtonPin;
uint32_t clockMs = 0;
std::array<int, 49> levels;
std::vector<Event> events;
unsigned scenarios = 0;

void sample() {
  photowall::pollDeviceButtons();
  for (auto event = photowall::takeDeviceButtonEvent(); event != Event::None;
       event = photowall::takeDeviceButtonEvent()) events.push_back(event);
}

void advance(uint32_t duration) {
  for (uint32_t elapsed = 0; elapsed < duration; ++elapsed) {
    ++clockMs;
    sample();
  }
}

void drive(uint8_t pin, int level) {
  levels[pin] = level;
  sample();
}

void reset(bool poweredOn, uint32_t origin = 0, bool held = false) {
  clockMs = origin;
  levels.fill(HIGH);
  if (held) levels[kExternal] = LOW;
  events.clear();
  photowall::beginDeviceButtons(poweredOn);
}

void expect(std::initializer_list<Event> expected, const char* label) {
  ++scenarios;
  if (events != std::vector<Event>(expected)) {
    std::fprintf(stderr, "FAIL matrix scenario %u (%s), millis=%u: expected",
                 scenarios, label, clockMs);
    for (const auto event : expected) std::fprintf(stderr, " %u", static_cast<unsigned>(event));
    std::fprintf(stderr, "; observed");
    for (const auto event : events) std::fprintf(stderr, " %u", static_cast<unsigned>(event));
    std::fprintf(stderr, "\n");
    std::abort();
  }
}

void press() {
  drive(kExternal, LOW);
  advance(photowall::kButtonDebounceMs);
}

void release() {
  drive(kExternal, HIGH);
  advance(photowall::kButtonDebounceMs);
}

void expectPulse(bool poweredOn, uint32_t held) {
  const uint32_t threshold = poweredOn ? photowall::kPowerOffHoldMs : photowall::kPowerOnHoldMs;
  if (held >= threshold) expect({poweredOn ? Event::PowerOff : Event::PowerOn}, "pulse threshold");
  else if (poweredOn) expect({Event::Pair}, "running short press");
  else expect({}, "standby short press");
}

}  // namespace

NativeSerial Serial;
uint32_t millis() { return clockMs; }
int digitalRead(uint8_t pin) { return levels.at(pin); }
void pinMode(uint8_t pin, uint8_t mode) {
  assert((pin == kExternal || pin == kBoot) && mode == INPUT_PULLUP);
}
void NativeSerial::printf(const char*, ...) {}

int main() {
  const uint32_t wrap = std::numeric_limits<uint32_t>::max();
  const std::array<uint32_t, 4> origins = {0, 123456, wrap - 20, wrap - 2500};
  const std::array<uint32_t, 14> holds = {
      0, 1, 29, 30, 31, 135, 500, 1999, 2000, 2001, 2999, 3000, 3001, 7000};
  for (const bool poweredOn : {false, true}) {
    for (const auto origin : origins) {
      for (const auto held : holds) {
        reset(poweredOn, origin);
        press();
        advance(held);
        release();
        advance(50);
        expectPulse(poweredOn, held);
      }
    }
  }

  // An early release must not be upgraded to a power gesture by contact rebound.
  for (const bool poweredOn : {false, true}) {
    const uint32_t threshold = poweredOn ? photowall::kPowerOffHoldMs : photowall::kPowerOnHoldMs;
    for (const auto origin : origins) {
      reset(poweredOn, origin);
      press();
      advance(threshold - 1);
      drive(kExternal, HIGH);
      advance(2);
      drive(kExternal, LOW);
      advance(9);
      drive(kExternal, HIGH);
      advance(30);
      if (poweredOn) expect({Event::Pair}, "pre-threshold release rebound");
      else expect({}, "standby pre-threshold release rebound");

      // A sub-debounce HIGH glitch followed by stable LOW is still one hold.
      reset(poweredOn, origin);
      press();
      advance(threshold - 5);
      drive(kExternal, HIGH);
      advance(2);
      drive(kExternal, LOW);
      advance(photowall::kButtonDebounceMs - 1);
      expect({}, "LOW rebound not yet stable");
      advance(1);
      expect({poweredOn ? Event::PowerOff : Event::PowerOn}, "stable LOW fires before release");
      release();
      expect({poweredOn ? Event::PowerOff : Event::PowerOn}, "HIGH glitch while holding");
    }
  }

  for (const auto origin : origins) {
    // Neither a prolonged power-on hold nor release rebound may cause another action.
    reset(false, origin, true);
    advance(2000);
    expect({Event::PowerOn}, "initial held power-on");
    photowall::setDeviceButtonsPoweredOn(true);
    events.clear();
    advance(6000);
    drive(kExternal, HIGH);
    advance(5);
    drive(kExternal, LOW);
    advance(4000);
    release();
    expect({}, "same hold ignored through rebound");
    press();
    advance(135);
    release();
    expect({Event::Pair}, "new click after stable power-on release");

    // Repeated clicks before the consumer runs coalesce, but a pending shutdown wins.
    reset(true, origin);
    for (unsigned index = 0; index < 3; ++index) {
      levels[kBoot] = LOW;
      photowall::pollDeviceButtons();
      clockMs += 30;
      photowall::pollDeviceButtons();
      levels[kBoot] = HIGH;
      photowall::pollDeviceButtons();
      clockMs += 30;
      photowall::pollDeviceButtons();
    }
    assert(!photowall::devicePairingPending());
    sample();
    expect({}, "BOOT remains dedicated to original confirmation and factory recovery");

    for (unsigned index = 0; index < 3; ++index) {
      levels[kExternal] = LOW;
      photowall::pollDeviceButtons();
      clockMs += 30;
      photowall::pollDeviceButtons();
      levels[kExternal] = HIGH;
      photowall::pollDeviceButtons();
      clockMs += 30;
      photowall::pollDeviceButtons();
    }
    photowall::ButtonClick click{};
    assert(photowall::takeDeviceButtonEvent(&click) == Event::Pair);
    assert(click.pressedAt == clockMs - 60 && click.releasedAt == clockMs - 30);
    sample();
    expect({}, "latest external click consumed once, with physical edge times");

    reset(true, origin);
    // Both releases are observed by one poll; no ordering may defeat PowerOff.
    levels[kExternal] = LOW;
    levels[kBoot] = LOW;
    photowall::pollDeviceButtons();
    clockMs += 30;
    photowall::pollDeviceButtons();
    clockMs += 3000;
    levels[kExternal] = HIGH;
    levels[kBoot] = HIGH;
    photowall::pollDeviceButtons();
    clockMs += 30;
    sample();
    expect({Event::PowerOff}, "same-poll BOOT/external shutdown priority");
    assert(!photowall::devicePairingPending());
  }

  // Reproducible clean-input property sweep; oracle is only the public thresholds.
  uint32_t random = 0x13572468;
  for (unsigned index = 0; index < 512; ++index) {
    random = random * 1664525U + 1013904223U;
    const uint32_t origin = random;
    random = random * 1664525U + 1013904223U;
    const uint32_t held = random % 6501;
    const bool poweredOn = (index & 1U) != 0;
    reset(poweredOn, origin);
    press();
    advance(held);
    release();
    expectPulse(poweredOn, held);
  }
  std::printf("PASS: %u button matrix scenarios; threshold edges, debounce/rebound, same-hold suppression, BOOT priority, pending events and millis rollover\n",
              scenarios);
}

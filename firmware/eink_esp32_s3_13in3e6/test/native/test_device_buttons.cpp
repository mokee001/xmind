#include "device_buttons.h"
#include "device_lifecycle.h"
#include "physical_confirmation.h"

#include <array>
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

namespace {

uint32_t now = 0;
std::array<int, 49> levels;
std::array<int, 49> modes;
std::vector<std::string> logs;

void reset(uint32_t time = 0, bool externalHeld = false, bool poweredOn = false) {
  now = time;
  levels.fill(HIGH);
  modes.fill(-1);
  logs.clear();
  if (externalHeld) levels[photowall::kExternalButtonPin] = LOW;
  photowall::beginDeviceButtons(poweredOn);
}

void sample(uint32_t time, uint8_t pin, int level) {
  now = time;
  levels[pin] = level;
  photowall::pollDeviceButtons();
}

size_t countLogs(const std::string& text) {
  size_t count = 0;
  for (const auto& log : logs) if (log.find(text) != std::string::npos) ++count;
  return count;
}

}  // namespace

NativeSerial Serial;

uint32_t millis() { return now; }
int digitalRead(uint8_t pin) { return levels.at(pin); }
void pinMode(uint8_t pin, uint8_t mode) { modes.at(pin) = mode; }

void NativeSerial::printf(const char* format, ...) {
  char buffer[256];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(buffer, sizeof(buffer), format, arguments);
  va_end(arguments);
  logs.emplace_back(buffer);
}

int main() {
  constexpr uint8_t external = photowall::kExternalButtonPin;
  constexpr uint8_t boot = photowall::kBootButtonPin;
  static_assert(external == 40);
  const std::string externalLog = "external GPIO" + std::to_string(external);

  reset();
  sample(100, 8, LOW);
  sample(5000, 8, LOW);
  assert(modes[8] == -1 && !photowall::externalButtonPressed());
  assert(photowall::takeDeviceButtonEvent() == photowall::DeviceButtonEvent::None);

  reset();
  assert(modes[external] == INPUT_PULLUP && modes[boot] == INPUT_PULLUP);
  assert(modes[38] == -1);
  assert(!photowall::deviceButtonPressed());
  assert(countLogs("Button ready:") == 2);

  sample(10, external, LOW);
  sample(20, external, HIGH);
  sample(60, external, HIGH);
  assert(!photowall::deviceButtonPressed());
  assert(countLogs(": PRESSED") == 0);

  sample(100, external, LOW);
  sample(129, external, LOW);
  assert(!photowall::deviceButtonPressed());
  sample(130, external, LOW);
  assert(photowall::deviceButtonPressed());
  assert(countLogs(externalLog + ": PRESSED") == 1);
  sample(200, external, LOW);
  assert(countLogs(externalLog + ": PRESSED") == 1);

  levels[external] = HIGH;
  assert(!photowall::deviceButtonPressed());
  sample(210, external, HIGH);
  sample(220, external, LOW);
  sample(250, external, LOW);
  assert(photowall::deviceButtonPressed());
  assert(countLogs(externalLog + ": PRESSED") == 1);
  sample(260, external, HIGH);
  sample(290, external, HIGH);
  assert(!photowall::deviceButtonPressed());
  assert(countLogs(externalLog + ": RELEASED") == 1);
  assert(countLogs("held_ms=160") == 1);

  for (uint32_t index = 0; index < 3; ++index) {
    const uint32_t start = 400 + index * 200;
    sample(start, external, LOW);
    sample(start + 30, external, LOW);
    assert(photowall::deviceButtonPressed());
    sample(start + 100, external, HIGH);
    sample(start + 130, external, HIGH);
    assert(!photowall::deviceButtonPressed());
  }
  assert(countLogs(externalLog + ": PRESSED") == 4);
  assert(countLogs(externalLog + ": RELEASED") == 4);
  assert(countLogs("count=4") == 1);

  sample(1100, boot, LOW);
  sample(1130, boot, LOW);
  assert(photowall::deviceButtonPressed());
  assert(countLogs("BOOT GPIO0: PRESSED") == 1);
  sample(1200, external, LOW);
  sample(1230, external, LOW);
  sample(1300, boot, HIGH);
  sample(1330, boot, HIGH);
  assert(photowall::deviceButtonPressed());
  sample(1400, external, HIGH);
  sample(1430, external, HIGH);
  assert(!photowall::deviceButtonPressed());

  reset(std::numeric_limits<uint32_t>::max() - 10);
  sample(now, external, LOW);
  sample(18, external, LOW);
  assert(!photowall::deviceButtonPressed());
  sample(19, external, LOW);
  assert(photowall::deviceButtonPressed());

  reset(0, true);
  assert(photowall::deviceButtonPressed());
  sample(100, external, HIGH);
  assert(!photowall::deviceButtonPressed());

  using Event = photowall::DeviceButtonEvent;
  reset(0, true);
  sample(1999, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(2000, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOn);
  sample(6500, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  photowall::setDeviceButtonsPoweredOn(true);
  sample(10000, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(10100, external, HIGH);
  sample(10130, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(10200, external, LOW);
  sample(10230, external, LOW);
  sample(10280, external, HIGH);
  sample(10310, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::Confirm);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(11000, external, LOW);
  sample(11030, external, LOW);
  sample(14029, external, LOW);
  assert(!photowall::devicePowerOffPending());
  sample(14030, external, LOW);
  assert(photowall::devicePowerOffPending());
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOff);
  sample(15000, external, LOW);
  sample(15100, external, HIGH);
  sample(15130, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::None);

  // Release debounce may cross the long-press boundary; physical release must win.
  reset(0, false, true);
  sample(100, external, LOW);
  sample(130, external, LOW);
  sample(3129, external, HIGH);
  sample(3159, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::Confirm);
  reset(0, false, true);
  sample(100, external, LOW);
  sample(130, external, LOW);
  sample(3130, external, HIGH);
  sample(3160, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOff);
  assert(photowall::takeDeviceButtonEvent() == Event::None);

  // A queued shutdown outranks an older pairing click during blocking I/O.
  reset(0, false, true);
  sample(100, external, LOW);
  sample(130, external, LOW);
  sample(200, external, HIGH);
  sample(230, external, HIGH);
  assert(photowall::deviceConfirmationPending());
  assert(photowall::deviceConfirmationPending());  // Observing a pending click does not consume it.
  sample(300, external, LOW);
  sample(330, external, LOW);
  sample(3330, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOff);
  assert(!photowall::deviceConfirmationPending());
  assert(photowall::takeDeviceButtonEvent() == Event::None);

  // Startup accepts the power-on gesture before audio / BOOT recovery checks.
  // A 135ms click after releasing that gesture must survive the startup window.
  reset(0, true);
  sample(2000, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOn);
  photowall::setDeviceButtonsPoweredOn(true);
  sample(2500, external, HIGH);
  sample(2530, external, HIGH);
  assert(!photowall::deviceConfirmationPending());
  sample(3000, external, LOW);
  sample(3030, external, LOW);
  sample(3135, external, HIGH);
  sample(3165, external, HIGH);
  assert(photowall::deviceConfirmationPending());
  sample(10000, external, HIGH);
  assert(photowall::deviceConfirmationPending());
  assert(photowall::takeDeviceButtonEvent() == Event::Confirm);
  assert(!photowall::deviceConfirmationPending());

  reset(0, false, true);
  sample(100, boot, LOW);
  sample(130, boot, LOW);
  sample(9000, boot, LOW);
  assert(photowall::bootButtonPressed());
  assert(!photowall::externalButtonPressed());
  assert(!photowall::devicePowerOffPending());
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(9100, boot, HIGH);
  sample(9130, boot, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::None);

  reset(std::numeric_limits<uint32_t>::max() - 1000, true);
  sample(998, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::None);
  sample(999, external, LOW);
  assert(photowall::takeDeviceButtonEvent() == Event::PowerOn);

  reset();
  sample(100, external, LOW);
  sample(130, external, LOW);
  sample(200, external, HIGH);
  sample(230, external, HIGH);
  assert(photowall::takeDeviceButtonEvent() == Event::None);

  photowall::PhysicalConfirmationWindow confirmation;
  assert(!confirmation.consume(0));
  confirmation.grant(0);
  assert(confirmation.consume(0));
  assert(!confirmation.consume(1));
  confirmation.grant(100);
  assert(confirmation.consume(30099));
  confirmation.grant(100);
  assert(!confirmation.consume(30100));
  confirmation.grant(std::numeric_limits<uint32_t>::max() - 100);
  assert(confirmation.consume(100));
  confirmation.grant(500);
  confirmation.clear();
  assert(!confirmation.consume(501));

  assert(!confirmation.grantForConnection(500, 200, 199, 300));
  assert(!confirmation.grantForConnection(500, 200, 200, 300));
  assert(!confirmation.grantForConnection(30400, 100, 200, 400));
  assert(confirmation.grantForConnection(100, UINT32_MAX - 100, UINT32_MAX - 20, 30));
  assert(confirmation.consume(30029));
  assert(!confirmation.consume(30029));

  using photowall::StartIntent;
  for (auto intent : {StartIntent::OpenSetup, StartIntent::ButtonWake}) {
    uint32_t cookie = static_cast<uint32_t>(intent);
    assert(photowall::consumeStartIntent(false, cookie) == StartIntent::Normal && cookie == 0);
    cookie = static_cast<uint32_t>(intent);
    assert(photowall::consumeStartIntent(true, cookie) == intent && cookie == 0);
    assert(photowall::consumeStartIntent(true, cookie) == StartIntent::Normal);
  }
  uint32_t unknown = 123;
  assert(photowall::consumeStartIntent(true, unknown) == StartIntent::Normal);

  using photowall::ClaimCue;
  ClaimCue cue = ClaimCue::Idle;
  assert(!photowall::observeCloudClaim(cue, true));
  cue = ClaimCue::Submitted;
  assert(!photowall::observeCloudClaim(cue, true) && cue == ClaimCue::Idle);
  cue = ClaimCue::Submitted;
  assert(!photowall::observeCloudClaim(cue, false) && cue == ClaimCue::SeenUnclaimed);
  assert(!photowall::observeCloudClaim(cue, false));
  assert(photowall::observeCloudClaim(cue, true) && cue == ClaimCue::Idle);
  assert(!photowall::observeCloudClaim(cue, true));

  std::puts("PASS: debounce, raw-release safety, counters, BOOT fallback, 2s on/3s off, single-fire holds, no click from power-on hold, startup-window click preserved, non-consuming pairing check, release boundary, shutdown priority, timer rollover, standby clicks ignored, single-use 30s confirmation, one-shot software restart, pairing cue only after cloud claim");
}

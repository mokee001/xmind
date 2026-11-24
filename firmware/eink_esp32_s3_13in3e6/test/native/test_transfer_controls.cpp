#include "device_buttons.h"
#include "device_lifecycle.h"
#include "device_audio.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

using photowall::StartIntent;
using photowall::ClaimCue;
using photowall::DeviceSound;
struct String : std::string {
  using std::string::string;
  bool isEmpty() const { return empty(); }
};
struct Standby {};
NativeSerial Serial;
void NativeSerial::printf(const char*, ...) {}
void NativeSerial::begin(unsigned) {}
void NativeSerial::setTxTimeoutMs(unsigned) {}
void NativeSerial::print(char) {}
void NativeSerial::println() {}
void NativeSerial::println(const char*) {}
void NativeSerial::flush() {}

uint32_t clockMs, retainedIntent, lastPollAt, pollIntervalMs, lastCueCheckAt;
bool softwareReset, serverStarted, forceProvisioning, provisioningMode, restartRequested;
bool sleepFails, stopAtStandby, generatePressInTransfer, localJobFinishes, taskAvailable;
bool wifiAvailable;
unsigned sleeps, powerCycles, framePolls, claimsChecked, confirms, bootstrapCommits, wakeDisables;
std::array<int, 49> levels;
std::vector<std::pair<uint32_t, int>> edges;
std::vector<DeviceSound> sounds;
String setupToken, localFrameState, deviceId, pairingCode, deviceToken, wifiSsid, wifiPassword, apiBase, displayedRevision;
ClaimCue claimCue;
constexpr int WIFI_OFF = 0, WIFI_STA = 1, WL_CONNECTED = 3, ESP_RST_SW = 3, ESP_OK = 0;
int esp_reset_reason() { return softwareReset ? ESP_RST_SW : 1; }
uint32_t millis() { return clockMs; }
int digitalRead(uint8_t pin) { return levels.at(pin); }
void pinMode(uint8_t, uint8_t) {}
struct { [[noreturn]] void restart() { throw static_cast<StartIntent>(retainedIntent); } } ESP;

namespace photowall {
int* sampler = nullptr;
std::atomic<bool> stopped{false};
constexpr int wakePin = 40, GPIO_MODE_INPUT = 1, GPIO_PULLUP_ONLY = 2, GPIO_INTR_LOW_LEVEL = 3;
constexpr int ESP_SLEEP_WAKEUP_ALL = 4, pdPASS = 1;
void sampleTask(void*) {}
int xTaskCreate(void (*)(void*), const char*, int, void*, int, int** handle) {
  static int task;
  *handle = taskAvailable ? &task : nullptr;
  return taskAvailable ? pdPASS : 0;
}
void xTaskNotifyGive(int*) { stopped.store(true); }
void gpio_wakeup_disable(int pin) { assert(pin == 40); ++wakeDisables; }
void esp_sleep_disable_wakeup_source(int source) { assert(source == ESP_SLEEP_WAKEUP_ALL); }
void gpio_sleep_sel_dis(int pin) { assert(pin == 40); }
int gpio_sleep_set_direction(int pin, int mode) { assert(pin == 40 && mode == GPIO_MODE_INPUT); return ESP_OK; }
int gpio_sleep_set_pull_mode(int pin, int mode) { assert(pin == 40 && mode == GPIO_PULLUP_ONLY); return ESP_OK; }
int gpio_sleep_sel_en(int pin) { assert(pin == 40); return ESP_OK; }
int gpio_wakeup_enable(int pin, int mode) { assert(pin == 40 && mode == GPIO_INTR_LOW_LEVEL); return ESP_OK; }
int esp_sleep_enable_gpio_wakeup() { if (stopAtStandby) throw Standby{}; return ESP_OK; }
int esp_light_sleep_start() {
  ++sleeps;
  if (sleepFails) return -1;
  assert(!edges.empty() && edges.front().first >= clockMs);
  delay(edges.front().first - clockMs);
  return ESP_OK;
}
// PHOTOWALL_POWER_BODIES

bool beginDeviceAudio() { return true; }
void stopDeviceAudio() {}
bool playDeviceSound(DeviceSound sound) { sounds.push_back(sound); return true; }
struct {
  bool busy = false, due = false, pending = false, started = false;
  bool busyForControls() const { return busy; }
  bool readyToRestart() const { return due; }
  bool cloudBootstrapPending() const { return pending; }
  bool active() const { return started; }
  void begin(const String&, const char*, const String&, bool) { started = true; }
  void loop() {}
  void stop() { started = false; }
  void completeCloudBootstrap(bool, const char*) { pending = false; }
  void confirmExternalClick(uint32_t pressed, uint32_t released) { assert(released > pressed); ++confirms; }
} bleProvisioning;
}

void delay(uint32_t duration) {
  for (uint32_t elapsed = 0; elapsed < duration; ++elapsed) {
    ++clockMs;
    assert(clockMs < 100000);
    while (!edges.empty() && edges.front().first <= clockMs) {
      levels[40] = edges.front().second;
      edges.erase(edges.begin());
    }
    if (photowall::sampler && !photowall::stopped.load() && clockMs % 5 == 0) photowall::pollDeviceButtons();
  }
}
void pulse(uint32_t duration) { levels[40] = LOW; delay(duration); levels[40] = HIGH; delay(40); }
struct {
  std::map<std::string, bool> keys;
  void begin(const char*, bool) {}
  void end() {}
  void remove(const char* key) { keys.erase(key); }
  void putBool(const char* key, bool value) { keys[key] = value; }
  void clear() { keys.clear(); }
} prefs;
struct { void setReuse(bool) {} void end() {} } cloudHttp;
struct Socket { void stop() {} } cloudPlain, cloudSecure;
struct { void handleClient() {} void stop() {} } provisionServer;
struct { void stop() {} void processNextRequest() {} } dnsServer;
struct { void end() {} } MDNS;
struct { void powerOff() { ++powerCycles; } } panel;
struct {
  int getMode() { return 1; }
  void setAutoReconnect(bool) {}
  void persistent(bool enabled) { assert(!enabled); }
  void begin(const char*, const char*) {}
  struct Ip { String toString() { return "127.0.0.1"; } };
  Ip localIP() { return {}; }
  void disconnect(bool, bool erase) { assert(!erase); }
  void mode(int mode) { assert(mode == WIFI_OFF || mode == WIFI_STA); }
  int status() { return wifiAvailable ? WL_CONNECTED : 0; }
} WiFi;
void releaseLocalFrame() {}
void reportStatus(const String&, const String&, float) {}
String createSetupToken() { return "fixture-setup"; }
void handleButtonAtIdle();
void deriveIdentity() {}
void loadConfiguration() {}
void applyDemoWifiConfiguration() {}
void startDeviceServer(bool provisioning) {
  serverStarted = true; provisioningMode = provisioning; assert(photowall::bleProvisioning.started);
}
bool bootstrapDevice() { ++claimsChecked; lastCueCheckAt = millis(); return true; }
void finalizeProvisioningConfiguration() { ++bootstrapCommits; }
void processLocalDisplayJob() { if (localJobFinishes) localFrameState = "displayed"; }
void pollForFrame() { if (generatePressInTransfer) pulse(3100); ++framePolls; }

// PHOTOWALL_CONTROL_BODIES

void reset() {
  clockMs = 1; retainedIntent = lastPollAt = lastCueCheckAt = 0; pollIntervalMs = 15000;
  softwareReset = serverStarted = forceProvisioning = provisioningMode = restartRequested = false;
  sleepFails = generatePressInTransfer = localJobFinishes = false; taskAvailable = stopAtStandby = wifiAvailable = true;
  sleeps = powerCycles = framePolls = claimsChecked = confirms = bootstrapCommits = wakeDisables = 0;
  levels.fill(HIGH); edges.clear(); sounds.clear(); localFrameState = "idle"; claimCue = ClaimCue::Idle;
  wifiSsid = "fixture"; apiBase = "http://localhost"; deviceToken = "fixture";
  photowall::sampler = nullptr; photowall::stopped.store(false); photowall::bleProvisioning = {};
  prefs.keys = {{"token", true}, {"ssid", true}, {"pass", true}, {"api", true}, {"revision", true}};
}

template<class Action> void expectStandby(Action action) {
  try { action(); } catch (Standby&) { assert(powerCycles == 1 && sounds.back() == DeviceSound::PowerOff); return; }
  assert(false);
}
template<class Action> void expectRestart(StartIntent intent, Action action) {
  try { action(); } catch (StartIntent seen) { assert(seen == intent); return; }
  assert(false);
}

int main() {
  reset(); retainedIntent = static_cast<uint32_t>(StartIntent::OpenSetup); setup();
  assert(serverStarted && !provisioningMode && claimsChecked == 1 && sounds == std::vector<DeviceSound>{DeviceSound::PowerOn});
  const auto saved = prefs.keys;
  pulse(180); loop(); assert(!provisioningMode && photowall::bleProvisioning.started && confirms == 1 && prefs.keys == saved);
  reset(); softwareReset = true; retainedIntent = static_cast<uint32_t>(StartIntent::OpenSetup); setup();
  assert(provisioningMode && sounds.empty() && confirms == 0 && claimsChecked == 0);
  pulse(180); loop(); assert(confirms == 1 && prefs.keys == saved);
  reset(); softwareReset = true; setup(); assert(!provisioningMode && sounds.empty());
  reset(); softwareReset = true; retainedIntent = static_cast<uint32_t>(StartIntent::ButtonWake);
  levels[40] = LOW; setup(); delay(4000); levels[40] = HIGH; delay(40); loop();
  assert(!provisioningMode && powerCycles == 0 && confirms == 0 && sounds.size() == 1);
  reset(); wifiSsid = ""; setup(); assert(provisioningMode && !claimsChecked);
  reset(); taskAvailable = false; setup(); assert(serverStarted && !provisioningMode);
  reset(); wifiAvailable = false; edges = {{7000, LOW}, {7200, HIGH}}; setup();
  assert(provisioningMode && clockMs >= 36000 && confirms == 1 && prefs.keys == saved && photowall::bleProvisioning.started);
  reset(); wifiAvailable = false; edges = {{7000, LOW}, {10100, HIGH}}; expectStandby(setup);
  assert(clockMs < 10200 && !serverStarted && prefs.keys == saved);
  reset(); levels[0] = LOW; setup(); assert(prefs.keys.size() == 1 && prefs.keys.count("force_setup"));

  for (auto phase : {"receiving", "received", "queued", "refreshing"}) {
    reset(); setup(); localFrameState = phase; pulse(3100); loop();
    assert(!powerCycles && framePolls == 0 && photowall::devicePowerOffPending());
    localJobFinishes = true; loop(); assert(!powerCycles && localFrameState == "displayed");
    expectStandby(loop); assert(prefs.keys == saved);
  }
  reset(); setup(); generatePressInTransfer = true; loop(); assert(framePolls == 1 && !powerCycles);
  expectStandby(loop); assert(framePolls == 1 && prefs.keys == saved);
  reset(); wifiSsid = ""; setup(); auto& ble = photowall::bleProvisioning;
  ble.busy = ble.pending = true; pulse(3100); loop(); assert(bootstrapCommits == 1 && !powerCycles);
  ble.due = true; expectStandby(loop);
  reset(); wifiSsid = ""; setup(); restartRequested = true; localFrameState = "queued"; pulse(3100);
  loop(); localJobFinishes = true; expectStandby(loop);
  for (bool preserve : {true, false}) {
    reset(); setup(); expectRestart(StartIntent::Normal, [&] { restartInProvisioningMode(preserve); });
    assert(prefs.keys.count("token") == preserve && prefs.keys.count("force_setup") && !prefs.keys.count("ssid"));
  }
  reset(); setup(); delay(16000); loop(); assert(claimsChecked == 1);
  claimCue = ClaimCue::SeenUnclaimed; loop(); assert(claimsChecked == 2); loop(); assert(claimsChecked == 2);

  for (bool fallback : {false, true}) {
    reset(); stopAtStandby = false; sleepFails = fallback; levels[40] = LOW;
    edges = {{300, HIGH}, {310, LOW}, {400, HIGH}, {600, LOW}, {900, HIGH}, {1800, LOW}};
    photowall::waitForStandbyWake();
    assert(clockMs >= 3830 && clockMs < 3890 && !serverStarted && sounds.empty());
    assert(sleeps == (fallback ? 1u : 2u) && wakeDisables >= 1);
  }
  std::puts("PASS: cold/soft boot, original BOOT reset, automatic boot advertising, confirmation-only short press, transfer/display deferral, committed reprovision, claim cadence, release/tap/hold wake and sleep fallback");
}
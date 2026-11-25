#include <ArduinoJson.h>
#include "Arduino.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

struct String : std::string {
  using std::string::string;
  String(std::string value) : std::string(value) {}
  bool isEmpty() const { return empty(); }
};
using portMUX_TYPE = int;
constexpr int portMUX_INITIALIZER_UNLOCKED = 0;
void portENTER_CRITICAL(int* locked) { assert(!*locked); *locked = 1; }
void portEXIT_CRITICAL(int* locked) { assert(*locked); *locked = 0; }
#include "ble_provisioning.h"
#include "device_audio.h"
#include "device_lifecycle.h"

NativeSerial Serial;
void NativeSerial::println(const char*) {}
void NativeSerial::printf(const char*, ...) {}
uint32_t clockMs = 100;
bool bootHeld = false;
bool powerOffPending = false;
std::vector<photowall::DeviceSound> sounds;
uint32_t millis() { return clockMs; }
void delay(uint32_t duration) { clockMs += duration; }
int digitalRead(uint8_t pin) { assert(pin == 0); return bootHeld ? LOW : HIGH; }
struct BLEDevice { static void startAdvertising() {} };
unsigned disconnects = 0;
using wl_status_t = int;
constexpr int WIFI_OFF = 0, WIFI_STA = 1, WL_CONNECTED = 3, WL_CONNECT_FAILED = 4, WL_NO_SSID_AVAIL = 5;
int wifiStatus = 0;
struct {
  void scanDelete() {}
  void disconnect(bool, bool) { ++disconnects; wifiStatus = 0; }
  int status() { return wifiStatus; }
  int getMode() { return WIFI_STA; }
  void mode(int mode) { assert(mode == WIFI_STA); }
  void persistent(bool enabled) { assert(!enabled); }
  void setAutoReconnect(bool enabled) { assert(!enabled); }
  void begin(const char*, const char*) {}
} WiFi;
std::map<std::string, std::string> stored;
struct Preferences {
  void begin(const char*, bool) {}
  void end() {}
  void putString(const char* key, const String& value) { stored[key] = value; }
  void putBool(const char* key, bool value) { stored[key] = value ? "1" : "0"; }
  void putUChar(const char* key, uint8_t value) { stored[key] = std::to_string(value); }
  void remove(const char* key) { stored.erase(key); }
};
class BLECharacteristic {
 public:
  std::vector<uint8_t> bytes;
  const uint8_t* getData() const { return bytes.data(); }
  size_t getLength() const { return bytes.size(); }
};
String latestStatus, authorization;
unsigned scans = 0;
namespace photowall {
bool devicePowerOffPending() { return powerOffPending; }
bool playDeviceSound(DeviceSound sound) { sounds.push_back(sound); return true; }
String jsonString(const JsonDocument& document) { std::string out; serializeJson(document, out); return out; }
String normalizeApiBase(String input) { return input; }
void BleProvisioningService::begin(const String& id, const String&, const String& token, bool preserve) {
  deviceId_ = id; setupToken_ = token; active_ = true; preserveDeviceToken_ = preserve;
}
void BleProvisioningService::setStatus(const char* status, const String&, const String&) { latestStatus = status; }
void BleProvisioningService::sendEvent(const String& event) { authorization = event; }
void BleProvisioningService::scanNetworks() { ++scans; }
// PHOTOWALL_BLE_BODIES
}

int main() {
  photowall::BleProvisioningService service;
  service.begin("fixture-device", "fixture-version", "fixture-proof", false);
  uint8_t sequence = 0;
  const auto queue = [&](const char* json) {
    BLECharacteristic characteristic;
    characteristic.bytes = {1, ++sequence, 0, 1};
    characteristic.bytes.insert(characteristic.bytes.end(), json, json + std::strlen(json));
    service.handleCommandWrite(&characteristic);
  };
  const auto send = [&](const char* json) { authorization.clear(); queue(json); service.loop(); };
  constexpr auto authorize = "{\"op\":\"authorize\"}";
  constexpr auto scan = "{\"op\":\"scan\",\"setupToken\":\"fixture-proof\"}";
  service.confirmExternalClick(50, 80);
  service.handleClientConnected(); assert(latestStatus == "linked"); send(authorize);
  assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  clockMs = 180; service.confirmExternalClick(90, 140); send(authorize);
  assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  service.confirmExternalClick(120, 160); send(authorize);
  JsonDocument event;
  assert(!deserializeJson(event, authorization.c_str()));
  assert(event["type"] == "authorization" && event["deviceId"] == "fixture-device" && event["setupToken"] == "fixture-proof");
  send("{\"op\":\"scan\"}"); assert(!scans && latestStatus == "error");
  send(authorize); assert(latestStatus == "idle" && !authorization.empty()); // Retry is idempotent.
  send("{\"op\":\"cancel\",\"setupToken\":\"fixture-proof\"}");
  assert(disconnects == 0); // Cancelling a link/scan must retain existing Wi-Fi.
  send(scan); assert(scans == 1);
  service.handleClientDisconnected(); ++clockMs; service.handleClientConnected(); send(scan);
  assert(scans == 1 && latestStatus == "error");
  clockMs += 100; service.confirmExternalClick(clockMs-50, clockMs-10);
  queue(authorize); service.handleClientDisconnected(); ++clockMs; service.handleClientConnected(); service.loop();
  send(authorize); assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  clockMs += 100; service.confirmExternalClick(clockMs-50, clockMs-10); clockMs += 29990;
  send(authorize); assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  bootHeld = true; send(authorize); bootHeld = false;
  assert(latestStatus == "idle" && !authorization.empty()); send(scan); assert(scans == 2);
  assert(sounds.empty()); // BLE link, authorize retries, scans and cancel are not binding/Wi-Fi success.

  using photowall::DeviceSound;
  constexpr auto provision = "{\"op\":\"provision\",\"setupToken\":\"fixture-proof\",\"ssid\":\"fixture-network\",\"password\":\"fixture-password\",\"apiBase\":\"http://localhost\"}";
  send(provision); assert(latestStatus == "connecting" && sounds.empty());
  send(provision); assert(sounds.empty()); // Duplicate while connecting.
  wifiStatus = WL_CONNECTED; service.loop();
  assert(sounds == std::vector<DeviceSound>{DeviceSound::WifiConnected});
  assert(stored.at("ssid") == "fixture-network");
  service.loop(); send(provision); assert(sounds.size() == 1); // Connected and waiting for cloud.
  service.completeCloudBootstrap(false, "fixture-unreachable");
  assert(latestStatus == "cloud_unreachable" && sounds.size() == 1); // No cloud-binding melody.
  // Network failures and cancellation must be silent and allow an explicit retry.
  for (auto status : {WL_CONNECT_FAILED, WL_NO_SSID_AVAIL, 0}) {
    send(provision); wifiStatus = status;
    if (status == 0) clockMs += 30001;
    service.loop(); service.loop(); assert(sounds.size() == 1);
    assert(latestStatus == (status == WL_CONNECT_FAILED ? "wrong_password" : status == WL_NO_SSID_AVAIL ? "network_not_found" : "timeout"));
  }
  send(provision); send("{\"op\":\"cancel\",\"setupToken\":\"fixture-proof\"}");
  wifiStatus = WL_CONNECTED; service.loop(); assert(sounds.size() == 1);
  send(provision); powerOffPending = true; wifiStatus = WL_CONNECTED; service.loop();
  assert(sounds.size() == 1); // Shutdown wins; no misleading late success audio.
  powerOffPending = false; service.completeCloudBootstrap(false, "fixture-unreachable");
  send(provision); wifiStatus = WL_CONNECTED; service.loop();
  assert(sounds.size() == 2 && sounds.back() == DeviceSound::WifiConnected);
  service.completeCloudBootstrap(true, "fixture-ready");
  service.completeCloudBootstrap(true, "fixture-ready");
  send(provision); assert(sounds.size() == 2); // No duplicate before provisioning restart.
  service.handleClientDisconnected(); service.handleClientConnected(); service.loop();
  assert(sounds.size() == 2); // Automatic BLE reconnection stays silent.
  std::puts("PASS: physical BLE confirmation, one-shot explicit Wi-Fi success, failure/cancel/retry, cloud separation, shutdown priority and silent reconnect");
}

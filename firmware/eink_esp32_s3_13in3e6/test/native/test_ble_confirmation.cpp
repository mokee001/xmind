#include <ArduinoJson.h>
#include "Arduino.h"
#include <cassert>
#include <cstdio>
#include <cstring>
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

NativeSerial Serial;
void NativeSerial::println(const char*) {}
uint32_t clockMs = 100;
bool bootHeld = false;
uint32_t millis() { return clockMs; }
int digitalRead(uint8_t pin) { assert(pin == 0); return bootHeld ? LOW : HIGH; }
struct BLEDevice { static void startAdvertising() {} };
struct { void scanDelete() {} void disconnect(bool, bool) {} } WiFi;
class BLECharacteristic {
 public:
  std::vector<uint8_t> bytes;
  const uint8_t* getData() const { return bytes.data(); }
  size_t getLength() const { return bytes.size(); }
};
String latestStatus, authorization;
unsigned scans = 0;
namespace photowall {
String jsonString(const JsonDocument& document) { std::string out; serializeJson(document, out); return out; }
String normalizeApiBase(String input) { return input; }
void BleProvisioningService::begin(const String& id, const String&, const String& token, bool) {
  deviceId_ = id; setupToken_ = token; active_ = true;
}
void BleProvisioningService::setStatus(const char* status, const String&, const String&) { latestStatus = status; }
void BleProvisioningService::sendEvent(const String& event) { authorization = event; }
void BleProvisioningService::scanNetworks() { ++scans; }
void BleProvisioningService::processWifiConnection() {}
void BleProvisioningService::startWifiConnection(const String&, const String&, const String&) {}
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
  service.handleClientConnected(); send(authorize);
  assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  clockMs = 180; service.confirmExternalClick(90, 140); send(authorize);
  assert(latestStatus == "awaiting_confirmation" && authorization.empty());
  service.confirmExternalClick(120, 160); send(authorize);
  JsonDocument event;
  assert(!deserializeJson(event, authorization.c_str()));
  assert(event["type"] == "authorization" && event["deviceId"] == "fixture-device" && event["setupToken"] == "fixture-proof");
  send("{\"op\":\"scan\"}"); assert(!scans && latestStatus == "error");
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
  std::puts("PASS: original App BLE command framing, held BOOT, session-bound GPIO40 confirmation, expiry, reconnect and setup-token checks");
}
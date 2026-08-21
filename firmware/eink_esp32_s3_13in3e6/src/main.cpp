#include <Arduino.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

#include "panel_13in3e6.h"
#include "ble_provisioning.h"

namespace {

constexpr char kFirmwareVersion[] = "0.2.0";
constexpr uint8_t kBootButton = 0;
constexpr uint16_t kProvisionPort = 80;
constexpr uint32_t kWifiConnectTimeoutMs = 30000;
constexpr uint32_t kDefaultPollIntervalMs = 15000;
constexpr uint32_t kMinimumPollIntervalMs = 5000;
constexpr uint32_t kMaximumPollIntervalMs = 300000;
constexpr size_t kFrameHeaderBytes = 45;

Preferences prefs;
WebServer provisionServer(kProvisionPort);
DNSServer dnsServer;
photowall::Panel13in3E6 panel;
String deviceId;
String pairingCode;
String apiBase;
String deviceToken;
String displayedRevision;
String setupToken;
uint32_t lastPollAt = 0;
uint32_t pollIntervalMs = kDefaultPollIntervalMs;
bool restartRequested = false;
bool provisioningMode = false;

String jsonEscape(const String& input) {
  String escaped;
  escaped.reserve(input.length() + 8);
  for (size_t index = 0; index < input.length(); ++index) {
    const char value = input[index];
    if (value == '\\' || value == '"') escaped += '\\';
    escaped += value;
  }
  return escaped;
}

String normalizeApiBase(String value) {
  value.trim();
  while (value.endsWith("/")) value.remove(value.length() - 1);
  if (!value.startsWith("http://") && !value.startsWith("https://")) return "";
  return value;
}

void deriveIdentity() {
  const uint64_t mac = ESP.getEfuseMac();
  char id[28];
  snprintf(id, sizeof(id), "pwe6-%04X%08X", static_cast<uint16_t>(mac >> 32),
           static_cast<uint32_t>(mac));
  deviceId = id;
  char code[7];
  snprintf(code, sizeof(code), "%06lu", static_cast<unsigned long>(mac % 1000000ULL));
  pairingCode = code;
}

String createSetupToken() {
  char token[33];
  for (size_t index = 0; index < 4; ++index) {
    snprintf(token + index * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
  }
  return String(token);
}

void clearConfigurationIfRequested() {
  pinMode(kBootButton, INPUT_PULLUP);
  if (digitalRead(kBootButton) != LOW) return;
  const uint32_t started = millis();
  while (digitalRead(kBootButton) == LOW && millis() - started < 8000) delay(50);
  if (digitalRead(kBootButton) == LOW) {
    prefs.begin("photowall", false);
    prefs.clear();
    prefs.end();
    Serial.println("Factory reset: Wi-Fi and device credentials cleared");
  }
}

void loadConfiguration() {
  prefs.begin("photowall", true);
  apiBase = prefs.getString("api", "");
  deviceToken = prefs.getString("token", "");
  displayedRevision = prefs.getString("revision", "");
  setupToken = prefs.getString("setup", "");
  prefs.end();
}

void saveDeviceToken(const String& token) {
  deviceToken = token;
  prefs.begin("photowall", false);
  const size_t storedLength = prefs.putString("token", token);
  prefs.end();
  Serial.printf("Device token persisted: %s\n", storedLength == token.length() ? "yes" : "no");
}

void saveRevision(const String& revision) {
  displayedRevision = revision;
  prefs.begin("photowall", false);
  prefs.putString("revision", revision);
  prefs.end();
}

bool hasWifiConfiguration() {
  prefs.begin("photowall", true);
  const bool configured = prefs.getString("ssid", "").length() > 0 &&
                          prefs.getString("api", "").length() > 0;
  prefs.end();
  return configured;
}

bool connectWifi() {
  prefs.begin("photowall", true);
  const String ssid = prefs.getString("ssid", "");
  const String password = prefs.getString("pass", "");
  prefs.end();
  if (ssid.isEmpty()) return false;

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(ssid.c_str(), password.c_str());
  Serial.printf("Connecting to Wi-Fi %s", ssid.c_str());
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < kWifiConnectTimeoutMs) {
    delay(400);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
  return true;
}

void sendProvisionCors() {
  provisionServer.sendHeader("Access-Control-Allow-Origin", "*");
  provisionServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  provisionServer.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

void startProvisioning() {
  provisioningMode = true;
  setupToken = createSetupToken();
  const String apName = "PhotoWall-" + deviceId.substring(deviceId.length() - 4);
  const String apPassword = "PhotoWall" + pairingCode.substring(2);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), apPassword.c_str());
  dnsServer.start(53, "*", WiFi.softAPIP());
  photowall::bleProvisioning.begin(deviceId, kFirmwareVersion, setupToken);

  provisionServer.on("/status", HTTP_GET, []() {
    sendProvisionCors();
    provisionServer.send(200, "application/json",
      "{\"state\":\"provisioning\",\"device_id\":\"" + jsonEscape(deviceId) +
      "\",\"firmware_version\":\"" + kFirmwareVersion +
      "\",\"setup_token\":\"" + setupToken + "\"}");
  });
  provisionServer.on("/provision", HTTP_OPTIONS, []() {
    sendProvisionCors();
    provisionServer.send(204);
  });
  provisionServer.on("/provision", HTTP_POST, []() {
    JsonDocument document;
    const bool formSubmission = provisionServer.hasArg("ssid");
    const DeserializationError error = formSubmission
      ? DeserializationError::Ok
      : deserializeJson(document, provisionServer.arg("plain"));
    const String ssid = formSubmission ? provisionServer.arg("ssid") : String(document["ssid"] | "");
    const String password = formSubmission ? provisionServer.arg("password") : String(document["password"] | "");
    const String requestedApi = normalizeApiBase(formSubmission
      ? provisionServer.arg("api_base")
      : String(document["api_base"] | ""));
    if (error || ssid.isEmpty() || requestedApi.isEmpty()) {
      sendProvisionCors();
      if (formSubmission) {
        provisionServer.send(400, "text/html; charset=utf-8",
          "<!doctype html><meta name=viewport content='width=device-width'><h2>Configuration failed</h2>"
          "<p>Please enter your home Wi-Fi name and try again.</p><p><a href='/'>Back</a></p>");
      } else {
        provisionServer.send(400, "application/json", "{\"error\":\"ssid and api_base are required\"}");
      }
      return;
    }
    prefs.begin("photowall", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", password);
    prefs.putString("api", requestedApi);
    prefs.putString("setup", setupToken);
    prefs.remove("token");
    prefs.remove("revision");
    prefs.end();
    sendProvisionCors();
    if (formSubmission) {
      provisionServer.send(202, "text/html; charset=utf-8",
        "<!doctype html><meta name=viewport content='width=device-width'><h2>Connecting PhotoWall</h2>"
        "<p>The display is joining your home Wi-Fi now. This page will close shortly.</p>"
        "<p>Return to the PhotoWall app to finish the connection.</p>");
    } else {
      provisionServer.send(202, "application/json",
        "{\"accepted\":true,\"device_id\":\"" + jsonEscape(deviceId) +
        "\",\"setup_token\":\"" + setupToken + "\"}");
    }
    restartRequested = true;
  });
  provisionServer.onNotFound([]() {
    sendProvisionCors();
    provisionServer.send(200, "text/html; charset=utf-8",
      "<!doctype html><html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>PhotoWall setup</title><style>body{font:17px -apple-system,system-ui,sans-serif;max-width:480px;margin:36px auto;padding:0 22px;color:#18211b}"
      "input{box-sizing:border-box;width:100%;padding:12px;margin:6px 0 18px;border:1px solid #b9c4bb;border-radius:9px;font-size:16px}"
      "button{width:100%;padding:14px;border:0;border-radius:9px;background:#176b45;color:#fff;font-size:17px;font-weight:600}</style>"
      "<h1>PhotoWall E6</h1><p>Enter your home Wi-Fi details. The display will connect to the cloud automatically.</p>"
      "<form action='/provision' method='post'><label>Home Wi-Fi name</label><input name='ssid' required autocomplete='username'>"
      "<label>Wi-Fi password</label><input name='password' type='password' autocomplete='current-password'>"
      "<input name='api_base' type='hidden' value='https://api.mokeedesign.cn'><button type='submit'>Connect display</button></form>"
      "<p>After connecting, return to the PhotoWall app to finish setup.</p></html>");
  });
  provisionServer.begin();
  Serial.printf("Provisioning AP: %s\nPassword: %s\nPairing code: %s\n", apName.c_str(),
                apPassword.c_str(), pairingCode.c_str());
}

bool beginHttp(HTTPClient& http, WiFiClient& plain, WiFiClientSecure& secure, const String& url) {
  http.setConnectTimeout(12000);
  http.setTimeout(30000);
  if (url.startsWith("https://")) {
    // MVP only. Production firmware must pin the cloud CA or server certificate.
    secure.setInsecure();
    return http.begin(secure, url);
  }
  return http.begin(plain, url);
}

bool postJson(const String& path, const String& body, String* response = nullptr,
              int* responseCode = nullptr) {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (!beginHttp(http, plain, secure, apiBase + path)) return false;
  http.addHeader("Content-Type", "application/json");
  const int code = http.POST(body);
  if (responseCode) *responseCode = code;
  if (response) *response = http.getString();
  http.end();
  return code >= 200 && code < 300;
}

bool bootstrapDevice(String* errorMessage = nullptr) {
  JsonDocument request;
  request["device_id"] = deviceId;
  request["pairing_code"] = pairingCode;
  request["setup_token"] = setupToken;
  request["ip"] = WiFi.localIP().toString();
  request["firmware_version"] = kFirmwareVersion;
  request["device_token"] = deviceToken;
  String body;
  serializeJson(request, body);
  String response;
  int bootstrapHttpStatus = 0;
  Serial.println("Cloud bootstrap request: POST /api/devices/bootstrap");
  if (!postJson("/api/devices/bootstrap", body, &response, &bootstrapHttpStatus)) {
    Serial.printf("Device bootstrap failed: HTTP %d %s\n", bootstrapHttpStatus, response.c_str());
    if (errorMessage) {
      JsonDocument errorDocument;
      if (!deserializeJson(errorDocument, response)) {
        *errorMessage = String(errorDocument["error"] | "云端暂时不可用，请稍后重试");
      } else {
        *errorMessage = "云端暂时不可用，请检查家庭网络后重试";
      }
    }
    return false;
  }
  JsonDocument document;
  if (deserializeJson(document, response)) {
    if (errorMessage) *errorMessage = "云端响应格式异常，请稍后重试";
    return false;
  }
  const String receivedToken = document["device_token"] | "";
  if (receivedToken.isEmpty()) {
    if (errorMessage) *errorMessage = "云端未返回设备凭据，请稍后重试";
    return false;
  }
  if (receivedToken != deviceToken) saveDeviceToken(receivedToken);
  const uint32_t pollSeconds = document["poll_seconds"] | (kDefaultPollIntervalMs / 1000);
  pollIntervalMs = constrain(pollSeconds,
                             kMinimumPollIntervalMs / 1000,
                             kMaximumPollIntervalMs / 1000) * 1000UL;
  Serial.printf("Cloud bootstrap accepted: HTTP %d, token_present=yes, poll_seconds=%lu\n",
                bootstrapHttpStatus, static_cast<unsigned long>(pollIntervalMs / 1000));
  if (document["claimed"] | false) {
    prefs.begin("photowall", false);
    prefs.remove("setup");
    prefs.end();
    setupToken = "";
  }
  Serial.println("Device registered with cloud");
  return true;
}

uint16_t readBigEndian16(const uint8_t* value) {
  return static_cast<uint16_t>((value[0] << 8) | value[1]);
}

uint32_t readBigEndian32(const uint8_t* value) {
  return (static_cast<uint32_t>(value[0]) << 24) |
         (static_cast<uint32_t>(value[1]) << 16) |
         (static_cast<uint32_t>(value[2]) << 8) | value[3];
}

bool readExactly(WiFiClient* stream, uint8_t* target, size_t length, uint32_t timeoutMs) {
  size_t offset = 0;
  uint32_t lastData = millis();
  while (offset < length && millis() - lastData < timeoutMs) {
    const int available = stream->available();
    if (available <= 0) {
      delay(2);
      continue;
    }
    const size_t chunk = min(length - offset, static_cast<size_t>(available));
    const int received = stream->readBytes(target + offset, chunk);
    if (received > 0) {
      offset += static_cast<size_t>(received);
      lastData = millis();
    }
  }
  return offset == length;
}

uint8_t* downloadFrame(const String& frameUrl) {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  const String url = frameUrl.startsWith("http") ? frameUrl : apiBase + frameUrl;
  if (!beginHttp(http, plain, secure, url)) return nullptr;
  const int code = http.GET();
  if (code != HTTP_CODE_OK || http.getSize() != static_cast<int>(kFrameHeaderBytes + photowall::kPackedFrameBytes)) {
    Serial.printf("Frame download rejected: HTTP %d size %d\n", code, http.getSize());
    http.end();
    return nullptr;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t header[kFrameHeaderBytes];
  if (!readExactly(stream, header, sizeof(header), 15000)) {
    Serial.println("PWE6 header read timeout");
    http.end();
    return nullptr;
  }
  if (memcmp(header, "PWE6", 4) != 0 || header[4] != 1 ||
      readBigEndian16(header + 5) != photowall::kPanelWidth ||
      readBigEndian16(header + 7) != photowall::kPanelHeight ||
      readBigEndian32(header + 9) != photowall::kPackedFrameBytes) {
    Serial.println("Invalid PWE6 header");
    http.end();
    return nullptr;
  }

  uint8_t* payload = static_cast<uint8_t*>(heap_caps_malloc(
      photowall::kPackedFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!payload) payload = static_cast<uint8_t*>(malloc(photowall::kPackedFrameBytes));
  if (!payload || !readExactly(stream, payload, photowall::kPackedFrameBytes, 30000)) {
    Serial.println("PWE6 payload allocation/read failed");
    free(payload);
    http.end();
    return nullptr;
  }
  http.end();

  uint8_t digest[32];
  mbedtls_sha256(payload, photowall::kPackedFrameBytes, digest, 0);
  if (memcmp(digest, header + 13, sizeof(digest)) != 0) {
    Serial.println("PWE6 SHA-256 mismatch");
    free(payload);
    return nullptr;
  }
  return payload;
}

void reportStatus(const String& state, const String& revision, float progress, const String& error = "") {
  if (deviceToken.isEmpty()) return;
  JsonDocument request;
  request["state"] = state;
  request["revision"] = revision;
  request["progress"] = progress;
  request["error"] = error;
  request["ip"] = WiFi.localIP().toString();
  String body;
  serializeJson(request, body);
  postJson("/api/devices/" + deviceId + "/status?token=" + deviceToken, body);
}

void pollForFrame() {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  const String url = apiBase + "/api/devices/" + deviceId + "/next?revision=" +
                     displayedRevision + "&token=" + deviceToken;
  if (!beginHttp(http, plain, secure, url)) return;
  const int code = http.GET();
  Serial.printf("Cloud next poll: GET /api/devices/%s/next HTTP %d, interval_seconds=%lu\n",
                deviceId.c_str(), code, static_cast<unsigned long>(pollIntervalMs / 1000));
  if (code == HTTP_CODE_NO_CONTENT) {
    http.end();
    return;
  }
  const String response = http.getString();
  http.end();
  if (code != HTTP_CODE_OK) {
    Serial.printf("Frame poll failed: HTTP %d %s\n", code, response.c_str());
    return;
  }

  JsonDocument document;
  if (deserializeJson(document, response)) return;
  const String revision = document["revision"] | "";
  const String frameUrl = document["frame_url"] | "";
  if (revision.isEmpty() || frameUrl.isEmpty()) return;

  reportStatus("downloading", revision, 5);
  uint8_t* payload = downloadFrame(frameUrl);
  if (!payload) {
    reportStatus("error", revision, 0, "frame download or verification failed");
    return;
  }
  reportStatus("refreshing", revision, 50);
  const bool displayed = panel.drawPackedFrame(payload, photowall::kPackedFrameBytes);
  free(payload);
  if (!displayed) {
    reportStatus("error", revision, 50, "panel refresh failed or timed out");
    return;
  }
  saveRevision(revision);
  reportStatus("displayed", revision, 100);
  Serial.printf("Displayed revision %s\n", revision.c_str());
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  deriveIdentity();
  clearConfigurationIfRequested();
  loadConfiguration();
  panel.begin();

  Serial.printf("PhotoWall E6 %s, device %s, pairing %s\n", kFirmwareVersion,
                deviceId.c_str(), pairingCode.c_str());
  if (!hasWifiConfiguration() || !connectWifi()) {
    startProvisioning();
    return;
  }
  if (!bootstrapDevice()) lastPollAt = millis();
}

void loop() {
  photowall::bleProvisioning.loop();
  if (provisioningMode && photowall::bleProvisioning.cloudBootstrapPending()) {
    loadConfiguration();
    String bootstrapError;
    if (bootstrapDevice(&bootstrapError)) {
      photowall::bleProvisioning.completeCloudBootstrap(true, "设备已连接 PhotoWall 云端");
    } else {
      photowall::bleProvisioning.completeCloudBootstrap(false, bootstrapError);
    }
  }
  if (provisioningMode) {
    dnsServer.processNextRequest();
    provisionServer.handleClient();
    if (restartRequested) {
      delay(500);
      ESP.restart();
    }
    delay(2);
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (!connectWifi()) {
      delay(5000);
      return;
    }
    bootstrapDevice();
  }
  if (deviceToken.isEmpty()) {
    if (!bootstrapDevice()) {
      delay(5000);
      return;
    }
  }
  if (lastPollAt == 0 || millis() - lastPollAt >= pollIntervalMs) {
    lastPollAt = millis();
    pollForFrame();
  }
  delay(20);
}

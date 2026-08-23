#include <Arduino.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
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

#if __has_include("demo_wifi_config.h")
#include "demo_wifi_config.h"
#define PHOTOWALL_HAS_DEMO_WIFI 1
#endif

namespace {

constexpr char kFirmwareVersion[] = "0.3.0";
constexpr uint8_t kBootButton = 0;
constexpr uint16_t kProvisionPort = 80;
constexpr uint32_t kWifiConnectTimeoutMs = 30000;
constexpr uint32_t kDefaultPollIntervalMs = 15000;
constexpr uint32_t kMinimumPollIntervalMs = 5000;
constexpr uint32_t kMaximumPollIntervalMs = 300000;
constexpr size_t kFrameHeaderBytes = 45;
constexpr size_t kFrameBytes = kFrameHeaderBytes + photowall::kPackedFrameBytes;

Preferences prefs;
WebServer provisionServer(kProvisionPort);
DNSServer dnsServer;
photowall::Panel13in3E6 panel;
String deviceId;
String pairingCode;
String apiBase;
String wifiSsid;
String wifiPassword;
String deviceToken;
String displayedRevision;
String setupToken;
uint32_t lastPollAt = 0;
uint32_t pollIntervalMs = kDefaultPollIntervalMs;
bool panelInitialized = false;
bool restartRequested = false;
bool provisioningMode = false;
bool forceProvisioning = false;
uint8_t* localFrame = nullptr;
size_t localFrameBytes = 0;
String localFrameState = "idle";
String localFrameError;
bool localTestPatternPending = false;
uint32_t localDisplayQueuedAt = 0;

uint16_t readBigEndian16(const uint8_t* value) {
  return static_cast<uint16_t>((value[0] << 8) | value[1]);
}

uint32_t readBigEndian32(const uint8_t* value) {
  return (static_cast<uint32_t>(value[0]) << 24) |
         (static_cast<uint32_t>(value[1]) << 16) |
         (static_cast<uint32_t>(value[2]) << 8) | value[3];
}

void releaseLocalFrame() {
  free(localFrame);
  localFrame = nullptr;
  localFrameBytes = 0;
}

bool validateLocalFrame() {
  if (!localFrame || localFrameBytes != kFrameBytes) {
    localFrameError = "frame size mismatch";
    return false;
  }
  if (memcmp(localFrame, "PWE6", 4) != 0 || localFrame[4] != 1 ||
      readBigEndian16(localFrame + 5) != photowall::kPanelWidth ||
      readBigEndian16(localFrame + 7) != photowall::kPanelHeight ||
      readBigEndian32(localFrame + 9) != photowall::kPackedFrameBytes) {
    localFrameError = "invalid PWE6 header";
    return false;
  }

  uint8_t digest[32];
  mbedtls_sha256(localFrame + kFrameHeaderBytes, photowall::kPackedFrameBytes, digest, 0);
  if (memcmp(digest, localFrame + 13, sizeof(digest)) != 0) {
    localFrameError = "PWE6 SHA-256 mismatch";
    return false;
  }
  return true;
}

bool displayLocalControlPattern() {
  uint8_t* payload = static_cast<uint8_t*>(heap_caps_malloc(
      photowall::kPackedFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!payload) payload = static_cast<uint8_t*>(malloc(photowall::kPackedFrameBytes));
  if (!payload) return false;

  for (size_t offset = 0; offset < photowall::kPackedFrameBytes; ++offset) {
    payload[offset] = ((offset / 300) % 2 == 0) ? 0x00 : 0xFF;
  }
  if (!panelInitialized) {
    panel.begin();
    panelInitialized = true;
  }
  const bool displayed = panel.drawPackedFrame(payload, photowall::kPackedFrameBytes);
  free(payload);
  return displayed;
}

void processLocalDisplayJob() {
  if (localFrameState != "queued" || millis() - localDisplayQueuedAt < 100) return;

  Serial.println("Local display refresh started");
  localFrameState = "refreshing";
  bool displayed = false;
  if (localTestPatternPending) {
    localTestPatternPending = false;
    displayed = displayLocalControlPattern();
  } else if (localFrame) {
    if (!panelInitialized) {
      panel.begin();
      panelInitialized = true;
    }
    displayed = panel.drawPackedFrame(
        localFrame + kFrameHeaderBytes, photowall::kPackedFrameBytes);
  }
  releaseLocalFrame();
  localFrameState = displayed ? "displayed" : "error";
  if (!displayed) localFrameError = "panel refresh failed";
  Serial.printf("Local display refresh %s\n", displayed ? "completed" : "failed");
}

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
    prefs.putBool("force_setup", true);
    prefs.end();
    Serial.println("Factory reset: Wi-Fi and device credentials cleared");
  }
}

void loadConfiguration() {
  prefs.begin("photowall", false);
  apiBase = prefs.getString("api", "");
  wifiSsid = prefs.getString("ssid", "");
  wifiPassword = prefs.getString("pass", "");
  deviceToken = prefs.getString("token", "");
  displayedRevision = prefs.getString("revision", "");
  setupToken = prefs.getString("setup", "");
  forceProvisioning = prefs.getBool("force_setup", false);
  prefs.end();
}

void applyDemoWifiConfiguration() {
#if PHOTOWALL_HAS_DEMO_WIFI
  if (!forceProvisioning && wifiSsid.isEmpty() && kDemoWifiSsid[0] != '\0') {
    wifiSsid = kDemoWifiSsid;
    wifiPassword = kDemoWifiPassword;
    const String configuredApi = normalizeApiBase(kDemoApiBase);
    if (!configuredApi.isEmpty()) apiBase = configuredApi;
    Serial.printf("Using fixed demonstration Wi-Fi: %s\n", wifiSsid.c_str());
  }
#endif
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
  return !forceProvisioning && !wifiSsid.isEmpty() && !apiBase.isEmpty();
}

bool connectWifi() {
  if (wifiSsid.isEmpty()) return false;

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  Serial.printf("Connecting to Wi-Fi %s", wifiSsid.c_str());
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

void startDeviceServer(bool provisioning) {
  provisioningMode = provisioning;
  String apName;
  String apPassword;
  if (provisioning) {
    Serial.println("Creating setup token");
    setupToken = createSetupToken();
    Serial.println("Setup token ready");
    apName = "PhotoWall-" + deviceId.substring(deviceId.length() - 4);
    apPassword = "PhotoWall" + pairingCode.substring(2);
    Serial.printf("Starting provisioning AP: %s\n", apName.c_str());
    WiFi.mode(WIFI_AP_STA);
    if (!WiFi.softAP(apName.c_str(), apPassword.c_str())) {
      Serial.println("Provisioning AP failed to start");
      return;
    }
    Serial.printf("Provisioning AP ready: %s\n", WiFi.softAPIP().toString().c_str());
    dnsServer.start(53, "*", WiFi.softAPIP());
    photowall::bleProvisioning.begin(
        deviceId, kFirmwareVersion, setupToken, !deviceToken.isEmpty());
  } else {
    String mdnsHost = "photowall-" + deviceId.substring(deviceId.length() - 4);
    mdnsHost.toLowerCase();
    if (MDNS.begin(mdnsHost.c_str())) {
      MDNS.addService("photowall", "tcp", kProvisionPort);
      MDNS.addServiceTxt("photowall", "tcp", "device_id", deviceId);
      Serial.printf("Local device service: http://%s.local\n", mdnsHost.c_str());
    } else {
      Serial.println("mDNS service failed to start");
    }
  }

  provisionServer.on("/status", HTTP_GET, []() {
    const bool provisioning = provisioningMode;
    const String address = provisioning ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
    sendProvisionCors();
    provisionServer.send(200, "application/json",
      "{\"state\":\"" + String(provisioning ? "provisioning" : "online") +
      "\",\"device_id\":\"" + jsonEscape(deviceId) +
      "\",\"firmware_version\":\"" + kFirmwareVersion +
      "\",\"ip\":\"" + address +
      "\",\"frame_state\":\"" + jsonEscape(localFrameState) +
      "\",\"frame_error\":\"" + jsonEscape(localFrameError) +
      "\",\"setup_token\":\"" + (provisioning ? setupToken : "") + "\"}");
  });
  provisionServer.on("/control", HTTP_OPTIONS, []() {
    sendProvisionCors();
    provisionServer.send(204);
  });
  provisionServer.on("/control", HTTP_POST, []() {
    JsonDocument document;
    if (deserializeJson(document, provisionServer.arg("plain"))) {
      sendProvisionCors();
      provisionServer.send(400, "application/json", "{\"error\":\"invalid command\"}");
      return;
    }
    const String action = document["action"] | "";
    if (action != "display_test_pattern") {
      sendProvisionCors();
      provisionServer.send(400, "application/json", "{\"error\":\"unsupported command\"}");
      return;
    }
    if (localFrameState == "queued" || localFrameState == "refreshing") {
      sendProvisionCors();
      provisionServer.send(409, "application/json", "{\"error\":\"display is busy\"}");
      return;
    }
    localFrameError = "";
    localFrameState = "queued";
    localTestPatternPending = true;
    localDisplayQueuedAt = millis();
    sendProvisionCors();
    provisionServer.send(202, "application/json", "{\"state\":\"queued\"}");
  });
  provisionServer.on("/v1/frame", HTTP_OPTIONS, []() {
    sendProvisionCors();
    provisionServer.send(204);
  });
  provisionServer.on("/v1/frame", HTTP_POST, []() {
    int responseCode = 400;
    if (localFrameState == "received") {
      if (!validateLocalFrame()) {
        localFrameState = "error";
        responseCode = 422;
      } else {
        localFrameState = "queued";
        localDisplayQueuedAt = millis();
        responseCode = 202;
      }
    }
    if (responseCode != 202) releaseLocalFrame();
    sendProvisionCors();
    if (responseCode == 202) {
      provisionServer.send(202, "application/json", "{\"state\":\"queued\"}");
    } else {
      provisionServer.send(responseCode, "application/json",
        "{\"state\":\"error\",\"error\":\"" + jsonEscape(localFrameError) + "\"}");
    }
  }, []() {
    HTTPUpload& upload = provisionServer.upload();
    if (upload.status == UPLOAD_FILE_START) {
      releaseLocalFrame();
      localFrameError = "";
      localFrameState = "receiving";
      localFrame = static_cast<uint8_t*>(heap_caps_malloc(kFrameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!localFrame) localFrame = static_cast<uint8_t*>(malloc(kFrameBytes));
      if (!localFrame) {
        localFrameState = "error";
        localFrameError = "frame allocation failed";
      }
    } else if (upload.status == UPLOAD_FILE_WRITE && localFrameState == "receiving") {
      if (localFrameBytes + upload.currentSize > kFrameBytes) {
        localFrameState = "error";
        localFrameError = "frame exceeds expected size";
      } else {
        memcpy(localFrame + localFrameBytes, upload.buf, upload.currentSize);
        localFrameBytes += upload.currentSize;
      }
    } else if (upload.status == UPLOAD_FILE_END && localFrameState == "receiving") {
      if (localFrameBytes == kFrameBytes) {
        localFrameState = "received";
      } else {
        localFrameState = "error";
        localFrameError = "incomplete frame";
      }
    } else if (upload.status == UPLOAD_FILE_ABORTED) {
      localFrameState = "error";
      localFrameError = "upload aborted";
    }
  });
  provisionServer.on("/provision", HTTP_OPTIONS, []() {
    sendProvisionCors();
    provisionServer.send(204);
  });
  provisionServer.on("/provision", HTTP_POST, []() {
    if (!provisioningMode) {
      sendProvisionCors();
      provisionServer.send(404, "application/json", "{\"error\":\"provisioning is not active\"}");
      return;
    }
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
    prefs.remove("force_setup");
    if (deviceToken.isEmpty()) prefs.remove("token");
    prefs.remove("revision");
    prefs.end();
    sendProvisionCors();
    if (formSubmission) {
      provisionServer.send(200, "text/html; charset=utf-8",
        "<!doctype html><html lang='zh-CN'><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>PhotoWall 配网完成</title><style>body{font:17px -apple-system,system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#18211b}"
        "h1{font-size:28px}p{line-height:1.6;color:#5d665f}a{display:block;margin-top:28px;padding:14px;border-radius:9px;background:#176b45;color:#fff;text-align:center;text-decoration:none;font-weight:600}</style>"
        "<h1>屏幕正在连接</h1><p>配置已保存，正在返回 PhotoWall App。</p>"
        "<a href='photowall://setup-complete'>返回 PhotoWall App</a>"
        "<script>setTimeout(function(){location.href='photowall://setup-complete'},350)</script></html>");
    } else {
      provisionServer.send(202, "application/json",
        "{\"accepted\":true,\"device_id\":\"" + jsonEscape(deviceId) +
        "\",\"setup_token\":\"" + setupToken + "\"}");
    }
    restartRequested = true;
  });
  provisionServer.onNotFound([]() {
    sendProvisionCors();
    if (!provisioningMode) {
      provisionServer.send(404, "application/json", "{\"error\":\"not found\"}");
      return;
    }
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
  if (provisioning) {
    Serial.printf("Provisioning AP: %s\nPassword: %s\nPairing code: %s\n", apName.c_str(),
                  apPassword.c_str(), pairingCode.c_str());
  }
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

bool bootstrapDevice() {
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
    return false;
  }
  JsonDocument document;
  if (deserializeJson(document, response)) return false;
  const String receivedToken = document["device_token"] | "";
  if (receivedToken.isEmpty()) return false;
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

void restartInProvisioningMode(bool preserveBinding) {
  const String state = preserveBinding ? "reprovisioning" : "unbound";
  reportStatus(state, displayedRevision, 0);
  prefs.begin("photowall", false);
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.remove("api");
  prefs.remove("setup");
  prefs.remove("revision");
  prefs.putBool("force_setup", true);
  if (!preserveBinding) prefs.remove("token");
  prefs.end();
  Serial.printf("Cloud requested BLE reprovisioning: preserve_binding=%s\n",
                preserveBinding ? "yes" : "no");
  delay(500);
  ESP.restart();
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
  const String command = document["command"] | "";
  if (command == "reprovision") {
    restartInProvisioningMode(document["preserve_binding"] | false);
    return;
  }
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
  if (!panelInitialized) {
    panel.begin();
    panelInitialized = true;
  }
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
  delay(6000);
  Serial.println("PhotoWall startup diagnostics ready");
  deriveIdentity();
  clearConfigurationIfRequested();
  loadConfiguration();
  applyDemoWifiConfiguration();

  Serial.printf("PhotoWall E6 %s, device %s, pairing %s\n", kFirmwareVersion,
                deviceId.c_str(), pairingCode.c_str());
  if (!hasWifiConfiguration() || !connectWifi()) {
    startDeviceServer(true);
    return;
  }
  startDeviceServer(false);
  if (!bootstrapDevice()) lastPollAt = millis();
}

void loop() {
  provisionServer.handleClient();
  photowall::bleProvisioning.loop();
  if (provisioningMode && photowall::bleProvisioning.cloudBootstrapPending()) {
    loadConfiguration();
    if (bootstrapDevice()) {
      photowall::bleProvisioning.completeCloudBootstrap(
          true, "设备已连接 PhotoWall 服务");
    } else {
      photowall::bleProvisioning.completeCloudBootstrap(
          false, "PhotoWall 服务暂时不可用，请检查家庭网络后重试");
    }
  }
  processLocalDisplayJob();
  if (provisioningMode) {
    dnsServer.processNextRequest();
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

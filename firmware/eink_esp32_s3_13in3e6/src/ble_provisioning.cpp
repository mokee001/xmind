#include "ble_provisioning.h"

#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLESecurity.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_gap_ble_api.h>
#include <esp_gatt_defs.h>

namespace photowall {
namespace {

constexpr char kServiceUuid[] = "7d2e0001-6f7a-4f2b-9d3a-54d7f1b0a001";
constexpr char kInfoUuid[] = "7d2e0002-6f7a-4f2b-9d3a-54d7f1b0a001";
constexpr char kCommandUuid[] = "7d2e0003-6f7a-4f2b-9d3a-54d7f1b0a001";
constexpr char kEventUuid[] = "7d2e0004-6f7a-4f2b-9d3a-54d7f1b0a001";
constexpr uint8_t kFrameVersion = 1;
constexpr size_t kEventChunkBytes = 140;
constexpr uint32_t kWifiConnectTimeoutMs = 30000;
constexpr uint32_t kRestartDelayMs = 5000;
constexpr size_t kMaximumNetworks = 20;

BleProvisioningService* activeService = nullptr;

class CommandCallbacks : public BLECharacteristicCallbacks {
 public:
  void onWrite(BLECharacteristic* characteristic) override {
    if (activeService) activeService->handleCommandWrite(characteristic);
  }
};

class ServerCallbacks : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer*) override {
    if (activeService) activeService->handleClientConnected();
  }

  void onDisconnect(BLEServer*) override {
    if (activeService) activeService->handleClientDisconnected();
  }
};

class SecurityCallbacks : public BLESecurityCallbacks {
 public:
  uint32_t onPassKeyRequest() override { return 0; }
  void onPassKeyNotify(uint32_t) override {}
  bool onSecurityRequest() override { return true; }
  void onAuthenticationComplete(esp_ble_auth_cmpl_t result) override {
    if (!result.success) Serial.println("BLE secure session authentication failed");
  }
  bool onConfirmPIN(uint32_t) override { return true; }
};

CommandCallbacks commandCallbacks;
ServerCallbacks serverCallbacks;
SecurityCallbacks securityCallbacks;

String jsonString(const JsonDocument& document) {
  String output;
  serializeJson(document, output);
  return output;
}

}  // namespace

BleProvisioningService bleProvisioning;

void BleProvisioningService::begin(
    const String& deviceId, const String& firmwareVersion, const String& setupToken) {
  if (active_) return;
  deviceId_ = deviceId;
  firmwareVersion_ = firmwareVersion;
  setupToken_ = setupToken;
  status_ = "idle";
  activeService = this;

  String advertisedName = "PhotoWall-" + deviceId.substring(deviceId.length() - 4);
  advertisedName.toUpperCase();
  BLEDevice::init(advertisedName);
  BLEDevice::setMTU(185);
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT);
  BLEDevice::setSecurityCallbacks(&securityCallbacks);

  BLESecurity security;
  security.setAuthenticationMode(ESP_LE_AUTH_REQ_SC_BOND);
  security.setCapability(ESP_IO_CAP_NONE);
  security.setKeySize(16);
  security.setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  security.setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  BLEService* service = server->createService(BLEUUID(String(kServiceUuid)), 16);

  infoCharacteristic_ = service->createCharacteristic(kInfoUuid, BLECharacteristic::PROPERTY_READ);
  infoCharacteristic_->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  JsonDocument info;
  info["deviceId"] = deviceId_;
  info["deviceName"] = advertisedName;
  info["firmwareVersion"] = firmwareVersion_;
  info["setupToken"] = setupToken_;
  infoCharacteristic_->setValue(jsonString(info));

  BLECharacteristic* commandCharacteristic = service->createCharacteristic(
      kCommandUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  commandCharacteristic->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  commandCharacteristic->setCallbacks(&commandCallbacks);

  eventCharacteristic_ = service->createCharacteristic(
      kEventUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  eventCharacteristic_->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  BLE2902* notifications = new BLE2902();
  notifications->setNotifications(true);
  notifications->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED | ESP_GATT_PERM_WRITE_ENCRYPTED);
  eventCharacteristic_->addDescriptor(notifications);
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  advertising->start();
  active_ = true;
  Serial.printf("BLE provisioning ready: %s\n", advertisedName.c_str());
}

void BleProvisioningService::loop() {
  if (!active_) return;

  char command[kCommandBufferBytes] = {};
  bool hasCommand = false;
  portENTER_CRITICAL(&commandMux_);
  if (commandReady_) {
    memcpy(command, pendingCommand_, sizeof(command));
    commandReady_ = false;
    hasCommand = true;
  }
  portEXIT_CRITICAL(&commandMux_);
  if (hasCommand) processCommand(command);

  if (scanRequested_) {
    scanRequested_ = false;
    scanNetworks();
  }
  if (wifiConnecting_) processWifiConnection();
  if (restartAt_ != 0 && static_cast<int32_t>(millis() - restartAt_) >= 0) {
    stop();
    delay(100);
    ESP.restart();
  }
}

void BleProvisioningService::stop() {
  if (!active_) return;
  BLEDevice::stopAdvertising();
  BLEDevice::deinit(true);
  active_ = false;
  clientConnected_ = false;
  activeService = nullptr;
}

bool BleProvisioningService::active() const { return active_; }

void BleProvisioningService::handleClientConnected() {
  clientConnected_ = true;
  setStatus(status_.c_str(), "安全蓝牙会话已连接");
}

void BleProvisioningService::handleClientDisconnected() {
  clientConnected_ = false;
  if (active_ && restartAt_ == 0) BLEDevice::startAdvertising();
}

void BleProvisioningService::resetCommandFrame() {
  commandFrameLength_ = 0;
  commandMessageId_ = 0;
  commandNextSequence_ = 0;
  commandTotalChunks_ = 0;
}

void BleProvisioningService::handleCommandWrite(BLECharacteristic* characteristic) {
  const uint8_t* data = characteristic->getData();
  const size_t length = characteristic->getLength();
  if (!data || length < 5 || data[0] != kFrameVersion) {
    resetCommandFrame();
    return;
  }

  const uint8_t messageId = data[1];
  const uint8_t sequence = data[2];
  const uint8_t total = data[3];
  if (total == 0 || sequence >= total) {
    resetCommandFrame();
    return;
  }
  if (sequence == 0) {
    resetCommandFrame();
    commandMessageId_ = messageId;
    commandTotalChunks_ = total;
  }
  if (messageId != commandMessageId_ || total != commandTotalChunks_ ||
      sequence != commandNextSequence_) {
    resetCommandFrame();
    return;
  }

  const size_t payloadLength = length - 4;
  if (commandFrameLength_ + payloadLength >= sizeof(commandFrame_)) {
    resetCommandFrame();
    return;
  }
  memcpy(commandFrame_ + commandFrameLength_, data + 4, payloadLength);
  commandFrameLength_ += payloadLength;
  commandNextSequence_++;
  if (commandNextSequence_ != commandTotalChunks_) return;

  commandFrame_[commandFrameLength_] = '\0';
  portENTER_CRITICAL(&commandMux_);
  if (!commandReady_) {
    memcpy(pendingCommand_, commandFrame_, commandFrameLength_ + 1);
    commandReady_ = true;
  }
  portEXIT_CRITICAL(&commandMux_);
  resetCommandFrame();
}

void BleProvisioningService::processCommand(const char* command) {
  JsonDocument document;
  if (deserializeJson(document, command)) {
    setStatus("error", "蓝牙命令格式无效", "invalid_command");
    return;
  }
  const String suppliedToken = document["setupToken"] | "";
  if (suppliedToken.isEmpty() || suppliedToken != setupToken_) {
    setStatus("error", "设备凭证校验失败", "invalid_setup_token");
    return;
  }

  const String operation = document["op"] | "";
  if (operation == "scan") {
    if (wifiConnecting_) {
      setStatus("error", "设备正在连接 Wi-Fi", "busy");
      return;
    }
    scanRequested_ = true;
    setStatus("scanning", "正在扫描附近 Wi-Fi");
    return;
  }
  if (operation == "provision") {
    const String ssid = document["ssid"] | "";
    const String password = document["password"] | "";
    if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 64) {
      setStatus("error", "Wi-Fi 凭据格式无效", "invalid_credentials");
      return;
    }
    startWifiConnection(ssid, password);
    return;
  }
  if (operation == "cancel") {
    WiFi.disconnect(false, false);
    wifiConnecting_ = false;
    pendingPassword_ = "";
    setStatus("idle", "已取消配网");
    return;
  }
  setStatus("error", "不支持的蓝牙命令", "unsupported_command");
}

void BleProvisioningService::scanNetworks() {
  const int count = WiFi.scanNetworks(false, true);
  if (count < 0) {
    setStatus("error", "Wi-Fi 扫描失败", "scan_failed");
    return;
  }

  JsonDocument event;
  event["type"] = "wifi_networks";
  JsonArray networks = event["networks"].to<JsonArray>();
  size_t added = 0;
  for (int index = 0; index < count && added < kMaximumNetworks; ++index) {
    const String ssid = WiFi.SSID(index);
    if (ssid.isEmpty()) continue;
    bool duplicate = false;
    for (JsonObject existing : networks) {
      if (String(existing["ssid"] | "") == ssid) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    JsonObject network = networks.add<JsonObject>();
    network["ssid"] = ssid;
    network["signalStrength"] = WiFi.RSSI(index);
    network["secure"] = WiFi.encryptionType(index) != WIFI_AUTH_OPEN;
    added++;
  }
  WiFi.scanDelete();
  sendEvent(jsonString(event));
  setStatus("awaiting_credentials", "请选择家庭 Wi-Fi");
}

void BleProvisioningService::startWifiConnection(const String& ssid, const String& password) {
  pendingSsid_ = ssid;
  pendingPassword_ = password;
  WiFi.disconnect(false, false);
  WiFi.begin(pendingSsid_.c_str(), pendingPassword_.c_str());
  wifiConnectStartedAt_ = millis();
  wifiConnecting_ = true;
  setStatus("connecting", "正在连接家庭 Wi-Fi");
  Serial.printf("BLE provisioning connecting to Wi-Fi %s\n", pendingSsid_.c_str());
}

void BleProvisioningService::processWifiConnection() {
  const wl_status_t wifiStatus = WiFi.status();
  if (wifiStatus == WL_CONNECTED) {
    Preferences preferences;
    preferences.begin("photowall", false);
    preferences.putString("ssid", pendingSsid_);
    preferences.putString("pass", pendingPassword_);
    preferences.putString("api", "https://api.mokeedesign.cn");
    preferences.putString("setup", setupToken_);
    preferences.remove("token");
    preferences.remove("revision");
    preferences.end();
    pendingPassword_ = "";
    wifiConnecting_ = false;
    setStatus("connected", "家庭 Wi-Fi 已连接");
    restartAt_ = millis() + kRestartDelayMs;
    return;
  }
  if (wifiStatus == WL_CONNECT_FAILED) {
    pendingPassword_ = "";
    wifiConnecting_ = false;
    setStatus("wrong_password", "Wi-Fi 密码错误，请重试", "wrong_password");
    return;
  }
  if (wifiStatus == WL_NO_SSID_AVAIL) {
    pendingPassword_ = "";
    wifiConnecting_ = false;
    setStatus("network_not_found", "没有找到该 Wi-Fi", "network_not_found");
    return;
  }
  if (millis() - wifiConnectStartedAt_ >= kWifiConnectTimeoutMs) {
    WiFi.disconnect(false, false);
    pendingPassword_ = "";
    wifiConnecting_ = false;
    setStatus("timeout", "连接 Wi-Fi 超时，请重试", "timeout");
  }
}

void BleProvisioningService::setStatus(
    const char* status, const String& message, const String& errorCode) {
  status_ = status;
  JsonDocument event;
  event["type"] = "status";
  event["status"] = status_;
  event["message"] = message;
  event["deviceId"] = deviceId_;
  event["localUrl"] = status_ == "connected" ? localUrl() : "";
  event["errorCode"] = errorCode;
  sendEvent(jsonString(event));
}

void BleProvisioningService::sendEvent(const String& json) {
  if (!eventCharacteristic_) return;
  eventCharacteristic_->setValue(json);
  if (!clientConnected_) return;

  static uint8_t messageId = 0;
  messageId++;
  const size_t totalChunks = (json.length() + kEventChunkBytes - 1) / kEventChunkBytes;
  for (size_t sequence = 0; sequence < totalChunks; ++sequence) {
    const size_t offset = sequence * kEventChunkBytes;
    const size_t payloadLength = min(kEventChunkBytes, json.length() - offset);
    uint8_t frame[kEventChunkBytes + 4];
    frame[0] = kFrameVersion;
    frame[1] = messageId;
    frame[2] = static_cast<uint8_t>(sequence);
    frame[3] = static_cast<uint8_t>(totalChunks);
    memcpy(frame + 4, json.c_str() + offset, payloadLength);
    eventCharacteristic_->setValue(frame, payloadLength + 4);
    eventCharacteristic_->notify();
    delay(20);
  }
}

String BleProvisioningService::localUrl() const {
  String suffix = deviceId_.substring(deviceId_.length() - 4);
  suffix.toLowerCase();
  return "http://photowall-" + suffix + ".local";
}

}  // namespace photowall
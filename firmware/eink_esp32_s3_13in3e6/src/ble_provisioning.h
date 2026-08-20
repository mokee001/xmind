#pragma once

#include <Arduino.h>

class BLECharacteristic;

namespace photowall {

class BleProvisioningService {
 public:
  void begin(const String& deviceId, const String& firmwareVersion, const String& setupToken);
  void loop();
  void stop();
  bool active() const;

  void handleCommandWrite(BLECharacteristic* characteristic);
  void handleClientConnected();
  void handleClientDisconnected();

 private:
  static constexpr size_t kCommandBufferBytes = 768;

  void processCommand(const char* command);
  void scanNetworks();
  void startWifiConnection(const String& ssid, const String& password);
  void processWifiConnection();
  void setStatus(const char* status, const String& message = "", const String& errorCode = "");
  void sendEvent(const String& json);
  String localUrl() const;
  void resetCommandFrame();

  BLECharacteristic* infoCharacteristic_ = nullptr;
  BLECharacteristic* eventCharacteristic_ = nullptr;
  String deviceId_;
  String firmwareVersion_;
  String setupToken_;
  String pendingSsid_;
  String pendingPassword_;
  String status_ = "idle";
  char commandFrame_[kCommandBufferBytes] = {};
  char pendingCommand_[kCommandBufferBytes] = {};
  size_t commandFrameLength_ = 0;
  uint8_t commandMessageId_ = 0;
  uint8_t commandNextSequence_ = 0;
  uint8_t commandTotalChunks_ = 0;
  volatile bool commandReady_ = false;
  bool active_ = false;
  bool clientConnected_ = false;
  bool scanRequested_ = false;
  bool wifiConnecting_ = false;
  uint32_t wifiConnectStartedAt_ = 0;
  uint32_t restartAt_ = 0;
  portMUX_TYPE commandMux_ = portMUX_INITIALIZER_UNLOCKED;
};

extern BleProvisioningService bleProvisioning;

}  // namespace photowall
#pragma once

#include <Arduino.h>

namespace photowall {

constexpr size_t kPanelWidth = 1200;
constexpr size_t kPanelHeight = 1600;
constexpr size_t kPackedFrameBytes = kPanelWidth * kPanelHeight / 2;

// Driver for the dual-controller Waveshare 13.3E6 panel. The initialization
// sequence is derived from Waveshare's Apache-2.0 licensed Arduino example.
class Panel13in3E6 {
 public:
  void begin();
  bool drawPackedFrame(const uint8_t* payload, size_t length);

 private:
  static constexpr uint8_t kSck = 9;
  static constexpr uint8_t kMosi = 46;
  static constexpr uint8_t kCsMaster = 10;
  static constexpr uint8_t kCsSlave = 3;
  static constexpr uint8_t kBusy = 12;
  static constexpr uint8_t kReset = 2;
  static constexpr uint8_t kDc = 11;
  static constexpr uint8_t kPower = 1;

  void selectAll(bool selected);
  void transfer(uint8_t value);
  void command(uint8_t value);
  void data(uint8_t value);
  void reset();
  bool waitUntilIdle(uint32_t timeoutMs = 120000);
  bool initialize();
  bool refreshAndSleep();
};

}  // namespace photowall

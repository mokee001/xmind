#pragma once
#include <Arduino.h>
#include <SPI.h>

namespace photowall {
constexpr size_t kPanelWidth = 800;
constexpr size_t kPanelHeight = 480;
constexpr size_t kPackedFrameBytes = kPanelWidth * kPanelHeight / 2;
class PanelE1002 {
 public:
  void begin();
  bool drawPackedFrame(const uint8_t* payload, size_t length,
                       uint16_t width = kPanelWidth, uint16_t height = kPanelHeight);
 private:
  SPIClass spi_{HSPI};
  static constexpr uint8_t kSck = 7, kMosi = 9, kCs = 10, kDc = 11, kReset = 12, kBusy = 13;
  void command(uint8_t value);
  void data(const uint8_t* values, size_t length);
  bool waitUntilIdle(const char* stage, bool requireBusy = false);
  bool initialize();
  void sleep();
};
}

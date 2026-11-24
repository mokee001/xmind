#pragma once

#include <cstdint>

namespace photowall {

// Waveshare ESP32-S3-ePaper-13.3E6 onboard ES8311 + NS4150B, not generic I2S pins.
constexpr int kBoardAudioSdaPin = 41;
constexpr int kBoardAudioSclPin = 42;
constexpr int kBoardAudioMclkPin = 14;
constexpr int kBoardAudioBclkPin = 21;
constexpr int kBoardAudioWsPin = 47;
constexpr int kBoardAudioDataPin = 45;
constexpr int kBoardAudioAmpPin = 13;
constexpr uint32_t kBoardAudioSampleRate = 16000;
constexpr uint32_t kBoardAudioMclkHz = kBoardAudioSampleRate * 256;

class BoardEs8311 {
 public:
  bool begin();
  bool setMuted(bool muted);
  void end();

 private:
  bool writeRegister(uint8_t reg, uint8_t value);
  bool readRegister(uint8_t reg, uint8_t& value);
  bool busStarted_ = false;
  bool detected_ = false;
};

}  // namespace photowall

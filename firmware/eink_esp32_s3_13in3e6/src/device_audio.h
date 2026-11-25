#pragma once

#include <cstddef>
#include <cstdint>

namespace photowall {

enum class DeviceSound : uint8_t { PowerOn, PairingSuccess, PowerOff, ButtonPress, WifiConnected };

// Only physical interactions are audible for now. Keep the network/binding
// events available to the state machines, but suppress them at the audio boundary.
constexpr bool deviceSoundEnabled(DeviceSound sound) {
  return sound == DeviceSound::PowerOn || sound == DeviceSound::PowerOff ||
         sound == DeviceSound::ButtonPress;
}

enum class AudioBackend : uint8_t {
  Disabled, PassiveBuzzer, ActiveBuzzer, I2sSpeaker, BoardEs8311
};

struct DeviceAudioConfig {
  AudioBackend backend = AudioBackend::Disabled;
  int signalPin = -1;
  int bclkPin = -1;
  int wordSelectPin = -1;
  int dataPin = -1;
  bool activeLow = false;
  unsigned volumePercent = 12;
};

struct SoundNote {
  uint16_t frequencyHz;
  uint16_t durationMs;
  uint16_t pauseMs;
};

struct SoundPattern {
  const SoundNote* notes;
  size_t count;
};

constexpr uint32_t kSoundSampleRate = 16000;

// Excludes the panel, buttons, USB, UART, flash/PSRAM, straps and onboard RGB LED.
constexpr bool safeAudioOutputPin(int pin) {
  return (pin >= 4 && pin <= 7) || (pin >= 13 && pin <= 18) || pin == 21 ||
         (pin >= 38 && pin <= 42 && pin != 40) || pin == 47;
}

constexpr bool validDeviceAudioConfig(const DeviceAudioConfig& config) {
  if (config.backend == AudioBackend::Disabled) return true;
  if (config.volumePercent > 100) return false;
  if (config.backend == AudioBackend::PassiveBuzzer ||
      config.backend == AudioBackend::ActiveBuzzer) {
    return safeAudioOutputPin(config.signalPin);
  }
  if (config.backend == AudioBackend::I2sSpeaker) {
    return safeAudioOutputPin(config.bclkPin) && safeAudioOutputPin(config.wordSelectPin) &&
           safeAudioOutputPin(config.dataPin) && config.bclkPin != config.wordSelectPin &&
           config.bclkPin != config.dataPin && config.wordSelectPin != config.dataPin;
  }
  if (config.backend == AudioBackend::BoardEs8311) {
    // The verified board mapping is fixed, including its otherwise reserved GPIO45.
    return config.signalPin == -1 && config.bclkPin == -1 &&
           config.wordSelectPin == -1 && config.dataPin == -1 && !config.activeLow;
  }
  return false;
}

SoundPattern deviceSoundPattern(DeviceSound sound);
void generateDeviceToneSamples(uint16_t frequencyHz, uint32_t firstSample,
                               uint32_t totalSamples, unsigned volumePercent,
                               int16_t* samples, size_t count);
bool beginDeviceAudio();
bool deviceAudioReady();
bool playDeviceSound(DeviceSound sound);
void stopDeviceAudio();

}  // namespace photowall

#include "device_audio.h"

#include <Arduino.h>
#include <algorithm>
#include <cmath>

#if __has_include("device_audio_config.h")
#include "device_audio_config.h"
#endif

#ifndef PHOTOWALL_AUDIO_BACKEND
#define PHOTOWALL_AUDIO_BACKEND 0
#endif
#ifndef PHOTOWALL_AUDIO_SIGNAL_PIN
#define PHOTOWALL_AUDIO_SIGNAL_PIN -1
#endif
#ifndef PHOTOWALL_AUDIO_ACTIVE_LOW
#define PHOTOWALL_AUDIO_ACTIVE_LOW 0
#endif
#ifndef PHOTOWALL_AUDIO_BCLK_PIN
#define PHOTOWALL_AUDIO_BCLK_PIN -1
#endif
#ifndef PHOTOWALL_AUDIO_WS_PIN
#define PHOTOWALL_AUDIO_WS_PIN -1
#endif
#ifndef PHOTOWALL_AUDIO_DATA_PIN
#define PHOTOWALL_AUDIO_DATA_PIN -1
#endif
#ifndef PHOTOWALL_AUDIO_VOLUME_PERCENT
#define PHOTOWALL_AUDIO_VOLUME_PERCENT 12
#endif

#if PHOTOWALL_AUDIO_BACKEND == 3 || PHOTOWALL_AUDIO_BACKEND == 4
#include <ESP_I2S.h>
#endif
#if PHOTOWALL_AUDIO_BACKEND == 4
#include "board_es8311.h"
#endif
#if defined(ARDUINO_ARCH_ESP32)
#include <driver/gpio.h>
#endif

namespace photowall {
namespace {

constexpr DeviceAudioConfig kConfig = {
    static_cast<AudioBackend>(PHOTOWALL_AUDIO_BACKEND),
    PHOTOWALL_AUDIO_SIGNAL_PIN,
    PHOTOWALL_AUDIO_BCLK_PIN,
    PHOTOWALL_AUDIO_WS_PIN,
    PHOTOWALL_AUDIO_DATA_PIN,
    PHOTOWALL_AUDIO_ACTIVE_LOW != 0,
    PHOTOWALL_AUDIO_VOLUME_PERCENT};
// Lengthen power cues by 20%; retain all pitches and the pairing cadence.
constexpr SoundNote kPowerOn[] = {{1568, 120, 60}, {2093, 192, 0}};
constexpr SoundNote kPairingSuccess[] = {{2093, 80, 40}, {2637, 80, 40}, {3136, 180, 0}};
constexpr SoundNote kPowerOff[] = {{2093, 240, 84}, {1568, 480, 0}};
bool audioReady = false;
bool audioPinsConfigured = false;

const char* soundName(DeviceSound sound) {
  switch (sound) {
    case DeviceSound::PowerOn: return "power_on";
    case DeviceSound::PairingSuccess: return "pairing_success";
    case DeviceSound::PowerOff: return "power_off";
  }
  return "unknown";
}

#if PHOTOWALL_AUDIO_BACKEND != 0
void releaseAudioPin(int pin, int idleLevel = LOW) {
  digitalWrite(pin, idleLevel);
  pinMode(pin, OUTPUT);
#if defined(ARDUINO_ARCH_ESP32)
  gpio_hold_dis(static_cast<gpio_num_t>(pin));
#endif
}

void holdQuietAudioPin(int pin, int level) {
  digitalWrite(pin, level);
  pinMode(pin, OUTPUT);
#if defined(ARDUINO_ARCH_ESP32)
  gpio_hold_en(static_cast<gpio_num_t>(pin));
#endif
}
#endif

#if PHOTOWALL_AUDIO_BACKEND == 3 || PHOTOWALL_AUDIO_BACKEND == 4
I2SClass audioI2s;

bool writeI2sTone(uint16_t frequencyHz, uint16_t durationMs) {
  const uint32_t total = kSoundSampleRate * durationMs / 1000;
  int16_t mono[128];
  int16_t stereo[256];
  for (uint32_t first = 0; first < total; first += 128) {
    const size_t count = std::min<uint32_t>(128, total - first);
    generateDeviceToneSamples(frequencyHz, first, total, kConfig.volumePercent, mono, count);
    // Send identical left/right slots; amplifier channel-selection straps need not change.
    for (size_t index = 0; index < count; ++index) {
      stereo[index * 2] = mono[index];
      stereo[index * 2 + 1] = mono[index];
    }
    const size_t bytes = count * 2 * sizeof(int16_t);
    if (audioI2s.write(reinterpret_cast<const uint8_t*>(stereo), bytes) != bytes) return false;
  }
  return true;
}
#endif

#if PHOTOWALL_AUDIO_BACKEND == 4
static_assert(kSoundSampleRate == kBoardAudioSampleRate, "ES8311 clock configuration must match PCM");
BoardEs8311 boardCodec;
#endif

}  // namespace

SoundPattern deviceSoundPattern(DeviceSound sound) {
  switch (sound) {
    case DeviceSound::PowerOn: return {kPowerOn, sizeof(kPowerOn) / sizeof(kPowerOn[0])};
    case DeviceSound::PairingSuccess:
      return {kPairingSuccess, sizeof(kPairingSuccess) / sizeof(kPairingSuccess[0])};
    case DeviceSound::PowerOff: return {kPowerOff, sizeof(kPowerOff) / sizeof(kPowerOff[0])};
  }
  return {nullptr, 0};
}

void generateDeviceToneSamples(uint16_t frequencyHz, uint32_t firstSample,
                               uint32_t totalSamples, unsigned volumePercent,
                               int16_t* samples, size_t count) {
  constexpr float kTwoPi = 6.28318530718f;
  constexpr uint32_t kFadeSamples = kSoundSampleRate / 200;
  const float amplitude = 32767.0f * std::min(volumePercent, 100U) / 100.0f;
  for (size_t index = 0; index < count; ++index) {
    const uint32_t frame = firstSample + index;
    if (frequencyHz == 0 || frame >= totalSamples) {
      samples[index] = 0;
      continue;
    }
    const float envelope = static_cast<float>(std::min(
        kFadeSamples, std::min(frame, totalSamples - frame - 1))) / kFadeSamples;
    const float phase = kTwoPi * frequencyHz * frame / kSoundSampleRate;
    samples[index] = static_cast<int16_t>(std::sin(phase) * amplitude * envelope);
  }
}

bool beginDeviceAudio() {
  if (audioReady) return true;
  if (kConfig.backend == AudioBackend::Disabled) {
    Serial.printf("Audio disabled: output module and wiring have not been configured\n");
    return false;
  }
  if (!validDeviceAudioConfig(kConfig)) {
    Serial.printf("Audio disabled: invalid or conflicting output pins/configuration\n");
    return false;
  }
#if PHOTOWALL_AUDIO_BACKEND == 1
  releaseAudioPin(kConfig.signalPin);
  audioPinsConfigured = true;
  audioReady = ledcAttach(kConfig.signalPin, 1000, 8);
  if (audioReady) ledcWrite(kConfig.signalPin, 0);
#elif PHOTOWALL_AUDIO_BACKEND == 2
  releaseAudioPin(kConfig.signalPin, kConfig.activeLow ? HIGH : LOW);
  audioPinsConfigured = true;
  audioReady = true;
#elif PHOTOWALL_AUDIO_BACKEND == 3
  releaseAudioPin(kConfig.bclkPin);
  releaseAudioPin(kConfig.wordSelectPin);
  releaseAudioPin(kConfig.dataPin);
  audioPinsConfigured = true;
  audioI2s.setPins(kConfig.bclkPin, kConfig.wordSelectPin, kConfig.dataPin);
  audioReady = audioI2s.begin(I2S_MODE_STD, kSoundSampleRate,
                            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  if (!audioReady) stopDeviceAudio();
#elif PHOTOWALL_AUDIO_BACKEND == 4
  releaseAudioPin(kBoardAudioAmpPin, LOW);
  releaseAudioPin(kBoardAudioSdaPin, HIGH);
  releaseAudioPin(kBoardAudioSclPin, HIGH);
  releaseAudioPin(kBoardAudioMclkPin);
  releaseAudioPin(kBoardAudioBclkPin);
  releaseAudioPin(kBoardAudioWsPin);
  releaseAudioPin(kBoardAudioDataPin);
  audioPinsConfigured = true;
  // GPIO48 belongs to the ES7210 recording path. Do not create an RX channel.
  audioI2s.setPins(kBoardAudioBclkPin, kBoardAudioWsPin, kBoardAudioDataPin, -1,
                  kBoardAudioMclkPin);
  if (audioI2s.begin(I2S_MODE_STD, kSoundSampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                     I2S_SLOT_MODE_STEREO) && boardCodec.begin() && writeI2sTone(0, 120)) {
    delay(100);
    audioReady = true;
    Serial.printf("Audio board SPK ready: 16000 Hz, MCLK %lu Hz, PCM %u%%, codec -6 dB, PA off\n",
                  static_cast<unsigned long>(kBoardAudioMclkHz), kConfig.volumePercent);
  } else {
    stopDeviceAudio();
  }
#endif
  Serial.printf("Audio output initialization: %s\n", audioReady ? "ready" : "failed");
  return audioReady;
}

bool deviceAudioReady() { return audioReady; }

bool playDeviceSound(DeviceSound sound) {
  if (!audioReady) {
    Serial.printf("Sound skipped: %s (audio output unavailable)\n", soundName(sound));
    return false;
  }
  const SoundPattern pattern = deviceSoundPattern(sound);
  if (pattern.count == 0) return false;
  uint32_t patternDurationMs = 0;
  for (size_t index = 0; index < pattern.count; ++index) {
    patternDurationMs += pattern.notes[index].durationMs + pattern.notes[index].pauseMs;
  }
  const uint32_t started = millis();
  Serial.printf("Sound playback: %s\n", soundName(sound));
  Serial.printf("Audio cue plan: notes=%u duration_ms=%lu PCM=%u%%\n",
                static_cast<unsigned>(pattern.count),
                static_cast<unsigned long>(patternDurationMs), kConfig.volumePercent);
#if PHOTOWALL_AUDIO_BACKEND == 4
  if (!writeI2sTone(0, 40) || !boardCodec.setMuted(false)) {
    stopDeviceAudio();
    return false;
  }
  delay(40);
  digitalWrite(kBoardAudioAmpPin, HIGH);
  delay(10);
  Serial.printf("Audio PA enable requested: GPIO13 HIGH (not an acoustic measurement)\n");
#endif
  for (size_t index = 0; index < pattern.count; ++index) {
    const auto& note = pattern.notes[index];
#if PHOTOWALL_AUDIO_BACKEND == 1
    if (ledcWriteTone(kConfig.signalPin, note.frequencyHz) == 0) {
      ledcWrite(kConfig.signalPin, 0);
      return false;
    }
    delay(note.durationMs);
    ledcWrite(kConfig.signalPin, 0);
    delay(note.pauseMs);
#elif PHOTOWALL_AUDIO_BACKEND == 2
    digitalWrite(kConfig.signalPin, kConfig.activeLow ? LOW : HIGH);
    delay(note.durationMs);
    digitalWrite(kConfig.signalPin, kConfig.activeLow ? HIGH : LOW);
    delay(note.pauseMs);
#elif PHOTOWALL_AUDIO_BACKEND == 3 || PHOTOWALL_AUDIO_BACKEND == 4
    if (!writeI2sTone(note.frequencyHz, note.durationMs) || !writeI2sTone(0, note.pauseMs)) {
      Serial.printf("Audio I2S write failed\n");
      stopDeviceAudio();
      return false;
    }
#else
    (void)note;
#endif
  }
#if PHOTOWALL_AUDIO_BACKEND == 3 || PHOTOWALL_AUDIO_BACKEND == 4
  // Drain the DMA tail before a following shutdown can disable the transmitter.
  if (!writeI2sTone(0, 120)) {
    stopDeviceAudio();
    return false;
  }
  delay(100);
#endif
#if PHOTOWALL_AUDIO_BACKEND == 4
  const bool muted = boardCodec.setMuted(true);
  digitalWrite(kBoardAudioAmpPin, LOW);
  if (!muted) {
    stopDeviceAudio();
    return false;
  }
#endif
  Serial.printf("Sound playback complete: %s\n", soundName(sound));
  Serial.printf("Audio cue transport finished: elapsed_ms=%lu; audible result requires confirmation\n",
                static_cast<unsigned long>(millis() - started));
  return true;
}

void stopDeviceAudio() {
#if PHOTOWALL_AUDIO_BACKEND == 4
  // Also protect cold-start standby, before codec/I2S have ever been initialized.
  holdQuietAudioPin(kBoardAudioAmpPin, LOW);
#endif
  if (!audioPinsConfigured) return;
#if PHOTOWALL_AUDIO_BACKEND == 1
  if (audioReady) {
    ledcWrite(kConfig.signalPin, 0);
    ledcDetach(kConfig.signalPin);
  }
  holdQuietAudioPin(kConfig.signalPin, LOW);
#elif PHOTOWALL_AUDIO_BACKEND == 2
  holdQuietAudioPin(kConfig.signalPin, kConfig.activeLow ? HIGH : LOW);
#elif PHOTOWALL_AUDIO_BACKEND == 3
  audioI2s.end();
  holdQuietAudioPin(kConfig.bclkPin, LOW);
  holdQuietAudioPin(kConfig.wordSelectPin, LOW);
  holdQuietAudioPin(kConfig.dataPin, LOW);
#elif PHOTOWALL_AUDIO_BACKEND == 4
  boardCodec.end();
  audioI2s.end();
  holdQuietAudioPin(kBoardAudioMclkPin, LOW);
  holdQuietAudioPin(kBoardAudioBclkPin, LOW);
  holdQuietAudioPin(kBoardAudioWsPin, LOW);
  holdQuietAudioPin(kBoardAudioDataPin, LOW);
  holdQuietAudioPin(kBoardAudioSdaPin, HIGH);
  holdQuietAudioPin(kBoardAudioSclPin, HIGH);
#endif
  audioReady = false;
  audioPinsConfigured = false;
}

}  // namespace photowall

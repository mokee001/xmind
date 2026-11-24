#include "device_audio.h"
#include "board_es8311.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <Wire.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <set>
#include <vector>

#ifndef PHOTOWALL_AUDIO_DATA_PIN
#define PHOTOWALL_AUDIO_DATA_PIN -1
#endif
#ifndef PHOTOWALL_AUDIO_VOLUME_PERCENT
#define PHOTOWALL_AUDIO_VOLUME_PERCENT 12
#endif

namespace {

constexpr bool kBoard = PHOTOWALL_AUDIO_BACKEND == 4;
constexpr unsigned kVolumePercent = PHOTOWALL_AUDIO_VOLUME_PERCENT;
static_assert(kVolumePercent <= 100, "PCM test volume must be valid");
constexpr int kMaxPcmSample = 32767U * kVolumePercent / 100;
struct Hardware {
  std::array<uint8_t, 256> registers{};
  std::array<uint8_t, 49> levels{};
  std::set<uint8_t> touchedPins;
  std::vector<uint8_t> tx;
  uint8_t readReg = 0;
  bool wireReady = false;
  bool i2sReady = false;
  bool wireBeginSucceeds = true;
  bool i2sBeginSucceeds = true;
  bool shortI2cWrite = false;
  bool negativeI2cRead = false;
  bool wrongReadback = false;
  bool ignoreMuteWrites = false;
  size_t transactions = 0;
  size_t failTransactionAt = 0;
  size_t requests = 0;
  size_t shortReadAt = 0;
  size_t i2sWrites = 0;
  size_t failI2sWriteAt = 0;
  size_t frames = 0;
  size_t nonzeroFrames = 0;
  int peakSample = 0;
  unsigned paEnables = 0;
  unsigned codecWrites = 0;
  uint32_t elapsedMs = 0;
} hw;

void assertQuiet() {
  assert(!photowall::deviceAudioReady());
  assert(!hw.i2sReady && !hw.wireReady);
  if (kBoard) assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
}

void resetHardware() {
  photowall::stopDeviceAudio();
  hw = Hardware{};
  hw.registers[0xFD] = 0x83;
  hw.registers[0xFE] = 0x11;
}

void startReady() {
  assert(photowall::beginDeviceAudio());
  assert(photowall::deviceAudioReady());
  if (kBoard) {
    assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
    assert(hw.registers[0x31] == 0x60 && hw.registers[0x32] == 0xB3);
    assert(hw.registers[0x0E] == 0x6A);
  }
}

}  // namespace

NativeSerial Serial;
TwoWire Wire;
uint32_t millis() { return hw.elapsedMs; }
int digitalRead(uint8_t) { return HIGH; }
void pinMode(uint8_t pin, uint8_t mode) {
  assert(mode == OUTPUT && pin < hw.levels.size());
  hw.touchedPins.insert(pin);
}
void digitalWrite(uint8_t pin, uint8_t value) {
  assert(pin < hw.levels.size());
  hw.touchedPins.insert(pin);
  hw.levels[pin] = value;
  if (kBoard && pin == photowall::kBoardAudioAmpPin && value == HIGH) {
    assert(hw.i2sReady && hw.wireReady && (hw.registers[0x31] & 0x60) == 0);
    ++hw.paEnables;
  }
}
void delay(uint32_t durationMs) { hw.elapsedMs += durationMs; }
bool ledcAttach(uint8_t, uint32_t, uint8_t) { assert(false); return false; }
bool ledcWrite(uint8_t, uint32_t) { assert(false); return false; }
uint32_t ledcWriteTone(uint8_t, uint32_t) { assert(false); return 0; }
bool ledcDetach(uint8_t) { assert(false); return false; }
void NativeSerial::printf(const char*, ...) {}

bool TwoWire::begin(int sda, int scl, uint32_t frequency) {
  assert(kBoard && sda == 41 && scl == 42 && frequency == 100000);
  assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
  hw.wireReady = hw.wireBeginSucceeds;
  return hw.wireReady;
}
bool TwoWire::end() {
  assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
  hw.wireReady = false;
  return true;
}
void TwoWire::setTimeOut(uint16_t durationMs) { assert(durationMs == 25); }
void TwoWire::beginTransmission(uint8_t address) {
  assert(hw.wireReady && address == 0x18);
  hw.tx.clear();
}
size_t TwoWire::write(uint8_t value) {
  if (hw.shortI2cWrite) return 0;
  hw.tx.push_back(value);
  return 1;
}
uint8_t TwoWire::endTransmission(bool stop) {
  assert(stop);
  ++hw.transactions;
  if (hw.transactions == hw.failTransactionAt) return 4;
  if (hw.tx.size() == 1) hw.readReg = hw.tx[0];
  if (hw.tx.size() == 2) {
    const uint8_t reg = hw.tx[0];
    if (reg != 0x31) assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
    if (reg != 0x31 || !hw.ignoreMuteWrites) hw.registers[reg] = hw.tx[1];
    ++hw.codecWrites;
  }
  return 0;
}
size_t TwoWire::requestFrom(uint8_t address, size_t length, bool stop) {
  assert(address == 0x18 && length == 1 && stop);
  ++hw.requests;
  return hw.requests == hw.shortReadAt ? 0 : 1;
}
int TwoWire::available() { return 1; }
int TwoWire::read() {
  if (hw.negativeI2cRead) return -1;
  if (hw.wrongReadback && hw.readReg == 0x09) return 0;
  return hw.registers[hw.readReg];
}

void I2SClass::setPins(int8_t bclk, int8_t ws, int8_t dout, int8_t din, int8_t mclk) {
  assert(din == -1);  // No microphone or recording channel.
  if (kBoard) {
    assert(bclk == 21 && ws == 47 && dout == 45 && mclk == 14);
    assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
  } else {
    assert(bclk == 4 && ws == 5 && dout == 6 && mclk == -1);
  }
}
bool I2SClass::begin(i2s_mode_t mode, uint32_t rate, i2s_data_bit_width_t bits,
                     i2s_slot_mode_t slots, int8_t slotMask) {
  assert(mode == I2S_MODE_STD && rate == 16000 && bits == I2S_DATA_BIT_WIDTH_16BIT);
  assert(slots == I2S_SLOT_MODE_STEREO && slotMask == -1);
  // Simulate a partially allocated channel even when initialization reports failure.
  hw.i2sReady = true;
  return hw.i2sBeginSucceeds;
}
bool I2SClass::end() {
  if (kBoard) assert(hw.levels[photowall::kBoardAudioAmpPin] == LOW);
  hw.i2sReady = false;
  return true;
}
size_t I2SClass::write(const uint8_t* data, size_t length) {
  assert(hw.i2sReady && length % 4 == 0);
  ++hw.i2sWrites;
  if (hw.i2sWrites == hw.failI2sWriteAt) return length - 1;
  for (size_t index = 0; index < length; index += 4) {
    int16_t left = 0;
    int16_t right = 0;
    std::memcpy(&left, data + index, sizeof(left));
    std::memcpy(&right, data + index + 2, sizeof(right));
    assert(left == right);
    const int magnitude = std::abs(static_cast<int>(left));
    assert(magnitude <= kMaxPcmSample);
    hw.peakSample = std::max(hw.peakSample, magnitude);
    ++hw.frames;
    if (left != 0) {
      ++hw.nonzeroFrames;
      if (kBoard) assert(hw.levels[photowall::kBoardAudioAmpPin] == HIGH);
    }
  }
  return length;
}

int main() {
  using namespace photowall;
  if (kBoard && PHOTOWALL_AUDIO_DATA_PIN != -1) {
    assert(!beginDeviceAudio());
    assert(hw.touchedPins.empty() && hw.transactions == 0 && hw.i2sWrites == 0);
    std::puts("PASS: onboard backend refuses configurable/occupied GPIO before initialization");
    return 0;
  }

  resetHardware();
  if (kBoard) {
    stopDeviceAudio();
    assert(hw.touchedPins == std::set<uint8_t>{13} && hw.levels[13] == LOW);
  }
  startReady();
  const size_t initTransactions = hw.transactions;
  const size_t initReads = hw.requests;
  assert(beginDeviceAudio() && hw.transactions == initTransactions);
  constexpr std::array<uint32_t, 3> cueDurationsMs = {372, 420, 804};
  size_t soundIndex = 0;
  for (const auto sound : {DeviceSound::PowerOn, DeviceSound::PairingSuccess, DeviceSound::PowerOff}) {
    const size_t framesBefore = hw.frames;
    assert(playDeviceSound(sound));
    const uint32_t transmittedMs = cueDurationsMs[soundIndex++] + 120 + (kBoard ? 40 : 0);
    assert(hw.frames - framesBefore == transmittedMs * 16);
    if (kBoard) assert(hw.levels[13] == LOW && hw.registers[0x31] == 0x60);
  }
  assert(hw.frames == (kBoard ? 2196U : 1956U) * 16);
  assert(hw.nonzeroFrames > 14000);
  assert(hw.peakSample >= kMaxPcmSample * 99 / 100);
  assert(!playDeviceSound(static_cast<DeviceSound>(99)));
  stopDeviceAudio();
  assertQuiet();
  if (kBoard) {
    assert(hw.paEnables == 3);
    const std::set<uint8_t> expectedPins = {13, 14, 21, 41, 42, 45, 47};
    assert(hw.touchedPins == expectedPins);
    assert(hw.registers[0x12] == 0x02 && hw.registers[0x0D] == 0xFC && hw.registers[0x01] == 0);
    assert(hw.levels[41] == HIGH && hw.levels[42] == HIGH);
    for (const auto pin : {13, 14, 21, 45, 47}) assert(hw.levels[pin] == LOW);
  } else {
    assert(hw.transactions == 0 && hw.paEnables == 0);
  }

  resetHardware();
  hw.i2sBeginSucceeds = false;
  assert(!beginDeviceAudio());
  assertQuiet();

  if (kBoard) {
    resetHardware();
    hw.wireBeginSucceeds = false;
    assert(!beginDeviceAudio());
    assertQuiet();
    resetHardware();
    hw.registers[0xFE] = 0x12;
    assert(!beginDeviceAudio() && hw.codecWrites == 0);
    assertQuiet();
    resetHardware();
    hw.shortI2cWrite = true;
    assert(!beginDeviceAudio());
    assertQuiet();
    resetHardware();
    hw.negativeI2cRead = true;
    assert(!beginDeviceAudio());
    assertQuiet();
    resetHardware();
    hw.wrongReadback = true;
    assert(!beginDeviceAudio());
    assertQuiet();
    for (size_t failure = 1; failure <= initTransactions; ++failure) {
      resetHardware();
      hw.failTransactionAt = failure;
      assert(!beginDeviceAudio() && hw.paEnables == 0);
      assertQuiet();
    }
    for (size_t failure = 1; failure <= initReads; ++failure) {
      resetHardware();
      hw.shortReadAt = failure;
      assert(!beginDeviceAudio() && hw.paEnables == 0);
      assertQuiet();
    }
    resetHardware();
    hw.failI2sWriteAt = 1;
    assert(!beginDeviceAudio() && hw.paEnables == 0);
    assertQuiet();
    // Unmute/mute read, write and verification must all fail closed.
    for (size_t failure = 1; failure <= 6; ++failure) {
      resetHardware();
      startReady();
      hw.failTransactionAt = hw.transactions + failure;
      assert(!playDeviceSound(DeviceSound::PowerOn));
      assertQuiet();
    }
    for (size_t failure = 1; failure <= 4; ++failure) {
      resetHardware();
      startReady();
      hw.shortReadAt = hw.requests + failure;
      assert(!playDeviceSound(DeviceSound::PowerOff));
      assertQuiet();
    }
    resetHardware();
    startReady();
    hw.ignoreMuteWrites = true;
    assert(!playDeviceSound(DeviceSound::PowerOff));
    assert(hw.paEnables == 0);  // An ACK is not sufficient to enable the PA.
    assertQuiet();
  }
  for (const size_t offset : {size_t{1}, size_t{10}}) {
    resetHardware();
    startReady();
    hw.failI2sWriteAt = hw.i2sWrites + offset;
    assert(!playDeviceSound(DeviceSound::PowerOn));
    assertQuiet();
  }
  resetHardware();
  startReady();
  stopDeviceAudio();
  assertQuiet();
  std::printf("PASS: I2S backend=%d PCM=%u%%; fixed pins/TX, codec ID/readback, every I2C fault, PCM peak/cues, PA gating and quiet cleanup\n",
              PHOTOWALL_AUDIO_BACKEND, kVolumePercent);
}

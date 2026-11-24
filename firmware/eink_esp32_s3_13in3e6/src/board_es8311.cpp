/*
 * SPDX-FileCopyrightText: 2015-2022 Espressif Systems (Shanghai) CO LTD
 * SPDX-License-Identifier: Apache-2.0
 *
 * Playback-only adaptation of Waveshare's Arduino 02_Audio_out ES8311 driver.
 * Fixed 16 kHz / 4.096 MHz clocks; checked I2C, chip identity and quiet shutdown.
 */

#include "board_es8311.h"

#include <Arduino.h>
#include <Wire.h>

namespace photowall {
namespace {

constexpr uint8_t kCodecAddress = 0x18;
constexpr uint8_t kCodecVolume = 0xB3;  // -6 dB; return to the last level without reported distortion.
struct RegisterValue { uint8_t reg; uint8_t value; };
constexpr RegisterValue kPlaybackRegisters[] = {
    {0x31, 0x60},  // Mute both DAC stages before enabling analog output.
    {0x32, kCodecVolume},
    {0x01, 0x3F},  // External MCLK, normal polarity, codec slave.
    {0x02, 0x00}, {0x03, 0x10}, {0x04, 0x10}, {0x05, 0x00},
    {0x06, 0x03}, {0x07, 0x00}, {0x08, 0xFF},  // 16 kHz / MCLK x256.
    {0x09, 0x0C}, {0x0A, 0x0C},  // 16-bit I2S, left slot into mono DAC.
    {0x0D, 0x01},
    {0x0E, 0x6A},  // Keep unused PGA and ADC modulator powered down.
    {0x12, 0x00}, {0x13, 0x10}, {0x37, 0x08}};
  constexpr RegisterValue kReadbackRegisters[] = {
    {0x01, 0x3F}, {0x09, 0x0C}, {0x31, 0x60}, {0x32, kCodecVolume}};

}  // namespace

bool BoardEs8311::writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(kCodecAddress);
  const bool queued = Wire.write(reg) == 1 && Wire.write(value) == 1;
  const uint8_t result = Wire.endTransmission(true);
  return queued && result == 0;
}

bool BoardEs8311::readRegister(uint8_t reg, uint8_t& value) {
  Wire.beginTransmission(kCodecAddress);
  const bool queued = Wire.write(reg) == 1;
  const uint8_t result = Wire.endTransmission(true);
  if (!queued || result != 0 || Wire.requestFrom(kCodecAddress, size_t{1}, true) != 1 ||
      Wire.available() != 1) return false;
  const int received = Wire.read();
  if (received < 0) return false;
  value = static_cast<uint8_t>(received);
  return true;
}

bool BoardEs8311::begin() {
  if (busStarted_) end();
  busStarted_ = Wire.begin(kBoardAudioSdaPin, kBoardAudioSclPin, 100000);
  if (!busStarted_) return false;
  Wire.setTimeOut(25);
  uint8_t id1 = 0;
  uint8_t id2 = 0;
  if (!readRegister(0xFD, id1) || !readRegister(0xFE, id2) || id1 != 0x83 || id2 != 0x11) {
    Serial.printf("Audio ES8311 not detected at I2C 0x18; amplifier stays disabled\n");
    return false;
  }
  detected_ = true;
  Serial.printf("Audio ES8311 detected: I2C 0x18, chip ID 0x8311\n");
  if (!writeRegister(0x00, 0x1F)) return false;
  delay(20);
  if (!writeRegister(0x00, 0x00) || !writeRegister(0x00, 0x80)) return false;
  for (const auto& setting : kPlaybackRegisters) {
    if (!writeRegister(setting.reg, setting.value)) return false;
  }
  // Acknowledged writes alone are not proof of correct digital audio configuration.
  for (const auto& expected : kReadbackRegisters) {
    uint8_t value = 0;
    if (!readRegister(expected.reg, value) || value != expected.value) return false;
  }
  return true;
}

bool BoardEs8311::setMuted(bool muted) {
  if (!detected_ || !busStarted_) return false;
  uint8_t value = 0;
  if (!readRegister(0x31, value)) return false;
  value = muted ? value | 0x60 : value & ~0x60;
  if (!writeRegister(0x31, value)) return false;
  uint8_t actual = 0;
  if (!readRegister(0x31, actual) || actual != value) {
    Serial.printf("Audio DAC mute readback failed; amplifier must stay disabled\n");
    return false;
  }
  Serial.printf("Audio DAC mute readback: requested=%s reg31=0x%02X\n",
                muted ? "muted" : "unmuted", static_cast<unsigned>(actual));
  return true;
}

void BoardEs8311::end() {
  if (!busStarted_) return;
  bool quiet = true;
  if (detected_) {
    // Caller disables PA first. Keep clocks running until DAC/analog power is off.
    quiet &= setMuted(true);
    quiet &= writeRegister(0x12, 0x02);
    quiet &= writeRegister(0x13, 0x00);
    quiet &= writeRegister(0x0E, 0x6A);
    quiet &= writeRegister(0x0D, 0xFC);
    quiet &= writeRegister(0x00, 0x1F);
    quiet &= writeRegister(0x01, 0x00);
  }
  quiet &= Wire.end();
  if (!quiet) Serial.printf("Audio codec shutdown incomplete; amplifier disabled independently\n");
  detected_ = false;
  busStarted_ = false;
}

}  // namespace photowall

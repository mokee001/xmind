// Modified panel driver for PhotoWall.
// The controller initialization values are derived from Waveshare's
// ESP32-S3-ePaper-13.3E6 Arduino example, licensed under Apache-2.0.

#include "panel_13in3e6.h"

namespace photowall {

void Panel13in3E6::begin() {
  pinMode(kBusy, INPUT_PULLUP);
  pinMode(kReset, OUTPUT);
  pinMode(kDc, OUTPUT);
  pinMode(kSck, OUTPUT);
  pinMode(kMosi, OUTPUT);
  pinMode(kCsMaster, OUTPUT);
  pinMode(kCsSlave, OUTPUT);
  pinMode(kPower, OUTPUT);
  digitalWrite(kCsMaster, HIGH);
  digitalWrite(kCsSlave, HIGH);
  digitalWrite(kReset, LOW);
  digitalWrite(kPower, LOW);
  digitalWrite(kSck, LOW);
}

void Panel13in3E6::selectAll(bool selected) {
  digitalWrite(kCsMaster, selected ? LOW : HIGH);
  digitalWrite(kCsSlave, selected ? LOW : HIGH);
}

void Panel13in3E6::transfer(uint8_t value) {
  for (uint8_t bit = 0; bit < 8; ++bit) {
    digitalWrite(kMosi, value & 0x80 ? HIGH : LOW);
    value <<= 1;
    digitalWrite(kSck, HIGH);
    digitalWrite(kSck, LOW);
  }
}

void Panel13in3E6::command(uint8_t value) {
  digitalWrite(kDc, LOW);
  transfer(value);
}

void Panel13in3E6::data(uint8_t value) {
  digitalWrite(kDc, HIGH);
  transfer(value);
}

void Panel13in3E6::reset() {
  digitalWrite(kReset, HIGH);
  delay(30);
  digitalWrite(kReset, LOW);
  delay(30);
  digitalWrite(kReset, HIGH);
  delay(30);
  digitalWrite(kReset, LOW);
  delay(30);
  digitalWrite(kReset, HIGH);
  delay(30);
}

bool Panel13in3E6::waitUntilIdle(const char* stage, uint32_t timeoutMs) {
  const uint32_t started = millis();
  while (digitalRead(kBusy) == LOW) {
    if (millis() - started > timeoutMs) {
      Serial.printf("Panel BUSY timeout during %s (pin=%d)\n", stage, digitalRead(kBusy));
      return false;
    }
    delay(100);
  }
  Serial.printf("Panel ready after %s (%lu ms)\n", stage,
                static_cast<unsigned long>(millis() - started));
  return true;
}

bool Panel13in3E6::initialize() {
  selectAll(false);
  digitalWrite(kReset, LOW);
  digitalWrite(kPower, LOW);
  delay(100);
  Serial.printf("Panel BUSY with power off: %d\n", digitalRead(kBusy));
  digitalWrite(kPower, HIGH);
  delay(10);
  Serial.printf("Panel BUSY after power on: %d\n", digitalRead(kBusy));
  reset();
  Serial.printf("Panel BUSY after reset: %d\n", digitalRead(kBusy));

  digitalWrite(kCsMaster, LOW);
  command(0x74);
  const uint8_t cmd74[] = {0xC0, 0x1C, 0x1C, 0xCC, 0xCC, 0xCC, 0x15, 0x15, 0x55};
  for (uint8_t value : cmd74) data(value);
  selectAll(false);

  selectAll(true);
  command(0xF0);
  const uint8_t cmdF0[] = {0x49, 0x55, 0x13, 0x5D, 0x05, 0x10};
  for (uint8_t value : cmdF0) data(value);
  selectAll(false);

  selectAll(true);
  command(0x00);
  data(0xDF);
  data(0x69);
  selectAll(false);

  selectAll(true);
  command(0x50);
  data(0xF7);
  selectAll(false);

  selectAll(true);
  command(0x60);
  data(0x03);
  data(0x03);
  selectAll(false);

  selectAll(true);
  command(0x86);
  data(0x10);
  selectAll(false);

  selectAll(true);
  command(0xE3);
  data(0x22);
  selectAll(false);

  selectAll(true);
  command(0xE0);
  data(0x01);
  selectAll(false);

  selectAll(true);
  command(0x61);
  data(0x04);
  data(0xB0);
  data(0x03);
  data(0x20);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0x01);
  const uint8_t cmd01[] = {0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38};
  for (uint8_t value : cmd01) data(value);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0xB6);
  data(0x07);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0x06);
  data(0xE8);
  data(0x28);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0xB7);
  data(0x01);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0x05);
  data(0xE8);
  data(0x28);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0xB0);
  data(0x01);
  selectAll(false);

  digitalWrite(kCsMaster, LOW);
  command(0xB1);
  data(0x02);
  selectAll(false);
  return true;
}

bool Panel13in3E6::refreshAndSleep() {
  selectAll(true);
  command(0x04);
  selectAll(false);
  if (!waitUntilIdle("power on")) {
    digitalWrite(kReset, LOW);
    digitalWrite(kPower, LOW);
    return false;
  }

  delay(50);
  selectAll(true);
  command(0x12);
  data(0x00);
  selectAll(false);
  if (!waitUntilIdle("display refresh")) {
    digitalWrite(kReset, LOW);
    digitalWrite(kPower, LOW);
    return false;
  }

  selectAll(true);
  command(0x02);
  data(0x00);
  selectAll(false);

  selectAll(true);
  command(0x07);
  data(0xA5);
  selectAll(false);
  delay(100);
  digitalWrite(kPower, LOW);
  digitalWrite(kReset, LOW);
  return true;
}

bool Panel13in3E6::drawPackedFrame(const uint8_t* payload, size_t length) {
  if (payload == nullptr || length != kPackedFrameBytes || !initialize()) return false;

  // PWE6: low nibble = first pixel, high nibble = second pixel.
  // Controller: high nibble = first pixel, low nibble = second pixel.
  // A full nibble swap preserves pixel order while converting representations.
  digitalWrite(kCsMaster, LOW);
  command(0x10);
  for (size_t row = 0; row < kPanelHeight; ++row) {
    const size_t rowOffset = row * (kPanelWidth / 2);
    for (size_t columnByte = 0; columnByte < kPanelWidth / 4; ++columnByte) {
      const uint8_t packed = payload[rowOffset + columnByte];
      data(static_cast<uint8_t>((packed << 4) | (packed >> 4)));
    }
    if ((row & 31U) == 0) yield();
  }
  selectAll(false);

  digitalWrite(kCsSlave, LOW);
  command(0x10);
  for (size_t row = 0; row < kPanelHeight; ++row) {
    const size_t rowOffset = row * (kPanelWidth / 2) + (kPanelWidth / 4);
    for (size_t columnByte = 0; columnByte < kPanelWidth / 4; ++columnByte) {
      const uint8_t packed = payload[rowOffset + columnByte];
      data(static_cast<uint8_t>((packed << 4) | (packed >> 4)));
    }
    if ((row & 31U) == 0) yield();
  }
  selectAll(false);
  return refreshAndSleep();
}

}  // namespace photowall

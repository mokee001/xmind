// E1002 ED2208 initialization and pin map derived from Seeed_GFX commit
// 0dfdd7135425be82b5bb4b4b58d74dd51ab29a59, Setup521 and ED2208_Init.h.
// Upstream notices are retained in ../licenses/Seeed_GFX.txt.
#ifdef PHOTOWALL_RETERMINAL_E1002
#include "panel_e1002.h"
#include "frame_format.h"
#include <initializer_list>

namespace photowall {
void PanelE1002::begin() {
  pinMode(kBusy, INPUT);
  pinMode(kCs, OUTPUT); digitalWrite(kCs, HIGH);
  pinMode(kDc, OUTPUT); digitalWrite(kDc, HIGH);
  pinMode(kReset, OUTPUT); digitalWrite(kReset, HIGH);
  spi_.begin(kSck, -1, kMosi, kCs);
}
void PanelE1002::command(uint8_t value) {
  spi_.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(kDc, LOW); digitalWrite(kCs, LOW);
  spi_.transfer(value);
  digitalWrite(kCs, HIGH); spi_.endTransaction();
}
void PanelE1002::data(const uint8_t* values, size_t length) {
  spi_.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(kDc, HIGH); digitalWrite(kCs, LOW);
  spi_.writeBytes(values, length);
  digitalWrite(kCs, HIGH); spi_.endTransaction();
}
bool PanelE1002::waitUntilIdle(const char* stage, bool requireBusy) {
  const uint32_t started = millis();
  bool sawBusy = false;
  // Allow the controller to assert BUSY after receiving the command. A refresh
  // that never asserts BUSY is not a confirmed successful screen update.
  do {
    if (digitalRead(kBusy) == LOW) sawBusy = true;
    if (digitalRead(kBusy) == HIGH && (!requireBusy || sawBusy)) {
      delay(20);
      Serial.printf("E1002 panel ready: %s, %lu ms, busy_seen=%d\n", stage,
                    static_cast<unsigned long>(millis() - started), sawBusy);
      return true;
    }
    delay(1);
  } while (millis() - started < (requireBusy && !sawBusy ? 2000UL : 120000UL));
  Serial.printf("E1002 panel timeout: %s, busy_seen=%d\n", stage, sawBusy);
  return false;
}
bool PanelE1002::initialize() {
  digitalWrite(kReset, LOW); delay(20);
  digitalWrite(kReset, HIGH); delay(10);
  if (!waitUntilIdle("reset")) return false;
  const auto reg = [this](uint8_t cmd, std::initializer_list<uint8_t> values) {
    command(cmd); data(values.begin(), values.size());
  };
  reg(0xAA, {0x49,0x55,0x20,0x08,0x09,0x18});
  reg(0x01, {0x3F,0x00,0x32,0x2A,0x0E,0x2A});
  reg(0x00, {0x5F,0x69});
  reg(0x03, {0x00,0x54,0x00,0x44});
  reg(0x05, {0x40,0x1F,0x1F,0x2C});
  reg(0x06, {0x6F,0x1F,0x16,0x25});
  reg(0x08, {0x6F,0x1F,0x1F,0x22});
  reg(0x13, {0x00,0x04});
  reg(0x30, {0x02}); reg(0x41, {0x00}); reg(0x50, {0x3F});
  reg(0x60, {0x02,0x00}); reg(0x61, {0x03,0x20,0x01,0xE0});
  reg(0x82, {0x1E}); reg(0x84, {0x01}); reg(0x86, {0x00});
  reg(0xE3, {0x2F}); reg(0xE0, {0x00}); reg(0xE6, {0x00});
  command(0x04); delay(10);
  return waitUntilIdle("power on");
}
void PanelE1002::sleep() {
  command(0x02); const uint8_t zero = 0; data(&zero, 1); delay(10);
  waitUntilIdle("power off");
  command(0x07); const uint8_t key = 0xA5; data(&key, 1);
}
bool PanelE1002::drawPackedFrame(const uint8_t* payload, size_t length,
                                uint16_t width, uint16_t height) {
  if (!payload || !((width == 800 && height == 480) || (width == 1200 && height == 1600)) ||
      length != size_t(width) * height / 2 || !validPanelCodes(payload, length)) return false;
  if (!initialize()) { digitalWrite(kReset, LOW); return false; }
  command(0x10);
  uint8_t row[kPanelWidth / 2];
  for (uint16_t y = 0; y < kPanelHeight; ++y) {
    for (uint16_t x = 0; x < kPanelWidth; x += 2) {
      const uint8_t a = containedPixel(payload, width, height, x, y, kPanelWidth, kPanelHeight);
      const uint8_t b = containedPixel(payload, width, height, x + 1, y, kPanelWidth, kPanelHeight);
      row[x / 2] = (a << 4) | b;
    }
    data(row, sizeof(row));
    if ((y & 15) == 0) yield();
  }
  command(0x12); const uint8_t zero = 0; data(&zero, 1);
  const bool refreshed = waitUntilIdle("refresh", true);
  if (refreshed) sleep(); else digitalWrite(kReset, LOW);
  return refreshed;
}
}
#endif

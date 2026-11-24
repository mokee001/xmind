#pragma once

#include <cstddef>
#include <cstdint>

class TwoWire {
 public:
  bool begin(int sda, int scl, uint32_t frequency);
  bool end();
  void setTimeOut(uint16_t timeoutMs);
  void beginTransmission(uint8_t address);
  size_t write(uint8_t value);
  uint8_t endTransmission(bool stop);
  size_t requestFrom(uint8_t address, size_t length, bool stop);
  int available();
  int read();
};

extern TwoWire Wire;

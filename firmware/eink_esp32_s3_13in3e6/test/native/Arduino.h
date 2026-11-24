#pragma once

#include <cstdint>

constexpr int LOW = 0;
constexpr int HIGH = 1;
constexpr uint8_t OUTPUT = 1;
constexpr uint8_t INPUT_PULLUP = 2;

uint32_t millis();
int digitalRead(uint8_t pin);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t level);
void delay(uint32_t durationMs);
bool ledcAttach(uint8_t pin, uint32_t frequency, uint8_t resolution);
bool ledcWrite(uint8_t pin, uint32_t duty);
uint32_t ledcWriteTone(uint8_t pin, uint32_t frequency);
bool ledcDetach(uint8_t pin);

struct NativeSerial {
  void printf(const char* format, ...);
  void begin(unsigned);
  void setTxTimeoutMs(unsigned);
  void print(char);
  void println();
  void println(const char*);
  void flush();
};

extern NativeSerial Serial;

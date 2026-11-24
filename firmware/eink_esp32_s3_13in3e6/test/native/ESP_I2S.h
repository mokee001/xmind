#pragma once

#include <cstddef>
#include <cstdint>

enum i2s_mode_t { I2S_MODE_STD };
enum i2s_data_bit_width_t { I2S_DATA_BIT_WIDTH_16BIT = 16 };
enum i2s_slot_mode_t { I2S_SLOT_MODE_STEREO = 2 };

class I2SClass {
 public:
  void setPins(int8_t bclk, int8_t ws, int8_t dout, int8_t din = -1, int8_t mclk = -1);
  bool begin(i2s_mode_t mode, uint32_t rate, i2s_data_bit_width_t bits,
             i2s_slot_mode_t slots, int8_t slotMask = -1);
  bool end();
  size_t write(const uint8_t* data, size_t length);
};

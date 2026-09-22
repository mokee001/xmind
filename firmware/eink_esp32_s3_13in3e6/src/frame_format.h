#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace photowall {
constexpr size_t kPwe6HeaderBytes = 45;
constexpr size_t kMaxFramePayload = 1200 * 1600 / 2;
struct FrameShape {
  uint16_t width = 0;
  uint16_t height = 0;
  size_t bytes = 0;
};
inline bool parseFrameHeader(const uint8_t* header, size_t length, FrameShape& shape) {
  if (!header || length < kPwe6HeaderBytes || memcmp(header, "PWE6", 4) || header[4] != 1)
    return false;
  const uint16_t w = (uint16_t(header[5]) << 8) | header[6];
  const uint16_t h = (uint16_t(header[7]) << 8) | header[8];
  const uint32_t bytes = (uint32_t(header[9]) << 24) | (uint32_t(header[10]) << 16) |
                         (uint32_t(header[11]) << 8) | header[12];
  bool supported = w == 1200 && h == 1600;
#ifdef PHOTOWALL_RETERMINAL_E1002
  supported = supported || (w == 800 && h == 480);
#endif
  if (!supported || bytes != size_t(w) * h / 2) return false;
  shape = {w, h, bytes};
  return true;
}
inline bool validPanelCodes(const uint8_t* payload, size_t bytes) {
  if (!payload) return false;
  for (size_t i = 0; i < bytes; ++i) {
    const uint8_t a = payload[i] & 15, b = payload[i] >> 4;
    if (a > 6 || a == 4 || b > 6 || b == 4) return false;
  }
  return true;
}
// Source PWE6 packs the first pixel into the low nibble. Preserve its palette
// when shrinking already-quantized frames: interpolating indices invents colors.
inline uint8_t containedPixel(const uint8_t* payload, uint16_t sw, uint16_t sh,
                              uint16_t x, uint16_t y, uint16_t dw, uint16_t dh) {
  uint32_t fw = dw, fh = uint32_t(sh) * dw / sw;
  if (fh > dh) { fh = dh; fw = uint32_t(sw) * dh / sh; }
  const uint32_t left = (dw - fw) / 2, top = (dh - fh) / 2;
  if (x < left || x >= left + fw || y < top || y >= top + fh) return 1;
  const uint32_t sx = ((x - left) * sw + sw / 2) / fw;
  const uint32_t sy = ((y - top) * sh + sh / 2) / fh;
  const size_t index = size_t(sy) * sw + sx;
  return (payload[index / 2] >> ((index & 1) * 4)) & 15;
}
}

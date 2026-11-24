#include "../firmware/eink_esp32_s3_13in3e6/src/frame_reader.h"
#include <algorithm>
#include <cassert>
#include <cstring>
#include <vector>
#include <iostream>
struct Stream {
  std::vector<uint8_t> data;
  size_t offset = 0, limit = 7;
  bool open = true, stalled = false;
  size_t biggest = 0;
  int available() { return stalled ? 0 : int(data.size() - offset); }
  bool connected() { return open; }
  int read(uint8_t* out, size_t n) {
    biggest = std::max(biggest, n);
    n = std::min({n, limit, data.size() - offset});
    std::memcpy(out, data.data()+offset, n); offset += n; return int(n);
  }
};
int main() {
  uint32_t tick = 0;
  auto clock = [&]() { return tick; };
  auto yield = [&]() { ++tick; };
  std::vector<uint8_t> output(960000);
  Stream s; s.data.resize(960001, 42);
  assert(photowall::readFrameBytes(s, output.data(), 960000, 30, clock, yield));
  assert(s.offset == 960000 && s.biggest <= 4096 && tick == 0);
  assert(std::all_of(output.begin(), output.end(), [](auto c){ return c==42; }));
  // Buffered final bytes remain readable even after peer disconnects.
  s.open=false;
  assert(photowall::readFrameBytes(s, output.data(), 1, 30, clock, yield));
  assert(!photowall::readFrameBytes(s, output.data(), 1, 30, clock, yield));
  assert(tick==0); // truncated frame fails without waiting out timeout
  s.open=true; s.stalled=true;
  assert(!photowall::readFrameBytes(s, output.data(), 1, 30, clock, yield));
  assert(tick==30);
  tick=UINT32_MAX-10;
  assert(!photowall::readFrameBytes(s, output.data(), 1, 30, clock, yield));
  assert(tick==19); // millis wraparound remains bounded
  std::cout << "frame reader regression cases passed\n";
}

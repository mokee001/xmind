#pragma once
#include <stddef.h>
#include <stdint.h>

namespace photowall {
// Stop at the validated payload length, never at connection close. Bounded,
// non-blocking reads avoid readBytes' additional stream timeout on short reads.
template <typename Stream, typename Clock, typename Yield>
bool readFrameBytes(Stream& stream, uint8_t* target, size_t length,
                    uint32_t idleTimeout, Clock now, Yield yield) {
  size_t offset = 0;
  uint32_t lastData = now();
  while (offset < length) {
    if (uint32_t(now() - lastData) >= idleTimeout) return false;
    const int available = stream.available();
    if (available <= 0) {
      if (!stream.connected()) return false;
      yield();
      continue;
    }
    size_t chunk = length - offset;
    if (chunk > size_t(available)) chunk = size_t(available);
    if (chunk > 4096) chunk = 4096;
    const int received = stream.read(target + offset, chunk);
    if (received > 0 && size_t(received) <= chunk) {
      offset += size_t(received);
      lastData = now();
    } else {
      if (received > 0) return false;
      yield();
    }
  }
  return true;
}
}  // namespace photowall

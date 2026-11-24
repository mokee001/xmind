#pragma once

#include <cstdint>

namespace photowall {

class PhysicalConfirmationWindow {
 public:
  static constexpr uint32_t kValidityMs = 30000;

  void grant(uint32_t now) {
    grantedAt_ = now;
    available_ = true;
  }

  bool grantForConnection(uint32_t now, uint32_t connectedAt, uint32_t pressedAt,
                          uint32_t releasedAt) {
    if (now - pressedAt >= now - connectedAt || now - releasedAt >= kValidityMs) return false;
    grant(releasedAt);
    return true;
  }

  bool consume(uint32_t now) {
    const bool valid = available_ && now - grantedAt_ < kValidityMs;
    clear();
    return valid;
  }

  void clear() { available_ = false; }

 private:
  uint32_t grantedAt_ = 0;
  bool available_ = false;
};

}  // namespace photowall
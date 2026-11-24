#pragma once

#include <cstdint>

namespace photowall {

enum class StartIntent : uint32_t { Normal = 0, ButtonWake = 0x5057574b, OpenSetup = 0x50575354 };

inline StartIntent consumeStartIntent(bool softwareReset, uint32_t& retained) {
  const auto intent = static_cast<StartIntent>(retained);
  retained = 0;
  if (softwareReset && (intent == StartIntent::ButtonWake || intent == StartIntent::OpenSetup)) return intent;
  return StartIntent::Normal;
}

enum class ClaimCue : uint8_t { Idle, Submitted, SeenUnclaimed };
constexpr char kClaimCueKey[] = "pair_cue";

inline bool observeCloudClaim(ClaimCue& cue, bool claimed) {
  const bool play = cue == ClaimCue::SeenUnclaimed && claimed;
  if (cue == ClaimCue::Submitted || cue == ClaimCue::SeenUnclaimed) {
    cue = claimed ? ClaimCue::Idle : ClaimCue::SeenUnclaimed;
  }
  return play;
}

}  // namespace photowall
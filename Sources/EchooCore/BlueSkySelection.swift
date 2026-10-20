import Foundation

public enum BlueSkySlot: String, Codable, CaseIterable, Sendable {
    case photo1, photo2, photo3, photo4, photo5
    public var side: Int {
        switch self { case .photo1: return 968; case .photo2: return 1104
        case .photo3: return 776; case .photo4: return 602; case .photo5: return 1040 }
    }
    public var requirements: [String] {
        ["isPet"]
    }
    public var compositionPreferences: [String] {
        let common = ["singlePetSubject"]
        switch self {
        case .photo1: return common + ["headLargeProminent", "topComplete", "bottomComplete", "rightComplete"]
        case .photo2: return common + ["fullBody", "topComplete", "bottomComplete", "leftComplete", "rightComplete"]
        case .photo3, .photo4: return common + ["fullBody", "topComplete", "bottomComplete", "leftComplete", "rightComplete"]
        case .photo5: return common + ["halfBodyCloseUp", "headClearProminent", "leftComplete", "topComplete"]
        }
    }
    public var posePreferences: [String] {
        switch self { case .photo2: return ["topDown", "curled"]
        case .photo3, .photo4: return ["frontStandingOrSitting"]
        case .photo1, .photo5: return [] }
    }
    public var preferredFacts: [String] { compositionPreferences + posePreferences }
}

public enum BlueSkyFallback {
    public static let hideOrder: [BlueSkySlot] = [.photo4, .photo3, .photo2, .photo1, .photo5]
    public static func visibleSlots(photoCount: Int) -> [BlueSkySlot] {
        let hidden = Set(hideOrder.prefix(5 - min(5, max(0, photoCount))))
        return BlueSkySlot.allCases.filter { !hidden.contains($0) }
    }
}

public enum BlueSkyDimension: String, Codable, CaseIterable, Sendable {
    case sharpness, exposure, colorNaturalness, cutoutFeasibility, expression, lifelikeness, interest
    public var weight: Int {
        switch self { case .sharpness, .expression, .lifelikeness: return 20; default: return 10 }
    }
}

public struct BlueSkyRating: Codable, Equatable, Sendable {
    public let value: Int?
    /// A provider allowlisted observation code, never raw OCR or private text.
    public let reason: String
    public init(value: Int?, reason: String) { self.value = value; self.reason = reason }
    private enum CodingKeys: String, CodingKey { case value, reason }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.value) else {
            throw DecodingError.keyNotFound(CodingKeys.value, .init(codingPath: decoder.codingPath, debugDescription: "Missing score"))
        }
        value = try container.decodeIfPresent(Int.self, forKey: .value)
        reason = try container.decode(String.self, forKey: .reason)
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let value { try container.encode(value, forKey: .value) } else { try container.encodeNil(forKey: .value) }
        try container.encode(reason, forKey: .reason)
    }
}

public struct BlueSkyPhotoEvaluation: Codable, Equatable, Sendable {
    public let photoID: String
    public let facts: [String: Finding]
    public let scores: [String: BlueSkyRating]
    public let provenance: [String]
    public let notApplicablePreferences: [String]?
    public init(photoID: String, facts: [String: Finding], scores: [String: BlueSkyRating], provenance: [String],
                notApplicablePreferences: [String]? = nil) {
        self.photoID = photoID; self.facts = facts; self.scores = scores; self.provenance = provenance
        self.notApplicablePreferences = notApplicablePreferences
    }
    public var totalScore: Int? {
        var result = 0
        for dimension in BlueSkyDimension.allCases {
            guard let rating = scores[dimension.rawValue]?.value, (1...5).contains(rating) else { return nil }
            result += rating * dimension.weight / 5
        }
        return result
    }
}

public enum PetIdentityRelation: String, Codable, Sendable { case same, different, unknown }
public struct PetIdentityEvidence: Codable, Equatable, Sendable {
    public let leftID: String
    public let rightID: String
    public let relation: PetIdentityRelation
    public let reason: String
    public let provenance: [String]
    public init(leftID: String, rightID: String, relation: PetIdentityRelation, reason: String, provenance: [String]) {
        self.leftID = leftID; self.rightID = rightID; self.relation = relation
        self.reason = reason; self.provenance = provenance
    }
}

public enum BlueSkyEligibility: String, Codable, Sendable { case eligible, ineligible, pending }
public struct BlueSkyCandidate: Codable, Equatable, Sendable {
    public let slot: BlueSkySlot
    public let photoID: String
    public let eligibility: BlueSkyEligibility
    public let preferred: Bool
    public let score: Int?
    public let failedRequirements: [String]
    public let unresolvedRequirements: [String]
    /// nil only when reading a historical plan with the single-preference schema.
    public let matchedPreferences: [String]?
    public var preferenceCount: Int { matchedPreferences?.count ?? (preferred ? 1 : 0) }
    public var posePreferenceCount: Int { (matchedPreferences ?? []).filter { slot.posePreferences.contains($0) }.count }
    public var compositionPreferenceCount: Int { (matchedPreferences ?? []).filter { slot.compositionPreferences.contains($0) }.count }
}
public struct BlueSkySelection: Codable, Equatable, Sendable {
    public let slot: BlueSkySlot
    public let photoID: String
    public let preferred: Bool
    public let score: Int?
    public let matchedPreferences: [String]?
}
public enum BlueSkyPlanState: String, Codable, Sendable { case selected, insufficientMaterial, pendingEvidence }
public struct BlueSkyPlan: Codable, Equatable, Sendable {
    public let state: BlueSkyPlanState
    public let selections: [BlueSkySelection]
    public let rankings: [BlueSkyCandidate]
    public let preferredCount: Int
    public let totalScore: Int
    /// Separate from the compatible photo-evidence wire contract.
    public let strategyVersion: String?
    public let hiddenSlots: [BlueSkySlot]?
    public let mode: String?
    public let hasPendingEvidence: Bool?
    public let posePreferredCount: Int?
    public let compositionPreferredCount: Int?
    public var visibleSlots: [BlueSkySlot] { BlueSkyFallback.visibleSlots(photoCount: selections.count) }
    public var isCompleteStandard: Bool { state == .selected && selections.count == 5 }
    public init(state: BlueSkyPlanState, selections: [BlueSkySelection], rankings: [BlueSkyCandidate],
                preferredCount: Int, totalScore: Int, strategyVersion: String? = nil,
                hiddenSlots: [BlueSkySlot]? = nil, mode: String? = nil, hasPendingEvidence: Bool? = nil,
                posePreferredCount: Int? = nil, compositionPreferredCount: Int? = nil) {
        self.state = state; self.selections = selections; self.rankings = rankings
        self.preferredCount = preferredCount; self.totalScore = totalScore; self.strategyVersion = strategyVersion
        self.hiddenSlots = hiddenSlots; self.mode = mode; self.hasPendingEvidence = hasPendingEvidence
        self.posePreferredCount = posePreferredCount; self.compositionPreferredCount = compositionPreferredCount
    }
}
public enum BlueSkySelectionError: Error { case invalidEvidence, invalidProcessedSize }

/// Template-specific logic. No renderer is registered until visual generation is implemented.
public enum BlueSkySelector {
    public static let version = "blue-sky-pet-v2"
    public static let strategyVersion = "blue-sky-selection-v3"
    public static let generationRulesVersion = "blue-sky-generation-rules-v3"
    public static let factKeys = ["isPet", "singlePetSubject", "technicalBasics", "headLargeProminent",
        "headClearProminent", "fullBody", "halfBodyCloseUp", "topDown", "frontStandingOrSitting", "curled",
        "topComplete", "bottomComplete", "leftComplete", "rightComplete"]

    public static func candidate(_ photo: BlueSkyPhotoEvaluation, for slot: BlueSkySlot) -> BlueSkyCandidate {
        let failed = slot.requirements.filter { photo.facts[$0] == .absent }
        var unresolved = slot.requirements.filter { photo.facts[$0] == nil || photo.facts[$0] == .unknown }
        // Preferences affect ranking only. Unknown is never counted as a match.
        let matched = slot.preferredFacts.filter { photo.facts[$0] == .present && !(photo.notApplicablePreferences ?? []).contains($0) }
        if photo.provenance.isEmpty { unresolved.append("provenance") }
        return BlueSkyCandidate(slot: slot, photoID: photo.photoID,
            eligibility: !failed.isEmpty ? .ineligible : unresolved.isEmpty ? .eligible : .pending,
            preferred: !matched.isEmpty, score: photo.totalScore,
            failedRequirements: failed, unresolvedRequirements: unresolved, matchedPreferences: matched)
    }

    /// Only caller-admitted pets are eligible. Unknown evidence never becomes a pass;
    /// the plan still renders by hiding slots, down to a static-only background.
    public static func select(photoIDs: [String], evaluations: [BlueSkyPhotoEvaluation],
                              identities: [PetIdentityEvidence], excluding: Set<String> = [],
                              excludingFromSlots: [BlueSkySlot: Set<String>] = [:],
                              requiredPetPhotoID: String? = nil) throws -> BlueSkyPlan {
        let ids = Set(photoIDs)
        guard ids.count == photoIDs.count, ids.allSatisfy({ !$0.isEmpty && !$0.contains("\u{0}") }),
              requiredPetPhotoID.map({ ids.contains($0) || ids.isEmpty }) ?? true,
              Set(evaluations.map(\.photoID)).count == evaluations.count,
              evaluations.allSatisfy({ ids.contains($0.photoID) }) else { throw BlueSkySelectionError.invalidEvidence }
        func pairKey(_ left: String, _ right: String) -> String { [left, right].sorted().joined(separator: "\u{0}") }
        var relations: [String: PetIdentityRelation] = [:]
        for pair in identities {
            let key = pairKey(pair.leftID, pair.rightID)
            guard pair.leftID != pair.rightID, ids.contains(pair.leftID), ids.contains(pair.rightID),
                  relations[key] == nil else { throw BlueSkySelectionError.invalidEvidence }
            relations[key] = pair.provenance.isEmpty ? .unknown : pair.relation
        }
        let byID = Dictionary(uniqueKeysWithValues: evaluations.map { ($0.photoID, $0) })
        var rankings: [BlueSkyCandidate] = []
        var pools: [BlueSkySlot: [BlueSkyCandidate]] = [:]
        for slot in BlueSkySlot.allCases {
            let ranked = photoIDs.filter { !excluding.contains($0) && !(excludingFromSlots[slot]?.contains($0) ?? false) }.map { id -> BlueSkyCandidate in
                guard let photo = byID[id] else {
                    return BlueSkyCandidate(slot: slot, photoID: id, eligibility: .pending, preferred: false,
                        score: nil, failedRequirements: [], unresolvedRequirements: ["evaluation"], matchedPreferences: [])
                }
                let original = candidate(photo, for: slot)
                guard let target = requiredPetPhotoID, target != id else { return original }
                let relation = relations[pairKey(target, id)] ?? .unknown
                let failed = original.failedRequirements + (relation == .different ? ["targetPetIdentity"] : [])
                let unresolved = original.unresolvedRequirements + (relation == .unknown ? ["targetPetIdentity"] : [])
                return BlueSkyCandidate(slot: slot, photoID: id,
                    eligibility: !failed.isEmpty ? .ineligible : unresolved.isEmpty ? .eligible : .pending,
                    preferred: original.preferred, score: original.score,
                    failedRequirements: failed, unresolvedRequirements: unresolved, matchedPreferences: original.matchedPreferences)
            }.sorted {
                if $0.eligibility != $1.eligibility {
                    let order: [BlueSkyEligibility: Int] = [.eligible: 0, .pending: 1, .ineligible: 2]
                    return order[$0.eligibility]! < order[$1.eligibility]!
                }
                if $0.posePreferenceCount != $1.posePreferenceCount { return $0.posePreferenceCount > $1.posePreferenceCount }
                if $0.compositionPreferenceCount != $1.compositionPreferenceCount { return $0.compositionPreferenceCount > $1.compositionPreferenceCount }
                if $0.score != $1.score { return ($0.score ?? -1) > ($1.score ?? -1) }
                return $0.photoID < $1.photoID
            }
            rankings += ranked; pools[slot] = ranked.filter { $0.eligibility == .eligible }
        }
        var identityPending = false
        for hiddenCount in 0...5 {
            let hidden = Array(BlueSkyFallback.hideOrder.prefix(hiddenCount))
            let slots = BlueSkySlot.allCases.filter { !hidden.contains($0) }
            var best: [BlueSkySelection]? = nil
            var bestPose = -1, bestComposition = -1, bestScore = -1
            func search(_ index: Int, _ chosen: [BlueSkySelection], _ pose: Int, _ composition: Int, _ score: Int) {
                if index == slots.count {
                    let key = chosen.map(\.photoID).joined(separator: "\u{0}")
                    let bestKey = (best ?? []).map(\.photoID).joined(separator: "\u{0}")
                    if pose > bestPose || (pose == bestPose && (composition > bestComposition ||
                        (composition == bestComposition && (score > bestScore || (score == bestScore && key < bestKey))))) {
                        best = chosen; bestPose = pose; bestComposition = composition; bestScore = score
                    }
                    return
                }
                let remaining = slots[index...].map { pools[$0] ?? [] }
                let upperPose = pose + remaining.reduce(0) { $0 + ($1.map(\.posePreferenceCount).max() ?? 0) }
                let upperComposition = composition + remaining.reduce(0) { $0 + ($1.map(\.compositionPreferenceCount).max() ?? 0) }
                let upperScore = score + remaining.reduce(0) { $0 + ($1.compactMap(\.score).max() ?? 0) }
                if upperPose < bestPose || (upperPose == bestPose && (upperComposition < bestComposition ||
                    (upperComposition == bestComposition && upperScore < bestScore))) { return }
                if upperPose == bestPose && upperComposition == bestComposition && upperScore == bestScore, let best {
                    let prefix = chosen.map(\.photoID).joined(separator: "\u{0}")
                    let bestPrefix = best.prefix(chosen.count).map(\.photoID).joined(separator: "\u{0}")
                    if prefix > bestPrefix { return }
                }
                for candidate in pools[slots[index]] ?? [] {
                    guard !chosen.contains(where: { $0.photoID == candidate.photoID }) else { continue }
                    let matches = chosen.map { relations[pairKey($0.photoID, candidate.photoID)] ?? .unknown }
                    if matches.contains(.different) { continue }
                    if matches.contains(.unknown) { identityPending = true; continue }
                    search(index + 1, chosen + [BlueSkySelection(slot: candidate.slot, photoID: candidate.photoID,
                        preferred: candidate.preferred, score: candidate.score, matchedPreferences: candidate.matchedPreferences)],
                        pose + candidate.posePreferenceCount, composition + candidate.compositionPreferenceCount, score + (candidate.score ?? 0))
                }
            }
            search(0, [], 0, 0, 0)
            if let best {
                return BlueSkyPlan(state: .selected, selections: best, rankings: rankings,
                    preferredCount: max(0, bestPose) + max(0, bestComposition), totalScore: max(0, bestScore), strategyVersion: strategyVersion,
                    hiddenSlots: hidden, mode: hiddenCount == 0 ? "standard" : hiddenCount == 5 ? "backgroundOnly" : "fallback",
                    hasPendingEvidence: identityPending || rankings.contains { $0.eligibility == .pending || ($0.eligibility == .eligible && $0.score == nil) },
                    posePreferredCount: max(0, bestPose), compositionPreferredCount: max(0, bestComposition))
            }
        }
        throw BlueSkySelectionError.invalidEvidence // The empty assignment always succeeds.
    }

    /// The caller passes the tight bounds of the completed cutout, including its outline.
    /// No clipping is requested. Rotation/placement follows after this uniform scaling.
    public static func fittedSize(width: Double, height: Double, slot: BlueSkySlot) throws -> (width: Double, height: Double) {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { throw BlueSkySelectionError.invalidProcessedSize }
        let side = Double(slot.side)
        return width >= height ? (side, side * height / width) : (side * width / height, side)
    }
}

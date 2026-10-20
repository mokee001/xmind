import Foundation

public enum CutoutVerificationState: String, Codable, Sendable { case passed, failed, pending }

/// Judgments concern the unrotated, unmirrored subject in source-image coordinates.
public struct BlueSkyCutoutEvaluation: Codable, Equatable, Sendable {
    public let photoID: String
    public let cutoutDigest: String
    public let facts: [String: Finding]
    public let provenance: [String]
    public init(photoID: String, cutoutDigest: String, facts: [String: Finding], provenance: [String]) {
        self.photoID = photoID; self.cutoutDigest = cutoutDigest; self.facts = facts; self.provenance = provenance
    }
}

public struct BlueSkyCutoutVerdict: Codable, Equatable, Sendable {
    public let state: CutoutVerificationState
    public let failed: [String]
    public let unresolved: [String]
}

public enum BlueSkyCutoutVerifier {
    public static let version = "blue-sky-cutout-check-v2"
    public static let common = ["correctSubject", "anatomyPreserved", "backgroundRemoved"]
    public static let edges = ["topComplete", "bottomComplete", "leftComplete", "rightComplete"]
    public static let factKeys = common + edges

    public static func verdict(_ evidence: BlueSkyCutoutEvaluation?, photoID: String,
                               slot: BlueSkySlot, cutoutDigest: String) -> BlueSkyCutoutVerdict {
        guard let evidence, evidence.photoID == photoID, !evidence.provenance.isEmpty,
              evidence.cutoutDigest == cutoutDigest, !cutoutDigest.isEmpty,
              Set(evidence.facts.keys) == Set(factKeys) else {
            return .init(state: .pending, failed: [], unresolved: ["verificationEvidence"])
        }
        // Source-edge completeness is a composition preference, never a hidden
        // post-selection gate. Actual extraction damage still fails verification.
        let required = common
        let failed = required.filter { evidence.facts[$0] == .absent }
        let unknown = required.filter { evidence.facts[$0] == .unknown }
        return .init(state: !failed.isEmpty ? .failed : unknown.isEmpty ? .passed : .pending,
                     failed: failed, unresolved: unknown)
    }
}

public struct BlueSkyPlacement: Codable, Equatable, Sendable {
    public let slot: BlueSkySlot
    public let centerX, centerY, clockwiseDegrees: Double
    public init(slot: BlueSkySlot, centerX: Double, centerY: Double, clockwiseDegrees: Double = 0) {
        self.slot = slot; self.centerX = centerX; self.centerY = centerY; self.clockwiseDegrees = clockwiseDegrees
    }
}

public enum BlueSkyLayer: Equatable, Sendable {
    case asset(String, x: Double, y: Double, width: Double, height: Double)
    case photo(BlueSkySlot)
}

/// Frame geometry from Park 5:4. Dynamic cutouts use the user-confirmed long-edge fit,
/// rather than the example photos' Figma image-fill crop/flip transforms.
public enum BlueSkyLayout {
    public static let width = 1800
    public static let height = 2400
    public static let version = "park-5-4-layout-v5"
    public static let placements: [BlueSkyPlacement] = [
        .init(slot: .photo1, centerX: 340.4795, centerY: 332.4795, clockwiseDegrees: 45),
        .init(slot: .photo2, centerX: 1546.1151104514443, centerY: 677.115038024664, clockwiseDegrees: -116),
        .init(slot: .photo3, centerX: 354.34044583854836, centerY: 1631.3404372877576, clockwiseDegrees: 14),
        .init(slot: .photo4, centerX: 991, centerY: 1338),
        .init(slot: .photo5, centerX: 1464, centerY: 2116)
    ]
    /// Back-to-front scene shared by the native renderer and version archive.
    public static let layers: [BlueSkyLayer] = [
        .asset("background", x: 0, y: 0, width: 1800, height: 2400),
        .asset("star", x: 1088, y: -8, width: 796.1371459960938, height: 582),
        .asset("star", x: 228, y: 1535, width: 807.0806274414062, height: 590),
        .asset("poetry", x: 396, y: 470, width: 643, height: 691),
        .photo(.photo3),
        .asset("lines", x: 72, y: 2033, width: 851, height: 341),
        .photo(.photo1), .photo(.photo5),
        .asset("bubble", x: 1326, y: 1415, width: 474, height: 594),
        .asset("grid", x: 806, y: 1052, width: 1053.3922119140625, height: 285),
        .photo(.photo4), .photo(.photo2)
    ]
}

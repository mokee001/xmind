import Foundation

public enum Theme: String, Codable, CaseIterable, Sendable {
    case daily, pets, food, landscape
}

public enum MediaKind: String, Codable, Sendable {
    case image, video, other
}

/// Availability describes the requested preview, not the original asset.
public enum PreviewAvailability: String, Codable, Sendable {
    case ready, cloudPending, unavailable
}

public struct PhotoInput: Codable, Equatable, Sendable {
    public let id: String
    public let mediaKind: MediaKind
    public let isScreenshot: Bool
    public let previewAvailability: PreviewAvailability

    public init(
        id: String,
        mediaKind: MediaKind,
        isScreenshot: Bool = false,
        previewAvailability: PreviewAvailability = .ready
    ) {
        self.id = id
        self.mediaKind = mediaKind
        self.isScreenshot = isScreenshot
        self.previewAvailability = previewAvailability
    }
}

/// Unknown is never silently converted to absent.
public enum Finding: String, Codable, Sendable {
    case present, absent, unknown
}

public enum ExclusionReason: String, Codable, CaseIterable, Sendable {
    case unsupportedMedia
    case screenshot
    case unreadableImage
    case extremeBlur
    case extremeExposure
    case informationDominant
    case surveillance
    case highRiskPrivacy
    case intimateExposure
    case bloodyViolence

    public static let contentChecks: [Self] = [
        .screenshot, .unreadableImage, .extremeBlur, .extremeExposure,
        .informationDominant, .surveillance, .highRiskPrivacy,
        .intimateExposure, .bloodyViolence
    ]
}

public struct ContentEvidence: Codable, Equatable, Sendable {
    public let photoID: String
    public let policyVersion: String
    public let findings: [ExclusionReason: Finding]
    /// The API adapter must attach the provider/model versions used.
    public let provenance: [String]

    public init(
        photoID: String,
        policyVersion: String,
        findings: [ExclusionReason: Finding],
        provenance: [String] = []
    ) {
        self.photoID = photoID
        self.policyVersion = policyVersion
        self.findings = findings
        self.provenance = provenance
    }
}

public enum AdmissionState: String, Codable, Sendable {
    case passed, rejected, pending
}

public enum PendingReason: String, Codable, Sendable {
    case cloudPending
    case previewUnavailable
    case missingEvidence
    case mismatchedEvidence
    case unresolvedContent
}

public struct AdmissionDecision: Codable, Equatable, Sendable {
    public let photoID: String
    public let state: AdmissionState
    public let exclusions: [ExclusionReason]
    public let unresolvedChecks: [ExclusionReason]
    public let pendingReason: PendingReason?
    public let policyVersion: String
}

/// Scene facts are supplied by independently versioned native/API adapters.
/// They are not a replacement for admission checks.
public struct ThemeEvidence: Codable, Equatable, Sendable {
    public let photoID: String
    public let policyVersion: String
    public let companionAnimalIsSignificant: Finding
    public let zooScene: Finding
    public let preparedFoodOrDrink: Finding
    public let wildMushroomsOnDiningTable: Finding
    public let environmentHasDisplayValue: Finding

    public init(
        photoID: String,
        policyVersion: String,
        companionAnimalIsSignificant: Finding = .unknown,
        zooScene: Finding = .unknown,
        preparedFoodOrDrink: Finding = .unknown,
        wildMushroomsOnDiningTable: Finding = .unknown,
        environmentHasDisplayValue: Finding = .unknown
    ) {
        self.photoID = photoID
        self.policyVersion = policyVersion
        self.companionAnimalIsSignificant = companionAnimalIsSignificant
        self.zooScene = zooScene
        self.preparedFoodOrDrink = preparedFoodOrDrink
        self.wildMushroomsOnDiningTable = wildMushroomsOnDiningTable
        self.environmentHasDisplayValue = environmentHasDisplayValue
    }
}

public struct ThemeAssignment: Codable, Equatable, Sendable {
    public let photoID: String
    public let themes: [Theme]
    public let pendingThemes: [Theme]
    public let policyVersion: String
}

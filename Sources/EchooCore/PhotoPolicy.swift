import Foundation

/// Pure business policy. No PhotoKit, filesystem, API keys, or legacy imports.
public struct PhotoPolicy: Sendable {
    public let version: String

    public init(version: String = "echoo-policy-v1") {
        self.version = version
    }

    public func admission(
        for photo: PhotoInput,
        evidence: ContentEvidence?
    ) -> AdmissionDecision {
        func result(
            _ state: AdmissionState,
            exclusions: [ExclusionReason] = [],
            unresolved: [ExclusionReason] = [],
            pending: PendingReason? = nil
        ) -> AdmissionDecision {
            AdmissionDecision(
                photoID: photo.id,
                state: state,
                exclusions: exclusions,
                unresolvedChecks: unresolved,
                pendingReason: pending,
                policyVersion: version
            )
        }

        var metadataExclusions: [ExclusionReason] = []
        if photo.mediaKind != .image { metadataExclusions.append(.unsupportedMedia) }
        if photo.isScreenshot { metadataExclusions.append(.screenshot) }
        if !metadataExclusions.isEmpty {
            return result(.rejected, exclusions: metadataExclusions)
        }

        switch photo.previewAvailability {
        case .cloudPending:
            return result(.pending, pending: .cloudPending)
        case .unavailable:
            return result(.pending, pending: .previewUnavailable)
        case .ready:
            break
        }

        guard let evidence else {
            return result(.pending, pending: .missingEvidence)
        }
        guard evidence.photoID == photo.id, evidence.policyVersion == version else {
            return result(.pending, pending: .mismatchedEvidence)
        }

        let checks = ExclusionReason.contentChecks
        let exclusions = checks.filter { evidence.findings[$0] == .present }
        let unresolved = checks.filter {
            evidence.findings[$0] == nil || evidence.findings[$0] == .unknown
        }

        if !exclusions.isEmpty {
            return result(.rejected, exclusions: exclusions, unresolved: unresolved)
        }
        if !unresolved.isEmpty {
            return result(.pending, unresolved: unresolved, pending: .unresolvedContent)
        }
        return result(.passed)
    }

    public func themes(
        for admission: AdmissionDecision,
        evidence: ThemeEvidence?
    ) -> ThemeAssignment {
        guard admission.state == .passed, admission.policyVersion == version else {
            return ThemeAssignment(
                photoID: admission.photoID, themes: [], pendingThemes: [],
                policyVersion: version
            )
        }

        let optionalThemes: [Theme] = [.pets, .food, .landscape]
        guard let evidence,
              evidence.photoID == admission.photoID,
              evidence.policyVersion == version else {
            return ThemeAssignment(
                photoID: admission.photoID, themes: [.daily],
                pendingThemes: optionalThemes, policyVersion: version
            )
        }

        var included: [Theme] = [.daily]
        var pending: [Theme] = []

        let petStatus: Finding
        if evidence.zooScene == .present ||
            evidence.companionAnimalIsSignificant == .absent {
            petStatus = .absent
        } else if evidence.zooScene == .absent &&
                    evidence.companionAnimalIsSignificant == .present {
            petStatus = .present
        } else {
            petStatus = .unknown
        }

        let foodStatus: Finding
        if evidence.preparedFoodOrDrink == .present ||
            evidence.wildMushroomsOnDiningTable == .present {
            foodStatus = .present
        } else if evidence.preparedFoodOrDrink == .absent &&
                    evidence.wildMushroomsOnDiningTable == .absent {
            foodStatus = .absent
        } else {
            foodStatus = .unknown
        }

        for (theme, status) in [
            (Theme.pets, petStatus),
            (Theme.food, foodStatus),
            (Theme.landscape, evidence.environmentHasDisplayValue)
        ] {
            switch status {
            case .present: included.append(theme)
            case .unknown: pending.append(theme)
            case .absent: break
            }
        }
        return ThemeAssignment(
            photoID: admission.photoID, themes: included,
            pendingThemes: pending, policyVersion: version
        )
    }
}

import Foundation

public struct AnalysisPreview: Sendable {
    public let jpeg: Data
    public let width: Int
    public let height: Int

    public init(jpeg: Data, width: Int, height: Int) {
        self.jpeg = jpeg
        self.width = width
        self.height = height
    }
}

public enum PreviewResult: Sendable {
    case ready(AnalysisPreview)
    case cloudPending
    case unavailable
}

/// The caller owns permission, library fetch size, and all iCloud download decisions.
public protocol PhotoPreviewProviding: Sendable {
    func preview(maxPixel: Int) async throws -> PreviewResult
}

public struct ImageLabel: Codable, Equatable, Sendable {
    public let identifier: String
    public let confidence: Float

    public init(identifier: String, confidence: Float) {
        self.identifier = identifier
        self.confidence = confidence
    }
}

public struct QualityMetrics: Codable, Equatable, Sendable {
    public let laplacianVariance: Float
    public let darkFraction: Float
    public let brightFraction: Float

    public init(laplacianVariance: Float, darkFraction: Float, brightFraction: Float) {
        self.laplacianVariance = laplacianVariance
        self.darkFraction = darkFraction
        self.brightFraction = brightFraction
    }
}

/// Raw OCR text and extracted private values deliberately do not enter this report.
public struct NativeAnalysis: Codable, Equatable, Sendable {
    public let revision: String
    public let labels: [ImageLabel]
    public let animals: [ImageLabel]
    public let textRegionCount: Int
    public let textCoverage: Float
    public let privacyFinding: Finding
    public let quality: QualityMetrics

    public init(
        revision: String, labels: [ImageLabel], animals: [ImageLabel],
        textRegionCount: Int, textCoverage: Float,
        privacyFinding: Finding, quality: QualityMetrics
    ) {
        self.revision = revision
        self.labels = labels
        self.animals = animals
        self.textRegionCount = textRegionCount
        self.textCoverage = textCoverage
        self.privacyFinding = privacyFinding
        self.quality = quality
    }
}

public protocol NativePhotoAnalyzing: Sendable {
    func analyze(_ preview: AnalysisPreview) async throws -> NativeAnalysis
}

public struct RemoteAnalysis: Sendable {
    public let content: ContentEvidence
    public let themes: ThemeEvidence

    public init(content: ContentEvidence, themes: ThemeEvidence) {
        self.content = content
        self.themes = themes
    }
}

public protocol RemotePhotoAnalyzing: Sendable {
    func analyze(
        photoID: String, policyVersion: String,
        preview: AnalysisPreview, native: NativeAnalysis
    ) async throws -> RemoteAnalysis
}

public enum AnalysisIssue: String, Codable, Sendable {
    case previewFailed, nativeAnalysisFailed, gatewayNotConfigured, gatewayFailed, cancelled
}

public struct PhotoAnalysisResult: Codable, Sendable {
    public let admission: AdmissionDecision
    public let assignment: ThemeAssignment
    public let native: NativeAnalysis?
    public let issues: [AnalysisIssue]
    public let provenance: [String]
}

public struct PhotoAnalysisEngine: Sendable {
    public let policy: PhotoPolicy
    private let nativeAnalyzer: any NativePhotoAnalyzing
    private let remoteAnalyzer: (any RemotePhotoAnalyzing)?

    public init(
        policy: PhotoPolicy = PhotoPolicy(),
        nativeAnalyzer: any NativePhotoAnalyzing,
        remoteAnalyzer: (any RemotePhotoAnalyzing)? = nil
    ) {
        self.policy = policy
        self.nativeAnalyzer = nativeAnalyzer
        self.remoteAnalyzer = remoteAnalyzer
    }

    public func process(
        _ input: PhotoInput, source: any PhotoPreviewProviding
    ) async -> PhotoAnalysisResult {
        func output(
            _ decision: AdmissionDecision, native: NativeAnalysis? = nil,
            remote: RemoteAnalysis? = nil, issues: [AnalysisIssue] = []
        ) -> PhotoAnalysisResult {
            PhotoAnalysisResult(
                admission: decision,
                assignment: policy.themes(for: decision, evidence: remote?.themes),
                native: native, issues: issues,
                provenance: remote?.content.provenance ?? native.map { [$0.revision] } ?? []
            )
        }
        let precheck = policy.admission(for: input, evidence: nil)
        if precheck.state == .rejected || input.previewAvailability != .ready {
            return output(precheck)
        }

        do {
            try Task.checkCancellation()
            let initial = try await source.preview(maxPixel: 512)
            guard case .ready(let preview) = initial else {
                return output(unavailableDecision(input, result: initial))
            }
            let native: NativeAnalysis
            do {
                native = try await nativeAnalyzer.analyze(preview)
                try Task.checkCancellation()
            } catch is CancellationError {
                return output(precheck, issues: [.cancelled])
            } catch {
                return output(precheck, issues: [.nativeAnalysisFailed])
            }
            var findings: [ExclusionReason: Finding] = [.unreadableImage: .absent]
            // A missing local privacy hit is not a completed privacy clearance.
            if native.privacyFinding == .present { findings[.highRiskPrivacy] = .present }
            let local = ContentEvidence(
                photoID: input.id, policyVersion: policy.version,
                findings: findings, provenance: [native.revision]
            )
            let localDecision = policy.admission(for: input, evidence: local)
            if localDecision.state == .rejected {
                return output(localDecision, native: native)
            }
            guard let remoteAnalyzer else {
                return output(localDecision, native: native, issues: [.gatewayNotConfigured])
            }
            // Small previews cannot establish absence of small private text.
            // Request a larger bounded preview only for unresolved candidates.
            let larger = try await source.preview(maxPixel: 1536)
            guard case .ready(let remotePreview) = larger else {
                return output(unavailableDecision(input, result: larger), native: native)
            }
            // Recheck privacy locally before transmitting the larger preview.
            let detailedNative: NativeAnalysis
            do {
                detailedNative = try await nativeAnalyzer.analyze(remotePreview)
                try Task.checkCancellation()
            } catch is CancellationError {
                return output(localDecision, native: native, issues: [.cancelled])
            } catch {
                return output(localDecision, native: native, issues: [.nativeAnalysisFailed])
            }
            if detailedNative.privacyFinding == .present {
                findings[.highRiskPrivacy] = .present
                let privateEvidence = ContentEvidence(
                    photoID: input.id, policyVersion: policy.version, findings: findings,
                    provenance: [detailedNative.revision]
                )
                return output(
                    policy.admission(for: input, evidence: privateEvidence), native: detailedNative
                )
            }
            do {
                try Task.checkCancellation()
                let remote = try await remoteAnalyzer.analyze(
                    photoID: input.id, policyVersion: policy.version,
                    preview: remotePreview, native: detailedNative
                )
                return output(
                    policy.admission(for: input, evidence: remote.content),
                    native: detailedNative, remote: remote
                )
            } catch is CancellationError {
                return output(localDecision, native: detailedNative, issues: [.cancelled])
            } catch {
                return output(localDecision, native: detailedNative, issues: [.gatewayFailed])
            }
        } catch is CancellationError {
            return output(precheck, issues: [.cancelled])
        } catch {
            return output(precheck, issues: [.previewFailed])
        }
    }

    private func unavailableDecision(_ input: PhotoInput, result: PreviewResult) -> AdmissionDecision {
        let availability: PreviewAvailability
        switch result {
        case .cloudPending: availability = .cloudPending
        case .unavailable: availability = .unavailable
        case .ready: availability = .ready
        }
        return policy.admission(
            for: PhotoInput(
                id: input.id, mediaKind: input.mediaKind,
                isScreenshot: input.isScreenshot, previewAvailability: availability
            ), evidence: nil
        )
    }
}

public struct ThemeAlbum: Codable, Equatable, Sendable {
    public let theme: Theme
    public let photoIDs: [String]

    public init(theme: Theme, photoIDs: [String]) {
        self.theme = theme
        self.photoIDs = photoIDs
    }

    public static func assemble(from results: [PhotoAnalysisResult]) -> [Self] {
        Theme.allCases.map { theme in
            var seen = Set<String>()
            let ids = results.filter {
                $0.admission.state == .passed && $0.assignment.themes.contains(theme)
            }.compactMap { result -> String? in
                let id = result.admission.photoID
                return seen.insert(id).inserted ? id : nil
            }
            return Self(theme: theme, photoIDs: ids)
        }
    }
}

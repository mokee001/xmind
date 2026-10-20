import Foundation
import CryptoKit
import EchooCore

public struct BlueSkyVerificationInput: Sendable {
    public let photoID: String
    public let cutout: PetCutout
    public init(photoID: String, cutout: PetCutout) { self.photoID = photoID; self.cutout = cutout }
}

public struct BlueSkyGenerationResult: Sendable {
    public let artwork: RenderedArtwork
    public let plan: BlueSkyPlan
    /// Bounded codes only; unavailable evidence is never marked as a photo failure.
    public let issues: [String]
}

/// iOS-capable orchestration for an upstream-admitted pet album and version-bound
/// original-photo evidence. The host supplies resources and a backend verifier;
/// this engine neither fetches a library nor requests permissions/cloud downloads.
public struct BlueSkyGenerationEngine: Sendable {
    public typealias Extractor = @Sendable (AnalysisPreview) throws -> PetCutout
    public typealias Verifier = @Sendable ([BlueSkyVerificationInput]) async throws -> [BlueSkyCutoutEvaluation]
    private let extractor: Extractor
    public init(extractor: @escaping Extractor = { try ApplePetCutout.extract($0) }) { self.extractor = extractor }

    public func generate(album: ThemeAlbum, evaluations: [BlueSkyPhotoEvaluation], identities: [PetIdentityEvidence],
                         resources: [String: any PhotoPreviewProviding], targetPetPhotoID: String? = nil,
                         verify: Verifier) async throws -> BlueSkyGenerationResult {
        guard album.theme == .pets else { throw TemplateError.mismatchedTheme }
        var exclusions: [BlueSkySlot: Set<String>] = [:], unavailable: Set<String> = []
        var cutouts: [String: PetCutout] = [:], checked: [String: BlueSkyCutoutEvaluation] = [:]
        var issues: Set<String> = []
        let renderer = try BlueSkyRenderer()
        func select() throws -> BlueSkyPlan {
            try BlueSkySelector.select(photoIDs: album.photoIDs, evaluations: evaluations, identities: identities,
                excluding: unavailable, excludingFromSlots: exclusions, requiredPetPhotoID: targetPetPhotoID)
        }
        func background() throws -> BlueSkyGenerationResult {
            let plan = try BlueSkySelector.select(photoIDs: [], evaluations: [], identities: [])
            return .init(artwork: try renderer.renderVerified(plan: plan, cutouts: [:], evidence: []),
                         plan: plan, issues: issues.sorted())
        }
        for _ in 0...(album.photoIDs.count * 5) {
            try Task.checkCancellation()
            let plan = try select()
            if plan.selections.isEmpty {
                return .init(artwork: try renderer.renderVerified(plan: plan, cutouts: [:], evidence: []),
                             plan: plan, issues: issues.sorted())
            }
            var replaced = false
            for selected in plan.selections where cutouts[selected.photoID] == nil {
                do {
                    guard let resource = resources[selected.photoID],
                          case let .ready(preview) = try await resource.preview(maxPixel: 4096) else {
                        unavailable.insert(selected.photoID); issues.insert("resourceUnavailable"); replaced = true; continue
                    }
                    let cutout = try extractor(preview)
                    // Inspect the exact source-aligned preview that would be uploaded.
                    let native = try? await AppleNativeAnalyzer().analyze(cutout.inspection.original)
                    guard native?.privacyFinding != .present else {
                        unavailable.insert(selected.photoID); issues.insert("nativePrivacyBlocked"); replaced = true; continue
                    }
                    cutouts[selected.photoID] = cutout
                } catch is CancellationError { throw CancellationError() }
                catch {
                    unavailable.insert(selected.photoID); issues.insert("extractionUnavailable"); replaced = true
                }
            }
            if replaced { continue }
            let pending = plan.selections.filter { checked[$0.photoID] == nil }.map {
                BlueSkyVerificationInput(photoID: $0.photoID, cutout: cutouts[$0.photoID]!)
            }
            if !pending.isEmpty {
                do {
                    let evidence = try await verify(pending)
                    guard Set(evidence.map(\.photoID)).count == evidence.count,
                          Set(evidence.map(\.photoID)) == Set(pending.map(\.photoID)) else {
                        issues.insert("verificationResponseMismatch"); return try background()
                    }
                    for item in evidence { checked[item.photoID] = item }
                } catch is CancellationError { throw CancellationError() }
                catch {
                    issues.insert("verificationUnavailable"); return try background()
                }
            }
            for selected in plan.selections {
                let digest = SHA256.hash(data: cutouts[selected.photoID]!.png).map { String(format: "%02x", $0) }.joined()
                let verdict = BlueSkyCutoutVerifier.verdict(checked[selected.photoID], photoID: selected.photoID,
                                                            slot: selected.slot, cutoutDigest: digest)
                if verdict.state != .passed {
                    exclusions[selected.slot, default: []].insert(selected.photoID)
                    issues.insert(verdict.state == .pending ? "verificationPending" : "cutoutRejected")
                    replaced = true
                }
            }
            if replaced { continue }
            let images = Dictionary(uniqueKeysWithValues: plan.selections.map { ($0.photoID, cutouts[$0.photoID]!.png) })
            return .init(artwork: try renderer.renderVerified(plan: plan, cutouts: images,
                evidence: plan.selections.compactMap { checked[$0.photoID] }), plan: plan, issues: issues.sorted())
        }
        issues.insert("processingAttemptLimit")
        return try background()
    }
}

/// A host can register this after completing its own production validation.
/// Evidence is supplied for the caller's current admitted album, never fetched here.
public struct BlueSkyArtworkGenerator: ArtworkGenerating {
    public let definition: TemplateDefinition
    private let evaluations: [BlueSkyPhotoEvaluation]
    private let identities: [PetIdentityEvidence]
    private let target: String?
    private let verifier: BlueSkyGenerationEngine.Verifier
    public init(evaluations: [BlueSkyPhotoEvaluation], identities: [PetIdentityEvidence], targetPetPhotoID: String? = nil,
                state: TemplateState = .validatingAutomation, verify: @escaping BlueSkyGenerationEngine.Verifier) {
        self.evaluations = evaluations; self.identities = identities; self.target = targetPetPhotoID; self.verifier = verify
        definition = .init(id: "pets.blue-sky-green-field", name: "蓝天绿地拼贴", theme: .pets, state: state, minimumPhotoCount: 0)
    }
    public func availability(in album: ThemeAlbum) -> TemplateAvailability {
        guard album.theme == .pets, let plan = try? BlueSkySelector.select(photoIDs: album.photoIDs,
            evaluations: evaluations, identities: identities, requiredPetPhotoID: target) else { return .unavailable }
        return plan.isCompleteStandard ? .standard : .fallback
    }
    public func generate(album: ThemeAlbum, resources: [String: any PhotoPreviewProviding]) async throws -> RenderedArtwork {
        try await BlueSkyGenerationEngine().generate(album: album, evaluations: evaluations, identities: identities,
            resources: resources, targetPetPhotoID: target, verify: verifier).artwork
    }
}

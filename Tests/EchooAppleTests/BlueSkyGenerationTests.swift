import XCTest
import CoreGraphics
import CryptoKit
import EchooCore
@testable import EchooApple

private struct SyntheticPetResource: PhotoPreviewProviding {
    let image: AnalysisPreview
    func preview(maxPixel: Int) async throws -> PreviewResult { .ready(image) }
}

final class BlueSkyGenerationTests: XCTestCase {
    private func fixture() throws -> PetCutout {
        let original = try RasterImage.context(width: 120, height: 100)
        original.setFillColor(CGColor(gray: 0.6, alpha: 1))
        original.fill(CGRect(x: 0, y: 0, width: 120, height: 100))
        let mask = try RasterImage.context(width: 120, height: 100)
        mask.setFillColor(CGColor(red: 1, green: 0.1, blue: 0.1, alpha: 1))
        mask.fill(CGRect(x: 20, y: 10, width: 80, height: 70))
        let pixels = try XCTUnwrap(mask.makeImage())
        return .init(png: try RasterImage.png(pixels), width: 120, height: 100, requiresVerification: true,
            inspection: try ApplePetCutout.inspect(original: XCTUnwrap(original.makeImage()), fullFrameMask: pixels))
    }
    private func evaluations(_ count: Int) -> [BlueSkyPhotoEvaluation] {
        (0..<count).map { .init(photoID: "p\($0)",
            facts: Dictionary(uniqueKeysWithValues: BlueSkySelector.factKeys.map { ($0, $0 == "isPet" ? Finding.present : .absent) }),
            scores: [:], provenance: ["synthetic-not-real-pet-evidence"], notApplicablePreferences: []) }
    }
    private func pairs(_ values: [BlueSkyPhotoEvaluation]) -> [PetIdentityEvidence] {
        values.enumerated().flatMap { i, p in values.dropFirst(i+1).map {
            .init(leftID: p.photoID, rightID: $0.photoID, relation: .same, reason: "synthetic", provenance: ["synthetic"])
        } }
    }
    func testEmptyAlbumProducesRealBackgroundPNGWithoutExtractorOrVerifier() async throws {
        let result = try await BlueSkyGenerationEngine(extractor: { _ in XCTFail("No extraction for zero photos"); throw PetCutoutError.foregroundUnavailable })
            .generate(album: .init(theme: .pets, photoIDs: []), evaluations: [], identities: [], resources: [:],
                      verify: { _ in XCTFail("No API for zero photos"); return [] })
        XCTAssertEqual(result.plan.mode, "backgroundOnly")
        XCTAssertEqual(result.artwork.selectedPhotoIDs, [])
        let image = try RasterImage.decode(result.artwork.imageData)
        XCTAssertEqual(image.width, 1800); XCTAssertEqual(image.height, 2400)
    }
    func testAllCountsRenderDistinctRealPNGsWithExactVisibleSlotsAndSoftEdges() async throws {
        let cutout = try fixture()
        var digests: Set<String> = []
        for count in 0...5 {
            let values = evaluations(count), ids = values.map(\.photoID)
            let resources = Dictionary(uniqueKeysWithValues: ids.map { ($0, SyntheticPetResource(image: cutout.inspection.original) as any PhotoPreviewProviding) })
            let result = try await BlueSkyGenerationEngine(extractor: { _ in cutout }).generate(
                album: .init(theme: .pets, photoIDs: ids), evaluations: values, identities: pairs(values), resources: resources,
                verify: { inputs in inputs.map { input in
                    var facts = Dictionary(uniqueKeysWithValues: BlueSkyCutoutVerifier.factKeys.map { ($0, Finding.present) })
                    for edge in BlueSkyCutoutVerifier.edges { facts[edge] = .unknown }
                    return .init(photoID: input.photoID,
                        cutoutDigest: SHA256.hash(data: input.cutout.png).map { String(format: "%02x", $0) }.joined(),
                        facts: facts, provenance: ["synthetic-verifier-not-real-model"])
                } })
            XCTAssertEqual(Set(result.plan.selections.map(\.slot)), Set(BlueSkyFallback.visibleSlots(photoCount: count)))
            XCTAssertEqual(result.artwork.selectedPhotoIDs.count, count)
            XCTAssertEqual(result.artwork.pixelWidth, 1800); XCTAssertEqual(result.artwork.pixelHeight, 2400)
            digests.insert(SHA256.hash(data: result.artwork.imageData).map { String(format: "%02x", $0) }.joined())
        }
        XCTAssertEqual(digests.count, 6)
    }
    func testUnavailableResourcesFallBackToBackgroundWithoutVerification() async throws {
        let values = evaluations(2)
        let result = try await BlueSkyGenerationEngine().generate(album: .init(theme: .pets, photoIDs: values.map(\.photoID)),
            evaluations: values, identities: pairs(values), resources: [:],
            verify: { _ in XCTFail("Missing resources cannot be uploaded"); return [] })
        XCTAssertEqual(result.plan.mode, "backgroundOnly")
        XCTAssertTrue(result.issues.contains("resourceUnavailable"))
    }
    func testUnknownOrUnavailableVerificationStillProducesBackgroundWithoutClaimingPass() async throws {
        let cutout = try fixture(), values = evaluations(1)
        let resources: [String: any PhotoPreviewProviding] = ["p0": SyntheticPetResource(image: cutout.inspection.original)]
        let result = try await BlueSkyGenerationEngine(extractor: { _ in cutout }).generate(
            album: .init(theme: .pets, photoIDs: ["p0"]), evaluations: values, identities: [], resources: resources,
            verify: { inputs in inputs.map { .init(photoID: $0.photoID,
                cutoutDigest: SHA256.hash(data: $0.cutout.png).map { String(format: "%02x", $0) }.joined(),
                facts: Dictionary(uniqueKeysWithValues: BlueSkyCutoutVerifier.factKeys.map { ($0, Finding.unknown) }), provenance: ["synthetic-unknown"]) } })
        XCTAssertEqual(result.plan.mode, "backgroundOnly")
        XCTAssertTrue(result.issues.contains("verificationPending"))
        let unavailable = try await BlueSkyGenerationEngine(extractor: { _ in cutout }).generate(
            album: .init(theme: .pets, photoIDs: ["p0"]), evaluations: values, identities: [], resources: resources,
            verify: { _ in throw PetCutoutError.foregroundUnavailable })
        XCTAssertEqual(unavailable.plan.mode, "backgroundOnly")
        XCTAssertTrue(unavailable.issues.contains("verificationUnavailable"))
    }
}

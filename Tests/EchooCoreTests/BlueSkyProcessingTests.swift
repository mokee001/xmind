import XCTest
@testable import EchooCore

final class BlueSkyProcessingTests: XCTestCase {
    private func evidence(_ changes: [String: Finding] = [:], digest: String = "mask-a") -> BlueSkyCutoutEvaluation {
        var facts = Dictionary(uniqueKeysWithValues: BlueSkyCutoutVerifier.factKeys.map { ($0, Finding.present) })
        facts.merge(changes) { _, newer in newer }
        return .init(photoID: "cat", cutoutDigest: digest, facts: facts, provenance: ["synthetic-test-only"])
    }
    func testSourceEdgesArePreferencesAndDoNotBecomePostCutoutGates() {
        let sample = evidence(["rightComplete": .absent, "bottomComplete": .absent])
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(sample, photoID: "cat", slot: .photo1, cutoutDigest: "mask-a").state, .passed)
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(sample, photoID: "cat", slot: .photo5, cutoutDigest: "mask-a").state, .passed)
    }
    func testMissingOrCrossedAssetProofCannotPassButUnknownSourceEdgesCan() {
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(nil, photoID: "cat", slot: .photo1, cutoutDigest: "mask-a").state, .pending)
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(evidence(), photoID: "cat", slot: .photo1, cutoutDigest: "different-mask").state, .pending)
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(evidence(["topComplete": .unknown]), photoID: "cat", slot: .photo5, cutoutDigest: "mask-a").state, .passed)
        XCTAssertEqual(BlueSkyCutoutVerifier.verdict(evidence(["leftComplete": .unknown]), photoID: "cat", slot: .photo1, cutoutDigest: "mask-a").state, .passed)
    }
    func testDamagedMaskFailsRegardlessOfOriginalPhotoQuality() {
        for key in BlueSkyCutoutVerifier.common {
            XCTAssertEqual(BlueSkyCutoutVerifier.verdict(evidence([key: .absent]), photoID: "cat", slot: .photo5, cutoutDigest: "mask-a").state, .failed)
        }
    }
    func testAllFivePlacedExactlyOnceWithConfirmedLongEdgeSizes() {
        XCTAssertEqual(Set(BlueSkyLayout.placements.map(\.slot)), Set(BlueSkySlot.allCases))
        XCTAssertEqual(BlueSkyLayout.width, 1800)
        XCTAssertEqual(BlueSkyLayout.height, 2400)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo1 }!.clockwiseDegrees, 45)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo2 }!.clockwiseDegrees, -116)
        XCTAssertEqual(BlueSkySlot.photo2.side, 1104)
        XCTAssertEqual(BlueSkySlot.photo5.side, 1040)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo1 }!.centerX, 340.4795)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo1 }!.centerY, 332.4795)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo2 }!.centerX, 1546.1151104514443)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo2 }!.centerY, 677.115038024664)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo3 }!.centerX, 354.34044583854836)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo3 }!.centerY, 1631.3404372877576)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo3 }!.clockwiseDegrees, 14)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo4 }!.centerX, 991)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo5 }!.centerX, 1464)
        XCTAssertEqual(BlueSkyLayout.placements.first { $0.slot == .photo5 }!.centerY, 2116)
    }
}

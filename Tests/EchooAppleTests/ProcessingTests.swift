import XCTest
import CoreGraphics
import ImageIO
import CryptoKit
import EchooCore
@testable import EchooApple

final class ProcessingTests: XCTestCase {
    private func fixture(fullFrame: Bool = false) throws -> CGImage {
        let context = try RasterImage.context(width: 100, height: 80)
        if fullFrame {
            context.setFillColor(CGColor(gray: 0.6, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 100, height: 80))
        }
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        // Red foreground touches source right and bottom, leaving top and left margins.
        context.fill(CGRect(x: 25, y: 0, width: 75, height: 60))
        return try XCTUnwrap(context.makeImage())
    }
    func testSourceAlignedInspectionDistinguishesRealContactsFromTightPNGEdges() throws {
        let original = try fixture(fullFrame: true), mask = try fixture()
        let result = try ApplePetCutout.inspect(original: original, fullFrameMask: mask)
        XCTAssertEqual(result.sourceBounds, CGRect(x: 25, y: 20, width: 75, height: 60))
        XCTAssertEqual(result.edgeContactPixels["top"], 0)
        XCTAssertEqual(result.edgeContactPixels["left"], 0)
        XCTAssertEqual(result.edgeContactPixels["right"], 60)
        XCTAssertEqual(result.edgeContactPixels["bottom"], 75)
        XCTAssertEqual(result.original.width, result.masked.width)
        XCTAssertEqual(result.original.height, result.masked.height)
        let tight = try XCTUnwrap(mask.cropping(to: result.sourceBounds))
        XCTAssertEqual(tight.width, 75)
        XCTAssertEqual(tight.height, 60)
        // Tight PNG touches every output edge although source top and left were complete.
        XCTAssertEqual(try RasterImage.alphaBounds(tight), CGRect(x: 0, y: 0, width: 75, height: 60))
    }
    func testEmptyOrMismatchedInspectionDoesNotBecomeSuccessfulExtraction() throws {
        let empty = try XCTUnwrap(RasterImage.context(width: 100, height: 80).makeImage())
        XCTAssertThrowsError(try ApplePetCutout.inspect(original: fixture(fullFrame: true), fullFrameMask: empty))
        let smaller = try XCTUnwrap(RasterImage.context(width: 40, height: 20).makeImage())
        XCTAssertThrowsError(try ApplePetCutout.inspect(original: fixture(fullFrame: true), fullFrameMask: smaller))
    }
    func testBundledDesignAssetsHavePinnedDimensionsAndHashes() throws {
        let folder = try BlueSkyRenderer().assetDirectory
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("assets.json"))) as! [String: Any]
        let assets = manifest["assets"] as! [[String: Any]]
        XCTAssertEqual(assets.count, 6)
        for asset in assets {
            let data = try Data(contentsOf: folder.appendingPathComponent(asset["filename"] as! String))
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(digest, asset["sha256"] as? String)
            let image = try RasterImage.decode(data)
            XCTAssertEqual(image.width, asset["width"] as? Int)
            XCTAssertEqual(image.height, asset["height"] as? Int)
        }
    }
    func testProductionRendererRejectsUnverifiedOrChangedMasksWhileExplicitCalibrationCanPreview() throws {
        let slots = BlueSkySlot.allCases
        let ids = slots.map(\.rawValue)
        let scores = Dictionary(uniqueKeysWithValues: BlueSkyDimension.allCases.map { ($0.rawValue, BlueSkyRating(value: 3, reason: "test")) })
        let evals = ids.map { id in BlueSkyPhotoEvaluation(photoID: id,
            facts: Dictionary(uniqueKeysWithValues: BlueSkySelector.factKeys.map { ($0, Finding.present) }),
            scores: scores, provenance: ["synthetic-test-only"]) }
        var identity: [PetIdentityEvidence] = []
        for i in 0..<ids.count { for j in (i + 1)..<ids.count {
            identity.append(.init(leftID: ids[i], rightID: ids[j], relation: .same,
                                  reason: "test", provenance: ["synthetic-test-only"]))
        } }
        let plan = try BlueSkySelector.select(photoIDs: ids, evaluations: evals, identities: identity)
        let png = try RasterImage.png(fixture())
        let images = Dictionary(uniqueKeysWithValues: ids.map { ($0, png) })
        let renderer = try BlueSkyRenderer()
        XCTAssertThrowsError(try renderer.renderVerified(plan: plan, cutouts: images, evidence: []))
        let wrong = ids.map { BlueSkyCutoutEvaluation(photoID: $0, cutoutDigest: "wrong",
            facts: Dictionary(uniqueKeysWithValues: BlueSkyCutoutVerifier.factKeys.map { ($0, Finding.present) }), provenance: ["test"]) }
        XCTAssertThrowsError(try renderer.renderVerified(plan: plan, cutouts: images, evidence: wrong))
        let confirmed = Dictionary(uniqueKeysWithValues: plan.selections.map { ($0.slot, $0.photoID) })
        let preview = try renderer.renderReviewedCalibration(plan: plan, cutouts: images, confirmed: confirmed, options: .init(outlineScale: 0))
        XCTAssertEqual(preview.pixelWidth, 1800)
        XCTAssertEqual(preview.pixelHeight, 2400)
        XCTAssertEqual(Set(preview.selectedPhotoIDs), Set(ids))
    }
    private func opaqueSquare() throws -> CGImage {
        let context = try RasterImage.context(width: 120, height: 120)
        // Match the bitmap color space so the fixture's pure red is not converted
        // from the convenience CGColor initializer's different RGB profile.
        context.setFillColor(try XCTUnwrap(CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [1, 0, 0, 1])))
        context.fill(CGRect(x: 0, y: 0, width: 120, height: 120))
        return try XCTUnwrap(context.makeImage())
    }
    private func horizontalColors(_ image: CGImage) throws -> [(r: UInt8, g: UInt8, b: UInt8, a: UInt8)] {
        let rgba = try RasterImage.rgba(image), row = image.height / 2
        return (0..<image.width).map { x in
            let p = (row * image.width + x) * 4
            return (rgba.bytes[p], rgba.bytes[p + 1], rgba.bytes[p + 2], rgba.bytes[p + 3])
        }
    }
    func testFloatingOutlineSeparatesOffsetFromWidthAndLeavesTransparentGap() throws {
        let image = try BlueSkyRenderer.decorate(opaqueSquare(), strokes: BlueSkyOutlineStyle.strokes(for: .photo5))
        let row = try horizontalColors(image)
        let observed = Set(row.map { "\($0.r),\($0.g),\($0.b),\($0.a)" })
        let redStart = try XCTUnwrap(row.firstIndex { $0.r > 240 && $0.g < 10 && $0.a > 240 }, String(describing: observed))
        let white = (0..<redStart).filter { row[$0].r > 200 && row[$0].g > 200 && row[$0].a > 200 }
        let first = try XCTUnwrap(white.first), last = try XCTUnwrap(white.last)
        XCTAssertEqual(Double(redStart) - Double(first + last) / 2, 20, accuracy: 1)
        XCTAssertEqual(Double(white.count), 12, accuracy: 1)
        XCTAssertGreaterThanOrEqual((last + 1..<redStart).filter { row[$0].a == 0 }.count, 12)
        // The source red square is preserved; offset construction is decorative only.
        XCTAssertEqual(row.filter { $0.r > 240 && $0.g < 10 && $0.a > 240 }.count, 120)
    }
    func testFilledStickerBordersHaveTheRequestedVisibleBlackAndWhiteBands() throws {
        for (slot, black, white) in [(BlueSkySlot.photo2, 8, 16), (.photo3, 4, 12), (.photo4, 4, 12)] {
            let image = try BlueSkyRenderer.decorate(opaqueSquare(), strokes: BlueSkyOutlineStyle.strokes(for: slot))
            let row = try horizontalColors(image)
            let observed = Set(row.map { "\($0.r),\($0.g),\($0.b),\($0.a)" })
            let redStart = try XCTUnwrap(row.firstIndex { $0.r > 240 && $0.g < 10 && $0.a > 240 }, String(describing: observed))
            let blackPixels = row[..<redStart].filter { $0.r < 10 && $0.g < 10 && $0.b < 10 && $0.a > 240 }.count
            let whitePixels = row[..<redStart].filter { $0.r > 240 && $0.g > 240 && $0.b > 240 && $0.a > 240 }.count
            XCTAssertEqual(blackPixels, black)
            XCTAssertEqual(whitePixels, white)
            XCTAssertEqual(redStart, black + white)
        }
    }
}

import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import EchooCore
@testable import EchooApple

final class NativeTests: XCTestCase {
    private func image() throws -> CGImage {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 1024, height: 512, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1024, height: 512))
        return try XCTUnwrap(context.makeImage())
    }

    func testPreviewIsBoundedAndMetadataIsStripped() throws {
        let raw = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(raw, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try image(), [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 31.2, kCGImagePropertyGPSLatitudeRef: "N"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "private-test-marker"]
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let preview = try PreviewDecoder.from(data: raw as Data, maxPixel: 256)
        XCTAssertEqual(preview.width, 256)
        XCTAssertEqual(preview.height, 128)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(preview.jpeg as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        XCTAssertNil(exif?[kCGImagePropertyExifUserComment])
        XCTAssertFalse(preview.jpeg.range(of: Data("private-test-marker".utf8)) != nil)
    }

    func testPlainWhiteMetricsAreEvidenceNotAnExclusion() throws {
        let metrics = try QualityAnalyzer.metrics(image: image())
        XCTAssertEqual(metrics.laplacianVariance, 0, accuracy: 0.0001)
        XCTAssertGreaterThan(metrics.brightFraction, 0.99)
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["普通风景照片"]), .unknown)
    }

    func testLiteralPrivateValuesAreRecognizedWithoutReturningThem() {
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["密码：SYNTHETIC_TEST_ONLY"]), .present)
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["身份证号：110101199001011234"]), .present)
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["银行卡号：1234 5678 9012 3456"]), .present)
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["泳装与健身照片"]), .unknown)
        XCTAssertEqual(LocalPrivacyDetector.detect(lines: ["餐厅联系电话：13800138000"]), .unknown)
    }

    func testInvalidPreviewSizeAndBrokenDataThrow() {
        XCTAssertThrowsError(try PreviewDecoder.from(data: Data([0, 1]), maxPixel: 512))
    }

    func testColoredPixelsSurvivePreviewEncoding() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 128, height: 64,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: 64, y: 0, width: 64, height: 64))
        let preview = try PreviewDecoder.encode(XCTUnwrap(context.makeImage()))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(preview.jpeg as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let metrics = try QualityAnalyzer.metrics(image: decoded)
        XCTAssertGreaterThan(metrics.laplacianVariance, 0)
        XCTAssertLessThan(metrics.brightFraction, 0.01)
    }

    func testUnavailablePixelProviderCannotBecomeAWhitePreview() throws {
        var callbacks = CGDataProviderSequentialCallbacks(version: 0,
            getBytes: { _, _, _ in 0 }, skipForward: { _, _ in 0 },
            rewind: { _ in }, releaseInfo: nil)
        let provider = try XCTUnwrap(CGDataProvider(sequentialInfo: nil, callbacks: &callbacks))
        let unavailable = try XCTUnwrap(CGImage(width: 4, height: 4, bitsPerComponent: 8,
            bitsPerPixel: 32, bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        XCTAssertThrowsError(try PreviewDecoder.encode(unavailable))
    }

    func testDetailedPreviewFitsTwentyPhotoTransportBudgetWithoutCropping() throws {
        let width = 1536, height = 1024
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        var seed: UInt32 = 12345
        for index in stride(from: 0, to: bytes.count, by: 4) {
            for channel in 0..<3 {
                seed = seed &* 1664525 &+ 1013904223
                bytes[index + channel] = UInt8(truncatingIfNeeded: seed >> 24)
            }
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        let noisy = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8,
            bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let unbounded = try PreviewDecoder.encode(noisy)
        let budget = 6 * 1024 * 1024 / 20
        XCTAssertGreaterThan(unbounded.jpeg.count, budget)
        let bounded = try PreviewDecoder.from(data: unbounded.jpeg, maxPixel: 1536, maxJPEGBytes: budget)
        XCTAssertLessThanOrEqual(bounded.jpeg.count * 20, 6 * 1024 * 1024)
        XCTAssertLessThanOrEqual(max(bounded.width, bounded.height), 1536)
        XCTAssertEqual(Double(bounded.width) / Double(bounded.height), 1.5, accuracy: 0.003)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bounded.jpeg as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, bounded.width)
        XCTAssertEqual(decoded.height, bounded.height)
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertNil(properties[kCGImagePropertyExifDictionary])
    }

    func testImpossiblePreviewBudgetFailsInsteadOfReturningOversizedImage() throws {
        XCTAssertThrowsError(try PreviewDecoder.encode(image(), maxJPEGBytes: 1)) { error in
            guard case AppleAnalysisError.previewBudgetExceeded = error else { return XCTFail("Wrong error") }
        }
        XCTAssertThrowsError(try PreviewDecoder.encode(image(), maxJPEGBytes: 0))
    }
}

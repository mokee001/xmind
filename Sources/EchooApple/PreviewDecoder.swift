import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import EchooCore

public enum AppleAnalysisError: Error {
    case invalidPreviewSize, invalidPreviewBudget, previewBudgetExceeded
    case imageDecodeFailed, imageEncodeFailed, graphicsContextFailed
}

/// Decode a bounded, orientation-correct full-frame preview; strip all source metadata.
public enum PreviewDecoder {
    public static let revision = "imageio-verified-pixels-v2"
    public static func from(url: URL, maxPixel: Int, maxJPEGBytes: Int? = nil) throws -> AnalysisPreview {
        guard let source = CGImageSourceCreateWithURL(
            url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary
        ) else { throw AppleAnalysisError.imageDecodeFailed }
        return try from(source: source, maxPixel: maxPixel, maxJPEGBytes: maxJPEGBytes)
    }

    public static func from(data: Data, maxPixel: Int, maxJPEGBytes: Int? = nil) throws -> AnalysisPreview {
        guard let source = CGImageSourceCreateWithData(
            data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
        ) else { throw AppleAnalysisError.imageDecodeFailed }
        return try from(source: source, maxPixel: maxPixel, maxJPEGBytes: maxJPEGBytes)
    }

    private static func from(source: CGImageSource, maxPixel: Int, maxJPEGBytes: Int?) throws -> AnalysisPreview {
        guard (64...4096).contains(maxPixel) else { throw AppleAnalysisError.invalidPreviewSize }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw AppleAnalysisError.imageDecodeFailed
        }
        return try encode(image, maxJPEGBytes: maxJPEGBytes)
    }

    public static func encode(_ image: CGImage, maxJPEGBytes: Int? = nil) throws -> AnalysisPreview {
        if let maxJPEGBytes, maxJPEGBytes <= 0 { throw AppleAnalysisError.invalidPreviewBudget }
        // A HEIC thumbnail can have valid dimensions but inaccessible IOSurface pixels.
        // CGContext.draw then silently leaves the white fill unchanged. Materialize and
        // validate the pixel provider before accepting any preview, including white photos.
        guard let decoded = image.dataProvider?.data,
              image.width > 0, image.height > 0, image.bitsPerPixel > 0 else {
            throw AppleAnalysisError.imageDecodeFailed
        }
        let (prefix, overflow1) = image.bytesPerRow.multipliedReportingOverflow(by: image.height - 1)
        let (rowBits, overflow2) = image.width.multipliedReportingOverflow(by: image.bitsPerPixel)
        let (minimum, overflow3) = prefix.addingReportingOverflow(rowBits / 8 + (rowBits % 8 == 0 ? 0 : 1))
        guard !overflow1, !overflow2, !overflow3, CFDataGetLength(decoded) >= minimum,
              let provider = CGDataProvider(data: decoded), let colorSpace = image.colorSpace,
              let materialized = CGImage(width: image.width, height: image.height,
                bitsPerComponent: image.bitsPerComponent, bitsPerPixel: image.bitsPerPixel,
                bytesPerRow: image.bytesPerRow, space: colorSpace, bitmapInfo: image.bitmapInfo,
                provider: provider, decode: image.decode, shouldInterpolate: true, intent: image.renderingIntent) else {
            throw AppleAnalysisError.imageDecodeFailed
        }
        // Rasterize verified pixels into a fresh image; do not copy source metadata.
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { throw AppleAnalysisError.graphicsContextFailed }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.fill(rect)
        context.draw(materialized, in: rect)
        guard let clean = context.makeImage() else { throw AppleAnalysisError.imageEncodeFailed }
        // Keep the full frame. Try bounded JPEG quality before reducing dimensions;
        // this is a transport budget, never a photo-quality admission threshold.
        var current = clean
        while true {
            var lastSize = 0
            for quality in maxJPEGBytes == nil ? [0.88] : [0.88, 0.80, 0.72] {
                let jpeg = try jpeg(current, quality: quality)
                lastSize = jpeg.count
                if let budget = maxJPEGBytes, jpeg.count > budget { continue }
                return AnalysisPreview(jpeg: jpeg, width: current.width, height: current.height)
            }
            guard let budget = maxJPEGBytes, max(current.width, current.height) > 64 else {
                throw AppleAnalysisError.previewBudgetExceeded
            }
            let scale = min(0.90, sqrt(Double(budget) / Double(lastSize)) * 0.95)
            let longest = max(64, Int(Double(max(current.width, current.height)) * scale))
            let ratio = Double(longest) / Double(max(current.width, current.height))
            let width = max(1, Int((Double(current.width) * ratio).rounded()))
            let height = max(1, Int((Double(current.height) * ratio).rounded()))
            guard let smaller = CGContext(data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
                throw AppleAnalysisError.graphicsContextFailed
            }
            smaller.interpolationQuality = .high
            smaller.draw(clean, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let resized = smaller.makeImage() else { throw AppleAnalysisError.imageEncodeFailed }
            current = resized
        }
    }

    private static func jpeg(_ image: CGImage, quality: Double) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw AppleAnalysisError.imageEncodeFailed
        }
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: quality
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw AppleAnalysisError.imageEncodeFailed }
        return try stripMetadata(from: data as Data)
    }

    /// ImageIO may generate fresh EXIF. Remove APP1 and comments at the byte level as well.
    private static func stripMetadata(from data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8 else {
            throw AppleAnalysisError.imageEncodeFailed
        }
        var clean = Data(bytes[0..<2])
        var offset = 2
        while offset < bytes.count {
            let start = offset
            guard bytes[offset] == 0xff else { throw AppleAnalysisError.imageEncodeFailed }
            while offset < bytes.count && bytes[offset] == 0xff { offset += 1 }
            guard offset < bytes.count else { throw AppleAnalysisError.imageEncodeFailed }
            let marker = bytes[offset]
            offset += 1
            if marker == 0xda || marker == 0xd9 {
                clean.append(contentsOf: bytes[start...])
                return clean
            }
            guard offset + 2 <= bytes.count else { throw AppleAnalysisError.imageEncodeFailed }
            let length = Int(bytes[offset]) * 256 + Int(bytes[offset + 1])
            guard length >= 2, offset + length <= bytes.count else { throw AppleAnalysisError.imageEncodeFailed }
            offset += length
            if marker != 0xe1 && marker != 0xfe {
                clean.append(contentsOf: bytes[start..<offset])
            }
        }
        throw AppleAnalysisError.imageEncodeFailed
    }
}

/// Explicit local-file adapter for development; never enumerates the user's library itself.
public struct FilePhotoSource: PhotoPreviewProviding {
    public let url: URL
    public init(url: URL) { self.url = url }

    public func preview(maxPixel: Int) async throws -> PreviewResult {
        let work = Task.detached(priority: .utility) { () throws -> PreviewResult in
            try Task.checkCancellation()
            let preview = try PreviewDecoder.from(url: url, maxPixel: maxPixel)
            try Task.checkCancellation()
            return .ready(preview)
        }
        return try await withTaskCancellationHandler {
            try await work.value
        } onCancel: { work.cancel() }
    }
}

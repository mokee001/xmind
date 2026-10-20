import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Shared image I/O for the renderer and mask inspection. Coordinates exposed by
/// alphaBounds/edgeCounts are top-left image coordinates, before any layout transform.
enum RasterImage {
    static func decode(_ data: Data) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0,
                [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
            throw AppleAnalysisError.imageDecodeFailed
        }
        return image
    }
    static func context(width: Int, height: Int) throws -> CGContext {
        guard width > 0, height > 0, width <= 8192, height <= 8192,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw AppleAnalysisError.graphicsContextFailed
        }
        return context
    }
    static func png(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw AppleAnalysisError.imageEncodeFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw AppleAnalysisError.imageEncodeFailed }
        return data as Data
    }
    static func rgba(_ image: CGImage) throws -> (bytes: [UInt8], width: Int, height: Int) {
        let context = try context(width: image.width, height: image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let pointer = context.data else { throw AppleAnalysisError.imageDecodeFailed }
        return (Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: UInt8.self),
                                         count: image.width * image.height * 4)), image.width, image.height)
    }
    static func alphaBounds(_ image: CGImage) throws -> CGRect {
        let pixels = try rgba(image)
        var left = pixels.width, top = pixels.height, right = -1, bottom = -1
        for y in 0..<pixels.height {
            for x in 0..<pixels.width where pixels.bytes[(y * pixels.width + x) * 4 + 3] > 0 {
                left = min(left, x); right = max(right, x); top = min(top, y); bottom = max(bottom, y)
            }
        }
        guard right >= left, bottom >= top else { throw PetCutoutError.foregroundUnavailable }
        return CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
    }
}

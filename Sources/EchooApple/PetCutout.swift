import Foundation
import Vision
import CoreGraphics
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import EchooCore

public struct PetCutout: Sendable {
    public let png: Data
    public let width: Int
    public let height: Int
    /// Extraction is not a completed quality/edge verification.
    public let requiresVerification: Bool
    public let inspection: PetCutoutInspection
}
public struct PetCutoutInspection: Sendable {
    public let original: AnalysisPreview
    /// Full source frame on neutral gray, not the tight cropped PNG.
    public let masked: AnalysisPreview
    public let sourceBounds: CGRect
    /// Contact counts are evidence only, never a clipping verdict or quality threshold.
    public let edgeContactPixels: [String: Int]
}
public enum PetCutoutError: Error { case ambiguousSubject, foregroundUnavailable, imageEncodeFailed }

/// Foreground extraction is species-neutral; animal identity is verified by the backend.
public enum ApplePetCutout {
    public static let revision = "source-aligned-pet-cutout-v3"
    /// Called only for selected originals. Do not batch-segment the scoring pool.
    public static func extract(_ preview: AnalysisPreview) throws -> PetCutout {
        guard let source = CGImageSourceCreateWithData(preview.jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw AppleAnalysisError.imageDecodeFailed }
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first, observation.allInstances.count == 1 else {
            // Never silently pick an unrelated largest object or discard interaction hands.
            throw PetCutoutError.ambiguousSubject
        }
        let buffer = try observation.generateMaskedImage(ofInstances: observation.allInstances,
            from: handler, croppedToInstancesExtent: false)
        let ciImage = CIImage(cvPixelBuffer: buffer)
        guard let output = CIContext().createCGImage(ciImage, from: ciImage.extent),
              output.width > 0, output.height > 0 else { throw PetCutoutError.foregroundUnavailable }
        let inspection = try inspect(original: image, fullFrameMask: output)
        guard let tight = output.cropping(to: inspection.sourceBounds) else { throw PetCutoutError.imageEncodeFailed }
        return PetCutout(png: try RasterImage.png(tight), width: tight.width, height: tight.height,
                         requiresVerification: true, inspection: inspection)
    }

    public static func inspect(original: CGImage, fullFrameMask: CGImage) throws -> PetCutoutInspection {
        guard original.width == fullFrameMask.width, original.height == fullFrameMask.height else {
            throw PetCutoutError.foregroundUnavailable
        }
        let pixels = try RasterImage.rgba(fullFrameMask)
        let w = pixels.width, h = pixels.height
        func visible(_ x: Int, _ y: Int) -> Bool { pixels.bytes[(y * w + x) * 4 + 3] > 0 }
        let counts = ["top": (0..<w).filter { visible($0, 0) }.count,
                      "bottom": (0..<w).filter { visible($0, h - 1) }.count,
                      "left": (0..<h).filter { visible(0, $0) }.count,
                      "right": (0..<h).filter { visible(w - 1, $0) }.count]
        let bounds = try RasterImage.alphaBounds(fullFrameMask)
        let context = try RasterImage.context(width: w, height: h)
        context.setFillColor(CGColor(gray: 0.38, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        context.draw(fullFrameMask, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let composite = context.makeImage() else { throw PetCutoutError.imageEncodeFailed }
        // Both inputs use the same full-frame dimensions and orientation. A smaller
        // bounded inspection image does not modify the original-photo quality scores.
        let originalJPEG = try PreviewDecoder.from(data: RasterImage.png(original), maxPixel: 1024, maxJPEGBytes: 500_000)
        let maskedJPEG = try PreviewDecoder.from(data: RasterImage.png(composite), maxPixel: 1024, maxJPEGBytes: 500_000)
        return .init(original: originalJPEG, masked: maskedJPEG, sourceBounds: bounds, edgeContactPixels: counts)
    }
}

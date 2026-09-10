import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

enum CutoutError: Error, CustomStringConvertible {
    case invalidArguments
    case cannotReadImage
    case noForeground
    case cannotCreateOutput

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: macos_foreground_cutout INPUT_IMAGE OUTPUT_PNG"
        case .cannotReadImage:
            return "cannot read input image"
        case .noForeground:
            return "Vision did not find a foreground instance"
        case .cannotCreateOutput:
            return "cannot create output PNG"
        }
    }
}

func loadCGImage(at url: URL) throws -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(
            source,
            0,
            [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        )
    else {
        throw CutoutError.cannotReadImage
    }
    return image
}

func createCutout(inputURL: URL, outputURL: URL) throws {
    let image = try loadCGImage(at: inputURL)
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
    try handler.perform([request])

    guard
        let observation = request.results?.first,
        !observation.allInstances.isEmpty
    else {
        throw CutoutError.noForeground
    }

    let maskBuffer = try observation.generateScaledMaskForImage(
        forInstances: observation.allInstances,
        from: handler
    )

    let source = CIImage(cgImage: image)
    let mask = CIImage(cvPixelBuffer: maskBuffer)
    let transparent = CIImage(color: .clear).cropped(to: source.extent)
    let result = source.applyingFilter(
        "CIBlendWithMask",
        parameters: [
            kCIInputBackgroundImageKey: transparent,
            kCIInputMaskImageKey: mask,
        ]
    )

    let context = CIContext(options: [.cacheIntermediates: false])
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        throw CutoutError.cannotCreateOutput
    }
    try context.writePNGRepresentation(
        of: result,
        to: outputURL,
        format: .RGBA8,
        colorSpace: colorSpace
    )
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw CutoutError.invalidArguments
    }
    try createCutout(
        inputURL: URL(fileURLWithPath: CommandLine.arguments[1]),
        outputURL: URL(fileURLWithPath: CommandLine.arguments[2])
    )
} catch {
    FileHandle.standardError.write(Data("cutout failed: \(error)\n".utf8))
    exit(1)
}

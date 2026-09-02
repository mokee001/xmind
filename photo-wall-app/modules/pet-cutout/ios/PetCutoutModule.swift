import CoreImage
import ExpoModulesCore
import Foundation
import Vision

public final class PetCutoutModule: Module {
  private static let maxOutputDimension: CGFloat = 1800

  public func definition() -> ModuleDefinition {
    Name("PetCutout")

    AsyncFunction("cutoutAsync") { (sourceURL: URL) throws -> [String: Any] in
      guard #available(iOS 17.0, *) else {
        throw NSError(
          domain: "PetCutout",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "宠物抠图需要 iOS 17 或更高版本"]
        )
      }
      return try Self.cutout(sourceURL: sourceURL)
    }

    AsyncFunction("removeAsync") { (outputURL: URL) throws in
      guard outputURL.isFileURL else { return }
      if FileManager.default.fileExists(atPath: outputURL.path) {
        try FileManager.default.removeItem(at: outputURL)
      }
    }
  }

  @available(iOS 17.0, *)
  private static func cutout(sourceURL: URL) throws -> [String: Any] {
    guard sourceURL.isFileURL else {
      throw NSError(
        domain: "PetCutout",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "抠图输入必须是 iPhone 本地照片"]
      )
    }
    guard let sourceImage = CIImage(
      contentsOf: sourceURL,
      options: [.applyOrientationProperty: true]
    ) else {
      throw NSError(
        domain: "PetCutout",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "无法读取待抠图照片"]
      )
    }

    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(ciImage: sourceImage)
    try handler.perform([request])
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
      throw NSError(
        domain: "PetCutout",
        code: 4,
        userInfo: [NSLocalizedDescriptionKey: "没有识别到可抠取的宠物主体"]
      )
    }

    let pixelBuffer = try observation.generateMaskedImage(
      ofInstances: observation.allInstances,
      from: handler,
      croppedToInstancesExtent: true
    )
    let cutoutImage = CIImage(cvPixelBuffer: pixelBuffer)
    let longestDimension = max(cutoutImage.extent.width, cutoutImage.extent.height)
    let outputImage = longestDimension > maxOutputDimension
      ? cutoutImage.applyingFilter(
          "CILanczosScaleTransform",
          parameters: [
            kCIInputScaleKey: maxOutputDimension / longestDimension,
            kCIInputAspectRatioKey: 1.0,
          ]
        )
      : cutoutImage
    let context = CIContext(options: [.cacheIntermediates: false])
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let pngData = context.pngRepresentation(
            of: outputImage,
            format: .RGBA8,
            colorSpace: colorSpace
          ) else {
      throw NSError(
        domain: "PetCutout",
        code: 5,
        userInfo: [NSLocalizedDescriptionKey: "无法生成透明抠图"]
      )
    }

    let outputDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("pet-cutouts", isDirectory: true)
    try FileManager.default.createDirectory(
      at: outputDirectory,
      withIntermediateDirectories: true
    )
    let outputURL = outputDirectory.appendingPathComponent("\(UUID().uuidString).png")
    try pngData.write(to: outputURL, options: .atomic)

    return [
      "uri": outputURL.absoluteString,
      "width": Int(outputImage.extent.width.rounded()),
      "height": Int(outputImage.extent.height.rounded()),
    ]
  }
}
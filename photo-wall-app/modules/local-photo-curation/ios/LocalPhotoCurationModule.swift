import CoreImage
import ExpoModulesCore
import Foundation
import Photos
import UIKit
import Vision
import ImageIO

public final class LocalPhotoCurationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LocalPhotoCuration")

    AsyncFunction("observeFileAsync") { (uri: String) throws -> [String: Any] in
      guard let url = URL(string: uri), url.isFileURL,
            let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        throw NSError(domain: "LocalPhotoCuration", code: 2, userInfo: [NSLocalizedDescriptionKey: "照片原文件不可用"])
      }
      func image(_ size: Int) throws -> CGImage {
        guard let result = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: size
        ] as CFDictionary) else { throw NSError(domain: "LocalPhotoCuration", code: 3) }
        return result
      }
      // Match the confirmed baseline's public Vision revisions and input sizes.
      let classification = VNClassifyImageRequest()
      classification.revision = VNClassifyImageRequestRevision1
      try VNImageRequestHandler(cgImage: image(640), orientation: .up).perform([classification])
      let faces = VNDetectFaceRectanglesRequest()
      faces.revision = VNDetectFaceRectanglesRequestRevision3
      let humans = VNDetectHumanRectanglesRequest()
      humans.revision = VNDetectHumanRectanglesRequestRevision2
      humans.upperBodyOnly = true
      try VNImageRequestHandler(cgImage: image(1600), orientation: .up).perform([faces, humans])
      func region(_ observation: VNDetectedObjectObservation) -> [String: Any] {
        let box = observation.boundingBox
        return ["box": [box.minX, 1-box.maxY, box.maxX, 1-box.minY], "confidence": observation.confidence]
      }
      return ["version": 1,
              "labels": (classification.results ?? []).map { ["identifier": $0.identifier, "confidence": $0.confidence] as [String: Any] },
              "faces": faces.results?.count ?? 0,
              "face_regions": (faces.results ?? []).map { region($0) },
              "humans": (humans.results ?? []).map { region($0) }]
    }

    AsyncFunction("curateAsync") { (assetIDs: [String], options: [String: Double]) throws -> [String: Any] in
      let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      guard permission == .authorized || permission == .limited else {
        throw NSError(domain: "LocalPhotoCuration", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "需要照片访问权限才能在本机分析相册"
        ])
      }

      let minimumScore = options["minimumScore"] ?? 0.52
      let maximumCandidates = max(1, Int(options["maximumCandidates"] ?? 160))
      let textLineLimit = max(1, Int(options["textLineLimit"] ?? 5))
      let fetch = PHAsset.fetchAssets(withLocalIdentifiers: assetIDs, options: nil)
      var assetByID: [String: PHAsset] = [:]
      fetch.enumerateObjects { asset, _, _ in assetByID[asset.localIdentifier] = asset }

      var accepted: [[String: Any]] = []
      var rejected: [String: Int] = [:]
      var unavailable = 0
      var reviewedIDs: [String] = []

      for assetID in assetIDs {
        guard let asset = assetByID[Self.normalizedIdentifier(assetID)] ?? assetByID[assetID] else {
          unavailable += 1
          continue
        }
        if asset.mediaSubtypes.contains(.photoScreenshot) {
          reviewedIDs.append(assetID)
          rejected["screenshot", default: 0] += 1
          continue
        }
        guard let image = Self.thumbnail(for: asset) else {
          unavailable += 1
          continue
        }
        reviewedIDs.append(assetID)

        let signals = Self.analyze(image: image, textLineLimit: textLineLimit)
        if let reason = signals.rejectionReason {
          rejected[reason, default: 0] += 1
          continue
        }

        var score = 0.42
        score += min(0.20, signals.contrast * 0.35)
        score += signals.hasFace ? 0.14 : 0
        score += asset.isFavorite ? 0.12 : 0
        score += min(asset.pixelWidth, asset.pixelHeight) >= 1080 ? 0.07 : 0
        score += asset.location == nil ? 0 : 0.05
        score -= signals.textLines > 0 ? min(0.12, Double(signals.textLines) * 0.025) : 0

        if score >= minimumScore {
          accepted.append([
            "id": assetID,
            "score": min(1, score),
            "hasFace": signals.hasFace,
            "textLines": signals.textLines,
            "favorite": asset.isFavorite,
            "creationTime": asset.creationDate?.timeIntervalSince1970 ?? 0,
          ])
        } else {
          rejected["low_quality", default: 0] += 1
        }
      }

      accepted.sort {
        let left = $0["score"] as? Double ?? 0
        let right = $1["score"] as? Double ?? 0
        if left != right { return left > right }
        return ($0["creationTime"] as? Double ?? 0) > ($1["creationTime"] as? Double ?? 0)
      }
      let candidates = Array(accepted.prefix(maximumCandidates))
      return [
        "version": 1,
        "reviewedIds": reviewedIDs,
        "engine": "apple-vision-local-v1",
        "inspected": assetIDs.count,
        "analyzed": max(0, assetIDs.count - unavailable),
        "unavailable": unavailable,
        "eligible": accepted.count,
        "candidates": candidates,
        "rejected": rejected,
      ]
    }
  }

  private struct Signals {
    let contrast: Double
    let hasFace: Bool
    let textLines: Int
    let rejectionReason: String?
  }

  private static func normalizedIdentifier(_ value: String) -> String {
    if value.hasPrefix("ph://") { return String(value.dropFirst(5)) }
    return value
  }

  private static func thumbnail(for asset: PHAsset) -> CGImage? {
    let options = PHImageRequestOptions()
    options.isSynchronous = true
    options.isNetworkAccessAllowed = false
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    var output: CGImage?
    PHImageManager.default().requestImage(
      for: asset,
      targetSize: CGSize(width: 384, height: 384),
      contentMode: .aspectFit,
      options: options
    ) { image, _ in output = image?.cgImage }
    return output
  }

  private static func analyze(image: CGImage, textLineLimit: Int) -> Signals {
    let faceRequest = VNDetectFaceRectanglesRequest()
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .fast
    textRequest.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([faceRequest, textRequest])
    let textLines = textRequest.results?.filter { $0.confidence >= 0.45 }.count ?? 0
    let stats = luminanceStats(image: image)

    let rejection: String?
    if textLines >= textLineLimit { rejection = "text_heavy" }
    else if stats.mean < 0.08 { rejection = "too_dark" }
    else if stats.mean > 0.94 { rejection = "overexposed" }
    else if stats.contrast < 0.035 { rejection = "low_contrast" }
    else { rejection = nil }

    return Signals(
      contrast: stats.contrast,
      hasFace: !(faceRequest.results?.isEmpty ?? true),
      textLines: textLines,
      rejectionReason: rejection
    )
  }

  private static func luminanceStats(image: CGImage) -> (mean: Double, contrast: Double) {
    let width = 32, height = 32
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return (0.5, 0) }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    var values: [Double] = []
    values.reserveCapacity(width * height)
    for offset in stride(from: 0, to: pixels.count, by: 4) {
      let value = (0.2126 * Double(pixels[offset]) + 0.7152 * Double(pixels[offset + 1]) + 0.0722 * Double(pixels[offset + 2])) / 255
      values.append(value)
    }
    let mean = values.reduce(0, +) / Double(values.count)
    let variance = values.reduce(0) { $0 + pow($1 - mean, 2) } / Double(values.count)
    return (mean, sqrt(variance))
  }
}

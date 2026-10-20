import Foundation
import Vision
import CoreGraphics
import ImageIO
import Accelerate
import EchooCore

public struct AppleNativeAnalyzer: NativePhotoAnalyzing {
    public init() {}

    public func analyze(_ preview: AnalysisPreview) async throws -> NativeAnalysis {
        let work = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            let result = try Self.analyzeSynchronously(preview)
            try Task.checkCancellation()
            return result
        }
        return try await withTaskCancellationHandler {
            try await work.value
        } onCancel: { work.cancel() }
    }

    private static func analyzeSynchronously(_ preview: AnalysisPreview) throws -> NativeAnalysis {
        guard let source = CGImageSourceCreateWithData(preview.jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw AppleAnalysisError.imageDecodeFailed
        }
        let classification = VNClassifyImageRequest()
        classification.revision = VNClassifyImageRequestRevision2
        let animals = VNRecognizeAnimalsRequest()
        animals.revision = VNRecognizeAnimalsRequestRevision2
        let text = VNRecognizeTextRequest()
        text.revision = VNRecognizeTextRequestRevision3
        // Chinese is unavailable in fast OCR; use accurate recognition explicitly.
        text.recognitionLevel = .accurate
        let supported = try text.supportedRecognitionLanguages()
        text.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter(supported.contains)
        text.automaticallyDetectsLanguage = true
        text.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([classification, animals, text])

        let textObservations = text.results ?? []
        let recognized = textObservations.compactMap { $0.topCandidates(1).first }
        // Private strings exist only in this stack frame and are never returned or logged.
        let privateFinding = LocalPrivacyDetector.detect(
            lines: recognized.filter { $0.confidence >= 0.8 }.map(\.string)
        )
        let coverage = textObservations.reduce(Float(0)) { total, observation in
            total + Float(observation.boundingBox.width * observation.boundingBox.height)
        }
        return NativeAnalysis(
            revision: "vision-classify-r2-animal-r2-ocr-r3-quality-v1",
            labels: (classification.results ?? []).prefix(20).map {
                ImageLabel(identifier: $0.identifier, confidence: $0.confidence)
            },
            animals: (animals.results ?? []).flatMap { observation in
                observation.labels.prefix(2).map {
                    ImageLabel(identifier: $0.identifier, confidence: $0.confidence)
                }
            },
            textRegionCount: textObservations.count,
            textCoverage: min(1, coverage), privacyFinding: privateFinding,
            quality: try QualityAnalyzer.metrics(image: image)
        )
    }
}

public enum LocalPrivacyDetector {
    /// These conservative literal cues provide early exclusion only.
    /// Absence of a cue is unknown and still requires semantic privacy analysis.
    public static func detect(lines: [String]) -> Finding {
        let joined = lines.joined(separator: "\n")
        let patterns = [
            #"(?:密码|口令|password|passcode)\s*[:：=]\s*\S{3,}"#,
            #"(?:身份证号|公民身份号码|证件号码)\s*[:：]?\s*[0-9Xx\s]{15,}"#,
            #"(?:银行卡号|银行账号|bank account)\s*[:：]?\s*[0-9\s-]{12,}"#,
            #"(?:个人手机号|私人电话|个人电话)\s*[:：]?\s*(?:\+?86\s*)?1[3-9][0-9\s-]{9,}"#,
            #"(?:家庭住址|居住地址|收货地址)\s*[:：]\s*\S{5,}"#
        ]
        for pattern in patterns {
            if joined.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil {
                return .present
            }
        }
        return .unknown
    }
}

public enum QualityAnalyzer {
    /// Metrics describe this preview only; no automatic quality rejection threshold is embedded.
    public static func metrics(image: CGImage) throws -> QualityMetrics {
        let width = image.width
        let height = image.height
        var gray = [UInt8](repeating: 0, count: width * height)
        try gray.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(
                data: bytes.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { throw AppleAnalysisError.graphicsContextFailed }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var pixels = gray.map { Float($0) / 255 }
        var edges = [Float](repeating: 0, count: pixels.count)
        let kernel: [Float] = [0, 1, 0, 1, -4, 1, 0, 1, 0]
        let error = pixels.withUnsafeMutableBytes { sourceBytes in
            edges.withUnsafeMutableBytes { destinationBytes in
                var source = vImage_Buffer(
                    data: sourceBytes.baseAddress!, height: vImagePixelCount(height),
                    width: vImagePixelCount(width), rowBytes: width * MemoryLayout<Float>.size
                )
                var destination = vImage_Buffer(
                    data: destinationBytes.baseAddress!, height: vImagePixelCount(height),
                    width: vImagePixelCount(width), rowBytes: width * MemoryLayout<Float>.size
                )
                return vImageConvolve_PlanarF(
                    &source, &destination, nil, 0, 0, kernel, 3, 3, 0,
                    vImage_Flags(kvImageEdgeExtend)
                )
            }
        }
        guard error == kvImageNoError else { throw AppleAnalysisError.graphicsContextFailed }
        var mean: Float = 0
        var meanSquare: Float = 0
        vDSP_meanv(edges, 1, &mean, vDSP_Length(edges.count))
        vDSP_measqv(edges, 1, &meanSquare, vDSP_Length(edges.count))
        let count = Float(gray.count)
        return QualityMetrics(
            laplacianVariance: max(0, meanSquare - mean * mean),
            darkFraction: Float(gray.filter { $0 <= 5 }.count) / count,
            brightFraction: Float(gray.filter { $0 >= 250 }.count) / count
        )
    }
}

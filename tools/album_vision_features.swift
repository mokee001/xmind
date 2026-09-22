// Extract public Apple Vision classification observations locally.
// This is not Apple Photos' private Memories engine or a face identity model.
import Foundation
import Vision
import ImageIO

struct Asset: Decodable { let id: String; let path: String }
struct Label: Encodable { let identifier: String; let confidence: Float }
struct Region: Encodable { let box: [Double]; let confidence: Float }
func region(_ observation: VNDetectedObjectObservation) -> Region {
    let b = observation.boundingBox
    return Region(box: [b.minX, 1-b.maxY, b.maxX, 1-b.minY], confidence: observation.confidence)
}
struct Result: Encodable {
    let id: String; let labels: [Label]; let faces: Int
    var face_regions: [Region] = []; var humans: [Region] = []
    let error: String?
}
let input = FileHandle.standardInput.readDataToEndOfFile()
let assets = try JSONDecoder().decode([Asset].self, from: input)
var results: [Result] = []
for asset in assets {
    let result: Result = autoreleasepool {
        do {
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: asset.path) as CFURL, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 640
                  ] as CFDictionary) else {
                return Result(id: asset.id, labels: [], faces: 0, error: "decode_failed")
            }
            let classify = VNClassifyImageRequest()
            classify.revision = VNClassifyImageRequestRevision1
            let faces = VNDetectFaceRectanglesRequest()
            faces.revision = VNDetectFaceRectanglesRequestRevision3
            let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
            try handler.perform([classify])
            // Preserve classification input; give distant/profile faces more pixels.
            guard let detail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1600
            ] as CFDictionary) else {
                return Result(id: asset.id, labels: [], faces: 0, error: "detail_decode_failed")
            }
            let humans = VNDetectHumanRectanglesRequest()
            humans.revision = VNDetectHumanRectanglesRequestRevision2
            humans.upperBodyOnly = true
            try VNImageRequestHandler(cgImage: detail, orientation: .up).perform([faces, humans])
            let observations = classify.results ?? []
            // Keep all scores so later theme tuning needn't rerun the model.
            return Result(id: asset.id, labels: observations.map { Label(identifier: $0.identifier, confidence: $0.confidence) },
                          faces: faces.results?.count ?? 0,
                          face_regions: (faces.results ?? []).map { region($0) },
                          humans: (humans.results ?? []).map { region($0) }, error: nil)
        } catch {
            return Result(id: asset.id, labels: [], faces: 0, error: "vision_failed")
        }
    }
    results.append(result)
}
let encoded = try JSONEncoder().encode(results)
FileHandle.standardOutput.write(encoded)

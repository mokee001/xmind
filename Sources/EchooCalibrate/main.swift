import Foundation
import CryptoKit
import ImageIO
import Vision
import EchooCore
import EchooApple
import EchooGateway

private struct SamplePhoto: Codable {
    let photoID, sourceName, sourcePath, previewFilename: String
    let width, height: Int
    let petConfidence: Float?
    let nativeStatus: String
}
private struct SampleManifest: Codable {
    let schemaVersion, libraryPath: String
    let photos: [SamplePhoto]
    let proposedIDs: [String]
    let nativeStatus: String
    let previewVersion: String?
    let unavailablePhotos: [UnavailablePhoto]?
    var targetPetPhotoID: String? = nil
    var targetPetGroup: String? = nil
    var targetProposalNativeStatus: String? = nil
}
private struct UnavailablePhoto: Codable {
    let photoID, sourceName, reason: String
}
private enum CalibrationError: Error { case invalidArguments, unsafeOutput, invalidSample, privateSample }

@main
struct EchooCalibrate {
    static let images = Set(["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "webp"])
    static func main() async {
        do { try await run(Array(CommandLine.arguments.dropFirst())) }
        catch { FileHandle.standardError.write(Data("Calibration failed: \(type(of: error))\n".utf8)); exit(1) }
    }
    static func write<T: Encodable>(_ object: T, to url: URL) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(object).write(to: url, options: .atomic)
    }
    static func folder(_ path: String, outside library: URL? = nil) throws -> URL {
        let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        if let library {
            let source = library.resolvingSymlinksInPath()
            guard url != source, !url.path.hasPrefix(source.path + "/") else { throw CalibrationError.unsafeOutput }
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return url
    }
    /// Native labels are hints for local review, never a species whitelist or admission gate.
    static func petHint(data: Data, animals: [VNClassificationObservation]) throws -> Float? {
        let request = VNClassifyImageRequest()
        try VNImageRequestHandler(data: data, options: [:]).perform([request])
        let terms: Set<String> = ["cat", "dog", "hamster", "parrot", "turtle", "tortoise", "goldfish",
            "bird", "fish", "rabbit", "rodent", "ferret", "guinea", "pet"]
        let classified = (request.results ?? []).filter {
            !Set($0.identifier.lowercased().components(separatedBy: CharacterSet.letters.inverted)).isDisjoint(with: terms)
        }
        return (animals + classified).map(\.confidence).max()
    }
    static func run(_ args: [String]) async throws {
        guard let command = args.first else { throw CalibrationError.invalidArguments }
        switch command {
        case "process-selected", "verify-plan", "render-reviewed", "render-auto", "render-background":
            try await ProcessingCommands.run(args)
        case "export-template", "propose-target-sample":
            try TemplateTools.run(args)
        case "prepare", "refresh-previews":
            guard args.count == 3 else { throw CalibrationError.invalidArguments }
            let library = URL(fileURLWithPath: args[1], isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
            let output = try folder(args[2], outside: library)
            let manifestURL = output.appendingPathComponent("manifest.json")
            if FileManager.default.fileExists(atPath: manifestURL.path) {
                guard command == "refresh-previews",
                      let previous = try? JSONDecoder().decode(SampleManifest.self, from: Data(contentsOf: manifestURL)),
                      URL(fileURLWithPath: previous.libraryPath).resolvingSymlinksInPath() == library else {
                    throw CalibrationError.unsafeOutput
                }
            }
            let previewFolderName = "previews-" + UUID().uuidString
            let previewFolder = try folder(output.appendingPathComponent(previewFolderName).path, outside: library)
            let files = try FileManager.default.contentsOfDirectory(at: library,
                includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: .skipsHiddenFiles)
                .filter { url in
                    let attrs = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                    return attrs?.isRegularFile == true && attrs?.isSymbolicLink != true && images.contains(url.pathExtension.lowercased())
                }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            var photos: [SamplePhoto] = [], unavailable: [UnavailablePhoto] = [], nativeAvailable = true
            for file in files {
                let id = SHA256.hash(data: Data(file.lastPathComponent.utf8)).map { String(format: "%02x", $0) }.joined()
                guard let preview = try? PreviewDecoder.from(url: file, maxPixel: 512) else {
                    unavailable.append(UnavailablePhoto(photoID: id, sourceName: file.lastPathComponent, reason: "previewDecodeUnavailable"))
                    continue
                }
                let name = id + ".jpg"
                try preview.jpeg.write(to: previewFolder.appendingPathComponent(name), options: .withoutOverwriting)
                var confidence: Float?
                if nativeAvailable {
                    do {
                        let request = VNRecognizeAnimalsRequest(); request.revision = VNRecognizeAnimalsRequestRevision2
                        try VNImageRequestHandler(data: preview.jpeg, options: [:]).perform([request])
                        confidence = try petHint(data: preview.jpeg, animals: (request.results ?? []).flatMap(\.labels))
                    } catch { nativeAvailable = false }
                }
                photos.append(SamplePhoto(photoID: id, sourceName: file.lastPathComponent, sourcePath: file.path,
                    previewFilename: previewFolderName + "/" + name, width: preview.width, height: preview.height,
                    petConfidence: confidence, nativeStatus: nativeAvailable ? "available" : "unavailable"))
                if photos.count % 50 == 0 { print("Prepared \(photos.count) local previews.") }
            }
            let pets = photos.filter { $0.petConfidence != nil }
            let count = min(20, pets.count)
            // Systematic spread over native pet candidates, not a quality/admission threshold.
            let proposed = count == 0 ? [] : (0..<count).map { pets[$0 * pets.count / count].photoID }
            try write(SampleManifest(schemaVersion: "echoo-calibration-samples-v3", libraryPath: library.path,
                photos: photos, proposedIDs: proposed, nativeStatus: nativeAvailable ? "available" : "unavailable",
                previewVersion: PreviewDecoder.revision, unavailablePhotos: unavailable), to: manifestURL)
            print("Prepared \(photos.count) verified local previews; \(unavailable.count) previews unavailable; \(proposed.count) coarse pet sample suggestions. No template filtering or API calls.")
        case "refresh-native":
            guard args.count == 2 else { throw CalibrationError.invalidArguments }
            let manifestURL = URL(fileURLWithPath: args[1])
            let manifest = try JSONDecoder().decode(SampleManifest.self, from: Data(contentsOf: manifestURL))
            guard manifest.previewVersion == PreviewDecoder.revision else { throw CalibrationError.invalidSample }
            var refreshed: [SamplePhoto] = [], available = true
            for photo in manifest.photos {
                var confidence: Float?
                if available {
                    do {
                        let data = try Data(contentsOf: manifestURL.deletingLastPathComponent().appendingPathComponent(photo.previewFilename))
                        let request = VNRecognizeAnimalsRequest(); request.revision = VNRecognizeAnimalsRequestRevision2
                        try VNImageRequestHandler(data: data, options: [:]).perform([request])
                        confidence = try petHint(data: data, animals: (request.results ?? []).flatMap(\.labels))
                    } catch { available = false }
                }
                refreshed.append(SamplePhoto(photoID: photo.photoID, sourceName: photo.sourceName, sourcePath: photo.sourcePath,
                    previewFilename: photo.previewFilename, width: photo.width, height: photo.height,
                    petConfidence: confidence, nativeStatus: available ? "available" : "unavailable"))
            }
            let pets = refreshed.filter { $0.petConfidence != nil }, count = min(20, refreshed.filter { $0.petConfidence != nil }.count)
            let proposed = count == 0 ? [] : (0..<count).map { pets[$0 * pets.count / count].photoID }
            try write(SampleManifest(schemaVersion: "echoo-calibration-samples-v3", libraryPath: manifest.libraryPath,
                photos: refreshed, proposedIDs: proposed, nativeStatus: available ? "available" : "unavailable",
                previewVersion: manifest.previewVersion, unavailablePhotos: manifest.unavailablePhotos,
                targetPetPhotoID: manifest.targetPetPhotoID, targetPetGroup: manifest.targetPetGroup,
                targetProposalNativeStatus: manifest.targetProposalNativeStatus), to: manifestURL)
            print("Native pet candidates refreshed; \(proposed.count) proposed samples.")
        case "previews":
            guard args.count == 4 else { throw CalibrationError.invalidArguments }
            let manifest = try JSONDecoder().decode(SampleManifest.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
            guard manifest.previewVersion == PreviewDecoder.revision else { throw CalibrationError.invalidSample }
            let ids = try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
            guard (0...20).contains(ids.count), Set(ids).count == ids.count else { throw CalibrationError.invalidSample }
            let output = try folder(args[3], outside: URL(fileURLWithPath: manifest.libraryPath))
            let byID = Dictionary(uniqueKeysWithValues: manifest.photos.map { ($0.photoID, $0) })
            // Match the gateway's existing aggregate transport cap for all 1...20 samples.
            let perPhotoBudget = (6 * 1024 * 1024) / max(1, ids.count)
            var photos: [[String: Any]] = []
            for id in ids {
                guard let photo = byID[id] else { throw CalibrationError.invalidSample }
                let preview = try PreviewDecoder.from(url: URL(fileURLWithPath: photo.sourcePath),
                    maxPixel: 1536, maxJPEGBytes: perPhotoBudget)
                let native = try? await AppleNativeAnalyzer().analyze(preview)
                if native?.privacyFinding == .present { throw CalibrationError.privateSample }
                let digest = SHA256.hash(data: preview.jpeg).map { String(format: "%02x", $0) }.joined()
                try preview.jpeg.write(to: output.appendingPathComponent(id + ".jpg"), options: .atomic)
                photos.append(["photoID": id, "width": preview.width, "height": preview.height,
                    "contentDigest": digest, "jpegBase64": preview.jpeg.base64EncodedString(),
                    "nativePrivacyFinding": native?.privacyFinding.rawValue ?? "unknown"])
            }
            // Human review of these detailed previews is required before calibration transmission.
            let payload: [String: Any] = ["schemaVersion": "echoo-blue-sky-v1", "templateVersion": BlueSkySelector.version,
                "policyVersion": PhotoPolicy().version, "mode": "calibration", "sampleReviewed": false,
                "requestID": UUID().uuidString, "photos": photos]
            try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
                .write(to: output.appendingPathComponent("input.json"), options: .atomic)
            print("Detailed previews prepared; awaiting local sample review.")
        case "plan":
            guard args.count == 4 || args.count == 5 else { throw CalibrationError.invalidArguments }
            let requestData = try Data(contentsOf: URL(fileURLWithPath: args[1]))
            let request = try JSONSerialization.jsonObject(with: requestData) as! [String: Any]
            let photos = request["photos"] as! [[String: Any]]
            let digests = Dictionary(uniqueKeysWithValues: photos.map { ($0["photoID"] as! String, $0["contentDigest"] as! String) })
            let evidence = try HTTPBlueSkyGateway.decodeResponse(Data(contentsOf: URL(fileURLWithPath: args[2])),
                requestID: request["requestID"] as! String, digests: digests)
            var excluded: [BlueSkySlot: Set<String>] = [:]
            if args.count == 5 {
                let values = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: URL(fileURLWithPath: args[4])))
                for (key, ids) in values {
                    guard let slot = BlueSkySlot(rawValue: key) else { throw CalibrationError.invalidArguments }
                    excluded[slot] = Set(ids)
                }
            }
            let plan = try BlueSkySelector.select(photoIDs: photos.map { $0["photoID"] as! String },
                evaluations: evidence.evaluations, identities: evidence.identity, excludingFromSlots: excluded,
                requiredPetPhotoID: request["targetPetPhotoID"] as? String)
            try write(plan, to: URL(fileURLWithPath: args[3]))
        case "cutouts":
            guard args.count == 4 else { throw CalibrationError.invalidArguments }
            let manifest = try JSONDecoder().decode(SampleManifest.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
            guard manifest.previewVersion == PreviewDecoder.revision else { throw CalibrationError.invalidSample }
            let plan = try JSONDecoder().decode(BlueSkyPlan.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
            let output = try folder(args[3], outside: URL(fileURLWithPath: manifest.libraryPath))
            let byID = Dictionary(uniqueKeysWithValues: manifest.photos.map { ($0.photoID, $0) })
            var records: [[String: Any]] = []
            for selected in plan.selections {
                guard let photo = byID[selected.photoID] else { throw CalibrationError.invalidSample }
                let destination = output.appendingPathComponent(selected.photoID + ".png")
                do {
                    if !FileManager.default.fileExists(atPath: destination.path) {
                        let preview = try PreviewDecoder.from(url: URL(fileURLWithPath: photo.sourcePath), maxPixel: 4096)
                        let cutout = try ApplePetCutout.extract(preview)
                        try cutout.png.write(to: destination, options: .withoutOverwriting)
                    }
                    records.append(["slot": selected.slot.rawValue, "photoID": selected.photoID,
                        "state": "awaitingHumanVerification", "filename": destination.lastPathComponent])
                } catch {
                    records.append(["slot": selected.slot.rawValue, "photoID": selected.photoID,
                        "state": "extractionUnavailable"])
                }
            }
            try JSONSerialization.data(withJSONObject: records, options: [.prettyPrinted, .sortedKeys])
                .write(to: output.appendingPathComponent("cutouts.json"), options: .atomic)
        default: throw CalibrationError.invalidArguments
        }
    }
}

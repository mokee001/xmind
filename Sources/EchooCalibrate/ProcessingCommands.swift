import Foundation
import CryptoKit
import EchooCore
import EchooApple
import EchooGateway

enum ProcessingError: Error { case invalidArguments, invalidInput, unsafeOutput, unreviewed }

enum ProcessingCommands {
    static func json(_ url: URL) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw ProcessingError.invalidInput }
        return value
    }
    static func write(_ value: Any, _ url: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    static func folder(_ path: String, outside source: String? = nil) throws -> URL {
        let output = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        if let source {
            let root = URL(fileURLWithPath: source).standardizedFileURL.resolvingSymlinksInPath()
            guard output != root, !output.path.hasPrefix(root.path + "/") else { throw ProcessingError.unsafeOutput }
        }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return output
    }
    static func requestDigests(_ request: [String: Any]) throws -> [String: CutoutImageDigests] {
        guard let photos = request["photos"] as? [[String: Any]] else { throw ProcessingError.invalidInput }
        var result: [String: CutoutImageDigests] = [:]
        for photo in photos {
            guard let id = photo["photoID"] as? String, result[id] == nil,
                  let original = photo["originalDigest"] as? String, let masked = photo["maskedDigest"] as? String,
                  let cutout = photo["cutoutDigest"] as? String else { throw ProcessingError.invalidInput }
            result[id] = .init(original: original, masked: masked, cutout: cutout)
        }
        return result
    }
    static func run(_ args: [String]) async throws {
        guard let command = args.first else { throw ProcessingError.invalidArguments }
        switch command {
        case "render-background":
            guard args.count == 2 else { throw ProcessingError.invalidArguments }
            let destination = URL(fileURLWithPath: args[1]).standardizedFileURL.resolvingSymlinksInPath()
            guard destination.pathExtension.lowercased() == "png" else { throw ProcessingError.invalidArguments }
            _ = try folder(destination.deletingLastPathComponent().path)
            let plan = try BlueSkySelector.select(photoIDs: [], evaluations: [], identities: [])
            let artwork = try BlueSkyRenderer().renderVerified(plan: plan, cutouts: [:], evidence: [])
            try artwork.imageData.write(to: destination, options: .withoutOverwriting)
        case "process-selected":
            guard args.count == 4 else { throw ProcessingError.invalidArguments }
            let manifest = try json(URL(fileURLWithPath: args[1]))
            let plan = try JSONDecoder().decode(BlueSkyPlan.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
            guard let library = manifest["libraryPath"] as? String, let photos = manifest["photos"] as? [[String: Any]],
                  plan.state == .selected, plan.selections.count <= 5,
                  Set(plan.selections.map(\.slot)) == Set(plan.visibleSlots),
                  Set(plan.selections.map(\.photoID)).count == plan.selections.count else { throw ProcessingError.invalidInput }
            let output = try folder(args[3], outside: library)
            try write(["libraryPath": library, "revision": ApplePetCutout.revision], output.appendingPathComponent("processing-context.json"))
            var records: [[String: Any]] = [], inputs: [[String: Any]] = []
            for selected in plan.selections {
                guard let source = photos.first(where: { $0["photoID"] as? String == selected.photoID }),
                      let path = source["sourcePath"] as? String else { throw ProcessingError.invalidInput }
                let url = URL(fileURLWithPath: path)
                let root = URL(fileURLWithPath: library).resolvingSymlinksInPath().path + "/"
                guard url.resolvingSymlinksInPath().path.hasPrefix(root) else { throw ProcessingError.invalidInput }
                let name = selected.photoID
                let receipt = output.appendingPathComponent(name + ".inspection.json")
                let attributes = try FileManager.default.attributesOfItem(atPath: path)
                let stamp = "\(attributes[.size] ?? ""):\(attributes[.modificationDate] ?? "")"
                do {
                    var item: [String: Any]
                    if let cached = try? json(receipt), cached["revision"] as? String == ApplePetCutout.revision,
                       cached["sourceStamp"] as? String == stamp,
                       let request = cached["request"] as? [String: Any],
                       let data = try? Data(contentsOf: output.appendingPathComponent(name + ".png")),
                       request["cutoutDigest"] as? String == hash(data) {
                        item = cached
                    } else {
                        let original = try PreviewDecoder.from(url: url, maxPixel: 4096)
                        let cutout = try ApplePetCutout.extract(original)
                        let inspection = cutout.inspection
                        let privacy = try? await AppleNativeAnalyzer().analyze(inspection.original)
                        guard privacy?.privacyFinding != .present else { throw ProcessingError.unreviewed }
                        try cutout.png.write(to: output.appendingPathComponent(name + ".png"), options: .atomic)
                        var request: [String: Any] = ["photoID": name, "cutoutDigest": hash(cutout.png),
                            "nativePrivacyFinding": privacy?.privacyFinding.rawValue ?? "unknown"]
                        for (prefix, preview) in [("original", inspection.original), ("masked", inspection.masked)] {
                            try preview.jpeg.write(to: output.appendingPathComponent(name + "." + prefix + ".jpg"), options: .atomic)
                            request[prefix + "JPEGBase64"] = preview.jpeg.base64EncodedString()
                            request[prefix + "Digest"] = hash(preview.jpeg)
                            request[prefix + "Width"] = preview.width; request[prefix + "Height"] = preview.height
                        }
                        let bounds = inspection.sourceBounds
                        item = ["revision": ApplePetCutout.revision, "sourceStamp": stamp, "request": request,
                            "sourceWidth": original.width, "sourceHeight": original.height,
                            "sourceBounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height],
                            "edgeContactPixels": inspection.edgeContactPixels]
                        try write(item, receipt)
                    }
                    guard let request = item["request"] as? [String: Any] else { throw ProcessingError.invalidInput }
                    inputs.append(request)
                    records.append(["slot": selected.slot.rawValue, "photoID": name,
                        "state": "awaitingAutomaticVerification", "filename": name + ".png",
                        "edgeContactPixels": item["edgeContactPixels"] ?? [:]])
                } catch {
                    records.append(["slot": selected.slot.rawValue, "photoID": name, "state": "extractionUnavailable"])
                }
            }
            try write(records, output.appendingPathComponent("cutouts.json"))
            try write(["schemaVersion": "echoo-blue-sky-cutout-v1", "verificationVersion": BlueSkyCutoutVerifier.version,
                "policyVersion": PhotoPolicy().version, "requestID": UUID().uuidString,
                "mode": "calibration", "sampleReviewed": false, "photos": inputs], output.appendingPathComponent("verification-input.json"))
        case "verify-plan":
            guard args.count == 5 else { throw ProcessingError.invalidArguments }
            let plan = try JSONDecoder().decode(BlueSkyPlan.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
            let request = try json(URL(fileURLWithPath: args[2]))
            guard let requestID = request["requestID"] as? String else { throw ProcessingError.invalidInput }
            let digests = try requestDigests(request)
            let evidence = try HTTPCutoutVerificationGateway.decodeResponse(Data(contentsOf: URL(fileURLWithPath: args[3])), requestID: requestID, digests: digests)
            let byID = Dictionary(uniqueKeysWithValues: evidence.evaluations.map { ($0.photoID, $0) })
            let encoder = JSONEncoder()
            var verdicts: [[String: Any]] = []
            for selected in plan.selections {
                let verdict = BlueSkyCutoutVerifier.verdict(byID[selected.photoID], photoID: selected.photoID,
                    slot: selected.slot, cutoutDigest: digests[selected.photoID]?.cutout ?? "")
                var value = try JSONSerialization.jsonObject(with: encoder.encode(verdict)) as! [String: Any]
                value["photoID"] = selected.photoID; value["slot"] = selected.slot.rawValue; verdicts.append(value)
            }
            try write(["verdicts": verdicts, "allPassed": verdicts.count == plan.selections.count && verdicts.allSatisfy { $0["state"] as? String == "passed" }], URL(fileURLWithPath: args[4]))
        case "render-reviewed":
            guard args.count == 3 || (args.count == 4 && args[3] == "--single-preview") else { throw ProcessingError.invalidArguments }
            let reportURL = URL(fileURLWithPath: args[1]), report = try json(reportURL)
            guard report["cutoutsVerified"] as? Bool == true,
                  let rawPlan = report["plan"], let records = report["cutouts"] as? [[String: Any]],
                  let reviews = report["cutoutReview"] as? [String: String] else { throw ProcessingError.unreviewed }
            let plan = try decode(BlueSkyPlan.self, rawPlan)
            var images: [String: Data] = [:], confirmed: [BlueSkySlot: String] = [:]
            for selected in plan.selections {
                guard reviews[selected.photoID] == "pass",
                      records.contains(where: { $0["photoID"] as? String == selected.photoID && $0["slot"] as? String == selected.slot.rawValue && $0["filename"] as? String == selected.photoID + ".png" }) else {
                    throw ProcessingError.unreviewed
                }
                images[selected.photoID] = try Data(contentsOf: reportURL.deletingLastPathComponent().appendingPathComponent("cutouts/" + selected.photoID + ".png"))
                confirmed[selected.slot] = selected.photoID
            }
            let manifestURL = reportURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("manifest.json")
            guard let library = try json(manifestURL)["libraryPath"] as? String else { throw ProcessingError.invalidInput }
            let output = try folder(args[2], outside: library)
            let renderer = try BlueSkyRenderer()
            let variants: [(String, Double, Bool)] = args.count == 4 ? [("artwork", 1, false)] :
                [("artwork", 1, false), ("artwork-thin", 0.75, false), ("artwork-bold", 1.25, false), ("layout-debug", 1, true)]
            for (name, scale, debug) in variants {
                let artwork = try renderer.renderReviewedCalibration(plan: plan, cutouts: images, confirmed: confirmed,
                    options: .init(outlineScale: scale, showSlotBounds: debug))
                try artwork.imageData.write(to: output.appendingPathComponent(name + ".png"), options: .withoutOverwriting)
            }
            let strokes = Dictionary(uniqueKeysWithValues: BlueSkySlot.allCases.map { ($0.rawValue, BlueSkyOutlineStyle.strokes(for: $0)) })
            let style = try JSONSerialization.jsonObject(with: JSONEncoder().encode(strokes))
            let placements = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BlueSkyLayout.placements))
            try write(["mode": "humanReviewedCalibration", "productionReady": false,
                "outlineParametersConfirmed": BlueSkyTemplateRelease.outlineParametersApproved,
                "templateVisualApproved": BlueSkyTemplateRelease.visualApproved, "templateRelease": BlueSkyTemplateRelease.version,
                "layoutVersion": BlueSkyLayout.version, "width": 1800, "height": 2400,
                "layoutPlacements": placements,
                "slotSizes": Dictionary(uniqueKeysWithValues: BlueSkySlot.allCases.map { ($0.rawValue, $0.side) }),
                "selectionStrategyVersion": plan.strategyVersion ?? "historical-plan",
                "outlineVersion": BlueSkyOutlineStyle.version, "outlineStrokes": style,
                "selectedPhotoIDs": plan.selections.map(\.photoID), "sourceRun": reportURL.deletingLastPathComponent().lastPathComponent,
                "cutoutDigests": images.mapValues { hash($0) }, "mirrored": false,
                "apiCalledForThisPreview": false, "segmentationRepeatedForThisPreview": false], output.appendingPathComponent("render.json"))
        case "render-auto":
            guard args.count == 5 else { throw ProcessingError.invalidArguments }
            let plan = try JSONDecoder().decode(BlueSkyPlan.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
            let folder = URL(fileURLWithPath: args[2])
            guard let library = try json(folder.appendingPathComponent("processing-context.json"))["libraryPath"] as? String else {
                throw ProcessingError.invalidInput
            }
            let destination = URL(fileURLWithPath: args[4]).standardizedFileURL.resolvingSymlinksInPath()
            _ = try Self.folder(destination.deletingLastPathComponent().path, outside: library)
            let request = try json(folder.appendingPathComponent("verification-input.json"))
            guard let requestID = request["requestID"] as? String else { throw ProcessingError.invalidInput }
            let evidence = try HTTPCutoutVerificationGateway.decodeResponse(Data(contentsOf: URL(fileURLWithPath: args[3])),
                requestID: requestID, digests: requestDigests(request))
            var images: [String: Data] = [:]
            for selected in plan.selections { images[selected.photoID] = try Data(contentsOf: folder.appendingPathComponent(selected.photoID + ".png")) }
            let artwork = try BlueSkyRenderer().renderVerified(plan: plan, cutouts: images, evidence: evidence.evaluations)
            try artwork.imageData.write(to: destination, options: .withoutOverwriting)
        default: throw ProcessingError.invalidArguments
        }
    }
}

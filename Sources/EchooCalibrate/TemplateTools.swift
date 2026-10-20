import Foundation
import CryptoKit
import Vision
import EchooCore
import EchooApple

enum TemplateTools {
    static func run(_ args: [String]) throws {
        switch args.first {
        case "export-template":
            guard args.count == 2, BlueSkyTemplateRelease.visualApproved else { throw ProcessingError.invalidArguments }
            let output = try ProcessingCommands.folder(args[1])
            guard try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty else { throw ProcessingError.unsafeOutput }
            let placements = Dictionary(uniqueKeysWithValues: BlueSkyLayout.placements.map { ($0.slot, $0) })
            let slots: [[String: Any]] = BlueSkySlot.allCases.map { slot in
                let p = placements[slot]!
                return ["id": slot.rawValue, "side": slot.side, "centerX": p.centerX, "centerY": p.centerY,
                        "clockwiseDegrees": p.clockwiseDegrees, "requirements": slot.requirements,
                        "preferredFacts": slot.preferredFacts, "posePreferences": slot.posePreferences,
                        "compositionPreferences": slot.compositionPreferences, "unknownPreference": "no-bonus-remains-eligible"]
            }
            let layers: [[String: Any]] = BlueSkyLayout.layers.map { layer in
                switch layer {
                case let .photo(slot): return ["kind": "photo", "slot": slot.rawValue]
                case let .asset(name, x, y, width, height):
                    return ["kind": "asset", "asset": name + ".png", "x": x, "y": y,
                            "width": width, "height": height, "fit": "aspectFill"]
                }
            }
            let styles = Dictionary(uniqueKeysWithValues: BlueSkySlot.allCases.map { ($0.rawValue, BlueSkyOutlineStyle.strokes(for: $0)) })
            let rawStyles = try JSONSerialization.jsonObject(with: JSONEncoder().encode(styles))
            let weights = Dictionary(uniqueKeysWithValues: BlueSkyDimension.allCases.map { ($0.rawValue, $0.weight) })
            let config: [String: Any] = [
                "schemaVersion": "echoo-template-archive-v1", "templateID": "pets.blue-sky-green-field",
                "name": "蓝天绿地拼贴", "releaseVersion": BlueSkyTemplateRelease.version,
                "visualApproval": ["approved": true, "date": BlueSkyTemplateRelease.visualApprovalDate,
                    "source": "human-user-confirmation", "statement": BlueSkyTemplateRelease.approvalStatement],
                "productionReady": false, "automationValidation": "real-post-cutout-api-test-pending",
                "supportedSubject": "common-pet", "theme": "pets", "uniquePhotoCount": 5, "minimumPhotoCount": 0,
                "supportedSpeciesExamples": ["cat", "dog", "hamster", "parrot", "turtle", "goldfish"],
                "speciesExamplesAreExhaustive": false, "generationRulesVersion": BlueSkySelector.generationRulesVersion,
                "selection": ["version": BlueSkySelector.strategyVersion, "evidenceVersion": BlueSkySelector.version,
                    "facts": BlueSkySelector.factKeys,
                    "ratingRange": [1, 5], "unknownRating": "null", "weights": weights,
                    "objectiveOrder": ["requiredFacts", "maximumPosePreferenceCount", "maximumCompositionPreferenceCount", "maximumTotalKnownScore", "stablePhotoID"],
                    "preferenceWeight": "one-per-confirmed-applicable-fact-within-priority-tier", "unknownPreference": "no-bonus-remains-eligible",
                    "identity": "every-selected-photo-pair-explicit-same-individual-pet", "targetPet": "optional-direct-same-as-reference",
                    "generalScoreCutoff": NSNull(), "mirroring": false,
                    "failureFallback": "exclude-photo-slot-reselect-ordered-hide-zero-photo-background"],
                "fallback": ["hideOrder": BlueSkyFallback.hideOrder.map(\.rawValue), "minimumUserPhotoCount": 0,
                    "zeroPhotoOutput": "template-background-and-fixed-decorations", "reflowRemainingSlots": false],
                "layout": ["version": BlueSkyLayout.version, "width": BlueSkyLayout.width, "height": BlueSkyLayout.height,
                    "slots": slots, "layersBackToFront": layers, "coordinates": "top-left-design-pixels",
                    "contentFit": "tight-completed-cutout-including-outline-uniform-long-edge-fit-centered",
                    "clipAtSlot": false, "clipAtCanvas": true],
                "outlines": ["version": BlueSkyOutlineStyle.version, "lineCap": "round", "lineJoin": "round",
                    "dashPhase": 0, "offsetMeaning": "subject-silhouette-to-stroke-centerline", "strokesBackToFront": rawStyles],
                "processing": ["extractOnlySelected": true, "nativeRevision": ApplePetCutout.revision,
                    "qualityCheckVersion": BlueSkyCutoutVerifier.version, "qualityFacts": BlueSkyCutoutVerifier.factKeys,
                    "compareInSourceCoordinates": true, "unknownCannotPass": true,
                    "requiredQualityFacts": BlueSkyCutoutVerifier.common, "sourceEdgeFactsArePreferences": true,
                    "runtimeDependencies": ["Apple ImageIO", "Apple Vision", "Apple CoreGraphics", "model API via backend"]]
            ]
            try ProcessingCommands.write(config, output.appendingPathComponent("template.json"))
            let resources = try BlueSkyRenderer().assetDirectory
            let assetFolder = output.appendingPathComponent("assets")
            try FileManager.default.createDirectory(at: assetFolder, withIntermediateDirectories: false)
            for name in ["background.png", "star.png", "poetry.png", "lines.png", "bubble.png", "grid.png", "assets.json"] {
                try FileManager.default.copyItem(at: resources.appendingPathComponent(name), to: assetFolder.appendingPathComponent(name))
            }
            print("Template parameters and six original assets exported; no source photos or credentials.")
        case "propose-target-sample":
            guard args.count == 5 else { throw ProcessingError.invalidArguments }
            let manifestURL = URL(fileURLWithPath: args[1])
            let manifest = try ProcessingCommands.json(manifestURL)
            guard let library = manifest["libraryPath"] as? String, let photos = manifest["photos"] as? [[String: Any]],
                  photos.contains(where: { $0["photoID"] as? String == args[2] }) else { throw ProcessingError.invalidInput }
            let excluded = Set(try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: args[3]))))
            guard !excluded.contains(args[2]) else { throw ProcessingError.invalidInput }
            let output = try ProcessingCommands.folder(args[4], outside: library)
            let root = manifestURL.deletingLastPathComponent().resolvingSymlinksInPath()
            func feature(_ id: String) throws -> VNFeaturePrintObservation {
                guard let record = photos.first(where: { $0["photoID"] as? String == id }),
                      let filename = record["previewFilename"] as? String else { throw ProcessingError.invalidInput }
                let url = root.appendingPathComponent(filename).resolvingSymlinksInPath()
                guard url.path.hasPrefix(root.path + "/") else { throw ProcessingError.invalidInput }
                let request = VNGenerateImageFeaturePrintRequest()
                request.imageCropAndScaleOption = .scaleFit
                try VNImageRequestHandler(data: Data(contentsOf: url), options: [:]).perform([request])
                guard let observation = request.results?.first else { throw ProcessingError.invalidInput }
                return observation
            }
            let ids = photos.compactMap { photo -> String? in
                guard let id = photo["photoID"] as? String, !excluded.contains(id),
                      (photo["petConfidence"] as? NSNumber ?? photo["catConfidence"] as? NSNumber) != nil else { return nil }
                return id
            }.filter { $0 != args[2] }
            var rankings: [(String, Float)] = [], unavailable = 0, nativeAvailable = true
            do {
                let reference = try feature(args[2])
                for id in ids {
                    do {
                        var distance: Float = 0
                        try feature(id).computeDistance(&distance, to: reference)
                        guard distance.isFinite, distance >= 0 else { throw ProcessingError.invalidInput }
                        rankings.append((id, distance))
                    } catch { unavailable += 1 }
                }
            } catch { nativeAvailable = false; unavailable = ids.count }
            rankings.sort { $0.1 == $1.1 ? $0.0 < $1.0 : $0.1 < $1.1 }
            let result: [String: Any] = ["targetPetPhotoID": args[2], "nativeStatus": nativeAvailable ? "available" : "unavailable",
                "proposedIDs": [args[2]] + rankings.prefix(19).map(\.0), "candidateCount": ids.count + 1,
                "unavailableCount": unavailable, "identityAssigned": false,
                "purpose": "relative-similarity-sample-proposal-only-no-admission-or-identity-labels",
                "rankings": rankings.map { ["photoID": $0.0, "distance": $0.1] as [String: Any] }]
            try ProcessingCommands.write(result, output.appendingPathComponent("target-proposal.json"))
            print("Target sample proposal saved; native similarity available: \(nativeAvailable); no identity labels or API calls.")
        default: throw ProcessingError.invalidArguments
        }
    }
}

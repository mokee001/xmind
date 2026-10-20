import Foundation
import CryptoKit
import EchooCore

public struct BlueSkyGatewayPhoto: Sendable {
    public let photoID: String
    public let preview: AnalysisPreview
    public let nativePrivacyFinding: Finding
    public init(photoID: String, preview: AnalysisPreview, nativePrivacyFinding: Finding) {
        self.photoID = photoID; self.preview = preview; self.nativePrivacyFinding = nativePrivacyFinding
    }
}
public struct BlueSkyBatchEvidence: Codable, Sendable {
    public let schemaVersion: String
    public let templateVersion: String
    public let policyVersion: String
    public let requestID: String
    public let photoDigests: [String: String]
    public let evaluations: [BlueSkyPhotoEvaluation]
    public let identity: [PetIdentityEvidence]
}

/// Production entry requires the upstream admitted pet results. Calibration is a separate explicit mode.
public struct HTTPBlueSkyGateway: Sendable {
    private let endpoint: URL
    private let session: URLSession
    private let token: @Sendable () async throws -> String
    public init(baseURL: URL, session: URLSession = .shared, allowLocalHTTP: Bool = false,
                sessionToken: @escaping @Sendable () async throws -> String) throws {
        let local = ["127.0.0.1", "localhost", "::1"].contains(baseURL.host ?? "")
        guard baseURL.scheme == "https" || (allowLocalHTTP && local && baseURL.scheme == "http") else {
            throw GatewayError.insecureEndpoint
        }
        endpoint = baseURL.appendingPathComponent("v1/templates/blue-sky/evaluate")
        self.session = session; self.token = sessionToken
    }

    public func evaluate(photos: [BlueSkyGatewayPhoto], admittedResults: [PhotoAnalysisResult]) async throws -> BlueSkyBatchEvidence {
        guard Set(admittedResults.map { $0.admission.photoID }).count == admittedResults.count else { throw GatewayError.invalidPreview }
        let approved = Dictionary(uniqueKeysWithValues: admittedResults.map { ($0.admission.photoID, $0) })
        guard photos.allSatisfy({ photo in
            guard let result = approved[photo.photoID] else { return false }
            return result.admission.state == .passed && result.assignment.photoID == photo.photoID &&
                result.assignment.themes.contains(.pets) && result.admission.policyVersion == PhotoPolicy().version
        }) else { throw GatewayError.invalidPreview }
        return try await send(photos, mode: "production")
    }

    /// Human review authorizes this local sample only; it does not admit or relabel library photos.
    public func evaluateReviewedCalibrationSample(photos: [BlueSkyGatewayPhoto]) async throws -> BlueSkyBatchEvidence {
        try await send(photos, mode: "calibration")
    }

    private func send(_ photos: [BlueSkyGatewayPhoto], mode: String) async throws -> BlueSkyBatchEvidence {
        if photos.isEmpty {
            return .init(schemaVersion: "echoo-blue-sky-v1", templateVersion: BlueSkySelector.version,
                policyVersion: PhotoPolicy().version, requestID: UUID().uuidString,
                photoDigests: [:], evaluations: [], identity: [])
        }
        guard (1...20).contains(photos.count), Set(photos.map(\.photoID)).count == photos.count,
              photos.allSatisfy({ $0.nativePrivacyFinding != .present &&
                  $0.preview.width > 0 && $0.preview.height > 0 && max($0.preview.width, $0.preview.height) <= 4096 }),
              photos.reduce(0, { $0 + $1.preview.jpeg.count }) <= 6 * 1024 * 1024 else { throw GatewayError.invalidPreview }
        let requestID = UUID().uuidString
        let digests = Dictionary(uniqueKeysWithValues: photos.map { photo in
            (photo.photoID, SHA256.hash(data: photo.preview.jpeg).map { String(format: "%02x", $0) }.joined())
        })
        let body = BlueSkyRequest(schemaVersion: "echoo-blue-sky-v1", templateVersion: BlueSkySelector.version,
            policyVersion: PhotoPolicy().version, requestID: requestID, mode: mode, sampleReviewed: mode == "calibration",
            photos: photos.map { BlueSkyRequest.Photo(photoID: $0.photoID, jpegBase64: $0.preview.jpeg.base64EncodedString(),
                contentDigest: digests[$0.photoID]!, width: $0.preview.width, height: $0.preview.height,
                nativePrivacyFinding: $0.nativePrivacyFinding, admissionState: mode == "production" ? "passed" : nil,
                themes: mode == "production" ? ["pets"] : nil) })
        var request = URLRequest(url: endpoint)
        // Two streamed stages; each checks a 240s deadline between reads (120s idle bound).
        request.httpMethod = "POST"; request.timeoutInterval = 780
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayError.invalidResponse }
        guard http.statusCode == 200 else { throw GatewayError.httpFailure(http.statusCode) }
        return try Self.decodeResponse(data, requestID: requestID, digests: digests)
    }

    public static func decodeResponse(_ data: Data, requestID: String, digests: [String: String]) throws -> BlueSkyBatchEvidence {
        guard data.count <= 256 * 1024 else { throw GatewayError.invalidResponse }
        let body = try JSONDecoder().decode(BlueSkyBatchEvidence.self, from: data)
        guard body.schemaVersion == "echoo-blue-sky-v1", body.templateVersion == BlueSkySelector.version,
              body.policyVersion == PhotoPolicy().version, body.requestID == requestID, body.photoDigests == digests,
              body.evaluations.count == digests.count, Set(body.evaluations.map(\.photoID)) == Set(digests.keys),
              body.evaluations.allSatisfy({ photo in
                  guard let notApplicable = photo.notApplicablePreferences,
                        Set(notApplicable).count == notApplicable.count,
                        Set(notApplicable).isSubset(of: ["curled", "frontStandingOrSitting", "halfBodyCloseUp"]),
                        notApplicable.allSatisfy({ photo.facts[$0] == .absent }) else { return false }
                  return !(photo.provenance.isEmpty) && Set(photo.facts.keys) == Set(BlueSkySelector.factKeys) &&
                  Set(photo.scores.keys) == Set(BlueSkyDimension.allCases.map(\.rawValue)) &&
                  photo.scores.allSatisfy { key, score in
                      guard let allowed = Self.reasons[key], allowed.contains(score.reason),
                            (score.value == nil) == (score.reason == "unresolved") else { return false }
                      return score.value == nil || (1...5).contains(score.value!)
                  } }),
              body.identity.count == digests.count * (digests.count - 1) / 2,
              body.identity.allSatisfy({ !$0.provenance.isEmpty }) else { throw GatewayError.invalidResponse }
        _ = try BlueSkySelector.select(photoIDs: Array(digests.keys), evaluations: body.evaluations, identities: body.identity)
        return body
    }
    private static let reasons: [String: Set<String>] = [
        "sharpness": ["detailed", "adequate", "blurred", "resolutionUncertain", "unresolved"],
        "exposure": ["balanced", "minorLoss", "subjectDetailLost", "unresolved"],
        "colorNaturalness": ["natural", "lightingMood", "strongCast", "overprocessed", "unresolved"],
        "cutoutFeasibility": ["separated", "complexBoundary", "occluded", "unresolved"],
        "expression": ["engaging", "calmAppeal", "neutral", "obscured", "unresolved"],
        "lifelikeness": ["spontaneous", "interaction", "posed", "weakContext", "unresolved"],
        "interest": ["distinctiveAction", "playfulInteraction", "quietMoment", "ordinary", "unresolved"]
    ]
}

private struct BlueSkyRequest: Encodable {
    let schemaVersion, templateVersion, policyVersion, requestID, mode: String
    let sampleReviewed: Bool
    let photos: [Photo]
    struct Photo: Encodable {
        let photoID, jpegBase64, contentDigest: String
        let width, height: Int
        let nativePrivacyFinding: Finding
        let admissionState: String?
        let themes: [String]?
    }
}

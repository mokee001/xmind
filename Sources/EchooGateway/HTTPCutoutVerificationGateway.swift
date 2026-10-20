import Foundation
import CryptoKit
import EchooCore

public struct BlueSkyCutoutPhoto: Sendable {
    public let photoID: String
    public let original, masked: AnalysisPreview
    public let cutoutPNG: Data
    public let nativePrivacyFinding: Finding
    public init(photoID: String, original: AnalysisPreview, masked: AnalysisPreview,
                cutoutPNG: Data, nativePrivacyFinding: Finding) {
        self.photoID = photoID; self.original = original; self.masked = masked
        self.cutoutPNG = cutoutPNG; self.nativePrivacyFinding = nativePrivacyFinding
    }
}
public struct CutoutImageDigests: Codable, Equatable, Sendable {
    public let original, masked, cutout: String
    public init(original: String, masked: String, cutout: String) {
        self.original = original; self.masked = masked; self.cutout = cutout
    }
}
public struct BlueSkyCutoutEvidence: Codable, Sendable {
    public let schemaVersion, verificationVersion, policyVersion, requestID: String
    public let photoDigests: [String: CutoutImageDigests]
    public let evaluations: [BlueSkyCutoutEvaluation]
}

public struct HTTPCutoutVerificationGateway: Sendable {
    private let endpoint: URL
    private let session: URLSession
    private let token: @Sendable () async throws -> String
    public init(baseURL: URL, session: URLSession = .shared, allowLocalHTTP: Bool = false,
                sessionToken: @escaping @Sendable () async throws -> String) throws {
        let local = ["127.0.0.1", "localhost", "::1"].contains(baseURL.host ?? "")
        guard baseURL.scheme == "https" || (allowLocalHTTP && local && baseURL.scheme == "http") else {
            throw GatewayError.insecureEndpoint
        }
        endpoint = baseURL.appendingPathComponent("v1/templates/blue-sky/verify-cutouts")
        self.session = session; token = sessionToken
    }
    public func verify(photos: [BlueSkyCutoutPhoto], admittedResults: [PhotoAnalysisResult]) async throws -> BlueSkyCutoutEvidence {
        guard Set(admittedResults.map { $0.admission.photoID }).count == admittedResults.count else { throw GatewayError.invalidPreview }
        let admitted = Dictionary(uniqueKeysWithValues: admittedResults.map { ($0.admission.photoID, $0) })
        guard photos.allSatisfy({ photo in
            guard let result = admitted[photo.photoID] else { return false }
            return result.admission.state == .passed && result.assignment.photoID == photo.photoID &&
                result.assignment.themes.contains(.pets) && result.admission.policyVersion == PhotoPolicy().version
        }) else { throw GatewayError.invalidPreview }
        return try await send(photos, mode: "production")
    }
    public func verifyReviewedCalibrationSample(photos: [BlueSkyCutoutPhoto]) async throws -> BlueSkyCutoutEvidence {
        try await send(photos, mode: "calibration")
    }
    public static func digests(_ photos: [BlueSkyCutoutPhoto]) throws -> [String: CutoutImageDigests] {
        guard Set(photos.map(\.photoID)).count == photos.count else { throw GatewayError.invalidPreview }
        func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        return Dictionary(uniqueKeysWithValues: photos.map {
            ($0.photoID, CutoutImageDigests(original: digest($0.original.jpeg), masked: digest($0.masked.jpeg), cutout: digest($0.cutoutPNG)))
        })
    }
    private func send(_ photos: [BlueSkyCutoutPhoto], mode: String) async throws -> BlueSkyCutoutEvidence {
        if photos.isEmpty {
            return .init(schemaVersion: "echoo-blue-sky-cutout-v1", verificationVersion: BlueSkyCutoutVerifier.version,
                policyVersion: PhotoPolicy().version, requestID: UUID().uuidString, photoDigests: [:], evaluations: [])
        }
        guard (1...5).contains(photos.count), Set(photos.map(\.photoID)).count == photos.count,
              photos.allSatisfy({ $0.nativePrivacyFinding != .present && !$0.cutoutPNG.isEmpty &&
                [$0.original, $0.masked].allSatisfy { $0.width > 0 && $0.height > 0 && max($0.width, $0.height) <= 4096 } }),
              photos.reduce(0, { $0 + $1.original.jpeg.count + $1.masked.jpeg.count }) <= 6 * 1024 * 1024 else {
            throw GatewayError.invalidPreview
        }
        let ids = try Self.digests(photos)
        let requestID = UUID().uuidString
        var records: [[String: Any]] = []
        for photo in photos {
            let hash = ids[photo.photoID]!
            var record: [String: Any] = ["photoID": photo.photoID, "cutoutDigest": hash.cutout,
                "nativePrivacyFinding": photo.nativePrivacyFinding.rawValue]
            for (prefix, image, digest) in [("original", photo.original, hash.original), ("masked", photo.masked, hash.masked)] {
                record[prefix + "JPEGBase64"] = image.jpeg.base64EncodedString()
                record[prefix + "Digest"] = digest
                record[prefix + "Width"] = image.width; record[prefix + "Height"] = image.height
            }
            if mode == "production" { record["admissionState"] = "passed"; record["themes"] = ["pets"] }
            records.append(record)
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"; request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["schemaVersion": "echoo-blue-sky-cutout-v1",
            "verificationVersion": BlueSkyCutoutVerifier.version, "policyVersion": PhotoPolicy().version,
            "requestID": requestID, "mode": mode, "sampleReviewed": mode == "calibration", "photos": records])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayError.invalidResponse }
        guard http.statusCode == 200 else { throw GatewayError.httpFailure(http.statusCode) }
        return try Self.decodeResponse(data, requestID: requestID, digests: ids)
    }
    public static func decodeResponse(_ data: Data, requestID: String,
                                      digests: [String: CutoutImageDigests]) throws -> BlueSkyCutoutEvidence {
        guard data.count <= 256 * 1024 else { throw GatewayError.invalidResponse }
        let response = try JSONDecoder().decode(BlueSkyCutoutEvidence.self, from: data)
        guard response.schemaVersion == "echoo-blue-sky-cutout-v1", response.verificationVersion == BlueSkyCutoutVerifier.version,
              response.policyVersion == PhotoPolicy().version, response.requestID == requestID, response.photoDigests == digests,
              response.evaluations.count == digests.count,
              Set(response.evaluations.map(\.photoID)) == Set(digests.keys),
              response.evaluations.allSatisfy({ !$0.provenance.isEmpty && Set($0.facts.keys) == Set(BlueSkyCutoutVerifier.factKeys)
                && $0.cutoutDigest == digests[$0.photoID]?.cutout }) else {
            throw GatewayError.invalidResponse
        }
        return response
    }
}

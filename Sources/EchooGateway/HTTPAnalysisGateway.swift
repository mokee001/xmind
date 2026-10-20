import Foundation
import CryptoKit
import EchooCore

public enum GatewayError: Error {
    case insecureEndpoint, invalidPreview, httpFailure(Int), invalidResponse
}

/// The app only holds an application session token; vendor credentials stay on the server.
public struct HTTPAnalysisGateway: RemotePhotoAnalyzing {
    private let endpoint: URL
    private let token: @Sendable () async throws -> String
    private let session: URLSession

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        allowLocalHTTP: Bool = false,
        sessionToken: @escaping @Sendable () async throws -> String
    ) throws {
        let local = ["127.0.0.1", "localhost", "::1"].contains(baseURL.host ?? "")
        guard baseURL.scheme == "https" || (allowLocalHTTP && local && baseURL.scheme == "http") else {
            throw GatewayError.insecureEndpoint
        }
        self.endpoint = baseURL.appendingPathComponent("v1/analyze")
        self.token = sessionToken
        self.session = session
    }

    public func analyze(
        photoID: String, policyVersion: String,
        preview: AnalysisPreview, native: NativeAnalysis
    ) async throws -> RemoteAnalysis {
        guard preview.width > 0, preview.height > 0,
              max(preview.width, preview.height) <= 4096,
              preview.jpeg.count <= 6 * 1024 * 1024 else {
            throw GatewayError.invalidPreview
        }
        let digest = SHA256.hash(data: preview.jpeg).map { String(format: "%02x", $0) }.joined()
        let payload = RequestBody(
            schemaVersion: "echoo-analysis-v1", photoID: photoID,
            policyVersion: policyVersion, contentDigest: digest,
            jpegBase64: preview.jpeg.base64EncodedString(),
            width: preview.width, height: preview.height, native: native
        )
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(payload)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayError.invalidResponse }
        guard http.statusCode == 200 else { throw GatewayError.httpFailure(http.statusCode) }
        guard data.count <= 256 * 1024 else { throw GatewayError.invalidResponse }
        return try Self.decodeResponse(
            data, expectedPhotoID: photoID,
            expectedPolicyVersion: policyVersion, expectedDigest: digest
        )
    }

    public static func decodeResponse(
        _ data: Data, expectedPhotoID: String,
        expectedPolicyVersion: String, expectedDigest: String
    ) throws -> RemoteAnalysis {
        let body = try JSONDecoder().decode(ResponseBody.self, from: data)
        guard body.schemaVersion == "echoo-analysis-v1",
              body.photoID == expectedPhotoID,
              body.policyVersion == expectedPolicyVersion,
              body.contentDigest == expectedDigest,
              !body.provenance.isEmpty else { throw GatewayError.invalidResponse }
        var findings: [ExclusionReason: Finding] = [:]
        for check in ExclusionReason.contentChecks {
            // Missing checks remain unknown; they cannot become a silent pass.
            findings[check] = body.findings[check.rawValue] ?? .unknown
        }
        let themes = ThemeEvidence(
            photoID: body.photoID, policyVersion: body.policyVersion,
            companionAnimalIsSignificant: body.themeFacts["companionAnimalIsSignificant"] ?? .unknown,
            zooScene: body.themeFacts["zooScene"] ?? .unknown,
            preparedFoodOrDrink: body.themeFacts["preparedFoodOrDrink"] ?? .unknown,
            wildMushroomsOnDiningTable: body.themeFacts["wildMushroomsOnDiningTable"] ?? .unknown,
            environmentHasDisplayValue: body.themeFacts["environmentHasDisplayValue"] ?? .unknown
        )
        return RemoteAnalysis(
            content: ContentEvidence(
                photoID: body.photoID, policyVersion: body.policyVersion,
                findings: findings, provenance: body.provenance
            ), themes: themes
        )
    }
}

private struct RequestBody: Encodable {
    let schemaVersion: String
    let photoID: String
    let policyVersion: String
    let contentDigest: String
    let jpegBase64: String
    let width: Int
    let height: Int
    let native: NativeAnalysis
}

private struct ResponseBody: Decodable {
    let schemaVersion: String
    let photoID: String
    let policyVersion: String
    let contentDigest: String
    let findings: [String: Finding]
    let themeFacts: [String: Finding]
    let provenance: [String]
}

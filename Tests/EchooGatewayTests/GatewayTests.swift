import XCTest
import EchooCore
@testable import EchooGateway

final class GatewayTests: XCTestCase {
    private func response(changes: [String: Any] = [:]) throws -> Data {
        var body: [String: Any] = [
            "schemaVersion": "echoo-analysis-v1", "photoID": "p", "policyVersion": "echoo-policy-v1",
            "contentDigest": "digest", "provenance": ["test-provider"],
            "findings": Dictionary(uniqueKeysWithValues: ExclusionReason.contentChecks.map { ($0.rawValue, "absent") }),
            "themeFacts": ["companionAnimalIsSignificant": "present", "zooScene": "absent"]
        ]
        body.merge(changes) { _, new in new }
        return try JSONSerialization.data(withJSONObject: body)
    }

    private func decode(_ data: Data) throws -> RemoteAnalysis {
        try HTTPAnalysisGateway.decodeResponse(
            data, expectedPhotoID: "p", expectedPolicyVersion: "echoo-policy-v1", expectedDigest: "digest"
        )
    }

    func testValidResponseRoundTripsIntoPolicy() throws {
        let analysis = try decode(response())
        let policy = PhotoPolicy()
        let decision = policy.admission(for: PhotoInput(id: "p", mediaKind: .image), evidence: analysis.content)
        XCTAssertEqual(decision.state, .passed)
        XCTAssertEqual(policy.themes(for: decision, evidence: analysis.themes).themes, [.daily, .pets])
    }

    func testMissingChecksRemainUnknown() throws {
        let analysis = try decode(response(changes: ["findings": [:]]))
        XCTAssertEqual(analysis.content.findings[.highRiskPrivacy], .unknown)
        XCTAssertEqual(
            PhotoPolicy().admission(for: PhotoInput(id: "p", mediaKind: .image), evidence: analysis.content).state,
            .pending
        )
    }

    func testMismatchedPhotoVersionAndDigestAreRejected() throws {
        for changes: [String: Any] in [
            ["photoID": "wrong"], ["policyVersion": "wrong"], ["contentDigest": "wrong"],
            ["schemaVersion": "wrong"], ["provenance": []]
        ] {
            XCTAssertThrowsError(try decode(response(changes: changes)))
        }
    }

    func testMalformedFindingCannotBecomeAPass() throws {
        XCTAssertThrowsError(try decode(response(changes: ["findings": ["screenshot": false]])))
    }

    func testHTTPSIsRequiredExceptExplicitLoopbackDevelopment() throws {
        XCTAssertThrowsError(try HTTPAnalysisGateway(baseURL: URL(string: "http://example.com")!, sessionToken: { "test" }))
        XCTAssertThrowsError(try HTTPAnalysisGateway(baseURL: URL(string: "http://127.0.0.1")!, sessionToken: { "test" }))
        XCTAssertNoThrow(try HTTPAnalysisGateway(baseURL: URL(string: "http://127.0.0.1")!, allowLocalHTTP: true, sessionToken: { "test" }))
    }
}

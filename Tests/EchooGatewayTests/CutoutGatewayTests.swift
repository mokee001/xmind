import XCTest
import EchooCore
@testable import EchooGateway

final class CutoutGatewayTests: XCTestCase {
    let digests = ["a": CutoutImageDigests(original: "original", masked: "mask", cutout: "png")]
    func body() -> [String: Any] {
        ["schemaVersion": "echoo-blue-sky-cutout-v1", "verificationVersion": BlueSkyCutoutVerifier.version,
         "policyVersion": PhotoPolicy().version, "requestID": "r",
         "photoDigests": ["a": ["original": "original", "masked": "mask", "cutout": "png"]],
         "evaluations": [["photoID": "a", "cutoutDigest": "png", "provenance": ["test"],
             "facts": Dictionary(uniqueKeysWithValues: BlueSkyCutoutVerifier.factKeys.map { ($0, "present") })]]]
    }
    func decode(_ value: [String: Any]) throws -> BlueSkyCutoutEvidence {
        try HTTPCutoutVerificationGateway.decodeResponse(JSONSerialization.data(withJSONObject: value), requestID: "r", digests: digests)
    }
    func testCorrectPairedEvidenceAndExplicitUnknownDecode() throws {
        XCTAssertEqual(try decode(body()).evaluations[0].facts["rightComplete"], .present)
        var value = body(), evaluations = value["evaluations"] as! [[String: Any]]
        var facts = evaluations[0]["facts"] as! [String: String]
        facts["rightComplete"] = "unknown"; evaluations[0]["facts"] = facts; value["evaluations"] = evaluations
        XCTAssertEqual(try decode(value).evaluations[0].facts["rightComplete"], .unknown)
    }
    func testCrossedRequestMaskOriginalAndPNGAreRejected() throws {
        let changes: [[String: Any]] = [
            ["requestID": "wrong"], ["verificationVersion": "wrong"],
            ["photoDigests": ["a": ["original": "changed", "masked": "mask", "cutout": "png"]]],
            ["photoDigests": ["a": ["original": "original", "masked": "changed", "cutout": "png"]]]
        ]
        for change in changes {
            var value = body(); value.merge(change) { _, new in new }
            XCTAssertThrowsError(try decode(value))
        }
        for change in [["photoID": "b"], ["cutoutDigest": "other-png"], ["facts": [:]], ["provenance": []]] as [[String: Any]] {
            var value = body(), evaluations = value["evaluations"] as! [[String: Any]]
            evaluations[0].merge(change) { _, new in new }; value["evaluations"] = evaluations
            XCTAssertThrowsError(try decode(value))
        }
        var duplicate = body()
        let evaluations = duplicate["evaluations"] as! [[String: Any]]
        duplicate["evaluations"] = evaluations + evaluations
        XCTAssertThrowsError(try decode(duplicate))
    }
    func testEndpointMustUseHTTPSExceptExplicitLocalDevelopment() throws {
        XCTAssertThrowsError(try HTTPCutoutVerificationGateway(baseURL: URL(string: "http://example.com")!, sessionToken: { "token" }))
        XCTAssertNoThrow(try HTTPCutoutVerificationGateway(baseURL: URL(string: "http://127.0.0.1")!, allowLocalHTTP: true, sessionToken: { "token" }))
    }
}

import XCTest
import EchooCore
@testable import EchooGateway

final class BlueSkyGatewayTests: XCTestCase {
    func testZeroPhotosAvoidNetworkAndCredentials() async throws {
        let gateway = try HTTPBlueSkyGateway(baseURL: URL(string: "https://offline.invalid")!,
            sessionToken: { XCTFail("No token or API for an empty pool"); return "" })
        let empty = try await gateway.evaluate(photos: [], admittedResults: [])
        XCTAssertTrue(empty.evaluations.isEmpty)
        let cutouts = try HTTPCutoutVerificationGateway(baseURL: URL(string: "https://offline.invalid")!,
            sessionToken: { XCTFail("No token or API for zero cutouts"); return "" })
        let verified = try await cutouts.verify(photos: [], admittedResults: [])
        XCTAssertTrue(verified.evaluations.isEmpty)
    }
    func body() -> [String: Any] {
        let reasons = ["detailed", "balanced", "natural", "separated", "engaging", "spontaneous", "ordinary"]
        return [
            "schemaVersion": "echoo-blue-sky-v1", "templateVersion": BlueSkySelector.version,
            "policyVersion": "echoo-policy-v1", "requestID": "r", "photoDigests": ["a": "digest"],
            "evaluations": [["photoID": "a", "facts": Dictionary(uniqueKeysWithValues: BlueSkySelector.factKeys.map { ($0, "present") }),
                "scores": Dictionary(uniqueKeysWithValues: zip(BlueSkyDimension.allCases, reasons).map {
                    ($0.0.rawValue, ["value": 3, "reason": $0.1] as [String: Any]) }),
                "notApplicablePreferences": [], "provenance": ["test"]]],
            "identity": []
        ]
    }
    func decode(_ value: [String: Any]) throws -> BlueSkyBatchEvidence {
        try HTTPBlueSkyGateway.decodeResponse(JSONSerialization.data(withJSONObject: value), requestID: "r", digests: ["a": "digest"])
    }
    func testValidBoundEvidenceDecodes() throws {
        XCTAssertEqual(try decode(body()).evaluations[0].totalScore, 60)
    }
    func testWrongBatchDigestVersionAndDuplicateEvaluationsAreRejected() throws {
        for change in [["requestID": "wrong"], ["photoDigests": ["a": "wrong"]], ["templateVersion": "wrong"]] as [[String: Any]] {
            var value = body(); value.merge(change) { _, new in new }
            XCTAssertThrowsError(try decode(value))
        }
        var value = body()
        let evaluations = value["evaluations"] as! [[String: Any]]
        value["evaluations"] = evaluations + evaluations
        XCTAssertThrowsError(try decode(value))
    }
    func testUnknownRatingIsExplicitAndCannotContainPrivateReason() throws {
        var value = body()
        var evaluations = value["evaluations"] as! [[String: Any]]
        var scores = evaluations[0]["scores"] as! [String: [String: Any]]
        scores["sharpness"] = ["value": NSNull(), "reason": "unresolved"]
        evaluations[0]["scores"] = scores; value["evaluations"] = evaluations
        XCTAssertNil(try decode(value).evaluations[0].totalScore)
        scores["sharpness"] = ["value": 3, "reason": "arbitrary OCR string"]
        evaluations[0]["scores"] = scores; value["evaluations"] = evaluations
        XCTAssertThrowsError(try decode(value))
        scores["sharpness"] = ["reason": "unresolved"]
        evaluations[0]["scores"] = scores; value["evaluations"] = evaluations
        XCTAssertThrowsError(try decode(value))
    }
    func testHTTPSForTemplateCalls() throws {
        XCTAssertThrowsError(try HTTPBlueSkyGateway(baseURL: URL(string: "http://example.com")!, sessionToken: { "token" }))
        XCTAssertNoThrow(try HTTPBlueSkyGateway(baseURL: URL(string: "http://127.0.0.1")!, allowLocalHTTP: true, sessionToken: { "token" }))
    }
}

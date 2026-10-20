import XCTest
@testable import EchooCore

final class PhotoPolicyTests: XCTestCase {
    private let policy = PhotoPolicy()
    private let image = PhotoInput(id: "test-photo", mediaKind: .image)

    private func evidence(
        changes: [ExclusionReason: Finding] = [:],
        photoID: String = "test-photo",
        version: String = "echoo-policy-v1"
    ) -> ContentEvidence {
        var findings = Dictionary(
            uniqueKeysWithValues: ExclusionReason.contentChecks.map { ($0, Finding.absent) }
        )
        findings.merge(changes) { _, new in new }
        return ContentEvidence(photoID: photoID, policyVersion: version, findings: findings)
    }

    func testAllPassedPhotosEnterDailyWithoutThemeEvidence() {
        let admitted = policy.admission(for: image, evidence: evidence())
        XCTAssertEqual(admitted.state, .passed)
        let assignment = policy.themes(for: admitted, evidence: nil)
        XCTAssertEqual(assignment.themes, [.daily])
        XCTAssertEqual(assignment.pendingThemes, [.pets, .food, .landscape])
    }

    func testVideoAndScreenshotRejectWithoutContentAnalysis() {
        XCTAssertEqual(
            policy.admission(
                for: PhotoInput(id: "v", mediaKind: .video), evidence: nil
            ).exclusions,
            [.unsupportedMedia]
        )
        XCTAssertEqual(
            policy.admission(
                for: PhotoInput(id: "s", mediaKind: .image, isScreenshot: true),
                evidence: nil
            ).exclusions,
            [.screenshot]
        )
    }

    func testCloudPendingIsNotARejection() {
        let decision = policy.admission(
            for: PhotoInput(id: "cloud", mediaKind: .image, previewAvailability: .cloudPending),
            evidence: nil
        )
        XCTAssertEqual(decision.state, .pending)
        XCTAssertEqual(decision.pendingReason, .cloudPending)
        XCTAssertTrue(decision.exclusions.isEmpty)
    }

    func testMissingOrMismatchedEvidenceCannotPass() {
        XCTAssertEqual(policy.admission(for: image, evidence: nil).state, .pending)
        XCTAssertEqual(
            policy.admission(for: image, evidence: evidence(photoID: "another-photo")).state,
            .pending
        )
        XCTAssertEqual(
            policy.admission(for: image, evidence: evidence(version: "stale-policy")).state,
            .pending
        )
        let missingChecks = ContentEvidence(
            photoID: image.id, policyVersion: policy.version, findings: [:]
        )
        XCTAssertEqual(policy.admission(for: image, evidence: missingChecks).state, .pending)
    }

    func testEveryContentCheckCanRejectOrRemainPending() {
        for check in ExclusionReason.contentChecks {
            XCTAssertEqual(
                policy.admission(for: image, evidence: evidence(changes: [check: .present])).state,
                .rejected
            )
            XCTAssertEqual(
                policy.admission(for: image, evidence: evidence(changes: [check: .unknown])).state,
                .pending
            )
        }
    }

    func testRejectedAndPendingPhotosHaveNoThemeAssignments() {
        for finding in [Finding.present, .unknown] {
            let decision = policy.admission(
                for: image, evidence: evidence(changes: [.highRiskPrivacy: finding])
            )
            XCTAssertTrue(policy.themes(for: decision, evidence: nil).themes.isEmpty)
        }
    }

    func testZooAnimalIsDailyButNotPet() {
        let admitted = policy.admission(for: image, evidence: evidence())
        let facts = ThemeEvidence(
            photoID: image.id, policyVersion: policy.version,
            companionAnimalIsSignificant: .present, zooScene: .present,
            preparedFoodOrDrink: .absent, wildMushroomsOnDiningTable: .absent,
            environmentHasDisplayValue: .absent
        )
        XCTAssertEqual(policy.themes(for: admitted, evidence: facts).themes, [.daily])
    }

    func testFoodExceptionsAndMultilabelAssignment() {
        let admitted = policy.admission(for: image, evidence: evidence())
        let facts = ThemeEvidence(
            photoID: image.id, policyVersion: policy.version,
            companionAnimalIsSignificant: .present, zooScene: .absent,
            preparedFoodOrDrink: .absent, wildMushroomsOnDiningTable: .present,
            environmentHasDisplayValue: .present
        )
        XCTAssertEqual(
            policy.themes(for: admitted, evidence: facts).themes,
            [.daily, .pets, .food, .landscape]
        )
    }

    func testUnprocessedIngredientsDoNotEnterFood() {
        let admitted = policy.admission(for: image, evidence: evidence())
        let facts = ThemeEvidence(
            photoID: image.id, policyVersion: policy.version,
            companionAnimalIsSignificant: .absent, zooScene: .absent,
            preparedFoodOrDrink: .absent, wildMushroomsOnDiningTable: .absent,
            environmentHasDisplayValue: .absent
        )
        XCTAssertEqual(policy.themes(for: admitted, evidence: facts).themes, [.daily])
    }

    func testWrongPhotoThemeEvidenceIsNotUsed() {
        let admitted = policy.admission(for: image, evidence: evidence())
        let facts = ThemeEvidence(
            photoID: "wrong", policyVersion: policy.version,
            companionAnimalIsSignificant: .present, zooScene: .absent
        )
        let assignment = policy.themes(for: admitted, evidence: facts)
        XCTAssertEqual(assignment.themes, [.daily])
        XCTAssertEqual(assignment.pendingThemes, [.pets, .food, .landscape])
    }
}

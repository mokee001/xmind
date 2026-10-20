import XCTest
@testable import EchooCore

final class BlueSkySelectionTests: XCTestCase {
    func photo(_ id: String, _ facts: [String: Finding] = [:], score: Int = 3,
               notApplicable: [String] = []) -> BlueSkyPhotoEvaluation {
        var values = Dictionary(uniqueKeysWithValues: BlueSkySelector.factKeys.map { ($0, Finding.absent) })
        for key in ["isPet", "singlePetSubject", "technicalBasics", "topComplete", "bottomComplete", "leftComplete", "rightComplete"] { values[key] = .present }
        values.merge(facts) { _, new in new }
        return .init(photoID: id, facts: values,
            scores: Dictionary(uniqueKeysWithValues: BlueSkyDimension.allCases.map { ($0.rawValue, .init(value: score, reason: "test")) }),
            provenance: ["test"], notApplicablePreferences: notApplicable)
    }
    func pool() -> [BlueSkyPhotoEvaluation] {
        [photo("a", ["headLargeProminent": .present]),
         photo("b", ["fullBody": .present, "topDown": .present, "curled": .present]),
         photo("c", ["fullBody": .present, "frontStandingOrSitting": .present]),
         photo("d", ["fullBody": .present, "frontStandingOrSitting": .present]),
         photo("e", ["halfBodyCloseUp": .present, "headClearProminent": .present])]
    }
    func identities(_ photos: [BlueSkyPhotoEvaluation]) -> [PetIdentityEvidence] {
        photos.enumerated().flatMap { i, left in photos.dropFirst(i + 1).map {
            .init(leftID: left.photoID, rightID: $0.photoID, relation: .same, reason: "test", provenance: ["test"])
        } }
    }
    func plan(_ photos: [BlueSkyPhotoEvaluation], pairs: [PetIdentityEvidence]? = nil) throws -> BlueSkyPlan {
        try BlueSkySelector.select(photoIDs: photos.map(\.photoID), evaluations: photos, identities: pairs ?? identities(photos))
    }
    func testWeightsAndOriginalPhotoScore() {
        XCTAssertEqual(BlueSkyDimension.allCases.reduce(0) { $0 + $1.weight }, 100)
        XCTAssertEqual(photo("a").totalScore, 60)
        XCTAssertEqual(photo("a", score: 5).totalScore, 100)
    }
    func testBodyEdgesSingleSubjectAndTechnicalBasicsAreNotHardGates() {
        let sample = photo("x", ["fullBody": .unknown, "singlePetSubject": .absent,
            "technicalBasics": .absent, "leftComplete": .absent, "topComplete": .unknown])
        for slot in BlueSkySlot.allCases {
            XCTAssertEqual(BlueSkySelector.candidate(sample, for: slot).eligibility, .eligible)
        }
        XCTAssertEqual(BlueSkySelector.candidate(photo("x", ["isPet": .unknown]), for: .photo1).eligibility, .pending)
        XCTAssertEqual(BlueSkySelector.candidate(photo("x", ["isPet": .absent]), for: .photo1).eligibility, .ineligible)
    }
    func testAllCommonPetsUseTheSameSpeciesNeutralContract() throws {
        for species in ["cat", "dog", "hamster", "parrot", "turtle", "goldfish", "rabbit"] {
            let p = photo(species, ["curled": .absent, "frontStandingOrSitting": .absent],
                          notApplicable: ["curled", "frontStandingOrSitting"])
            let result = try plan([p])
            XCTAssertEqual(result.selections.first?.photoID, species)
            XCTAssertEqual(result.selections.first?.slot, .photo5)
            XCTAssertEqual(result.posePreferredCount, 0)
        }
        XCTAssertFalse(BlueSkySelector.factKeys.contains("isCat"))
    }
    func testPosePriorityOutranksCompositionAndGeneralScore() throws {
        var photos = pool()
        photos[1] = photo("b", ["topDown": .present, "curled": .present,
                              "topComplete": .absent, "bottomComplete": .absent,
                              "leftComplete": .absent, "rightComplete": .absent], score: 1)
        photos.append(photo("high", ["fullBody": .present], score: 5))
        let result = try plan(photos)
        XCTAssertEqual(result.selections.first { $0.slot == .photo2 }?.photoID, "b")
        XCTAssertEqual(result.posePreferredCount, 4)
    }
    func testCompositionOutranksScoreAfterPoseTies() throws {
        var photos = pool()
        photos[0] = photo("a", ["headLargeProminent": .present], score: 1)
        photos.append(photo("high", score: 5))
        let result = try plan(photos)
        XCTAssertEqual(result.selections.first { $0.slot == .photo1 }?.photoID, "a")
        XCTAssertFalse(result.selections.contains { $0.photoID == "high" })
    }
    func testMissingAllPreferencesStillProducesStandardFivePhotoPlan() throws {
        let photos = (0..<5).map { n -> BlueSkyPhotoEvaluation in
            var values = Dictionary(uniqueKeysWithValues: BlueSkySelector.factKeys.map { ($0, Finding.unknown) })
            values["isPet"] = .present
            return .init(photoID: "p\(n)", facts: values, scores: [:], provenance: ["test"])
        }
        let result = try plan(photos)
        XCTAssertEqual(result.mode, "standard")
        XCTAssertEqual(result.selections.count, 5)
        XCTAssertEqual(result.preferredCount, 0)
        XCTAssertTrue(result.selections.allSatisfy { $0.score == nil })
    }
    func testEveryFallbackCountUsesTheExactHideOrderIncludingZero() throws {
        for count in 0...5 {
            let result = try plan(Array(pool().prefix(count)))
            XCTAssertEqual(result.state, .selected)
            XCTAssertEqual(result.selections.count, count)
            XCTAssertEqual(result.hiddenSlots, Array(BlueSkyFallback.hideOrder.prefix(5-count)))
            XCTAssertEqual(Set(result.selections.map(\.slot)), Set(BlueSkyFallback.visibleSlots(photoCount: count)))
            XCTAssertEqual(Set(result.selections.map(\.photoID)).count, count)
            XCTAssertEqual(result.mode, count == 5 ? "standard" : count == 0 ? "backgroundOnly" : "fallback")
        }
    }
    func testMissingPairCannotBeFilledByTransitiveIdentityButCanUseSmallerPlan() throws {
        let photos = pool()
        let pairs = identities(photos).filter { Set([$0.leftID, $0.rightID]) != Set(["c", "d"]) }
        let result = try plan(photos, pairs: pairs)
        XCTAssertEqual(result.selections.count, 4)
        XCTAssertEqual(result.hasPendingEvidence, true)
        XCTAssertFalse(Set(result.selections.map(\.photoID)).isSuperset(of: ["c", "d"]))
    }
    func testDifferentPetsNeverMixEvenWhenThatMeansFewerPhotos() throws {
        let photos = pool()
        let pairs = identities(photos).map { p in PetIdentityEvidence(leftID: p.leftID, rightID: p.rightID,
            relation: p.leftID == "a" ? .different : .same, reason: "test", provenance: ["test"]) }
        let result = try plan(photos, pairs: pairs)
        XCTAssertEqual(result.selections.count, 4)
        XCTAssertFalse(result.selections.contains { $0.photoID == "a" })
    }
    func testTargetReferenceConstraintCannotSwitchToAnotherPet() throws {
        let photos = pool() + [photo("other", score: 5)]
        let pairs = identities(photos).map { p in PetIdentityEvidence(leftID: p.leftID, rightID: p.rightID,
            relation: p.rightID == "other" ? .different : .same, reason: "test", provenance: ["test"]) }
        let result = try BlueSkySelector.select(photoIDs: photos.map(\.photoID), evaluations: photos,
            identities: pairs, requiredPetPhotoID: "a")
        XCTAssertEqual(result.selections.count, 5)
        XCTAssertFalse(result.selections.contains { $0.photoID == "other" })
        XCTAssertTrue(result.rankings.contains { $0.photoID == "other" && $0.failedRequirements.contains("targetPetIdentity") })
    }
    func testDuplicateInputsAndDuplicatePairsAreRejected() throws {
        let photos = pool(), pairs = identities(pool())
        XCTAssertThrowsError(try plan(photos + [photos[0]]))
        XCTAssertThrowsError(try plan(photos, pairs: pairs + [pairs[0]]))
    }
    func testSlotExclusionDoesNotChangeOriginalScoresOrOtherSlotEligibility() throws {
        let photos = pool() + [photo("spare", score: 2)]
        let result = try BlueSkySelector.select(photoIDs: photos.map(\.photoID), evaluations: photos,
            identities: identities(photos), excludingFromSlots: [.photo1: ["a"]])
        XCTAssertEqual(result.selections.count, 5)
        XCTAssertNotEqual(result.selections.first { $0.slot == .photo1 }?.photoID, "a")
        XCTAssertEqual(photos[0].totalScore, 60)
        XCTAssertTrue(result.rankings.contains { $0.slot == .photo5 && $0.photoID == "a" && $0.eligibility == .eligible })
    }
    func testStableTieBreakIsIndependentOfInputOrder() throws {
        let photos = (0..<6).map { photo("p\($0)") }
        XCTAssertEqual(try plan(photos).selections, try plan(Array(photos.reversed())).selections)
    }
    func testHistoricalPlanRemainsReadableWithoutRelabelingEvidenceVersion() throws {
        let data = Data("""
        {"state":"selected","preferredCount":1,"totalScore":60,
         "selections":[{"slot":"photo2","photoID":"old","preferred":true,"score":60}],"rankings":[]}
        """.utf8)
        let old = try JSONDecoder().decode(BlueSkyPlan.self, from: data)
        XCTAssertNil(old.strategyVersion)
        XCTAssertNil(old.hiddenSlots)
    }
    func testCompletedContentLongSideFitsWithoutStretchingOrCropping() throws {
        let size = try BlueSkySelector.fittedSize(width: 300, height: 600, slot: .photo3)
        XCTAssertEqual(size.width, 388); XCTAssertEqual(size.height, 776)
        XCTAssertThrowsError(try BlueSkySelector.fittedSize(width: 0, height: 10, slot: .photo1))
    }
}

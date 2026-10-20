import XCTest
@testable import EchooCore

private actor PreviewRecorder: PhotoPreviewProviding {
    var sizes: [Int] = []
    var result: PreviewResult = .ready(AnalysisPreview(jpeg: Data([1]), width: 512, height: 512))
    func preview(maxPixel: Int) async throws -> PreviewResult {
        sizes.append(maxPixel)
        return result
    }
}

private struct StubNative: NativePhotoAnalyzing {
    let privacy: Finding
    func analyze(_ preview: AnalysisPreview) async throws -> NativeAnalysis {
        NativeAnalysis(
            revision: "stub", labels: [], animals: [], textRegionCount: 0,
            textCoverage: 0, privacyFinding: privacy,
            quality: QualityMetrics(laplacianVariance: 0, darkFraction: 0, brightFraction: 1)
        )
    }
}

private actor StubRemote: RemotePhotoAnalyzing {
    var calls = 0
    let fails: Bool
    init(fails: Bool = false) { self.fails = fails }
    func analyze(
        photoID: String, policyVersion: String, preview: AnalysisPreview, native: NativeAnalysis
    ) async throws -> RemoteAnalysis {
        calls += 1
        if fails { throw StubError.network }
        return RemoteAnalysis(
            content: ContentEvidence(
                photoID: photoID, policyVersion: policyVersion,
                findings: Dictionary(uniqueKeysWithValues: ExclusionReason.contentChecks.map { ($0, .absent) }),
                provenance: ["stub"]
            ),
            themes: ThemeEvidence(
                photoID: photoID, policyVersion: policyVersion,
                companionAnimalIsSignificant: .present, zooScene: .absent,
                preparedFoodOrDrink: .absent, wildMushroomsOnDiningTable: .absent,
                environmentHasDisplayValue: .present
            )
        )
    }
}

private enum StubError: Error { case network }

private struct GrowingSource: PhotoPreviewProviding {
    func preview(maxPixel: Int) async throws -> PreviewResult {
        .ready(AnalysisPreview(jpeg: Data([1]), width: maxPixel, height: maxPixel))
    }
}

private struct DetailedPrivacyNative: NativePhotoAnalyzing {
    func analyze(_ preview: AnalysisPreview) async throws -> NativeAnalysis {
        try await StubNative(privacy: preview.width > 512 ? .present : .unknown).analyze(preview)
    }
}

final class PipelineTests: XCTestCase {
    func testCancelledAnalysisDoesNotLoadPhotoOrCallProvider() async {
        let source = PreviewRecorder()
        let remote = StubRemote()
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .unknown), remoteAnalyzer: remote)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return await engine.process(PhotoInput(id: "p", mediaKind: .image), source: source)
        }
        let result = await task.value
        let calls = await remote.calls
        let sizes = await source.sizes
        XCTAssertEqual(result.admission.state, .pending)
        XCTAssertEqual(result.issues, [.cancelled])
        XCTAssertTrue(sizes.isEmpty)
        XCTAssertEqual(calls, 0)
    }

    func testPrivacyFoundOnlyOnLargerPreviewStillBlocksAllAPITransmission() async {
        let remote = StubRemote()
        let engine = PhotoAnalysisEngine(nativeAnalyzer: DetailedPrivacyNative(), remoteAnalyzer: remote)
        let result = await engine.process(PhotoInput(id: "p", mediaKind: .image), source: GrowingSource())
        let calls = await remote.calls
        XCTAssertEqual(result.admission.state, .rejected)
        XCTAssertEqual(result.admission.exclusions, [.highRiskPrivacy])
        XCTAssertEqual(calls, 0)
    }
    func testMetadataRejectionDoesNotLoadPreviewOrCallAPI() async {
        let source = PreviewRecorder()
        let remote = StubRemote()
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .unknown), remoteAnalyzer: remote)
        let result = await engine.process(PhotoInput(id: "v", mediaKind: .video), source: source)
        let sizes = await source.sizes
        let calls = await remote.calls
        XCTAssertEqual(result.admission.state, .rejected)
        XCTAssertTrue(sizes.isEmpty)
        XCTAssertEqual(calls, 0)
    }

    func testRecognizedPrivacyNeverReachesAPI() async {
        let source = PreviewRecorder()
        let remote = StubRemote()
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .present), remoteAnalyzer: remote)
        let result = await engine.process(PhotoInput(id: "private", mediaKind: .image), source: source)
        let calls = await remote.calls
        let sizes = await source.sizes
        XCTAssertEqual(result.admission.exclusions, [.highRiskPrivacy])
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(sizes, [512])
    }

    func testNativeOnlyLeavesUnresolvedChecksPending() async {
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .unknown))
        let result = await engine.process(PhotoInput(id: "p", mediaKind: .image), source: PreviewRecorder())
        XCTAssertEqual(result.admission.state, .pending)
        XCTAssertEqual(result.issues, [.gatewayNotConfigured])
        XCTAssertTrue(result.assignment.themes.isEmpty)
    }

    func testHigherPreviewIsRequestedOnlyForRemoteCandidate() async {
        let source = PreviewRecorder()
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .unknown), remoteAnalyzer: StubRemote())
        let result = await engine.process(PhotoInput(id: "p", mediaKind: .image), source: source)
        let sizes = await source.sizes
        XCTAssertEqual(sizes, [512, 1536])
        XCTAssertEqual(result.admission.state, .passed)
        XCTAssertEqual(result.assignment.themes, [.daily, .pets, .landscape])
    }

    func testAPIFailureCannotProduceAlbumMembership() async {
        let engine = PhotoAnalysisEngine(
            nativeAnalyzer: StubNative(privacy: .unknown), remoteAnalyzer: StubRemote(fails: true)
        )
        let result = await engine.process(PhotoInput(id: "p", mediaKind: .image), source: PreviewRecorder())
        XCTAssertEqual(result.admission.state, .pending)
        XCTAssertEqual(result.issues, [.gatewayFailed])
        XCTAssertTrue(ThemeAlbum.assemble(from: [result]).allSatisfy { $0.photoIDs.isEmpty })
    }

    func testAlbumAssemblyDeduplicatesIDsWithinEachTheme() async {
        let engine = PhotoAnalysisEngine(nativeAnalyzer: StubNative(privacy: .unknown), remoteAnalyzer: StubRemote())
        let result = await engine.process(PhotoInput(id: "p", mediaKind: .image), source: PreviewRecorder())
        let albums = ThemeAlbum.assemble(from: [result, result])
        XCTAssertEqual(albums.first { $0.theme == .daily }?.photoIDs, ["p"])
        XCTAssertEqual(albums.first { $0.theme == .pets }?.photoIDs, ["p"])
    }

    func testUnfinishedTemplatesCannotBeSelected() throws {
        let catalog = try TemplateCatalog()
        let album = ThemeAlbum(theme: .pets, photoIDs: ["p"])
        XCTAssertThrowsError(try catalog.manuallySelected(id: "pets.blue-sky-green-field", album: album))
        XCTAssertTrue(TemplateDefinition.planned.allSatisfy { $0.state != .ready })
    }
}

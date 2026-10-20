import XCTest
@testable import EchooCore

private struct StubArtworkGenerator: ArtworkGenerating {
    let definition: TemplateDefinition
    var mode: TemplateAvailability = .unknown
    func availability(in album: ThemeAlbum) -> TemplateAvailability { mode }
    func generate(album: ThemeAlbum, resources: [String: any PhotoPreviewProviding]) async throws -> RenderedArtwork {
        RenderedArtwork(
            imageData: Data(), pixelWidth: 1, pixelHeight: 1,
            selectedPhotoIDs: album.photoIDs, templateID: definition.id
        )
    }
}

final class TemplateTests: XCTestCase {
    func testManualEmptyAlbumRequiresExplicitZeroPhotoSupport() throws {
        let background = StubArtworkGenerator(definition: .init(id: "background", name: "test", theme: .pets, state: .ready, minimumPhotoCount: 0))
        let normal = StubArtworkGenerator(definition: .init(id: "normal", name: "test", theme: .pets, state: .ready))
        let catalog = try TemplateCatalog(generators: [background, normal])
        let empty = ThemeAlbum(theme: .pets, photoIDs: [])
        XCTAssertNoThrow(try catalog.manuallySelected(id: "background", album: empty))
        XCTAssertThrowsError(try catalog.manuallySelected(id: "normal", album: empty))
        var random = SystemRandomNumberGenerator()
        XCTAssertEqual(try catalog.automaticallySelected(album: empty, using: &random).definition.id, "background")
    }
    func testAutomaticSelectionPrefersCompleteStandardPlansOverFallback() throws {
        let fallback = StubArtworkGenerator(definition: .init(id: "fallback", name: "test", theme: .pets, state: .ready), mode: .fallback)
        let standard = StubArtworkGenerator(definition: .init(id: "standard", name: "test", theme: .pets, state: .ready), mode: .standard)
        let catalog = try TemplateCatalog(generators: [fallback, standard])
        var random = SystemRandomNumberGenerator()
        XCTAssertEqual(try catalog.automaticallySelected(album: .init(theme: .pets, photoIDs: ["p"]), using: &random).definition.id, "standard")
    }
    func testAutomaticRoutingOnlyUsesReadyTemplatesAndExplicitlyEnabledThemes() throws {
        let pet = StubArtworkGenerator(definition: .init(id: "test.pets", name: "test", theme: .pets, state: .ready))
        let food = StubArtworkGenerator(definition: .init(id: "test.food", name: "test", theme: .food, state: .ready))
        let catalog = try TemplateCatalog(generators: [pet, food])
        var random = SystemRandomNumberGenerator()
        let choice = try catalog.automaticallySelected(
            albums: [.init(theme: .pets, photoIDs: ["p"]), .init(theme: .food, photoIDs: ["f"])],
            themeWeights: [.pets: 1, .food: 0], using: &random
        )
        XCTAssertEqual(choice.album.theme, .pets)
        XCTAssertEqual(choice.generator.definition.id, "test.pets")
        XCTAssertEqual(
            try catalog.manuallySelected(id: "test.pets", album: choice.album).definition,
            choice.generator.definition
        )
    }

    func testInvalidWeightsAndPendingTemplatesCannotEnterRandomSelection() throws {
        var random = SystemRandomNumberGenerator()
        let catalog = try TemplateCatalog()
        let albums = [ThemeAlbum(theme: .pets, photoIDs: ["p"])]
        XCTAssertThrowsError(try catalog.automaticallySelected(albums: albums, themeWeights: [.pets: 1], using: &random))
        XCTAssertThrowsError(try catalog.automaticallySelected(albums: albums, themeWeights: [.pets: -1], using: &random))
        let pending = StubArtworkGenerator(definition: TemplateDefinition.planned[0])
        XCTAssertThrowsError(try TemplateCatalog(generators: [pending]))
    }
}

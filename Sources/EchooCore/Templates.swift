import Foundation

public enum TemplateState: String, Codable, Sendable {
    case awaitingDesign, validatingSelection, validatingArtwork, validatingAutomation, ready
}

public struct TemplateDefinition: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let theme: Theme
    public let state: TemplateState
    public let minimumPhotoCount: Int?

    public init(id: String, name: String, theme: Theme, state: TemplateState, minimumPhotoCount: Int = 1) {
        self.id = id
        self.name = name
        self.theme = theme
        self.state = state
        self.minimumPhotoCount = minimumPhotoCount
    }

    public static let planned: [Self] = [
        .init(id: "pets.blue-sky-green-field", name: "蓝天绿地拼贴", theme: .pets, state: .validatingAutomation, minimumPhotoCount: 0),
        .init(id: "pets.denim-collage", name: "牛仔拼贴", theme: .pets, state: .awaitingDesign)
    ]
}

public struct RenderedArtwork: Sendable {
    public let imageData: Data
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let selectedPhotoIDs: [String]
    public let templateID: String

    public init(
        imageData: Data, pixelWidth: Int, pixelHeight: Int,
        selectedPhotoIDs: [String], templateID: String
    ) {
        self.imageData = imageData
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.selectedPhotoIDs = selectedPhotoIDs
        self.templateID = templateID
    }
}

/// Each template owns its selection and layout implementation.
/// High-resolution acquisition is supplied by the caller.
public enum TemplateAvailability: Sendable { case standard, fallback, unknown, unavailable }

public protocol ArtworkGenerating: Sendable {
    var definition: TemplateDefinition { get }
    /// Uses existing evidence only; selection must not trigger analysis of an entire library.
    func availability(in album: ThemeAlbum) -> TemplateAvailability
    func generate(
        album: ThemeAlbum, resources: [String: any PhotoPreviewProviding]
    ) async throws -> RenderedArtwork
}
public extension ArtworkGenerating {
    func availability(in album: ThemeAlbum) -> TemplateAvailability { .unknown }
}

public enum TemplateError: Error {
    case unavailableTemplate, emptyAlbum, mismatchedTheme, invalidThemeWeights, invalidAlbums
}

public struct AutomaticGenerationChoice: Sendable {
    public let album: ThemeAlbum
    public let generator: any ArtworkGenerating
}

public struct TemplateCatalog: Sendable {
    private let generators: [String: any ArtworkGenerating]

    public init(generators: [any ArtworkGenerating] = []) throws {
        var registered: [String: any ArtworkGenerating] = [:]
        for generator in generators {
            guard generator.definition.state == .ready,
                  (generator.definition.minimumPhotoCount ?? 1) >= 0,
                  registered[generator.definition.id] == nil else {
                throw TemplateError.unavailableTemplate
            }
            registered[generator.definition.id] = generator
        }
        self.generators = registered
    }

    public func manuallySelected(id: String, album: ThemeAlbum) throws -> any ArtworkGenerating {
        guard let generator = generators[id] else { throw TemplateError.unavailableTemplate }
        guard generator.definition.theme == album.theme else { throw TemplateError.mismatchedTheme }
        guard album.photoIDs.count >= (generator.definition.minimumPhotoCount ?? 1) else { throw TemplateError.emptyAlbum }
        return generator
    }

    /// Random template selection within a caller-selected theme.
    /// Random theme weighting is left configurable until product policy is settled.
    public func automaticallySelected<R: RandomNumberGenerator>(
        album: ThemeAlbum, using random: inout R
    ) throws -> any ArtworkGenerating {
        let choices = automaticChoices(album)
            .sorted { $0.definition.id < $1.definition.id }
        guard let generator = choices.randomElement(using: &random) else {
            if album.photoIDs.isEmpty { throw TemplateError.emptyAlbum }
            throw TemplateError.unavailableTemplate
        }
        return generator
    }

    private func automaticChoices(_ album: ThemeAlbum) -> [any ArtworkGenerating] {
        let choices = generators.values.filter {
            $0.definition.theme == album.theme && album.photoIDs.count >= ($0.definition.minimumPhotoCount ?? 1)
                && $0.availability(in: album) != .unavailable
        }
        let standard = choices.filter { $0.availability(in: album) == .standard }
        return standard.isEmpty ? choices : standard
    }

    /// Select both a theme and its template. The caller explicitly supplies theme weights.
    /// No product weighting policy is hard-coded; weights of 1 provide uniform theme choice.
    public func automaticallySelected<R: RandomNumberGenerator>(
        albums: [ThemeAlbum], themeWeights: [Theme: Int], using random: inout R
    ) throws -> AutomaticGenerationChoice {
        guard themeWeights.values.allSatisfy({ $0 >= 0 }) else {
            throw TemplateError.invalidThemeWeights
        }
        guard Set(albums.map(\.theme)).count == albums.count else {
            throw TemplateError.invalidAlbums
        }
        var eligible = albums.filter { album in
            (themeWeights[album.theme] ?? 0) > 0 &&
                !automaticChoices(album).isEmpty
        }.sorted { $0.theme.rawValue < $1.theme.rawValue }
        let standardAlbums = eligible.filter { album in automaticChoices(album).contains { $0.availability(in: album) == .standard } }
        if !standardAlbums.isEmpty { eligible = standardAlbums }
        var total = 0
        for album in eligible {
            let sum = total.addingReportingOverflow(themeWeights[album.theme] ?? 0)
            guard !sum.overflow else { throw TemplateError.invalidThemeWeights }
            total = sum.partialValue
        }
        guard total > 0 else { throw TemplateError.unavailableTemplate }
        let ticket = Int.random(in: 0..<total, using: &random)
        var boundary = 0
        for album in eligible {
            boundary += themeWeights[album.theme] ?? 0
            if ticket < boundary {
                return AutomaticGenerationChoice(
                    album: album, generator: try automaticallySelected(album: album, using: &random)
                )
            }
        }
        throw TemplateError.unavailableTemplate
    }
}

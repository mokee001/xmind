import Foundation
import EchooCore

public struct BlueSkyOutlineStroke: Codable, Equatable, Sendable {
    public let colorHex: String
    public let opacity: Double
    /// Distance from the subject silhouette to the stroke centerline.
    public let centerOffset: Double
    /// Full stroke width. Filled sticker borders have centerOffset=0 and are
    /// covered on the inside by the foreground image drawn last.
    public let lineWidth: Double
    public let dash: [Double]
    public init(colorHex: String, opacity: Double = 1, centerOffset: Double = 0,
                lineWidth: Double, dash: [Double] = []) {
        self.colorHex = colorHex; self.opacity = opacity; self.centerOffset = centerOffset
        self.lineWidth = lineWidth; self.dash = dash
    }
    public var outwardExtent: Double { centerOffset + lineWidth / 2 }
}

public enum BlueSkyOutlineStyle {
    public static let version = "blue-sky-outline-v3"
    /// Back-to-front strokes, in design pixels before final long-edge fitting.
    public static func strokes(for slot: BlueSkySlot) -> [BlueSkyOutlineStroke] {
        switch slot {
        case .photo1:
            return [.init(colorHex: "FFFFFF", centerOffset: 20, lineWidth: 12, dash: [28, 40])]
        case .photo2:
            return [.init(colorHex: "000000", lineWidth: 48), .init(colorHex: "FFFFFF", lineWidth: 32)]
        case .photo3, .photo4:
            return [.init(colorHex: "000000", lineWidth: 32), .init(colorHex: "FFFFFF", lineWidth: 24)]
        case .photo5:
            return [.init(colorHex: "FFFFFF", centerOffset: 20, lineWidth: 12)]
        }
    }
}

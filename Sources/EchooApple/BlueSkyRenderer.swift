import Foundation
import CoreGraphics
import CryptoKit
import EchooCore

public struct BlueSkyRenderOptions: Codable, Sendable {
    /// Uses the approved styling by default. Does not alter selection or source photos.
    public var outlineScale: Double
    public var showSlotBounds: Bool
    public init(outlineScale: Double = 1, showSlotBounds: Bool = false) {
        self.outlineScale = outlineScale; self.showSlotBounds = showSlotBounds
    }
}
public enum BlueSkyRenderError: Error { case invalidSelection, unverifiedCutout, missingAsset, invalidStyle }

public struct BlueSkyRenderer {
    public let assetDirectory: URL
    public init(assetDirectory: URL? = nil) throws {
        if let assetDirectory { self.assetDirectory = assetDirectory; return }
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle.main
        #endif
        guard let url = bundle.url(forResource: "BlueSky", withExtension: nil) else { throw BlueSkyRenderError.missingAsset }
        self.assetDirectory = url
    }

    public func renderVerified(plan: BlueSkyPlan, cutouts: [String: Data],
                               evidence: [BlueSkyCutoutEvaluation], options: BlueSkyRenderOptions = .init()) throws -> RenderedArtwork {
        guard Set(evidence.map(\.photoID)).count == evidence.count else { throw BlueSkyRenderError.unverifiedCutout }
        let byID = Dictionary(uniqueKeysWithValues: evidence.map { ($0.photoID, $0) })
        guard plan.selections.allSatisfy({ selected in
            guard let png = cutouts[selected.photoID] else { return false }
            let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
            return BlueSkyCutoutVerifier.verdict(byID[selected.photoID], photoID: selected.photoID,
                slot: selected.slot, cutoutDigest: digest).state == .passed
        }) else {
            throw BlueSkyRenderError.unverifiedCutout
        }
        return try render(plan: plan, cutouts: cutouts, options: options)
    }

    /// Explicit preview entry. Human confirmation is bound to each current photo/slot;
    /// it is not a production auto-verification result and never registers a ready template.
    public func renderReviewedCalibration(plan: BlueSkyPlan, cutouts: [String: Data],
                                          confirmed: [BlueSkySlot: String], options: BlueSkyRenderOptions = .init()) throws -> RenderedArtwork {
        guard confirmed.count == plan.selections.count, plan.selections.allSatisfy({ confirmed[$0.slot] == $0.photoID }) else {
            throw BlueSkyRenderError.unverifiedCutout
        }
        return try render(plan: plan, cutouts: cutouts, options: options)
    }

    private func render(plan: BlueSkyPlan, cutouts: [String: Data], options: BlueSkyRenderOptions) throws -> RenderedArtwork {
        guard plan.state == .selected, plan.selections.count <= 5,
              Set(plan.selections.map(\.slot)) == Set(plan.visibleSlots),
              Set(plan.selections.map(\.slot)).count == plan.selections.count,
              Set(plan.selections.map(\.photoID)).count == plan.selections.count,
              plan.hiddenSlots.map({ $0 == Array(BlueSkyFallback.hideOrder.prefix(5 - plan.selections.count)) }) ?? true,
              Set(cutouts.keys) == Set(plan.selections.map(\.photoID)) else { throw BlueSkyRenderError.invalidSelection }
        guard options.outlineScale.isFinite, (0...2).contains(options.outlineScale) else { throw BlueSkyRenderError.invalidStyle }
        let context = try RasterImage.context(width: BlueSkyLayout.width, height: BlueSkyLayout.height)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: BlueSkyLayout.width, height: BlueSkyLayout.height))
        let bySlot = Dictionary(uniqueKeysWithValues: plan.selections.map { ($0.slot, $0) })
        func staticImage(_ name: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double) throws {
            let image = try RasterImage.decode(Data(contentsOf: assetDirectory.appendingPathComponent(name + ".png")))
            let target = CGRect(x: x, y: Double(BlueSkyLayout.height) - y - h, width: w, height: h)
            let scale = max(w / Double(image.width), h / Double(image.height))
            let width = Double(image.width) * scale, height = Double(image.height) * scale
            context.saveGState(); context.clip(to: target)
            context.draw(image, in: CGRect(x: target.midX - width / 2, y: target.midY - height / 2, width: width, height: height))
            context.restoreGState()
        }
        func photo(_ slot: BlueSkySlot) throws {
            guard let selected = bySlot[slot] else { return }
            let image = try RasterImage.decode(cutouts[selected.photoID]!)
            let tightBounds = try RasterImage.alphaBounds(image)
            guard let tight = image.cropping(to: tightBounds) else { throw AppleAnalysisError.imageDecodeFailed }
            let styled = try Self.outlined(tight, slot: slot, scale: options.outlineScale)
            let fitted = try BlueSkySelector.fittedSize(width: Double(styled.width), height: Double(styled.height), slot: slot)
            let p = BlueSkyLayout.placements.first { $0.slot == slot }!
            context.saveGState()
            context.translateBy(x: p.centerX, y: Double(BlueSkyLayout.height) - p.centerY)
            context.rotate(by: -p.clockwiseDegrees * .pi / 180)
            // No slot clipping. Only the final 1800x2400 canvas clips overflow.
            context.draw(styled, in: CGRect(x: -fitted.width / 2, y: -fitted.height / 2, width: fitted.width, height: fitted.height))
            if options.showSlotBounds {
                context.setStrokeColor(CGColor(red: 1, green: 0.1, blue: 0.3, alpha: 0.8))
                context.setLineWidth(3)
                let side = Double(slot.side)
                context.stroke(CGRect(x: -side / 2, y: -side / 2, width: side, height: side))
            }
            context.restoreGState()
        }
        for layer in BlueSkyLayout.layers {
            switch layer {
            case let .asset(name, x, y, width, height): try staticImage(name, x, y, width, height)
            case let .photo(slot): try photo(slot)
            }
        }
        guard let image = context.makeImage() else { throw AppleAnalysisError.imageEncodeFailed }
        return .init(imageData: try RasterImage.png(image), pixelWidth: BlueSkyLayout.width,
                     pixelHeight: BlueSkyLayout.height, selectedPhotoIDs: plan.selections.map(\.photoID),
                     templateID: "pets.blue-sky-green-field")
    }

    private static func outlined(_ image: CGImage, slot: BlueSkySlot, scale: Double) throws -> CGImage {
        let strokes = BlueSkyOutlineStyle.strokes(for: slot)
        let outer = (strokes.map(\.outwardExtent).max() ?? 0) * scale
        let padding = ceil(outer) + 3
        let longest = Double(slot.side) - 2 * padding
        guard longest > 0 else { throw BlueSkyRenderError.invalidStyle }
        let factor = longest / Double(max(image.width, image.height))
        let w = max(1, Int((Double(image.width) * factor).rounded()))
        let h = max(1, Int((Double(image.height) * factor).rounded()))
        let resizedContext = try RasterImage.context(width: w, height: h)
        resizedContext.interpolationQuality = .high
        resizedContext.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let resized = resizedContext.makeImage() else { throw AppleAnalysisError.imageEncodeFailed }
        return try decorate(resized, strokes: strokes, scale: scale)
    }

    /// Outward contour offset is independent of line width. In particular,
    /// offset=20/width=12 leaves a transparent gap before the floating white ring.
    static func decorate(_ image: CGImage, strokes: [BlueSkyOutlineStroke], scale: Double = 1) throws -> CGImage {
        if scale == 0 { return image }
        let outer = (strokes.map(\.outwardExtent).max() ?? 0) * scale
        let padding = ceil(outer) + 3
        let w = image.width, h = image.height
        let width = w + 2 * Int(padding), height = h + 2 * Int(padding)
        let context = try RasterImage.context(width: width, height: height)
        let path = try contour(image, offset: padding, canvasHeight: Double(height))
        context.setLineCap(.round); context.setLineJoin(.round)
        for stroke in strokes {
            var line = path
            if stroke.centerOffset > 0 {
                // Draw the union of the filled subject and its rounded outward
                // expansion, then trace that expanded silhouette. This uses only
                // CoreGraphics, including on iOS; no model or additional mask pass.
                let expanded = try RasterImage.context(width: width, height: height)
                expanded.setFillColor(CGColor(gray: 1, alpha: 1))
                expanded.addPath(path); expanded.fillPath()
                expanded.setStrokeColor(CGColor(gray: 1, alpha: 1))
                expanded.setLineCap(.round); expanded.setLineJoin(.round)
                expanded.setLineWidth(stroke.centerOffset * 2 * scale)
                expanded.addPath(path); expanded.strokePath()
                guard let silhouette = expanded.makeImage() else { throw AppleAnalysisError.imageEncodeFailed }
                line = try contour(silhouette, offset: 0, canvasHeight: Double(height))
            }
            guard let rgb = UInt32(stroke.colorHex, radix: 16) else { throw BlueSkyRenderError.invalidStyle }
            let color = CGColor(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255,
                                blue: Double(rgb & 255) / 255, alpha: stroke.opacity)
            context.addPath(line); context.setStrokeColor(color); context.setLineWidth(stroke.lineWidth * scale)
            context.setLineDash(phase: 0, lengths: stroke.dash.map { CGFloat($0 * scale) }); context.strokePath()
        }
        context.draw(image, in: CGRect(x: padding, y: padding, width: Double(w), height: Double(h)))
        guard let result = context.makeImage(), let tight = result.cropping(to: try RasterImage.alphaBounds(result)) else {
            throw AppleAnalysisError.imageEncodeFailed
        }
        return tight
    }

    /// Pixel-boundary tracing for decorative strokes, with no Vision/cloud dependency.
    /// Alpha 128 defines only the rendering contour, never admission or mask-quality acceptance.
    private static func contour(_ image: CGImage, offset: Double, canvasHeight: Double) throws -> CGPath {
        let pixels = try RasterImage.rgba(image), w = image.width, h = image.height, stride = image.width + 1
        func filled(_ x: Int, _ y: Int) -> Bool {
            x >= 0 && y >= 0 && x < w && y < h && pixels.bytes[(y * w + x) * 4 + 3] >= 128
        }
        var edges: [Int: [Int]] = [:]
        func edge(_ x: Int, _ y: Int, _ x2: Int, _ y2: Int) {
            edges[y * stride + x, default: []].append(y2 * stride + x2)
        }
        for y in 0..<h { for x in 0..<w where filled(x, y) {
            if !filled(x, y - 1) { edge(x, y, x + 1, y) }
            if !filled(x + 1, y) { edge(x + 1, y, x + 1, y + 1) }
            if !filled(x, y + 1) { edge(x + 1, y + 1, x, y + 1) }
            if !filled(x - 1, y) { edge(x, y + 1, x, y) }
        } }
        let path = CGMutablePath()
        func point(_ vertex: Int) -> CGPoint {
            CGPoint(x: Double(vertex % stride) + offset, y: canvasHeight - Double(vertex / stride) - offset)
        }
        for start in edges.keys.sorted() {
            while edges[start] != nil {
                path.move(to: point(start)); var current = start
                while var nexts = edges[current], let next = nexts.popLast() {
                    if nexts.isEmpty { edges.removeValue(forKey: current) } else { edges[current] = nexts }
                    path.addLine(to: point(next)); current = next
                    if current == start { path.closeSubpath(); break }
                }
            }
        }
        return path
    }
}

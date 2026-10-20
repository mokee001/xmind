#if os(iOS)
import Foundation
import Photos
import UIKit
import EchooCore

public struct PhotoKitMetadata: Sendable {
    public let input: PhotoInput
    public let creationDate: Date?
    public let addedDate: Date?
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let isFavorite: Bool
    public let isPanorama: Bool
    public let isLivePhoto: Bool
    public let burstIdentifier: String?

    /// Asset selection and authorization belong to the upstream application.
    public init(asset: PHAsset, opaqueID: String) {
        let media: MediaKind = asset.mediaType == .image ? .image : asset.mediaType == .video ? .video : .other
        self.input = PhotoInput(
            id: opaqueID, mediaKind: media,
            isScreenshot: asset.mediaSubtypes.contains(.photoScreenshot)
        )
        creationDate = asset.creationDate
        if #available(iOS 26, *) { addedDate = asset.addedDate } else { addedDate = nil }
        pixelWidth = asset.pixelWidth
        pixelHeight = asset.pixelHeight
        isFavorite = asset.isFavorite
        isPanorama = asset.mediaSubtypes.contains(.photoPanorama)
        isLivePhoto = asset.mediaSubtypes.contains(.photoLive)
        burstIdentifier = asset.burstIdentifier
    }
}

/// One shared manager per caller-controlled batch; never requests permissions or fetches assets.
@MainActor
public final class PhotoKitPreviewSession {
    fileprivate let manager = PHCachingImageManager()
    public init() {}

    fileprivate static func options() -> PHImageRequestOptions {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = false
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.version = .current
        return options
    }

    public func preheat(assets: [PHAsset], maxPixel: Int = 512) {
        manager.startCachingImages(
            for: assets, targetSize: CGSize(width: maxPixel, height: maxPixel),
            contentMode: .aspectFit, options: Self.options()
        )
    }

    public func stopPreheating(assets: [PHAsset], maxPixel: Int = 512) {
        manager.stopCachingImages(
            for: assets, targetSize: CGSize(width: maxPixel, height: maxPixel),
            contentMode: .aspectFit, options: Self.options()
        )
    }

    public func source(asset: PHAsset) -> PhotoKitPhotoSource {
        PhotoKitPhotoSource(asset: asset, session: self)
    }
}

/// Immutable asset handle plus a manager isolated to the main actor.
/// The caller must not mutate/change the asset while a request is in flight.
public final class PhotoKitPhotoSource: PhotoPreviewProviding, @unchecked Sendable {
    private let asset: PHAsset
    private let session: PhotoKitPreviewSession

    fileprivate init(asset: PHAsset, session: PhotoKitPreviewSession) {
        self.asset = asset
        self.session = session
    }

    public func preview(maxPixel: Int) async throws -> PreviewResult {
        try Task.checkCancellation()
        return try await request(maxPixel: maxPixel)
    }

    @MainActor
    private func request(maxPixel: Int) async throws -> PreviewResult {
        guard (64...4096).contains(maxPixel) else { throw AppleAnalysisError.invalidPreviewSize }
        let state = PhotoKitRequestState(manager: session.manager)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard state.install(continuation) else { return }
                let identifier = session.manager.requestImage(
                for: asset, targetSize: CGSize(width: maxPixel, height: maxPixel),
                contentMode: .aspectFit, options: PhotoKitPreviewSession.options()
            ) { image, info in
                // PhotoKit callbacks are serialized onto the main actor before touching state.
                Task { @MainActor in
                    guard !state.finished else { return }
                    if (info?[PHImageCancelledKey] as? Bool) == true {
                        state.complete(.failure(CancellationError()))
                    } else if let error = info?[PHImageErrorKey] as? Error {
                        state.complete(.failure(error))
                    } else if (info?[PHImageResultIsDegradedKey] as? Bool) == true {
                        return
                    } else if let image {
                        do {
                            // Draw UIImage explicitly to apply orientation before normalization.
                            let pixelWidth = image.size.width * image.scale
                            let pixelHeight = image.size.height * image.scale
                            let factor = min(1, CGFloat(maxPixel) / max(pixelWidth, pixelHeight))
                            let size = CGSize(width: pixelWidth * factor, height: pixelHeight * factor)
                            let format = UIGraphicsImageRendererFormat()
                            format.scale = 1
                            format.opaque = true
                            let upright = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                                image.draw(in: CGRect(origin: .zero, size: size))
                            }
                            guard let cgImage = upright.cgImage else {
                                throw AppleAnalysisError.imageEncodeFailed
                            }
                            state.complete(.success(.ready(try PreviewDecoder.encode(cgImage))))
                        } catch { state.complete(.failure(error)) }
                    } else if (info?[PHImageResultIsInCloudKey] as? Bool) == true {
                        state.complete(.success(.cloudPending))
                    } else {
                        state.complete(.success(.unavailable))
                    }
                }
            }
                state.identifier = identifier
                state.timeout = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                    state.cancel()
                }
            }
        } onCancel: {
            Task { @MainActor in state.cancel() }
        }
    }
}

@MainActor
private final class PhotoKitRequestState {
    let manager: PHImageManager
    var identifier: PHImageRequestID?
    var timeout: Task<Void, Never>?
    private var continuation: CheckedContinuation<PreviewResult, Error>?
    private(set) var finished = false

    init(manager: PHImageManager) { self.manager = manager }

    func install(_ continuation: CheckedContinuation<PreviewResult, Error>) -> Bool {
        guard !finished else {
            continuation.resume(throwing: CancellationError())
            return false
        }
        self.continuation = continuation
        return true
    }

    func complete(_ result: Result<PreviewResult, Error>) {
        guard !finished else { return }
        finished = true
        timeout?.cancel()
        continuation?.resume(with: result)
        continuation = nil
    }

    func cancel() {
        if let identifier { manager.cancelImageRequest(identifier) }
        complete(.failure(CancellationError()))
    }
}
#endif

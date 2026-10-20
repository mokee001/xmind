# iOS 宿主接入示例

在 Xcode 中把这个独立目录作为本地 Swift Package 加入项目，链接 `EchooCore`、`EchooApple`、`EchooGateway`。以下示例只使用宿主已经获得的 PHAsset，不申请权限、不抓取照片库。

```swift
import Foundation
import Photos
import EchooCore
import EchooApple
import EchooGateway

@MainActor
func analyzeAlreadyObtainedAsset(
    asset: PHAsset,
    opaquePhotoID: String,
    gatewayURL: URL,
    getExistingSessionToken: @escaping @Sendable () async throws -> String
) async throws -> PhotoAnalysisResult {
    let metadata = PhotoKitMetadata(asset: asset, opaqueID: opaquePhotoID)
    let previews = PhotoKitPreviewSession()
    let source = previews.source(asset: asset)
    let gateway = try HTTPAnalysisGateway(
        baseURL: gatewayURL,
        sessionToken: getExistingSessionToken
    )
    let engine = PhotoAnalysisEngine(
        nativeAnalyzer: AppleNativeAnalyzer(), remoteAnalyzer: gateway
    )
    return await engine.process(metadata.input, source: source)
}
```

批量接入时共用一个 `PhotoKitPreviewSession` 和一个网关实例，按宿主的处理窗口调用 `preheat` / `stopPreheating`，避免为每张照片创建新的缓存管理器。示例只展示单张接口。`opaquePhotoID` 不要直接使用含斜杠的 Photos localIdentifier，可以由宿主维护不含隐私的 UUID 映射。

调用结果的 `admission.state` 为 passed 时才能展示 `assignment.themes`。pending 时展示“等待分析/资源”状态或由宿主排队恢复；不得当作不合格永久丢弃，也不得显示成准入通过。cloudPending 的后续资源获取由上游决定，重新提供本机资源后再处理。

对一批结果调用：

```swift
let albums = ThemeAlbum.assemble(from: results)
```

具体模板通过ArtworkGenerating接入。当前蓝天绿地提供BlueSkyGenerationEngine与BlueSkyArtworkGenerator，支持0～5张和常见宠物；默认状态validatingAutomation，离线/编译验证不等同生产ready。牛仔模板仍awaitingDesign。

下面连接已经准入的相册、原片API与抠图验收API；scoringPhotos、resources由宿主已获得的资源准备，不获取权限、扫描整库或开启iCloud下载。网关会核对入选照片的真实准入/pets结果，厂商凭证只在后端。

```swift
func generateBlueSky(
    results: [PhotoAnalysisResult],
    scoringPhotos: [BlueSkyGatewayPhoto],
    resources: [String: any PhotoPreviewProviding],
    originalGateway: HTTPBlueSkyGateway,
    cutoutGateway: HTTPCutoutVerificationGateway
) async throws -> BlueSkyGenerationResult {
    let album = ThemeAlbum.assemble(from: results).first { $0.theme == .pets }
        ?? ThemeAlbum(theme: .pets, photoIDs: [])
    let evidence = try await originalGateway.evaluate(photos: scoringPhotos, admittedResults: results)
    return try await BlueSkyGenerationEngine().generate(
        album: album, evaluations: evidence.evaluations, identities: evidence.identity,
        resources: resources,
        verify: { inputs in
            let photos = inputs.map { input in
                BlueSkyCutoutPhoto(
                    photoID: input.photoID,
                    original: input.cutout.inspection.original,
                    masked: input.cutout.inspection.masked,
                    cutoutPNG: input.cutout.png,
                    nativePrivacyFinding: .unknown
                )
            }
            return try await cutoutGateway.verify(photos: photos, admittedResults: results).evaluations
        }
    )
}
```

引擎在验收闭包之前对准确的源画面预览做本机隐私检查，已知命中不上传。闭包中的unknown不冒充本机无隐私。示例有意不捕获网络鉴权/格式异常；宿主可将原片API失败转换为明确缺失证据、交给引擎生成背景并保留待处理原因，不能伪造isPet或同一宠物通过。

BlueSkyGenerationEngine只加工实际入选照片，原生分割/资源不可用时替补，验收未知或失败继续重选/隐去；0张直接返回背景与固定装饰，不调用资源或验收闭包。没有物种不适用姿态的惩罚或额外质量硬门槛。返回的plan、artwork、issues可供宿主解释结果；背景成功不代表未决照片已通过。最终上屏/发布由下游处理。

注册生成器时，宿主应先完成自己的真实模型、分割及设备验证，再使用ready状态。minimumPhotoCount=0允许手动和无其他可用方案的自动背景兜底；自动路由优先能完成标准版的模板，使用既有证据，不批量调用模型。调用方主题权重继续显式传入。代码编译检查为iOS17模拟器模块，不是运行真机测试。

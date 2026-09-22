# Demo 到 TestFlight

用户于 2026-09-10 明确：后续统一先修改 Demo 预览，确认后直接更新到 TestFlight。

1. 修改 Demo／网页预览，提供可访问的结果供用户查看。尚未确认时继续完善预览。
2. 用户确认后，将对应实现合并到 App，保留其他任务已有调整，执行相关验证。
   该确认同时授权本次 TestFlight 打包与发布，无需再次请求发布许可。
3. 从确认过的 App 代码建立独立发布快照，保留完整 `src`、`modules`、`assets` 与依赖锁文件。
   排除相册原图、分析缓存、环境密钥及父目录的无关代码；忽略根原生工程时须使用 `/ios/`、
   `/android/`，不能误排除 `modules/*/ios/` 的原生模块源码。
4. 按现有 EAS `production` 配置递增构建号并打包。云构建额度不可用时，可用已配置的本机
   Xcode 与 EAS local 构建，再将确切 IPA 提交到同一个 App Store Connect 应用。
   免费套餐不支持的可选发布说明不能阻止安装包本身的提交；不为此自动购买套餐。
5. 校验 IPA 的应用标识、版本／构建号、签名，以及必要原生模块是否包含。
   `expo.ios.deploymentTarget` 保持 `17.0`，以符合照片分析和抠图模块要求。
6. 等待 Apple 处理并核对构建与现有测试组的关联。参照用户上一版实际使用的组分配，
   不新建无关组或扩大测试人员范围。上传成功、构建可测试状态与用户测试组可见性应分别确认。
7. 将版本、构建号、源码快照、IPA 校验值、提交链接和测试组核对结果记录下来，再告知用户更新入口。

项目：`@mokeee/photo-wall-app`；应用标识：`cn.mokeedesign.photowall`。
App Store Connect 应用 ID：`6808087330`。

2026-09-10 核对的现有测试组为内部组 `Team (Expo)`，ID 为
`1469f7eb-4dfa-4907-92e1-5aa09e307277`，自动接收所有构建。
构建 19 与旧构建 16 都已关联该组。后续发布应复核当前设置，不仅根据历史记录推断。
测试者的 `INSTALLED` 状态不包含其实际安装构建号，不能据此宣称手机已更新。

EAS 使用 `cli.appVersionSource=remote` 和 `build.production.autoIncrement=true`；
实际发布构建号以 IPA 和 App Store Connect 为准，不以 `app.json` 中旧的 `buildNumber` 推断。

本流程只代表 App 发布。涉及后端或设备固件时，另行核对它们的实际部署状态，不能以 App 更新替代。

下文 `outputs/` 路径均为本机归档，包含安装包和发布材料，不上传到 GitHub。独立发布快照的提交号属于对应归档内的 Git 仓库，不代表当前 App 分支的提交。

2026-09-10 19:58（北京时间），偏好管理与人物排除模式已发布为 `1.3.3（20）`：
Apple 状态为 `VALID / IN_BETA_TESTING`，构建 `b0082485-05b9-4d11-822a-99257b0689a0`
已关联现有 `Team (Expo)` 内部组。本次完整代码快照、IPA、校验值、提交与组关联记录位于
`outputs/testflight-preferences-20260910/`，状态文件为 `release-status.json`。
主项目 `ios.buildNumber` 已同步为实际发布号 `20`；不得把先前本地的 `23` 当成已发布版本。

2026-09-11，本次当前展示与偏好调整发布为 `1.3.4（24）`。Apple 已处理为 `VALID / IN_BETA_TESTING`，构建 `9ab3725f-5cb1-4665-9a9f-1065ccc3556c` 已核对关联现有 `Team (Expo)` 组（核对 UTC 2026-09-11T10:03:23.208Z）。完整代码快照、签名 IPA、SHA-256、测试与分发记录位于 `outputs/testflight-current-wall-20260911/`。本次采用封存提交 `45f27b6de3dc9df168d44727f6fd8ff10931d75c`，工作区后续继续到 `1.3.5（25）` 的改动予以保留，未降低版本号或覆盖新头像修改。此发布不代表后端、8772 人物能力或原生延长停留接口已部署。

`1.3.4（24）` 的 IPA SHA-256 为 `ed77db6e985aa087a75b1005eca3f2d17a9e4dc80669ad8f706911a9f78f1dbb`。后续 App 集成提交 `233381a` 已包含该版功能以及人物头像调整，配置已推进至 `1.3.5（27）`；它不是严格的 24 号安装包源码快照，此处也不据此宣称 27 号构建已经发布。

## 2026-09-16 · 回忆日历 App 1.3.6（29）

- 用户确认当前日历 Demo v0.3.0 后，迁移正式 App UI 与无 Tab 结构；保留真实蓝牙、配网和设备绑定链路。
- 源码提交 `fd9a863`，回退标签 `app-calendar-v1.3.6-build29`；独立构建快照提交 `9fbd7a305ace867f14307d42ec6b2a9a8b2406f8`。
- 归档目录 `outputs/calendar-native-20260916/`，安装包 `photo-wall-calendar.ipa`；签名和两个照片处理原生模块已核验。
- Apple 构建 ID `78978d5b-c95b-441e-b680-8d98117c6f32`，`VALID / IN_BETA_TESTING`，未过期；已精确核对属于原 Team (Expo) 组 `1469f7eb-4dfa-4907-92e1-5aa09e307277`。
- 提交任务 `a8314c59-9d49-42ae-897a-5c794bcaa96f` 为 FINISHED，无错误。核对时间 2026-09-16 17:57（上海）。测试者可从 TestFlight 更新；没有宣称特定手机已自动安装。
- UI 验证为真实 App 的网页导出，硬件连接使用实际函数回归；本轮未现场重新连接实体设备。
- 前后源码快照、IPA SHA256、回归与 UI 检查、Apple 和测试组证据见该目录 `release-status.json`。

## 2026-09-22 · 统一选片 App 1.3.7（30）

- 用户授权真实选片链路统一接入并更新安装包，随后自主将服务器升级为 4 vCPU / 8 GiB。
- 新包独立快照提交 `7bdd297c34f261abe047cf867f5b007f40541983`，归档目录 `outputs/unified-selection-20260922/`。
- IPA `photo-wall-unified-selection.ipa`，SHA-256 `77db49e7ff2380c2d4c17ad3a76a77207885fea41aa2bff812f12071a6b34d8c`；版本 1.3.7 / 构建 30、签名、两个照片处理原生模块及 `observeFileAsync` 均已核验，Hermes 新契约开关确认为 true。
- 提交 `044c8af4-2987-4015-bf6d-6507f7ef9f38` 为 FINISHED；Apple 构建 `22896d4f-7c8e-4e30-91dc-2d82d78fae0c` 于 16:41:37（上海）核对为 VALID / IN_BETA_TESTING，未过期，精确关联原 Team (Expo) 内部组。
- 手机从 TestFlight → Echooo 更新。没有自动安装到具体手机，也没有修改固件。
- 独立后端网关已部署，新契约流量进入 8001，其余请求仍保留原 8000；固定模型完整运行仅使用三张公开测试图。详情及回滚见 `docs/unified-selection-rollout-20260922.md`，不将此结果当作私人图库质量或实体上屏验收。
- 主项目配置已同步为构建 30，冻结的构建源码仍保留 EAS 远程递增前的 buildNumber 29；以实际签名包及 Apple 为准，不修改发布快照。

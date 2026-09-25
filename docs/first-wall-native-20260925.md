# 首次自动上屏 · App 1.3.8（31）已发布

2026-09-25 用户确认将本次 Demo 合入 App 并上传供手机测试，无需再次确认发布。

## 修复

1.3.7（30）连接完成仅触发后台同步，不自动生成或投送。本次连接/设置保存完成后，自动执行首批准备、生成、发布、真实设备回执、轻反馈。已连接但未有展示的旧会话也触发恢复。手机不展示未上屏成片，不要求正常流程确认投送。

首次选片每批读取最多60张、最多尝试上传16张，本机沿用原强规则；上传单次20秒超时，批次90秒停止继续工作（正在执行的原生分析会返回后停止）。只使用本机已有原图，不等待iCloud。已有8张合格候选可直接生成；后台暂未就绪时最多24次间隔5秒重试，第7次仍不足可追加一次有限批量。每批保留原断点。整个任务10分钟期限；设备回执最多60次检查，间隔5秒。并非承诺真实生成耗时；云端模型和网络仍影响首屏速度。

首次任务与全量上传互斥，全量同步在设备有真实回执后继续。沿用原账号、来源范围、偏好排除和版本校验。发布前持久化意图，发布后保存revision；重试与重启优先检查对应回执，不自动重复发。网络断开导致结果不确定且屏幕没有新revision时，展示检查入口及用户主动重新准备发送的出口。该明确重发可能在极端延迟下重复投送；服务端现有接口没有幂等键，本次没有擅自部署新后端。

只有对应revision的displayed_revision且无设备错误才成功。设备切换使旧请求失效。错误页面允许重试、调整照片授权；配置保留已有偏好和更新时间。

## 验证与限制

- 41项Node回归通过：首次发布、真实回执、超时重试、恢复、取消、有限追加批次、先持久化后发布、同步断点、日历和偏好。
- 7项Python接口回归通过（unittest discover）：网关真实模板渲染/候选夹具、选片上传协议。没有将夹具当作私人照片质量验收。
- JSX解析与git diff --check通过，iOS Hermes导出通过。独立iOS prebuild通过，deploymentTarget为17.0。
- 根选片基准校验发现6处既有差异（backend/dedup.py、selection_lab/server.py、selection_lab/static/index.html及三个旧测试文件）。这些文件不在本次修改内；未运行本机真实模型推理、未改变固定精选基线。
- 独立快照按锁文件完成 npm ci，使用 Expo 57.0.19 / React Native 0.86.3；未使用本机旧 ios 工程。Expo Doctor 20/21 项通过，剩余项为六个依赖有更新的补丁版本，本次保持已提交的锁文件。
- 2026-09-26，本机 Xcode Release 归档及 App Store 导出成功。IPA 为 1.3.8（31），最低 iOS 17.0；签名、LocalPhotoCurationModule、PetCutoutModule、observeFileAsync 均通过核验。包内 Hermes sourceHash 与实际 Metro JS 一致，确认统一选片开关为 true，并包含首次上屏函数和调用。
- EAS 已分配构建号 31，但免费云构建月额度耗尽，因此改用本机 Xcode 和现有正式分发凭据。下载的六份原生依赖与官方 Maven SHA1 逐一匹配；仅在本机缓存复用。未购买套餐、未修改系统 VPN 或关闭证书校验。
- 线上 capabilities 已核对 ready=true，契约为 unified-recollections-v1，基准为 c1c5683eb00c232123832a47f25ddd0d5e3e6e56。未进行本机真实模型或实体屏幕验收。

## 发布记录

独立快照与日志：`outputs/first-wall-20260925/`，快照提交 `02cffefa77058a4ba8d81c2d389144bc04f643a8`。签名包 `photo-wall-first-wall.ipa` 的 SHA-256 为 `8a6799b339036a90d9ee712da7643b1be456c447c7bdf098f0bbcee2a2e16abc`。

2026-09-26 00:50（上海）上传完成。Apple 上传任务 `aa0d51b6-1bd3-467d-92a7-20bde9758d53` 的三个文件均为 COMPLETE，任务为 PROCESSING，无错误或警告。本机 altool 已完成分析与两个分段；最后一段因连接中断，使用 Apple 官方 buildUploadFiles 接口、原上传任务和同一文件校验值补传并提交完成标记。

2026-09-26 00:54（上海）确认构建 `aa0d51b6-1bd3-467d-92a7-20bde9758d53` 为 VALID / IN_BETA_TESTING、未过期，且精确关联原 Team (Expo) 组 `1469f7eb-4dfa-4907-92e1-5aa09e307277`。手机可从 TestFlight → Echooo 更新至 1.3.8（31）。此结论不代表手机已经安装，也不代表实体屏幕已验收。

主项目 buildNumber 同步为实际发布号 31，冻结源码快照保留远程递增前的配置。签名 IPA、Apple 构建及组关联证据见归档内 release-status.json、ipa-verification.json、apple-state.json；临时签名钥匙串与凭据已清理。

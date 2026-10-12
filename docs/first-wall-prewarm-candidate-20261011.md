# 首幅预热与候选就绪提前结束 · 待确认候选

2026-10-11，用户授权执行首次生成提速。根据 `AGENTS.md` 的 Demo → 确认 → App/TestFlight 流程，本目录是独立实现候选；主 Demo 位于原工作区 `demos/calendar-app/`。本文不代表正式 App、线上服务或固件已更新。

2026-10-12 更新：用户明确要求本次直接合入并打包发布，以手机真实速度测试为准；候选已合入 `ed2940f`。本文保留候选阶段记录，实际发布进度与最终状态见 `docs/first-wall-release-20261012.md` 及对应归档。

## 不变项

- 首轮仍读取同一来源下近期 60 张，沿用本机原有预筛与排序、真实 Vision 观察数据、原图上传、正式候选校验。
- 不修改模型、主题词、筛选权重、去重或 12–24 张正式成册规则，不用数量不足回退补入未入选照片。
- 不在授权前读取照片，不在连接绑定前上传，不新增整理进度、候选数量或手动整理入口。
- 生成与发布仍分离，只有对应设备真实成功上屏回执才完成首次体验和记录日历。

## 服务端候选就绪接口

新增 `POST /api/selection/readiness`，请求与 `/api/generate` 使用同一请求模型，包含契约、来源、设备、模板、人物和主题偏好、排除项。

接口与生成共享鉴权、来源隔离、运行时就绪检查、模板检查和真实 selector，不能用原始候选总数代替偏好过滤后的实际可用性。检查不渲染、不发布，不改展示历史、最近展示照片或 last_wall。

- 成功：`{contract, ready: true, snapshot_id, input_revision}`。
- 当前来源没有结果、初筛未完成、过滤后照片不足：`{contract, ready: false, retryable: true, reason}`。
- 临时候选的人物分组尚未完成：保持原人物偏好，返回 `ready: false, retryable: true` 等正式分组；已完成的正式分组中人物无效或其他完整性错误返回 `retryable: false`。检查使用同一次读取的快照。
- 无权限 403、契约/模板不符 409、来源无效 422、未验收运行时 503，均不返回伪造 ready。

就绪结果只是当前检查结论，不是冻结的发布承诺；正式生成会再次校验，期间删除照片、改偏好或切换来源不能绕过校验。客户端连接旧服务得到 404 时仅关闭提前结束优化，保留原有有界准备流程。

后端合成数据回归：`test_selection_readiness`、`test_selection_gateway`、`test_selection_scheduling`、`test_unified_selection`、`test_selection_api` 共 55 项通过。其中 12 项新回归覆盖实际 selector 的偏好/排除/来源边界、权限、无副作用、临时/正式人物分组区别及生成前再检；独立审查复验新模块与原生成回归共 13 项通过。

本地基准检查仍发现 6 处既有差异：`backend/dedup.py`、`selection_lab/server.py`、`selection_lab/static/index.html`、`tests/test_selection_lab.py`、`tests/test_story_albums.py`、`tests/test_hybrid_albums.py`。未改这些文件，未在此环境运行真实照片推理，模型未校验。昨天已验证的线上冻结运行时不能代替本候选的未来部署验证。

## App 候选实现与验证

- 照片授权后，在原设备发现与连接过程中读取第一个来源的原 60 张窗口，预热同一原生初筛及最多 16 张原始观察结果；其他来源保持原串行流程。预热只在内存中，不发送照片、不创建上传检查点。观察尺寸与排序不变。
- 首次绑定可认领同一次未绑定预热缓存；已有账户改变或退出、照片来源/权限变化、相册变动、退后台使旧任务失效。实际上传前重读照片许可、资产修改时间和原图 URI。
- 首次上传与有节流的单个就绪请求重叠。只有服务确认当前偏好下可生成才提前结束；检查点写成功后才停，未处理项保留，真实首幅回执后再后台继续。就绪请求超时/暂时失败只失去提前结束优化；授权和明确偏好错误会传播。
- 初次及重试生成与就绪检查共用完整请求参数，不再用原始 `goodTotal >= 8` 作为偏好可用判断。
- 退后台中止当次 HTTP 与后续任务，返回时对账已保存的投送意图和版本。设备轮询提前收到回执时也会使等待页收敛；不把其他版本回执当作本次成功，不自动重复投送。

App 7 个模块共 53 项测试通过：`test_photo_prewarm`、`test_selection_readiness`、`test_first_wall_prewarm_adapter`、`test_selection_sync`、`test_first_wall_native`、`test_native_fetch_upload`、`test_native_wall_receipts`。包含实际 JS 适配器配合假原生/假服务的数据流回归；没有使用私人照片。独立复审核心 5 模块 42 项通过。

独立验证快照位于主工作区 `outputs/first-wall-prewarm-20261011/source/`，使用原始锁文件执行 `npm ci --offline --ignore-scripts`，Expo 为 57.0.19。`EXPO_PUBLIC_UNIFIED_SELECTION=1 expo export --platform ios` 成功，642 个模块生成 Hermes bundle；未生成签名 IPA、未改 App 版本、未上传 Apple。

Demo 提交为 `1dd769f`（主工作区），16 项 Demo/连接恢复测试通过。两侧合计 124 项不同测试通过，不重复计入独立复审。可体验入口为 `http://127.0.0.1:8095/?v=0.3.7#welcome`。

## 发布前仍需完成

- 用户确认本次完整 Demo，然后合并候选中的 App 与服务端变更。
- 安装新就绪接口时验证线上 frozen baseline 与实际服务源码，保留旧服务/设备链路及回滚快照；不要整体覆盖旧 `backend/server.py`。
- 按既定流程构建、上传并核对 Apple 处理及原测试组可见性。
- 真机记录授权、连接、首次候选就绪、生成完成、发布及设备回执时间。合成测试与 Demo 的时序只证明逻辑，不证明实际节省多少秒。

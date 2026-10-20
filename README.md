# Echoo Engine

独立搭建的照片准入、主题相册与模板成片引擎。没有复制、导入或调用原仓库的业务代码、模型、配置、缓存和测试结果。

本工程的边界是“已经拿到照片 → 分析与准入 → 多主题相册 → 模板选片与成片”。照片权限、原始库获取数量、iCloud 下载策略、成品上屏由宿主应用提供。本工程不会主动申请照片权限、抓取整库、开启 iCloud 下载或发布成品。

2026-10-19确认的[蓝天绿地生成规则](templates/pets.blue-sky-green-field/1.0.0/README.md)已同步到运行代码，结构化配置为[generation-rules.json](templates/pets.blue-sky-green-field/1.0.0/generation-rules.json)，规则版本blue-sky-generation-rules-v3。适用常见宠物；硬条件为宠物主体及同一个体、不重复照片，按姿态偏好、构图与边缘偏好、原片通用评分依次排序。不足五张时依次隐去photo4、photo3、photo2、photo1、photo5，零张仍输出背景及固定装饰。已完成离线规则/接口/原生渲染测试与iOS17模块编译；真实多物种模型与分割精度、真机性能仍待验证，不自动提升为生产ready。

## 当前实现

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `EchooCore` | 数据结构、准入策略、多主题归属、相册聚合、流程编排 | 已实现并测试 |
| `EchooApple` | ImageIO 预览图、Vision 分类/动物/OCR、Accelerate 质量指标、PhotoKit 输入适配 | 已实现；需要真实 iPhone 验证 Vision/PhotoKit 行为 |
| `EchooGateway` | Swift HTTP 客户端、身份/版本/图片摘要绑定、异常返回处理 | 已实现并测试 |
| `gateway/` | 阿里云图片审核、qwen3.8-flash 初评与复核、服务端缓存、本地 HTTP 测试入口 | 适配器已实现；真实服务需配置凭证后联调 |
| `echoo-audit` | 显式指定本地文件夹的小批量测试工具 | 已实现；默认不调用云端 |
| 模板接口 | 模板注册、主题内自动随机/手动选择、独立生成器协议 | 已实现；完整成片生成器待视觉验证 |
| 蓝天绿地选片 | 常见宠物、分层偏好、50/50评分、同一个体及0～5槽联合分配 | 运行v3已同步并通过离线测试；真实多物种精度待验证 |
| 蓝天绿地加工与渲染 | 物种通用原生抠图、源画面对齐验收、替补/隐去及零图背景输出 | 离线测试与原生PNG验证通过；已有猫视觉批准，多物种真实分割/验收待验证 |
| echoo-calibrate | 本地预览、评分与身份、人工复核、自动抠图验收和成片预览入口 | 通过普通本机进程启动；启动不重放API |

首个模板“蓝天绿地拼贴”已由用户确认视觉效果，定稿档案为templates/pets.blue-sky-green-field/1.0.0，状态进入 `validatingAutomation`，等待真实自动验收和其他宠物联调；“牛仔拼贴”仍为 `awaitingDesign`。两者尚未注册ready生成器。日常、美食、风景的具体模板没有被擅自定义。

## 分析流程

1. 对宿主传入的照片做媒体类型、截图标记和预览资源状态检查。视频和确定的截图直接排除，`cloudPending` 保留为待处理。
2. 请求约 512 像素、保留完整画面的预览图。ImageIO 应用方向，重新编码，并移除 EXIF/GPS/APP1/注释。
3. 本机执行 Vision 分类、动物识别和准确 OCR；计算预览图上的清晰度/明暗指标。本机 OCR 命中明确的高风险隐私表达时直接排除，不发送 API。OCR 原文和隐私值不会被保存、返回或记录日志。
4. 仍未完成的候选在配置网关后请求最大边 1536 的预览，并再次做本机隐私检查。PhotoKit 适配器两次请求均禁止网络访问；资源不在本机时交还上游处理。
5. 服务端先调用阿里云 `postImageCheckByVL`。通用厂商标签按用户范围解释；泳装、健身赤膊、露肩露腿、宗教政治、酒精等标签不会直接造成排除。范围模糊的色情/血腥告警需要语义澄清。
6. 尚未解决的准入与分类问题统一使用 `qwen3.8-flash`，关闭思考模式，返回短 JSON。未知、冲突或范围模糊的安全告警仍由 `qwen3.8-flash` 复核；这是同模型补充检查，不代表不同模型的独立交叉验证。多模态使用 JSON Object，并在服务器严格校验所有字段。
7. 所有准入检查明确为无风险才通过。有确定的排除项则排除；缺字段、资源缺失、服务不可用、模型拒答/截断和矛盾证据则待处理。待处理的准入结果不能进入展示相册。
8. 通过准入的照片自动进入日常。宠物、美食、风景按独立语义事实判定，可多选；某个主题尚未明确不会阻止日常归属。主题内保留相似照片，后续去重和精细选片由各模板负责。

**第一版没有经过实测标定的 Vision 阈值。** 原生分类首先提供证据，不把低分当作“没有该主题”，也不以单个清晰度/亮度数值直接筛除照片。因此初期通过本机预检的多数照片仍需 Flash；未来依据真实测试集标定后，再增加可可靠完成的原生判定分支。

本机隐私检测是前置拦截，不能保证所有隐私内容均被识别。漏检内容可能随预览图发送到所选服务。阿里云本地图片接入使用其临时上传桶；对象保留由厂商控制，本工程不声称立即删除。服务端不保存图片文件或模型原始回复，内存缓存仅包含结构化结果。

## 已确认的策略

- 准入排除：视频、截图、清晰度极低、主体严重曝光异常、以大量信息文字为主、监控画面、高风险隐私、关键生理部位裸露、血腥暴力。
- 高风险隐私：证件、财务/医疗资料、聊天记录、可读个人信息、密码等。
- 正常健身照、泳装照、普通人像与儿童照片不因自身类别被排除。
- 日常：全部通过准入的照片。
- 宠物：有展示价值的伴侣动物主体，可有多只宠物或人与宠物同框；动物园动物不纳入宠物。
- 美食：菜肴、甜点、饮料及相关烹饪/用餐场景；不纳入未经加工的食材；餐桌场景中的野生菌可纳入，不判断是否可食用。
- 风景：自然、城市、建筑及自然细节；人物存在时环境仍有独立展示价值即可纳入。
- 不因缺少 EXIF、图片是 PNG、长宽比、相似照片或 Live Photo 标记单独排除。

## 构建与测试

要求：Xcode（当前验证环境 27.1）、Swift 5.9+、iOS 17+、服务端 Python 3.10+。macOS 14+ 用于独立模块测试和本地工具。iOS 26+ 才读取 `PHAsset.addedDate`，旧系统留空。

GitHub分支为`mokee001/xmind`的`codex/echoo-engine-admission-blue-sky`，该分支根目录就是本独立工程，不依赖旧分支的工程或历史。完整源码包位于[releases/echoo-engine-source-20261020.zip](releases/echoo-engine-source-20261020.zip)，包含准入、四主题、模板路由、蓝天绿地选片/加工/生成、网关、测试、文档及静态设计资源；交付与复现方式见[交付说明](docs/DELIVERY.md)。

在包含`Package.swift`的工程根目录执行：

```sh
sh scripts/test-swift.sh
sh scripts/check-ios.sh
cd gateway
python3 -B -m unittest discover -s tests -v
```

测试覆盖准入未知状态、云端待处理、全部日常、多标签、动物园边界、餐桌野生菌、原料边界、原生隐私拦截、API 失败/错配/缺字段/冲突、元数据清理、缓存与 HTTP 鉴权。测试使用合成数据和替身 API，不上传真实照片，也不产生厂商调用费用。

`check-ios.sh` 编译三个库的 iOS 17 模拟器模块；它验证 API/类型兼容性，不等同于真机运行验证。HTTP 测试通过内存字节流运行真实请求解析与处理器，不需要打开监听端口。

## 本地测试工具

### 蓝天绿地小样本复核

在Finder中双击工程根目录“启动蓝天绿地选片测试.command”。API key只留在后端进程，不进入iOS包或GitHub；只生成背景时可留空。显式传入的新图库路径写在忽略目录中，没有旧图库默认值，不修改源照片。

本机生成512像素预览，以Vision动物/图片分类提供宠物线索；线索不构成主题、同一宠物或模板合格判断，没有只允许猫的过滤。页面可查看全部本地预览并选择0～20张，20为单批传输/评估上限，不是图库获取数量。详细预览最大边1536并按整批6MiB限制编码，保留完整画面。用户确认后才请求qwen3.8-flash原片评估，只有入选照片才抠图。

当前原片证据为blue-sky-pet-v2、提示词v4，选片策略v3。十四项事实包含isPet、singlePetSubject、头部/身体/视角/四边证据；不适用姿态放入受限notApplicablePreferences列表，未知不伪造成适用或通过。旧blue-sky-cat-v1结果不能重标或直接用于新评估；私人历史数据保留，明确新一轮评估才发送照片。

硬性要求只决定资格：来自准入宠物相册、主体为宠物、整组同一个体、照片不重复、指定宠物参照有效。按整组姿态命中数、构图与边缘命中数、原片已知通用评分逐级排序。七项原片评分与原权重保持；未知评分保持null，不补默认值、不单独淘汰。偏好未知、不满足或不适用都不妨碍填满标准版。

只有硬条件下无法填满五槽时才按photo4、photo3、photo2、photo1、photo5依次隐去，直到可完整分配剩余槽位；零张也输出1800×2400背景及固定装饰。计划state=selected包含少图和背景方案，mode区分standard/fallback/backgroundOnly，hiddenSlots说明隐去位置，hasPendingEvidence保留未决证据；不能把背景输出说成照片已通过全部检查。

ApplePetCutout按选中原片做通用前景分割，原始画面/灰底抠图保持同一坐标。加工验收v2只以主体正确、未被抠图误删、背景去除作为通过条件；源画面边缘完整性不再是隐藏硬门槛。失败或待确认在当前加工任务内替换、重选与隐去，保留原照片评分、身份和人工复核。资源/框架/API不可用时仍可输出不含用户照片的背景，不把失败伪装成合格。

本地界面显示当前入选数量、隐去槽位和分层排序；重启只恢复记录，不重放API。清空样本可直接生成背景，无需模型、抠图或照片资源。命令行也可运行：

```sh
.build/debug/echoo-calibrate render-background /path/to/new-output.png
```

已有同版本分析可显式沿用评分重新分配，旧轮次保留；人工宠物分组/评分仅为校准依据，不能冒充模型结果或正式准入。当前布局park-5-4-layout-v5、描边blue-sky-outline-v3及六个静态设计资产保持原批准参数，不启用镜像或主体重建。规范位于templates/pets.blue-sky-green-field/1.0.0，完整工程包见releases/；本机dist/中的独立模板冻结ZIP不随源码重复上传。

原生BlueSkyGenerationEngine和BlueSkyArtworkGenerator可供iOS宿主接入；输入上游已准入的宠物相册、调用方资源和版本匹配的分析，后端验收通过闭包提供。生成器默认validatingAutomation，不擅自注册ready。详情见docs/IOS_INTEGRATION.md。历史视觉迭代和验证范围见docs/DECISIONS.md与docs/VALIDATION.md。

### 通用准入与分类审计

```sh
.build/debug/echoo-audit /path/to/new-test-library --limit 20 --output /path/outside-library/result.json
```

默认只收集原生证据，没有完成语义与安全检查的照片明确为待处理。命令必须显式传入图库路径，不包含任何历史图库默认值。输出不能覆盖已有文件，不能写入源图库；不写入照片标签、不移动或删除照片。报告中使用照片 ID，不含 OCR 原文、位置或原图。

macOS 沙盒可能限制 Vision 的实际运行；若原生分析失败，报告保持待处理。正式验证以 iPhone 原生宿主或正常本机进程运行结果为准。

## 配置真实模型服务

仅在需要真实 API 联调时安装 `gateway/requirements.txt` 并配置 `gateway/.env.example` 对应的环境变量。 `.env.example` 不会自动加载；通过宿主服务的安全环境注入或本地终端导出变量。

```sh
cd gateway
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# 注入环境变量后
.venv/bin/python -m echoo_gateway.server
```

- `DASHSCOPE_API_KEY`：与所选地域匹配的百炼 API Key。
- `ALIBABA_CLOUD_ACCESS_KEY_ID / SECRET`：服务端内容安全凭证。
- `ECHOO_MODERATION_COVERAGE_VERIFIED`：确认所选服务的裸露/血腥检测已启用且无免审图库绕过后设为 true；未配置时保持待处理。
- `ECHOO_GATEWAY_SESSION_TOKEN`：本地网关测试令牌，至少 20 字符。生产应用需接入宿主提供的会话认证，不在客户端固化共享令牌。

厂商密钥不能放进 iOS 包或 GitHub。生产网关托管、身份系统、部署及 API 资源开通未被本工程擅自实施。示例服务器只监听回环地址，是开发联调入口。

## iOS 接入边界

宿主传入已授权的 `PHAsset`、对应的不含隐私的照片 ID、`PhotoKitPreviewSession` 和已有会话令牌提供器，构建 `PhotoAnalysisEngine` 后逐张或分批调用 `process`。宿主控制缓存窗口和并发；避免对几千张资源同时预热。相册通过 `ThemeAlbum.assemble` 聚合。示例见 [iOS 接入文档](docs/IOS_INTEGRATION.md)，执行证据见 [验证记录](docs/VALIDATION.md)。

具体模板实现 `ArtworkGenerating`，独立规定输入张数、选片、构图、主体处理、布局、输出尺寸与不足素材时的行为。宿主只把通过准入的主题相册交给生成器。自动流程在有可用模板的主题中优先标准版可生成项，声明minimumPhotoCount=0的模板允许空相册背景兜底；主题权重由调用方显式传入，不固化未确认的产品策略。手动流程获取同一注册生成器。模板需要更高清资源时由上游提供；最终返回 `RenderedArtwork`，上屏和发布交给下游。

## 尚需验证/输入

- 在真实 iPhone 和新图库上验证原生识别、性能、耗电、权限资源状态；按已确认样本测量误筛/漏筛与主题召回。
- 配置厂商服务后测量真实 API 效果、token 用量、费用、P50/P95 延迟；目前没有真实 API 实测结论。
- “蓝天绿地拼贴”的布局v5、描边v3及1号猫0～5张各档实际成品已获视觉确认；常见宠物规则、分层排序及少图/零图运行代码已同步。后续需用对应物种真实样本验证识别、同一个体判断、分割与自动验收。

## 实现参考

- [Apple：PhotoKit 缩略图加载与缓存](https://developer.apple.com/documentation/photokit/loading-and-caching-assets-and-thumbnails)
- [Apple：Vision OCR](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)
- [阿里云：图片审核大模型服务](https://help.aliyun.com/zh/document_detail/2857796.html)
- [阿里云：SDK 与本地图片接入](https://help.aliyun.com/zh/document_detail/467828.html)
- [官方 Python SDK 的 PyPI 发布记录](https://pypi.org/project/alibabacloud-green20220302/3.5.7/)
- [阿里云：视觉推理](https://help.aliyun.com/zh/model-studio/visual-reasoning)
- [阿里云：结构化输出约束](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [阿里云：地域与 Base URL](https://help.aliyun.com/zh/model-studio/base-url)

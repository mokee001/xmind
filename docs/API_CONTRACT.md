# 分析网关契约 v1

`POST /v1/analyze`，JSON，宿主提供 Bearer 会话令牌。生产需 HTTPS。开发客户端仅在显式允许时接受回环 HTTP。

请求字段：

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 固定 echoo-analysis-v1 |
| policyVersion | 固定 echoo-policy-v1；策略改变必须升级 |
| photoID | 不含用户隐私的资源 ID |
| contentDigest | 已清理 JPEG 的 SHA-256，防止结果串图 |
| jpegBase64 | 有界预览图，最多 6 MiB，禁止 EXIF/XMP APP1 |
| width / height | 与 JPEG 实际 SOF 尺寸一致，最大边 4096 |
| native | Vision 修订、粗分类标签、动物标签、本机隐私状态、OCR 区域统计和质量指标 |

API 适配器只把允许的粗分类/动物标识传给 Qwen，不传 OCR 原文、图片路径、拍摄时间、GPS 或隐私字符串。

返回字段：相同的版本/照片 ID/摘要，`findings`、`themeFacts` 和 `provenance`。findings/themeFacts 中每个值为 present、absent 或 unknown，不接受布尔值或缺省 false。

准入检查：screenshot、unreadableImage、extremeBlur、extremeExposure、informationDominant、surveillance、highRiskPrivacy、intimateExposure、bloodyViolence。

主题事实：companionAnimalIsSignificant、zooScene、preparedFoodOrDrink、wildMushroomsOnDiningTable、environmentHasDisplayValue。daily 由客户端核心规则确定。

服务不可用可返回成功 HTTP 携带未知事实及安全错误代码，也可返回 503；两种情况在引擎中均不能形成准入通过。无凭证、未开通安全检测、限流、拒答、截断、格式错误和结果冲突均不采用“默认通过”。

本地服务缓存有界且仅存内存中的已完成结构化结果。缓存键包含图片摘要、策略/提示版本、原生修订、厂商模型版本和会话范围；过期/未知/失败结果不会被当作可复用的成功结果。服务器重启后缓存消失。

## 蓝天绿地原片评估（宠物证据v2）

POST /v1/templates/blue-sky/evaluate，Bearer会话令牌及生产HTTPS。schemaVersion=echoo-blue-sky-v1、templateVersion=blue-sky-pet-v2、policyVersion、requestID、mode和photos。0～20张为单批传输限制，不决定原始库抓取数量；空批次返回空证据且不调用模型。Swift客户端在本地直接返回空证据，不请求令牌或网络。

每张含photoID、清理后的jpegBase64、contentDigest、真实width/height、nativePrivacyFinding；整批JPEG≤6MiB，禁止APP1/已知本机隐私命中。production要求上游admissionState=passed且themes含pets，Swift从PhotoAnalysisResult校验；calibration仅独立复核入口显式启用，样本需reviewed。原生粗分类不构成模板资格或同一宠物的证据。

响应绑定requestID、全部照片摘要、策略与证据版本。evaluations逐张含全部十四项facts（present/absent/unknown）：isPet、singlePetSubject、technicalBasics、headLargeProminent、headClearProminent、fullBody、halfBodyCloseUp、topDown、frontStandingOrSitting、curled及四方向Complete。scores保留七维value=1～5整数或显式null、受限reason和provenance。新增必需notApplicablePreferences数组，仅允许curled、frontStandingOrSitting、halfBodyCloseUp；列出项必须为absent，不能与present/unknown冲突、重复或使用任意字段。它不扩展通用准入Finding枚举，未知不能伪装为不适用。

每个无序照片对必须返回一次same/different/unknown和受限原因。same指同一个体宠物，不能用同种、同色或相似度/传递推断代替；缺对、重复对、摘要/版本错配均拒绝。旧blue-sky-cat-v1不能重标为宠物证据，旧缓存不跨版本使用。指定宠物使用targetPetPhotoID；非空输入参照必须在批次内，实际入选项需与参照直接same，不强制参照本身入选。

所有Qwen调用固定qwen3.8-flash。原片提示词v4覆盖常见宠物与物种适用性，SSE流式只在完整终止、结构校验成功后采信。模型仅接收短别名和去元数据预览，不发送源路径、文件名、GPS或OCR原文。初评/复核记录真实耗时与token用量，不伪造费用；拒答、截断、格式错误、调用失败或冲突保留未知。缓存隔离图片摘要、策略/提示词/模型/模式/会话范围，未知不缓存为成功。

## 选片计划与标准/兜底输出

plan.strategyVersion=blue-sky-selection-v3，生成规则blue-sky-generation-rules-v3。共同照片硬要求仅isPet，整组为samePetAcrossSelectedPhotos与不同照片不重复，指定参照继续生效；provenance/版本/摘要是证据完整性要求。身体、边缘、单主体和技术审美为偏好/评分，不是额外硬门槛。

整组目标依次为：姿态命中数 → 构图与边缘命中数 → 已知完整通用评分总和 → 稳定照片ID。每层内适用且present的偏好各计一次，层级之间不相抵；singlePetSubject计入主体构图，technicalBasics由通用评分体现，不另加二元奖励。未知或不适用偏好不加分、不阻止入选；评分缺失不补0/3，也不取消资格，保持原片rating.value=null，计划score可为空。

先尝试全部五槽的完整联合分配；无解时依次隐去photo4、photo3、photo2、photo1、photo5，直到剩余槽位可分配，最少0张。mode为standard/fallback/backgroundOnly，hiddenSlots按指定顺序记录；preferredCount为两层命中总数，另有posePreferredCount与compositionPreferredCount。state=selected包含背景方案，不代表未知照片已通过；hasPendingEvidence保留未决证据。

手动选择允许minimumPhotoCount=0的模板处理空相册；自动选择用已保存的可生成性结果优先standard，不启动模型扫描所有模板。BlueSkyArtworkGenerator默认validatingAutomation，宿主完成真实生产验证后再以ready注册。

本地/reselect复用同一版本的原片证据和评分，不调用模型；显式新一轮评估才更新事实。零样本可调用本地鉴权/background-artwork或原生CLI render-background，不需要照片API/分割。所有源图库、模型原始结果和人工复核分别保留。

## 蓝天绿地抠图后验收v2

POST /v1/templates/blue-sky/verify-cutouts，schemaVersion=echoo-blue-sky-cutout-v1、verificationVersion=blue-sky-cutout-check-v2。Bearer/生产HTTPS、上游准入与pets检查保持。每次0～5张；空批次不调用模型，Swift空请求直接返回本地空结果。

每张含photoID、nativePrivacyFinding、cutoutDigest及original/masked两组JPEGBase64/Width/Height/Digest。图像为正确朝向、未镜像的完整源画面和同坐标灰底抠图，紧边界透明PNG本机保存；整批≤6MiB，元数据/尺寸/摘要校验不变。响应绑定请求、验收版本和全部original/masked/cutout摘要，事实为correctSubject、anatomyPreserved、backgroundRemoved及四边完整性，另含provenance。

只有三个通用加工事实必须present：目标个体正确、未因分割误删原图已有主体、背景去除。四边完整性为原照片构图偏好，不再成为选片后硬门槛。目标不明确、多宠物残留、加工损坏或证据未知均不能伪装通过；最终渲染再次绑定真实PNG摘要。Qwen型号固定3.8-flash，抠图提示词v2按物种实际结构判断，不要求金鱼有爪或毛。

本地/process-artwork只在显式动作时启动，在独立processing任务中保存替补排除与有界尝试；不改原评分、身份、准入或人工基线。原生无法抠图、验收失败/未知时重新分配并逐槽隐去；服务不可用不反复上传整池，可回退静态背景。背景生成成功不标记用户照片验收通过。输出1800×2400 PNG，源库不改写，用户取消仍取消。

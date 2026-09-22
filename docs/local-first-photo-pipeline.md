# 本地优先照片识别与回退规则

## 目标

用户只需授权完整相册，不需要手动选择照片。App 先在 iPhone 上读取缩略图并筛掉截图、重文字图片、严重曝光异常和低质量照片，再将有限候选交给现有生成链路。完整原始相册不会因为授权自动上传。

当前版本是迁移阶段：完成了设备端预筛和自动全相册入口；主题语义、人脸聚类、模板渲染仍可使用云端兼容能力。最终目标是把这些识别与渲染能力逐步迁移到设备端，云端只保留模板配置、账户、远程投屏和最终作品中转。

## 三种运行模式

通过构建环境变量 `EXPO_PUBLIC_PHOTO_PIPELINE` 控制：

| 值 | 行为 | 用途 |
|---|---|---|
| `local_preferred` | 默认。先本地预筛；异常时只把最近的有限候选交给兼容云端链路 | 灰度上线 |
| `local_only` | 本地分析失败即停止，不上传完整相册 | 隐私验收和强隐私版本 |
| `cloud_legacy` | 跳过本地分析，保持原来的全量云端流程 | 紧急回滚与效果对照 |

默认候选上限由 `EXPO_PUBLIC_LOCAL_CANDIDATE_LIMIT` 控制，默认 160。安全候选下限由 `EXPO_PUBLIC_LOCAL_MINIMUM_CANDIDATES` 控制，默认 12。
首轮分析数量由 `EXPO_PUBLIC_LOCAL_INITIAL_ANALYSIS_LIMIT` 控制，默认按时间倒序分析最近 600 张，避免大相册必须等待全量分析后才出现结果。持久化增量索引完成后再在后台补齐其余照片。

## 自动回退规则

`local_preferred` 只在以下情况回退：

1. 当前安装包没有设备端模块（例如 Expo Go 或未重新安装的旧构建）。回退仍受候选上限约束。
2. Vision/PhotoKit 本地分析发生异常。
3. 本地候选低于安全下限，避免用户得到空白照片墙。

每次回退都会在同步结果中返回 `local.fallback=true` 和机器可读的 `local.reason`：

- `legacy_mode`
- `native_module_unavailable`
- `insufficient_local_candidates`
- `local_analysis_failed:<错误>`

前端会向用户展示本次是否使用设备端识别或发生安全回退。不能静默改变处理路径。

## 当前设备端规则 v1

- PhotoKit 的截图标记：直接排除。
- Vision 快速文字识别：文字行过多时排除，过滤聊天转发、海报和文档。
- 亮度与对比度：排除严重欠曝、过曝和低对比图片。
- 人脸、收藏、高分辨率、位置信息：作为正向分数，不作为硬门槛。
- 不依赖相机型号或 EXIF：别人相机拍摄后发送给用户的真实照片仍可入选。
- iCloud 中尚未下载的照片：首轮跳过，不强制联网下载；后续增量索引再处理。

阈值调整位置：

- JS 入口与候选数量：`photo-wall-app/src/deviceApi.js`
- Vision/质量规则：`photo-wall-app/modules/local-photo-curation/ios/LocalPhotoCurationModule.swift`

任何阈值调整都应同时记录规则版本，并用同一批真实照片比较入选率、截图漏网率、低质量漏网率和最终可用照片数。

## 上线与回滚

1. 内测先使用 `local_preferred`，收集 `used/fallback/reason/inspected/candidates`，不记录照片内容和人脸特征。
2. 本地成功率和最终选片质量稳定后，将测试组切到 `local_only`。
3. 若出现大范围空结果，可把构建配置切为 `cloud_legacy` 恢复旧流程；只有这个显式紧急模式会恢复全量同步，不需要撤销数据库或服务器接口。
4. 不建议长期依赖全量回退。上线隐私承诺“完整相册不上传”前，必须把生产配置锁定为 `local_only`，并完成本地渲染和直连传输。

## 尚未完成的本地化阶段

1. 持久化增量索引与 PhotoKit 变化监听。
2. Vision Feature Print 相似图去重。
3. Core ML/MobileCLIP 主题语义和本地人物聚类。
4. 模板在手机端渲染，只把最终成品交给屏幕或远程中转。
5. 蓝牙配对后通过局域网直传成品，移除本地投屏对云端格式转换的依赖。

在第 4 项完成前，产品文案必须准确表述为“完整相册先在本机筛选，仅候选进入兼容生成链路”，不能宣称所有处理已经完全离线。

# AI_IMAGE_PIPELINE_FULL_WORKFLOW.md

# AI 图片自动筛选与模板生成全流程规范
**AI Image Selection, Template Routing, Processing & Rendering Workflow Specification**

> 本文档是本项目 AI 图片处理全流程的统一执行规范（Single Source of Truth）。
>
> 无论当前使用的是本地模型、云端 API、GPT、Qwen、Gemini、Claude、其他视觉模型或未来替换的自训练模型，只要执行本项目的完整流程，都必须先读取并遵循本文档。
>
> 模型、API 或供应商可以替换，但本工作流、模板规则、结构化输入输出与质量标准应保持稳定。

---

# 0. 强制执行原则

任何执行本项目全流程的 AI / Agent / Workflow，在开始任务前必须：

1. 完整读取本文件。
2. 按本文档定义的 Pipeline 顺序执行。
3. 不得仅凭模型自身偏好跳过、重排或合并关键阶段。
4. 在“选模板”之前，必须先读取所有候选模板的轻量说明。
5. 在模板确定后，必须读取该模板的完整规范，再进行最终选图和图像处理。
6. 高成本处理必须尽量后置，仅对最终入选的图片执行。
7. 最终生成结果必须经过 Review / QA。
8. Review 不通过时优先定向修改问题区域，不应无必要地从头重跑整个 Pipeline。
9. 所有模型输出尽量使用结构化数据，而不是只输出自然语言判断。
10. 如果某个模型能力与本文档规则冲突，以本文档和模板规范为准。

---

# 1. 系统总览

完整工作流：

```text
本地 / 手机读取图片
        ↓
端侧预筛
        ↓
轻量压缩 / 缩略图打包
        ↓
上传云端 API
        ↓
云端 AI 粗筛
        ↓
形成 Qualified Image Pool
        ↓
读取全部 Template Summary
        ↓
AI 进行模板匹配与 Template Routing
        ↓
确定 Template
        ↓
读取该 Template 的完整 Template Package
        ↓
模板内最终精筛 / Slot Assignment
        ↓
按模板要求进行图像处理
        ↓
模板渲染
        ↓
Final Review / QA
        ↓
通过 → 返回网页 / App
        ↓
不通过 → 定向修正 → 再 Review
```

---

# 2. 总体架构原则

本系统采用：

**端侧轻处理 + 云端智能筛选 + 模板驱动处理 + 统一渲染 + 最终 QA**

核心原则：

- 端侧负责“明显不能用”的硬过滤。
- 云端负责真正需要视觉理解的内容判断。
- 模板不是单纯的视觉壳，而是一套规则包。
- AI 先根据图片池判断适合哪个模板。
- 模板确定后，再进行最细的选图。
- 图像处理必须由模板规则驱动。
- 最终成品必须再由模型 Review。
- 不同模型/API 必须尽量通过统一 Schema 输出标准结果。

---

# 3. Stage 1 — 本地 / 手机端预筛

## 3.1 目的

在图片上传云端之前，先排除明显不适合进入主流程的内容。

主要目标：

- 减少上传量
- 降低 API / 云端推理成本
- 提高处理速度
- 降低隐私风险
- 避免无效图片干扰后续模型判断

## 3.2 必须优先排除的内容

### A. 文件类型
排除：

- 视频
- GIF
- 不支持的动态图像格式
- 明显损坏的文件

Live Photo 可以在第一阶段仅保留静态封面帧。

---

### B. 极低质量图片
优先排除：

- 极端模糊
- 严重失焦
- 几乎不可辨认
- 严重损坏
- 严重曝光异常且无法使用

注意：

普通的运动模糊、氛围感模糊、夜景噪点等，不应仅因为“不够完美”就直接删除。

这一阶段主要排除“明显不可用”的图片。

---

### C. 无内容图片
排除：

- 纯黑
- 纯白
- 单一纯色
- 几乎完全没有有效视觉内容
- 误触产生的无意义画面

---

### D. 截图
原则上排除：

- 系统截图
- App 截图
- 聊天截图
- 网页截图
- 文档截图
- 视频截屏
- 录屏 / 屏幕录像导出的静态帧

如未来某些模板明确支持截图，可通过模板级配置允许进入。

---

### E. 隐私 / 敏感信息
优先在端侧阻断，不上传云端。

例如：

- 身份证
- 护照
- 银行卡
- 信用卡
- 密码
- 密码输入页面
- 验证码
- 支付码
- 收款码
- 医疗隐私
- 私密聊天记录
- 含高敏感个人数据的票据或文件
- 其他明显含用户私人身份信息的内容

判断不确定时，应优先保守处理。

---

### F. 重复 / 近似重复照片
必须在进入 Qualified Image Pool 之前处理：

- 完全相同的文件
- 连拍中构图和主体几乎一致的照片
- 同一张照片被重复导入、重复保存或重复导出后的版本
- 同一画面仅有轻微裁切、压缩、滤镜差异的版本

处理原则：

1. 先聚类
2. 每组只保留质量最好、主体最清晰、构图最完整的一张
3. 被判定为重复的照片不得继续进入模板槽位选择

如未来某个模板明确需要同一时刻的连续动作或多张变体，必须由模板级规则显式声明。

---

### G. NSFW / 色情内容
默认排除：

- 明显色情内容
- 明显裸露的成人内容
- 不适合进入普通消费型模板的敏感视觉内容

如未来产品有不同内容策略，应通过产品安全策略另行配置。

---

## 3.3 本阶段的边界

这一阶段：

**只做硬过滤，不做最终审美筛选。**

端侧不应该在这里判断：

- 哪张最漂亮
- 哪张最有故事感
- 哪张最适合某个模板
- 哪张应该成为 Hero Image

这些交给后续云端视觉模型。

---

## 3.4 输出

输出：

```text
Candidate Image Pool
```

即：

**可以安全进入云端粗筛阶段的候选图片池。**

---

# 4. Stage 2 — 图片轻量化与上传

## 4.1 原则

第一轮云端筛选不应默认上传全部高清原图。

应尽量先生成：

- Thumbnail
- Compressed Image
- Medium Resolution Preview

用于视觉模型第一轮理解。

---

## 4.2 推荐上传内容

每张图片至少携带：

```json
{
  "image_id": "IMG_0001",
  "width": 3024,
  "height": 4032,
  "create_time": "YYYY-MM-DDTHH:mm:ss",
  "source_type": "photo",
  "preview_asset": "...",
  "original_available": true
}
```

可选字段：

```json
{
  "local_cluster_id": "cluster_01",
  "local_quality_score": 0.91,
  "orientation": "portrait",
  "location_available": false
}
```

---

## 4.3 高清原图策略

原则：

**先看轻量版本，最终确定需要后，再请求原图。**

原图主要用于：

- 最终高质量裁切
- 抠图
- 主体分割
- 高清渲染
- Final Export

---

# 5. Stage 3 — 云端 AI 粗筛

## 5.1 目的

对 Candidate Image Pool 进行真正的视觉理解，形成：

```text
Qualified Image Pool
```

即：

**值得进入模板判断阶段的合格照片池。**

---

## 5.2 AI 需要理解的信息

建议对每张图片生成结构化特征，包括但不限于：

### 内容类型

```text
portrait
landscape
food
pet
architecture
travel
daily_life
indoor
outdoor
event
object
group_photo
selfie
other
```

### 视觉特征

- 主体是否明确
- 主体数量
- 人物数量
- 主体位置
- 横图 / 竖图 / 方图
- 视觉复杂度
- 背景复杂度
- 色彩倾向
- 明暗情况
- 构图质量
- 清晰度
- 曝光质量

### 内容价值

- 审美质量
- 信息价值
- 故事感
- 代表性
- 纪念价值
- 是否值得作为本批照片的代表

---

## 5.3 相似图处理

AI / Algorithm 应识别：

- 连拍
- 高度相似画面
- 相同人物相同场景
- 构图极其接近的重复照片

形成相似图 Cluster。

不是简单删除全部重复图。

应：

1. 聚类
2. 保留每组最优候选
3. 只允许每组最优候选进入 Qualified Image Pool
4. 后续模板精筛不得再次选入同组重复照片

注意：

Stage 5 可以补充更强的视觉聚类判断，但 Stage 1 已经命中的完全重复、视频截屏、截图、隐私图和高置信近似重复，不应再上传或传递给后续模板。

---

## 5.4 云端粗筛不做什么

此阶段：

- 不决定最终模板槽位
- 不对所有图片抠图
- 不做重型图像处理
- 不做最终模板渲染

---

## 5.5 输出

建议：

```json
{
  "qualified_images": [],
  "rejected_images": [],
  "similarity_clusters": [],
  "image_features": {}
}
```

---

# 6. Stage 4 — 读取所有模板的 Template Summary

这是整个系统的关键步骤。

在 AI 决定使用哪个模板之前：

**必须先读取所有候选模板的轻量 Template Summary。**

不能：

> AI 看到图片后凭感觉直接挑一个模板。

而应该：

```text
Qualified Image Pool
+
全部 Template Summary
↓
Template Routing
```

---

# 7. Template Package 标准

每个模板应该是一个独立的 Template Package。

推荐结构：

```text
/templates

  /template_001
    summary.yaml
    spec.yaml
    slot_rules.yaml
    processing_rules.yaml
    output_rules.yaml
    review_rules.yaml
    preview.png
    /examples

  /template_002
    ...
```

---

# 8. Template Summary

`summary.yaml`

这是模型在“选模板阶段”需要快速读取的轻量文件。

内容应尽量短、明确、机器可理解。

至少包括：

```yaml
template_id: template_001
template_name: example_template

image_count: 10

best_for:
  - travel
  - daily_life
  - mixed_content

not_recommended_for:
  - highly_repetitive_portraits

preferred_characteristics:
  - image_variety
  - clear_subjects
  - moderate_color_consistency

requires_cutout: false

style:
  - collage
  - journal

routing_notes:
  - works well when the image pool contains multiple scenes
```

---

# 9. Stage 5 — Template Routing / 模板选择

## 9.1 输入

Template Routing 模型必须同时看到：

1. Qualified Image Pool 的结构化摘要
2. 所有可用模板的 `summary.yaml`

---

## 9.2 判断依据

模型应根据：

- 图片数量
- 图片类型分布
- 人像比例
- 风景比例
- 是否存在优秀 Hero Image
- 是否存在适合抠图的主体
- 图片横竖比例
- 场景多样性
- 色彩分布
- 故事性
- 模板需要的图片数量
- 模板特殊限制

综合判断。

---

## 9.3 推荐输出

```json
{
  "chosen_template_id": "template_001",
  "match_score": 0.93,
  "reason_codes": [
    "sufficient_image_count",
    "high_content_diversity",
    "good_subject_distribution"
  ],
  "alternatives": [
    {
      "template_id": "template_003",
      "match_score": 0.81
    }
  ]
}
```

---

# 10. Stage 6 — 读取选定模板完整规范

模板确定后：

**必须从轻量 Template Summary 切换到完整 Template Package。**

至少读取：

```text
spec.yaml
slot_rules.yaml
processing_rules.yaml
output_rules.yaml
review_rules.yaml
```

只有完成这一步，才能进入最终精筛。

---

# 11. Template Full Spec

`spec.yaml`

建议包含：

- 模板目的
- 视觉特征
- 图片总数量
- 内容适用条件
- 禁止条件
- 主图要求
- 辅助图要求
- 图片多样性要求
- 色彩要求
- 文字规则
- 整体输出尺寸
- 模板特殊逻辑

---

# 12. Slot Rules

`slot_rules.yaml`

每个 Template Slot 都应该具有独立要求。

例如：

```yaml
slots:

  - slot_id: hero
    role: hero
    orientation: portrait
    preferred_content:
      - portrait
      - landscape
    subject_requirement: strong
    crop_tolerance: medium

  - slot_id: photo_02
    role: supporting
    orientation: square
    preferred_content:
      - food
      - daily_life

  - slot_id: subject_cutout
    role: cutout
    requires_cutout: true
    subject_requirement: isolated_or_clear
```

---

# 13. Stage 7 — 模板内最终精筛

模板选定之后，再从 Qualified Image Pool 中进行最终精筛。

这一阶段的目标不是：

> 找最好看的几张照片。

而是：

> 找最适合当前 Template 各个 Slot 的照片组合。

---

## 13.1 需要考虑

- Hero Slot 用哪张
- 哪张适合横裁
- 哪张适合竖裁
- 哪张适合抠图
- 哪张主体位置最符合模板
- 哪几张组合最有节奏
- 是否出现过多同场景
- 是否出现过多人像
- 是否视觉重复
- 是否与已选照片属于同一重复 / 近似重复 Cluster
- 图片之间颜色是否过于冲突

---

## 13.2 输出

推荐：

```json
{
  "template_id": "template_001",
  "slot_assignments": [
    {
      "slot_id": "hero",
      "image_id": "IMG_0018",
      "requires_original": true,
      "processing_profile": "hero_default"
    },
    {
      "slot_id": "photo_02",
      "image_id": "IMG_0024",
      "requires_original": true,
      "processing_profile": "square_crop"
    }
  ]
}
```

---

# 14. Stage 8 — 图像处理

图像处理由：

```text
Template Processing Rules
```

驱动。

不是由模型临时自由决定。

---

# 15. Processing Rules

`processing_rules.yaml`

模板应明确声明需要哪些处理。

例如：

```yaml
processing:

  crop:
    enabled: true

  cutout:
    enabled: true
    target_slots:
      - subject_cutout

  outline:
    enabled: true
    target_slots:
      - subject_cutout

  color_harmonization:
    enabled: false

  blur:
    enabled: false
```

---

# 16. 可支持的图像处理能力

包括但不限于：

- Crop
- Reframe
- Subject Segmentation
- Cutout
- Background Removal
- Outline
- Feather
- Shadow
- Blur
- Contrast
- Exposure
- Saturation
- Color Harmonization
- Resize
- Upscale
- Position Adjustment

---

# 17. 图像处理原则

## 17.1 Heavy Processing 后置

例如：

如果 500 张图上传：

```text
500
↓
粗筛
100
↓
模板确定
↓
最终选图
10
↓
只处理这 10 张
```

不要：

```text
500
↓
500 张全部抠图
↓
再选 10 张
```

---

## 17.2 模板不需要的处理不执行

例如：

```yaml
cutout:
  enabled: false
```

则不得无原因调用抠图模型。

---

# 18. Stage 9 — Template Rendering

最终选图与处理完成后：

进入模板 Renderer。

Renderer 根据：

- Template Layout
- Slot Assignment
- Processed Assets
- Text Content
- Decoration Rules
- Layer Rules
- Output Rules

生成最终结果。

---

# 19. Output Rules

`output_rules.yaml`

建议定义：

```yaml
output:

  width: 1080
  height: 1440
  aspect_ratio: "3:4"

  format:
    - png

  return:
    final_image: true
    structure_data: true
    slot_mapping: true
```

---

# 20. Stage 10 — Final Render Review / QA

模板生成完成后：

**不得立即返回给用户。**

必须先进入：

```text
Final Review / QA
```

---

# 21. Final Review 输入

Review 模型最好同时看到：

1. 最终生成图片
2. 当前 Template Full Spec
3. Slot Rules
4. Processing Rules
5. Review Rules
6. 原始选中图片
7. Slot Assignment
8. 本轮处理记录

Review 的目标不是：

> 按模型自己的审美判断漂不漂亮。

而是：

> 判断最终结果有没有正确实现这个 Template 的设计意图和规则。

---

# 22. Review 检查维度

## A. Template Correctness

检查：

- 图片数量是否正确
- Slot 是否正确
- 图片有没有放错位置
- 是否缺少元素
- 是否超出安全区域
- 是否违反模板布局

---

## B. Image Processing Quality

检查：

- 抠图是否破损
- 是否缺头发
- 是否缺肢体
- 是否错误保留背景
- 边缘是否异常
- 是否严重锯齿
- 裁切是否切脸
- 裁切是否切掉关键主体
- 是否变形
- 分辨率是否明显不足

---

## C. Visual Quality

检查：

- 整体视觉是否平衡
- 主次是否清楚
- 是否过挤
- 是否过空
- 图片是否严重互相冲突
- 色调是否异常
- 是否有明显不自然的组合

注意：

如果模板本身要求：

- 强烈留白
- 不规则裁切
- 人物出框
- 色调不一致

这些不应自动判定为错误。

Review 必须以模板本身规则为标准。

---

## D. Content Quality

检查：

- 是否出现明显重复图
- 是否出现错误主题
- 是否误选敏感图片
- 是否选入本不适合此模板的图片
- AI 图像处理是否导致语义失真

---

# 23. Review Rules

`review_rules.yaml`

每个模板可以定义自己的 Review 标准。

例如：

```yaml
review:

  minimum_score: 85

  check:
    slot_accuracy: true
    crop_quality: true
    cutout_quality: true
    visual_balance: true
    content_relevance: true

  intentional_design:
    allow_subject_overflow: true
    allow_asymmetry: true

  max_revision_rounds: 2
```

---

# 24. Review 输出标准

Review 应返回结构化数据。

例如：

```json
{
  "status": "needs_revision",
  "overall_score": 82,
  "issues": [
    {
      "type": "crop",
      "slot_id": "photo_03",
      "severity": "high",
      "problem_code": "subject_head_cropped",
      "recommended_action": "recalculate_crop"
    },
    {
      "type": "tone",
      "slot_id": "photo_07",
      "severity": "medium",
      "problem_code": "too_dark",
      "recommended_action": "adjust_exposure"
    }
  ]
}
```

---

# 25. Stage 11 — 定向返修

如果 Review 不通过：

优先只修复：

```text
issues[]
```

指向的问题。

例如：

```text
photo_03 裁切失败
↓
只重新裁切 photo_03

photo_05 抠图失败
↓
只重新抠 photo_05

整体布局错位
↓
重新执行 Renderer

图片选错
↓
仅重新执行对应 Slot 的 Selection
```

避免：

```text
Final Review Failed
↓
整个 Pipeline 从第 1 步全部重新执行
```

除非问题确实来源于上游。

---

# 26. Revision Loop

推荐：

```yaml
qa:

  pass_score: 85
  max_revision_rounds: 2
```

逻辑：

```text
Render
↓
Review

PASS
↓
返回

FAIL
↓
Targeted Revision
↓
Review

FAIL
↓
第二次 Targeted Revision
↓
Final Review

仍未通过
↓
停止循环
↓
返回当前最佳版本 + QA 状态
```

不得无限循环。

---

# 27. Stage 12 — 返回客户端

通过 Review 后：

根据当前运行环境返回。

---

## Desktop / Web Test

```text
Cloud
↓
HTTP API
↓
临时 HTML / Web Workbench
```

---

## Mobile App

```text
Cloud
↓
Backend API
↓
Mobile App
```

---

# 28. 推荐最终返回数据

```json
{
  "status": "success",
  "template_id": "template_001",
  "final_asset": "...",
  "selected_images": [],
  "slot_assignments": [],
  "qa": {
    "status": "passed",
    "score": 91
  }
}
```

---

# 29. 模型可替换原则

本 Pipeline 不应绑定：

- OpenAI
- Qwen
- Gemini
- Claude
- 任意特定供应商

不同模型只作为：

```text
Model Adapter
```

存在。

例如：

```text
GPT
↓
Adapter
↓

Qwen
↓
Adapter
↓

Gemini
↓
Adapter
↓

Local Model
↓
Adapter
↓

统一 Product Schema
```

后面的系统只认统一输出。

---

# 30. Schema 原则

不要让不同模型各自返回不同语言和格式。

例如图片理解统一返回：

```json
{
  "image_id": "IMG_001",
  "category": "portrait",
  "quality": 0.89,
  "aesthetic": 0.91,
  "subject_strength": 0.84,
  "composition": 0.86,
  "orientation": "portrait"
}
```

模板选择统一返回：

```json
{
  "template_id": "template_001",
  "score": 0.92
}
```

Slot Selection 统一返回：

```json
{
  "slot_id": "hero",
  "image_id": "IMG_018"
}
```

Review 统一返回：

```json
{
  "status": "passed",
  "score": 91,
  "issues": []
}
```

---

# 31. Golden Set / 基准集

为了确保更换不同 API / 模型后结果不会严重漂移：

建议建立：

```text
/golden-set
```

至少包含：

- 一批固定输入照片
- 端侧预筛预期结果
- 云端粗筛预期结果
- 推荐模板
- 最终选图
- Slot Assignment
- 参考抠图
- 参考成品
- QA 标准

每次更换模型：

```text
New Model
↓
Run Golden Set
↓
Compare
↓
确认是否出现 Drift
```

---

# 32. 建议项目目录

```text
/project

  AI_IMAGE_PIPELINE_FULL_WORKFLOW.md

  /schemas
    image_analysis.schema.json
    image_selection.schema.json
    template_routing.schema.json
    slot_assignment.schema.json
    processing_result.schema.json
    final_review.schema.json

  /templates

    /template_001
      summary.yaml
      spec.yaml
      slot_rules.yaml
      processing_rules.yaml
      output_rules.yaml
      review_rules.yaml
      preview.png
      /examples

    /template_002
      ...

  /golden-set
    cases.json

  /adapters
    qwen
    openai
    gemini
    local_model

  /pipeline
    prefilter
    screening
    routing
    selection
    processing
    rendering
    review
```

---

# 33. AI 每次执行前的最简检查清单

执行完整 Pipeline 前确认：

```text
[ ] 已读取 AI_IMAGE_PIPELINE_FULL_WORKFLOW.md

[ ] 已完成端侧预筛

[ ] 上传的是适用于视觉分析的轻量图片

[ ] 已完成 Cloud Coarse Screening

[ ] 已生成 Qualified Image Pool

[ ] 已读取所有候选 Template Summary

[ ] 已完成 Template Routing

[ ] 已读取被选 Template 的完整 Template Package

[ ] 已完成 Slot-aware Final Selection

[ ] 仅执行模板需要的 Image Processing

[ ] 已完成 Template Rendering

[ ] 已完成 Final Review

[ ] 若 Review Failed，已进行 Targeted Revision

[ ] 未超过最大 Revision 次数

[ ] 最终结果及 QA 状态已返回客户端
```

---

# 34. 不允许出现的流程

## 错误流程 A

```text
全部照片
↓
全部上传高清原图
↓
全部抠图
↓
再开始选照片
```

禁止。

---

## 错误流程 B

```text
粗筛
↓
AI 凭感觉随便挑模板
```

禁止。

必须读取 Template Summary。

---

## 错误流程 C

```text
模板确定
↓
没有读取模板规则
↓
模型自由发挥处理图片
```

禁止。

---

## 错误流程 D

```text
生成图片
↓
直接返回用户
```

禁止。

必须 Final Review。

---

## 错误流程 E

```text
Review Failed
↓
从端侧读取照片开始全部重跑
```

默认禁止。

优先 Targeted Revision。

---

# 35. 最终核心规则

整个系统始终遵守：

```text
先过滤
↓
再理解
↓
再选模板
↓
再按模板精筛
↓
再按模板处理
↓
再渲染
↓
再 Review
↓
再返回
```

---

# 36. 执行优先级

发生规则冲突时，优先级从高到低：

```text
1. 产品安全 / 隐私规则
2. 本全局 Pipeline Spec
3. 当前 Template Full Spec
4. 当前 Slot Rules
5. 当前 Processing Rules
6. 当前 Review Rules
7. Prompt
8. 模型自身偏好
```

模型不得以自己的审美判断覆盖明确的模板规则。

---

# 37. 版本管理

推荐在文件顶部或配置系统中维护：

```yaml
pipeline_spec_version: "1.0.0"
```

任何重要流程改变都应更新版本号。

例如：

```text
1.0.0
初始完整 Pipeline

1.1.0
增加视频抽帧能力

1.2.0
增加多模板推荐

2.0.0
核心 Pipeline 顺序发生变化
```

---

# 38. End

本文件是整个 AI 图片筛选、模板选择、图像处理、模板渲染及 Final Review 工作流的统一规范。

所有模型、API、Agent、客户端和服务端实现都应围绕本规范工作。

**模型可以替换。**

**API 可以替换。**

**执行环境可以从本地网页变成手机 App。**

但：

**Pipeline、Template Contract、Structured Output 和 QA 规则应该保持稳定。**

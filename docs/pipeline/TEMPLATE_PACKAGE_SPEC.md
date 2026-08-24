# TEMPLATE_PACKAGE_SPEC.md

# AI 图片模板包标准规范
**Template Package Specification for AI Image Pipeline**

> 本文档定义每一个模板文件夹必须包含什么、每个文件负责什么，以及 AI 在“选模板 → 选图 → 图像处理 → 渲染”阶段应该如何读取这些文件。
>
> 本规范应与全局 `AI_IMAGE_PIPELINE_FULL_WORKFLOW.md` 配合使用。
>
> 原则：
>
> - 全局 Pipeline 决定“流程怎么走”
> - Template Package 决定“这个模板具体怎么用”
> - 模型/API 可以替换
> - 模板规则、字段和输出结构应保持稳定

---

# 1. 模板包的目标

每个模板不能只是一个视觉文件或一张背景图。

每个模板都应该是一个独立的 **Template Package**，至少能够回答以下问题：

1. 这个模板适合什么类型的照片？
2. 不适合什么照片？
3. 需要多少张照片？
4. 每张照片分别放在哪里？
5. 每个图片槽位对图片有什么要求？
6. 是否需要裁切？
7. 是否需要抠图 / 主体分割？
8. 是否需要调用视觉模型或其他图像模型？
9. 如果需要模型，需要什么能力？
10. 最终生成结果的尺寸、格式、布局是什么？
11. 渲染结束后应该如何 Review？

---

# 2. 推荐模板目录结构

每个模板建议使用独立文件夹：

```text
/templates

  /template_001
    summary.yaml
    template.json
    processing.json
    review.json

    preview.png

    /assets
      background.png
      decoration_01.png
      decoration_02.png

    /examples
      example_01.jpg
      example_02.jpg
```

最小可运行模板包推荐至少包含：

```text
summary.yaml
template.json
processing.json
preview.png
```

其中：

| 文件 | 作用 |
|---|---|
| `summary.yaml` | 给 AI 快速判断“这个模板适不适合当前图片池” |
| `template.json` | 描述最终模板布局、图片槽位、尺寸、层级和输出结构 |
| `processing.json` | 描述裁切、抠图、模型调用、图像处理要求 |
| `review.json` | 描述最终生成后的模板专属 Review 规则 |
| `preview.png` | 给模型或人工快速理解模板视觉样式 |
| `/assets` | 模板固定装饰、背景、边框等资源 |
| `/examples` | 可选的正确成品示例 |

---

# 3. AI 读取模板的顺序

模板在不同阶段的读取方式不同。

---

## Stage A — 选模板阶段

AI **只需要快速读取所有模板的 `summary.yaml`**。

```text
Qualified Image Pool
+
template_001/summary.yaml
template_002/summary.yaml
template_003/summary.yaml
...
↓
Template Routing
↓
选择最匹配模板
```

这一阶段不要加载完整模板内容，避免无意义的上下文开销。

---

## Stage B — 模板选定之后

模板确定后，再读取：

```text
summary.yaml
template.json
processing.json
review.json
```

如果需要，也可以读取：

```text
preview.png
/examples
```

然后开始：

```text
模板内最终精筛
↓
Slot Assignment
↓
图像处理
↓
渲染
↓
Review
```

---

# 4. `summary.yaml`

## 4.1 作用

这是给模型快速阅读的**模板轻量说明文件**。

它必须足够简洁，让模型无需理解完整布局，就能快速判断：

> 当前这一批照片是否适合这个模板。

建议控制在较小体积，不要放复杂坐标、长 Prompt、完整渲染数据。

---

## 4.2 推荐结构

```yaml
template_id: template_001
template_name: monthly_collage_01
version: "1.0.0"

description: >
  A monthly lifestyle collage template using one dominant image
  and multiple supporting photos.

image_requirement:
  total_images: 10
  minimum_available_images: 15

best_for:
  - daily_life
  - travel
  - lifestyle
  - landscape
  - mixed_content

acceptable_content:
  - portrait
  - food
  - pet
  - architecture
  - indoor
  - outdoor

not_recommended_for:
  - highly_repetitive_portraits
  - screenshot_heavy_content
  - low_subject_variety

preferred_image_characteristics:
  - clear_subject
  - visual_variety
  - moderate_color_consistency
  - good_storytelling
  - mixed_scene_distribution

template_characteristics:
  layout_type: collage
  visual_style:
    - journal
    - memory
    - editorial
  hero_image_required: true

capabilities_required:
  vision_understanding: true
  slot_selection: true
  crop: true
  cutout: false
  segmentation: false
  generative_image_model: false

routing_notes:
  - Prefer this template when the image pool contains multiple scenes.
  - At least one visually strong image should be available for the hero slot.
  - Avoid when most images are visually identical.
```

---

# 5. `summary.yaml` 字段规范

## 基本信息

```yaml
template_id:
template_name:
version:
description:
```

---

## 图片数量

```yaml
image_requirement:
  total_images: 10
  minimum_available_images: 15
```

说明：

- `total_images`：最终模板实际使用多少张
- `minimum_available_images`：建议至少拥有多少张合格候选照片才适合使用该模板

---

## 适合内容

```yaml
best_for:
  - travel
  - daily_life
```

表示该模板最匹配的照片类型。

---

## 可接受内容

```yaml
acceptable_content:
  - portrait
  - food
```

不是最优，但可以使用。

---

## 不推荐内容

```yaml
not_recommended_for:
  - highly_repetitive_portraits
```

用于 Template Routing 阶段降低匹配分。

---

## 图片特征要求

```yaml
preferred_image_characteristics:
  - clear_subject
  - visual_variety
```

这些描述应该尽量使用简单、稳定、模型容易理解的关键词。

---

# 6. 模型能力声明 `capabilities_required`

这是模板包中非常重要的一部分。

模板必须明确告诉 Pipeline：

> 为了完成这个模板，需要调用什么类型的模型 / 能力。

例如：

```yaml
capabilities_required:
  vision_understanding: true
  slot_selection: true
  crop: true
  cutout: true
  segmentation: true
  generative_image_model: false
  text_generation: false
```

---

## 6.1 建议支持的能力字段

```yaml
capabilities_required:

  vision_understanding: true
  # 是否需要视觉理解模型

  image_scoring: true
  # 是否需要对候选图片评分

  slot_selection: true
  # 是否需要 AI 为不同 Slot 分配照片

  crop: true
  # 是否需要智能裁切

  segmentation: false
  # 是否需要主体分割

  cutout: false
  # 是否需要输出透明主体图

  background_removal: false
  # 是否需要去背景

  generative_image_model: false
  # 是否需要生成式图片模型

  image_edit_model: false
  # 是否需要 AI 图像编辑模型

  text_generation: false
  # 是否需要生成文案

  ocr: false
  # 是否需要 OCR

  upscale: false
  # 是否需要超分辨率
```

---

# 7. 不要在模板里写死具体模型名称

原则上不要：

```yaml
cutout_model: qwen-xxx
```

或者：

```yaml
vision_model: gpt-xxx
```

模板应该声明：

```yaml
capabilities_required:
  segmentation: true
```

然后由系统的 **Model Adapter / Capability Router** 决定当前使用：

```text
Qwen
GPT
Gemini
SAM
BiRefNet
自训练模型
其他 API
```

这样模板不会和某个供应商绑死。

---

# 8. 可选：模型能力建议

如果某个模板对模型能力有特殊要求，可以增加：

```yaml
capability_preferences:

  segmentation:
    subject_type:
      - person
      - object
    edge_quality: high
    alpha_mask_required: true

  vision_understanding:
    subject_position_detection: true
    composition_analysis: true
```

这里描述的是：

**能力要求**

而不是：

**具体厂商或模型名称**

---

# 9. `template.json`

## 9.1 作用

`template.json` 负责定义：

> 最终成品到底长什么样，以及图片应该被放到哪里。

这里应尽量使用确定性数据，而不是自然语言。

---

## 9.2 推荐结构

```json
{
  "template_id": "template_001",
  "version": "1.0.0",

  "canvas": {
    "width": 1080,
    "height": 1440,
    "aspect_ratio": "3:4",
    "background": "#FFFFFF"
  },

  "output": {
    "format": "png",
    "quality": 1.0
  },

  "slots": [
    {
      "slot_id": "hero",
      "type": "image",
      "role": "hero",

      "frame": {
        "x": 80,
        "y": 120,
        "width": 600,
        "height": 760
      },

      "fit": "cover",
      "clip": true,

      "requirements": {
        "preferred_orientation": "portrait",
        "strong_subject": true,
        "preferred_content": [
          "portrait",
          "landscape"
        ]
      }
    },

    {
      "slot_id": "photo_02",
      "type": "image",
      "role": "supporting",

      "frame": {
        "x": 720,
        "y": 120,
        "width": 280,
        "height": 280
      },

      "fit": "cover",
      "clip": true,

      "requirements": {
        "preferred_orientation": "square",
        "preferred_content": [
          "food",
          "daily_life",
          "pet"
        ]
      }
    }
  ],

  "text_slots": [],

  "fixed_assets": []
}
```

---

# 10. 坐标标准

建议所有模板统一使用同一种坐标标准。

推荐二选一：

---

## 方案 A：像素坐标

```json
{
  "x": 100,
  "y": 200,
  "width": 400,
  "height": 500
}
```

适合最终渲染。

---

## 方案 B：归一化坐标

```json
{
  "x": 0.1,
  "y": 0.2,
  "width": 0.4,
  "height": 0.5
}
```

所有值范围：

```text
0.0 – 1.0
```

更适合跨尺寸模板系统。

项目中一旦确定一种方式，应保持统一。

---

# 11. Slot 定义

每个图片位置都必须拥有唯一的：

```json
"slot_id"
```

例如：

```text
hero
photo_02
photo_03
background
cutout_person
sticker_01
```

AI 最终选图时不能只输出：

```text
选 IMG_001、IMG_002、IMG_003
```

而应该输出：

```json
{
  "slot_assignments": [
    {
      "slot_id": "hero",
      "image_id": "IMG_001"
    },
    {
      "slot_id": "photo_02",
      "image_id": "IMG_002"
    }
  ]
}
```

---

# 12. `processing.json`

## 12.1 作用

这个文件决定：

> 每个 Slot 的图片选好之后，接下来到底怎么处理。

所有需要：

- 裁切
- 抠图
- 分割
- 描边
- 阴影
- 模糊
- 调色
- AI 图像编辑

的要求都应该在这里明确声明。

---

# 13. `processing.json` 示例

```json
{
  "template_id": "template_001",

  "default_processing": {
    "resize": true,
    "crop": true,
    "color_adjustment": false,
    "cutout": false
  },

  "slots": {

    "hero": {
      "crop": {
        "enabled": true,
        "mode": "subject_aware",
        "preserve_face": true,
        "preserve_main_subject": true
      },

      "cutout": {
        "enabled": false
      }
    },

    "photo_02": {
      "crop": {
        "enabled": true,
        "mode": "cover"
      },

      "cutout": {
        "enabled": false
      }
    },

    "subject_cutout": {

      "crop": {
        "enabled": false
      },

      "cutout": {
        "enabled": true,
        "target": "primary_subject",
        "output": "rgba_png",
        "edge_quality": "high"
      },

      "outline": {
        "enabled": true,
        "width": 6
      },

      "shadow": {
        "enabled": true
      }
    }
  }
}
```

---

# 14. 抠图规则

如果模板需要抠图，必须显式写：

```json
{
  "cutout": {
    "enabled": true
  }
}
```

不得仅依赖 Prompt 中隐含描述。

---

## 推荐完整格式

```json
{
  "cutout": {
    "enabled": true,
    "target": "primary_subject",
    "subject_types": [
      "person"
    ],
    "output": "rgba_png",
    "alpha_mask_required": true,
    "edge_quality": "high"
  }
}
```

---

# 15. 当模板需要模型时

模板包必须明确声明模型能力。

例如需要人物抠图：

`summary.yaml`

```yaml
capabilities_required:
  vision_understanding: true
  segmentation: true
  cutout: true
```

`processing.json`

```json
{
  "cutout": {
    "enabled": true,
    "target": "person"
  }
}
```

Pipeline 看到后：

```text
Template
↓
读取 capabilities_required
↓
Capability Router
↓
寻找当前可用的 segmentation / cutout 模型
↓
执行
```

---

# 16. Capability Router 建议逻辑

模板不应该直接调用具体 API。

应该：

```text
Template Requirement
↓
Capability Router
↓
Model Adapter
↓
具体 API / Local Model
```

例如：

```text
模板要求：
segmentation = true

↓ Capability Router

当前系统可用：
BiRefNet
SAM
Qwen Image Edit
Other API

↓ 选择合适执行器

返回统一 Mask / RGBA PNG
```

---

# 17. 统一模型输入输出

不同模型可能返回完全不同结果。

因此进入模板系统之前必须转换为统一 Product Schema。

例如抠图统一输出：

```json
{
  "image_id": "IMG_018",

  "segmentation": {
    "status": "success",
    "subject_type": "person",
    "mask_asset": "mask_018.png",
    "rgba_asset": "cutout_018.png",
    "confidence": 0.96
  }
}
```

模板不需要知道：

> 这是 SAM 抠的还是其他 API 抠的。

---

# 18. `review.json`

## 18.1 作用

定义这个模板最终生成后应该怎么验收。

不同模板的视觉逻辑不同，所以 Review 不应只使用一套通用审美标准。

---

## 示例

```json
{
  "template_id": "template_001",

  "pass_score": 85,

  "max_revision_rounds": 2,

  "checks": {
    "slot_accuracy": true,
    "image_count": true,
    "crop_quality": true,
    "cutout_quality": false,
    "visual_balance": true,
    "content_relevance": true
  },

  "intentional_design": {
    "allow_asymmetry": true,
    "allow_subject_overflow": false,
    "allow_color_variation": true
  }
}
```

---

# 19. `preview.png`

每个模板推荐提供一个：

```text
preview.png
```

作用：

- 人工快速识别模板
- 多模态模型快速理解模板整体构图
- 辅助 Template Routing
- 辅助 Final Review

但是：

**preview.png 只是视觉参考，不应取代结构化规则。**

如果 Preview 与 JSON / YAML 发生冲突：

以结构化规则为准。

---

# 20. `/examples`

可选提供正确成品示例：

```text
/examples
  example_01.jpg
  example_02.jpg
  example_03.jpg
```

作用：

- 给模型理解设计意图
- 辅助选图
- 辅助 Review
- 建立 Golden Set

示例数量不宜过多。

---

# 21. 模板选择阶段的 AI 行为

AI 进行 Template Routing 时：

必须：

```text
1. 获取 Qualified Image Pool 摘要
2. 找到所有可用模板
3. 读取每个模板的 summary.yaml
4. 比较图片池特征和模板条件
5. 为模板计算匹配程度
6. 选择最高匹配模板
7. 返回 Template ID
```

这一阶段一般不需要读取：

```text
template.json
processing.json
review.json
```

---

# 22. 模板选定后的 AI 行为

模板已经确定后：

```text
1. 读取 summary.yaml
2. 读取 template.json
3. 读取 processing.json
4. 读取 review.json
5. 如有需要读取 preview.png
6. 根据 Slot Rules 做最终选图
7. 识别需要哪些模型能力
8. 调用对应能力
9. 处理图片
10. 渲染
11. Review
```

---

# 23. 模板包的最小 AI 指令

每个 Template Package 可以在 `summary.yaml` 中附加：

```yaml
execution_instruction: >
  Read this template summary during template routing.
  If this template is selected, load template.json,
  processing.json, and review.json before final image
  selection or rendering.
```

这样即使换了执行 Agent，也能快速理解使用方式。

---

# 24. 模板兼容性

模板应尽量保持：

```text
Model Agnostic
API Agnostic
Renderer Compatible
```

也就是说：

模板只声明：

```text
我要什么
```

不要声明：

```text
一定要谁来做
```

正确：

```yaml
capabilities_required:
  segmentation: true
```

不推荐：

```yaml
use_model:
  qwen_vl_xxx: true
```

---

# 25. 推荐 Template Package 最终形态

```text
template_001/

├── summary.yaml
│
│   给 Template Router 快速阅读
│
├── template.json
│
│   最终画布、Slot、尺寸、位置、层级
│
├── processing.json
│
│   裁切、抠图、分割、图像模型调用要求
│
├── review.json
│
│   Final QA 标准
│
├── preview.png
│
│   模板视觉参考
│
├── assets/
│   ├── background.png
│   └── decoration.png
│
└── examples/
    ├── example_01.jpg
    └── example_02.jpg
```

---

# 26. 最小版 Template Package

如果只是早期快速实验，可以只做：

```text
template_001/

├── summary.yaml
├── template.json
├── processing.json
└── preview.png
```

已经足够跑通：

```text
选模板
↓
最终选图
↓
判断是否需要抠图
↓
图像处理
↓
渲染
```

---

# 27. 推荐字段命名原则

所有模板尽量：

- 使用英文 key
- 使用 snake_case
- 使用稳定枚举
- 避免同一个意思出现多种字段名

例如统一使用：

```text
cutout
```

不要不同模板分别出现：

```text
remove_bg
background_delete
subject_extract
cut_person
```

这些会增加模型适配难度。

---

# 28. 不允许的模板结构

## 错误 A：全部写进一个巨大 Prompt

不推荐：

```text
template_prompt.txt
```

里面同时描述：

- 适合图片
- Slot
- 坐标
- 抠图
- 输出尺寸
- Review

原因：

难以解析，难以维护，模型之间表现不稳定。

---

## 错误 B：只有视觉模板，没有机器规则

例如只有：

```text
template.png
```

然后让 AI：

> 自己看图猜怎么填。

不推荐。

---

## 错误 C：模板写死具体 API

例如：

```json
{
  "cutout_api": "some_vendor_api"
}
```

不推荐。

模板应声明能力，系统决定执行器。

---

## 错误 D：抠图需求只存在于自然语言 Prompt

例如：

> 这张人物最好去掉背景。

不够稳定。

必须同时存在结构化字段：

```json
{
  "cutout": {
    "enabled": true
  }
}
```

---

# 29. Template Package 与全局 Pipeline 的关系

最终系统关系：

```text
AI_IMAGE_PIPELINE_FULL_WORKFLOW.md
│
│ 决定整个产品怎么跑
│
↓
Template Router
│
├── template_001/summary.yaml
├── template_002/summary.yaml
├── template_003/summary.yaml
│
↓
选择 template_002
│
↓
template_002/
├── template.json
├── processing.json
├── review.json
└── preview.png
│
↓
Final Selection
↓
Capability Routing
↓
Image Processing
↓
Rendering
↓
Review
```

---

# 30. 最终规则

每一个模板包必须做到：

### 选模板之前能回答：

> “我适合什么照片？”

由：

```text
summary.yaml
```

负责。

---

### 模板选定后能回答：

> “这些图片具体放哪里？”

由：

```text
template.json
```

负责。

---

### 模板选定后能回答：

> “这些图片需要怎么处理？需不需要模型？”

由：

```text
processing.json
+
summary.yaml / capabilities_required
```

负责。

---

### 最终能回答：

> “成品是否合格？”

由：

```text
review.json
```

负责。

---

# 31. End

Template Package 是整个 AI 图片模板系统中的独立执行单元。

正确设计应该满足：

```text
轻量 Summary
负责选模板

Structured Template JSON
负责确定最终布局

Processing JSON
负责确定图像处理和模型能力

Review JSON
负责最终质量验收
```

这样即使未来更换：

- API
- VLM
- 抠图模型
- 图像编辑模型
- Renderer
- 本地 / 云端部署方式

模板本身依然能够被新的执行系统快速理解和复用。

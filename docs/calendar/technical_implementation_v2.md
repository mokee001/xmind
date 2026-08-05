# AI 手帐日历：整体技术实现方案 v2

版本日期：2026-07-30

## 1. 文档目的

本文记录当前 MVP 已经实际运行的技术方案，包括：

- 素材如何导入和按日期整理。
- 当前选图具体如何完成。
- GPT Vision 负责哪些判断。
- 本地程序如何执行裁切、抠图、文字、插画和布局。
- 日历如何合成并完成 QA。
- 当前哪些步骤已经自动化，哪些仍是半自动。
- 后续如何接入 API，以及如何积累 2.0 训练数据。

本文描述的是当前真实实现，不把规划中的能力写成已经完成。

## 2. 当前技术结论

当前 MVP 采用：

```text
文件名日期规则
+ 本地文件过滤
+ 候选图联系表
+ 会话内 GPT Vision
+ 固定产品规则
+ 结构化处理计划
+ macOS Vision 抠图
+ Pillow 图片处理与渲染
+ 固定 Figma 模板
+ 本地 QA
```

核心分工：

```text
AI 负责理解、比较和处理决策
规则负责限制 AI 的可选范围
本地程序负责可重复执行和验收
```

当前没有训练模型权重，也没有启用 OpenAI API。`config.json` 中：

```json
{
  "decision_backend": "manual_gpt_vision",
  "api_enabled": false
}
```

处理决策由当前会话中的 GPT Vision 完成，因此不会产生独立 API 请求或 API 费用。

## 3. 当前实现状态

| 模块 | 当前实现 | 自动化程度 | 是否使用 AI |
|---|---|---:|---:|
| 文件扫描 | 扫描指定照片文件夹 | 自动 | 否 |
| 日期解析 | 从规范文件名提取日期 | 自动 | 否 |
| 文件类型排除 | 按扩展名排除视频和 GIF | 自动 | 否 |
| 完全重复检查 | SHA-256 哈希比较 | 当前按需执行 | 否 |
| 模糊、曝光、二维码检测 | 视觉复核和产品规则 | 半自动 | 是 |
| 截图分类和文字提取 | GPT Vision 读取截图 | 半自动 | 是 |
| 每日选图 | 联系表 + 同日比较 + 产品规则 | 半自动 | 是 |
| 图片内容理解 | 会话内 GPT Vision | 半自动 | 是 |
| 处理方式决策 | GPT Vision 从固定模式中选择 | 半自动 | 是 |
| API 单日决策校验 | Pydantic + 本地校验器 | 已实现，API 关闭时不调用 | 否 |
| 当前整月计划校验 | 渲染器 QA | 自动 | 否 |
| 图片抠图 | macOS Vision 前景分割 | 自动 | 否 |
| 圆图、椭圆、裁切 | Pillow | 自动 | 否 |
| 纯文字排版 | Pillow + momozhuanji | 自动 | 否 |
| 插画资产 | 当前可从设计师库匹配；7 月示例使用生成线稿 | 半自动 | 是 |
| 日期格布局 | AI 给相对方案，本地换算坐标 | 半自动 | 混合 |
| 模板合成 | Pillow 合成 Base、动态层、Overlay | 自动 | 否 |
| QA | 本地规则检查 | 自动 | 否 |
| 图文报告 | Pillow 渲染 | 自动 | 否 |

## 4. 完整运行流程

```text
一个月照片文件夹
    ↓
01. 扫描文件
    ↓
02. 从文件名提取日期
    ↓
03. 排除不支持的格式
    ↓
04. 按日期生成候选图联系表
    ↓
05. 检查重复、截图和明显不可用内容
    ↓
06. GPT Vision 按天比较候选照片
    ↓
07. 生成每日选图结果
    ↓
08. GPT Vision / Qwen 判断单日候选处理方式
    ↓
09. 全月艺术指导层复核并覆盖不合适的单日方式
    ↓
10. 本地校验结构化决策
    ↓
11. 本地执行裁切、抠图、文字和插画
    ↓
12. 将相对布局换算成模板坐标
    ↓
13. Base + 动态内容 + Overlay 合成
    ↓
14. 自动 QA，包括整月视觉节奏
    ↓
15. 输出日历、处理计划和图文报告
```

## 5. 素材整理

### 5.1 当前输入

测试照片文件夹：

```text
<input-photo-folder>/
```

当前支持进入候选图流程的格式：

- JPG
- JPEG
- PNG
- WEBP

当前直接排除：

- MOV
- MP4
- GIF
- 无法读取的文件

### 5.2 日期实现

当前 7 月测试集不依赖 EXIF，日期直接来自文件名：

```text
2026-07-08__001.jpeg
2026-07-08__002.jpeg
```

解析规则：

```regex
^2026-07-(\d{2})__
```

实现文件：

```text
tools/build_contact_sheets.py
```

解析出的日期同时作为硬性归属：

- 7 月 8 日文件只能进入 7 月 8 日格。
- 不允许为了版面效果把素材移动到其他日期。
- 下载图片缺少可靠 EXIF 时，文件名日期优先。

真实产品版本可增加 EXIF 日期读取，但当前脚本尚未集成 EXIF 优先级。

### 5.3 候选图联系表

本地程序将照片按日期分组，然后生成候选图联系表：

```text
candidates_01.jpg
candidates_02.jpg
...
```

每个缩略图同时显示：

- 日期。
- 文件名。
- 图片完整缩略图。

联系表解决的是“同一天多张照片难以快速比较”的问题。GPT Vision 可以一次查看同一批候选，而不需要逐张打开文件。

### 5.4 当前过滤方式

已经自动化：

- 文件扩展名过滤。
- 图片是否能够打开。
- 文件名日期归属。
- 最终计划中是否仍引用视频或 GIF。

当前按需执行：

- SHA-256 完全重复文件检查。
- 相似连拍人工或视觉比较。

当前由 GPT Vision 复核：

- 二维码和付款码。
- 截图是否具有生活意义。
- 严重模糊、黑屏、严重过曝或欠曝。
- 普通网页、广告、教程是否应排除。

7 月案例中，`2026-07-02__001.jpeg` 与 `2026-07-19__002.jpeg` 的 SHA-256 完全相同，因此只保留上下文更完整的 7 月 19 日。

## 6. 每日选图

### 6.1 当前实现方式

当前选图不是独立训练模型，也不是一个全自动评分程序，而是：

```text
本地联系表
+ 硬性排除规则
+ 会话内 GPT Vision 同日比较
+ 人工确认结构化结果
```

选图时只比较同一天的候选素材，不跨日期移动照片。

### 6.2 硬性规则

- 二维码、付款码和条形码不能作为主图。
- 视频和动态 GIF 不进入日历。
- 完全重复素材不能重复使用。
- 同一天原则上只选 1 张主图。
- 确有辅助价值时，单日最多 3 张素材。
- 没有合格素材时允许留白。
- 娱乐海报和专辑封面可以代表娱乐生活。
- 购物、奶茶、蛋糕等票据可以作为辅助素材，但隐私和二维码必须裁除。

### 6.3 选择优先级

综合判断顺序：

```text
审美
→ 生活意义
→ 活动事件
→ 人物关系
→ 模板适配
→ 技术质量
```

同日内容优先级：

```text
人物或合照
→ 宠物
→ 特定活动
→ 食物
→ 风景
→ 小物件
→ 构图最好
→ 工作或学习成果
```

这不是简单的固定打分。GPT Vision 会结合：

- 照片在小日期格里是否仍然看得清。
- 背景是否属于事件意义的一部分。
- 人物、宠物或活动是否比普通构图更值得记录。
- 是否与同一天其他图片高度重复。
- 是否适合当前日历模板。

### 6.4 选图输出

当前没有单独的 `selection.json`。选中的文件直接进入：

```text
runs/2026-07/treatment_plan.json
```

每个日期至少记录：

```json
{
  "day": 1,
  "sources": [
    "<input-photo-folder>/2026-07-01__005.jpg"
  ],
  "treatment": "proportional_full_image",
  "reason": "人物在草地奔跑，活动感和环境完整度都高。"
}
```

后续正式产品应将“选图”和“处理决策”拆成两个独立文件，便于单独评估选图准确率。

## 7. 图片理解和截图文字

### 7.1 图片理解

会话内 GPT Vision 负责判断：

- 内容类型。
- 主要主体。
- 人物或宠物数量。
- 背景价值。
- 裁切安全性。
- 抠图适配度。
- 小日期格可读性。
- 图片是否属于海报、截图、票据或普通照片。

当前不会为全部 135 张照片永久保存完整视觉理解 JSON，主要结果直接体现在选图理由和处理计划中。

### 7.2 截图处理

截图原图通常不直接进入日期格。GPT Vision 先读取截图内容，再根据产品规则处理：

```text
有意义聊天/笔记/网页
    ↓
提取用户原话或忠实摘要
    ↓
text_only 或 illustration_with_text
```

允许的文字来源：

- `user_caption`
- `manual_annotation`
- `ocr_note`
- `ocr_chat`
- `ocr_system_screenshot`
- `ocr_web_content`
- `reliable_event_metadata`
- `model_summary`

普通新闻、教程、广告和没有用户关联的网页内容必须排除。

隐私处理：

- 删除手机号。
- 删除地址。
- 删除订单号。
- 删除付款信息。
- 删除二维码和第三方隐私。

## 8. 图片处理决策

### 8.1 决策输入

GPT Vision 接收：

```text
当日已选中的 0-3 张素材
+ 截图文字或用户补充
+ 模板约束
+ 产品规则 JSON
+ Figma 正例和反例
```

### 8.2 当前固定处理类型

| 类型 | 用途 |
|---|---|
| `proportional_full_image` | 风景、完整环境和完整人物照片 |
| `non_cell_ratio_image` | 海报、专辑封面和特殊纵横比图片 |
| `circle_image` | 咖啡、局部物件和适合圆形聚焦的主体 |
| `oval_image_with_cutout` | 主图加票据等辅助素材 |
| `irregular_cutout` | 人物、宠物、玩偶和单主体物件 |
| `multi_irregular_cutout` | 最多 3 个透明主体组合 |
| `irregular_cutout_with_text` | 抠图主体加短文字 |
| `text_only` | 抽象感受、聊天原话和复杂文字 |
| `illustration_with_text` | 有具体可绘制场景的短文字 |
| `illustration_only` | 连续空白日期中的中性装饰 |
| `blank` | 留白 |

规则来源：

```text
rules/treatment_rules_v1.json
prompts/treatment_decision.md
docs/treatment_decision_spec_v1.md
docs/插画与文字专项校准规范_v1.md
```

### 8.3 AI 负责

- 选择处理类型。
- 指定主素材和辅助素材。
- 判断背景是否保留。
- 指定裁切重点。
- 建议圆形、椭圆或异形抠图。
- 选择文字或插画模式。
- 给出相对布局、锚点和旋转建议。
- 提供判断理由、风险和备选方案。

### 8.4 AI 不负责

- 修改日期归属。
- 自定义新的处理类型。
- 绕过图片数量和旋转限制。
- 自由修改 Figma 固定尺寸。
- 直接修改原始照片。
- 在没有证据时编造用户经历或情绪。
- 直接覆盖本地 QA 结果。

### 8.5 全月艺术指导层 v2

旧 GPT 参考版比逐日 Qwen 版更接近目标，不是因为它识别了不同的照片，而是因为它在决定每格处理方式时同时考虑了整个月。该能力现在已从会话经验固化为本地、可测试的规则层：

```text
单日模型决策
    ↓
语义到处理方式的稳定映射
    ↓
矩形 / 异形 / 文字插画 / 留白的整月节奏复核
    ↓
生成最终 treatment_plan.json
```

核心规则：

- 同一行不得连续出现三个完整矩形照片。
- 环境活动、自然风景和现场演出优先保留完整画面。
- 纸张、手持设备、人物近景、宠物关系和食物组合优先比较大尺寸异形抠图。
- 海报保留原比例；咖啡可用圆形聚焦；密集购物组合可用椭圆柔化边界。
- 只有第三方事件、没有用户自身感受的聊天内容默认留白。
- 有明确身体状态的文字可以使用“舒缓物件插画 + 原话”。
- 留白是视觉节奏的一部分，动态贴纸不能用来修补僵硬的方格照片墙。
- 大抠图允许安全越界，但主体中心仍属于原日期格，且无白边、无阴影。

实现文件：

```text
calendar_ai/art_direction.py
rules/monthly_art_direction_rules_v1.json
training/monthly_layout/gpt_july_reference_v1.json
tests/test_monthly_art_direction.py
```

其中黄金案例只保存已确认的设计决策，不保存用户原图、绝对路径或参考成图。更换视觉 API 后，该规则层仍会执行，因此审美基线不再依赖某一次对话记忆。

## 9. 结构化输出和本地校验

当前存在两层结构化数据。

### 9.1 API 单日决策结构

未来 API 批处理使用的单日决策结构定义在：

```text
calendar_ai/schemas.py
```

主要字段包括：

- `treatment_mode`
- `fallback_treatment_mode`
- `selected_asset_indices`
- `primary_asset_index`
- `subject_bbox`
- `rotation_degrees`
- `text_source`
- `short_text`
- `illustration_role`
- `illustration_category`
- `illustration_style_id`
- `layout_balance_needed`
- `consecutive_blank_run_length`

校验器位于：

```text
calendar_ai/analyzer.py
```

API 启用后会拒绝：

- 引用不存在的素材索引。
- 单日超过 3 个可见图片元素。
- 旋转超过 ±10°。
- 纯文字超过 24 个汉字。
- 插画加文字超过 14 个汉字。
- 没有文字来源却显示文字。
- 使用模型摘要伪装用户直接引语。
- 非连续空白日期使用装饰性 `illustration_only`。
- 插画模式缺少插画类别或风格 ID。

当前 `api_enabled=false`，所以整月运行不会调用 `analyzer.py`。这些结构和测试用于保证未来 API 接入时仍遵循相同产品规则。

### 9.2 当前整月执行计划

当前实际渲染读取：

```text
runs/2026-07/treatment_plan.json
```

它是面向本地渲染器的操作结构，主要记录：

- 日期。
- 已选源文件。
- 处理类型。
- 判断理由。
- 图片、文字或插画的相对位置。
- 旋转和裁切参数。

当前整月计划由会话内 GPT Vision 判断后写入，再由 `render_july_2026.py` 执行 QA。它与 API 单日输出含义一致，但字段形式尚未完全统一。

当前专项规则有 30 条校准案例，位于：

```text
training/illustration_text/calibration_cases_v1.jsonl
```

## 10. 图片处理执行

### 10.1 原图策略

- 原始照片不修改。
- 渲染器每次从源文件读取。
- 所有裁切、缩放和遮罩只作用于内存或派生资产。

### 10.2 抠图

当前抠图使用：

```text
tools/macos_foreground_cutout.swift
```

底层调用 macOS Vision 前景实例分割，输出透明 PNG。

抠图硬规则：

- 不添加白色描边。
- 不添加阴影。
- 保留透明通道。
- 主体贴边或分割失败时回退为完整图片或其他保守方式。

当前还没有集成 BiRefNet 或 SAM 2。

### 10.3 图片几何处理

Pillow 负责：

- EXIF 方向纠正。
- 等比例 `contain`。
- 等比例 `cover`。
- 主体焦点裁切。
- 圆形遮罩。
- 椭圆遮罩。
- 透明抠图缩放。
- ±10° 范围内旋转。
- 多素材合成。

实现文件：

```text
tools/render_july_2026.py
```

### 10.4 纯文字

纯文字采用：

- 字体：`momozhuanji`。
- 字体文件：模板目录中的 `fonts.ttf`。
- 固定文字区域：52×62 Figma 单位。
- 设计字号：10；当前 1500 px 成图约为 27 px。
- 最大长度：24 个汉字。
- 自动逐字换行。
- 本地根据目标区域自动缩小字号，避免溢出。

### 10.5 插画加文字

固定结构：

- 插画区域：54×50。
- 文字区域：52×14。
- 设计字号：8；当前 1500 px 成图约为 22 px。
- 文字最多 14 个汉字。
- 风格 ID：`journal_line_doodle_v1`。

插画风格：

- 单色深灰或黑色线描。
- 自然略不均匀的手绘线条。
- 低细节。
- 局部特写或单一视觉焦点。
- 人物禁止全身，只画头像、头肩、上半身或动作相关局部。
- 物品突出核心形态，不画完整环境场景。
- 明显留白。
- 无阴影。
- 无白色贴纸描边。

插画参考保存在 `training/illustration_text/references/closeup_single_focus_reference.png`。生产方案优先使用设计师插画库。当前 7 月 19 日示例采用图像生成得到热水袋和枕头线描特写，再通过本地浅色背景移除得到透明 PNG；素材遵守非全身和特写规则。

## 11. 日期格布局

### 11.1 模板

当前模板目录：

```text
<project-root>/calendar_engine/templates/calendar_template_v1/
```

主要文件：

- `base.png`
- `overlay.png`
- `fonts.ttf`
- `preview.png`

模板尺寸：

```text
1500 × 2001
```

### 11.2 当前布局分工

AI 给出：

- 处理模式。
- 日期格内相对位置。
- 相对宽高。
- 建议旋转。
- 图片、文字和辅助素材关系。

例如：

```json
{
  "kind": "text",
  "text": "怎么才周四\n好期待周末啊",
  "box": [0.09, 0.21, 0.82, 0.62],
  "rotation": 1
}
```

本地渲染器执行：

```text
相对 box
    ↓
所属日期格绝对坐标
    ↓
1500 × 2001 画布坐标
```

日期格坐标目前写在 `render_july_2026.py` 的 `GRID_X` 和 `GRID_Y` 中。后续应迁移到模板 JSON，避免模板与代码耦合。

### 11.3 图层顺序

```text
base.png
    ↓
照片、抠图、文字和插画内容层
    ↓
date.png
    ↓
overlay_sticker_static.png
    ↓
依据 decoration_plan.json 生成的 overlay_sticker_dynamic
```

静态装饰完全按模板走；动态装饰根据当月内容重新选择贴纸和位置。动态贴纸每格最多 1–2 个，不得遮挡日期数字、人物或动物面部以及重要文字。

当前模板为兼容已有 Figma 命名，也接受 `overlay_sticker_statistic.png` 作为静态装饰层。完整规则见 `静态与动态装饰层规范_v1.md`。

## 12. 输出文件

每次月份运行至少保存：

```text
runs/YYYY-MM/
├── treatment_plan.json
├── decoration_plan.json
├── render_plan.json
├── assets/
│   ├── cutouts/
│   ├── illustrations/
│   └── dynamic_stickers/
├── output/
│   ├── 最终日历.png
│   └── 预览.jpg
└── reports/
    ├── selection_report.md
    ├── treatment_report.md
    ├── qa_report.json
    ├── 选图报告_图文版.png
    └── 处理决策报告_图文版.png
```

`treatment_plan.json` 保存 AI 决策和相对布局。

`decoration_plan.json` 单独保存静态装饰来源、动态贴纸语义、位置、数量和遮挡上限。

当前动态贴纸从设计师提供的独立目录中选择。`overlay_sticker_dynamic.png` 仅作为参考合成层，不作为素材来源。素材扫描、总览、选取和透明化结果分别保存在 `sticker_library/current_catalog/` 与月份运行目录的 `assets/dynamic_stickers/from_source_library/`。

`render_plan.json` 保存执行后的实际坐标、尺寸、旋转和图层。

这样调整布局时不需要重新完成全部选图和图片理解。

## 13. 当前 QA

QA 实现在：

```text
tools/render_july_2026.py
```

当前自动检查：

- 日期是否在 1–31 日范围。
- 是否存在重复日期计划。
- 原始素材文件名日期是否与所属日期格一致。
- 图片模式是否引用 1–3 张素材。
- 无图片模式是否错误引用照片。
- 是否引用不存在的文件。
- 是否混入 GIF、MOV 或 MP4。
- 旋转是否超过 ±10°。
- 文字长度是否超过模式限制。
- 插画资产是否存在。
- 插画计划是否声明局部特写或单一视觉焦点。
- 插画计划是否明确禁止人物全身构图。
- 图层是否按 base、content、date、静态装饰、动态装饰顺序执行。
- 动态贴纸是否具有内容匹配依据。
- 动态贴纸是否能追溯到用户提供的素材目录文件。
- 处理后的动态贴纸是否具有有效透明背景。
- 每格动态贴纸是否超过 2 个。
- 动态贴纸是否遮挡任意日期数字。
- 动态贴纸覆盖率是否超过单格面积的 25%。
- 7 月 24 日票据是否裁除二维码区域。
- 是否启用抠图白边或阴影。
- 最终输出是否为 1500×2001。
- 最终 PNG 是否可以正常读取。

当前尚未完全自动化：

- 基于 alpha mask 的相邻日期碰撞。
- 日期数字的逐像素遮挡检测。
- 主体视觉中心是否误入其他日期。
- 每种处理方式的审美评分。
- API 单日决策结构到整月渲染计划的自动转换。

因此当前 QA 能保证硬性工程规则，但最终审美仍需要查看成图。

## 14. 7 月实际运行结果

输入：

```text
135 个文件
```

输出：

- 22 个真实照片日期。
- 2 个纯文字日期。
- 1 个插画加文字日期。
- 6 个留白日期。
- 25 个有内容日期。
- 27 个可见元素。

新增文字内容：

- 7 月 8 日：阅读生活相关重要事件，使用纯文字。
- 7 月 16 日：期待周末的聊天原话，使用纯文字。
- 7 月 19 日：身体状态与休息记录，使用插画加文字。

最终 QA：

```text
PASS
```

## 15. API 接入状态

API 代码已经准备：

```text
calendar_ai/analyzer.py
calendar_ai/schemas.py
calendar_ai/keychain.py
scripts/analyze_day.py
scripts/analyze_single.py
scripts/test_api.py
```

密钥设计：

- API Key 保存在 macOS 钥匙串。
- 不写入项目文件。
- 不写入 Git。
- 只有执行分析命令时才上传明确指定的照片。

当前 `api_enabled=false`，所以这些入口不会发起请求。

以后启用 API 后，替换的是：

```text
会话内 GPT Vision
    ↓
OpenAI Responses API 批量调用
```

规则 JSON、提示词、结构化输出、本地执行器和 QA 不需要推倒重做。

## 16. 当前主要缺口

要变成真正的一键本地工作流，还需要：

1. 将 EXIF 日期读取集成到导入脚本。
2. 将 SHA-256、pHash 和连拍聚类整合成固定步骤。
3. 增加本地模糊、曝光和黑屏检测。
4. 增加二维码和条形码本地检测。
5. 将截图分类和 OCR 变成批量自动步骤。
6. 将选图输出拆成独立 `selection.json`。
7. 将日期格坐标从代码迁移到模板 JSON。
8. 增加布局候选生成和碰撞检查。
9. 增加抠图失败自动回退。
10. 将整个月工作流封装成一个命令或本地界面。

## 17. 2.0 训练数据积累

当前每次运行应保留：

- 原始候选列表。
- 排除原因。
- 每日选中素材。
- GPT Vision 处理决策。
- 人工修订后的最终处理方式。
- 相对布局和最终坐标。
- 抠图资产。
- 最终日历。
- QA 结果。

后续可训练或微调的部分：

1. 每日候选排序模型。
2. 图片处理方式分类模型。
3. 文字、插画和留白决策模型。
4. 个性化审美模型。
5. 日期格相对布局模型。

当前最有价值的训练标签不是模型第一次输出，而是：

> 用户最终保留或修改后的处理方式和布局。

## 18. 关键文件索引

```text
README.md
config.json

calendar_ai/
  analyzer.py
  schemas.py
  keychain.py

rules/
  treatment_rules_v1.json

prompts/
  treatment_decision.md

docs/
  AI手帐日历_整体技术实现方案_v2.md
  treatment_decision_spec_v1.md
  插画与文字专项校准规范_v1.md

tools/
  build_contact_sheets.py
  macos_foreground_cutout.swift
  render_july_2026.py
  render_visual_reports.py

training/illustration_text/
  calibration_cases_v1.jsonl
  annotation_template.csv
  style_manifest_v1.json
  references/
```

## 19. 最终架构原则

当前 MVP 不依赖某一个不可替换的模型。

```text
模型可以替换
规则保持稳定
执行器保持确定
过程数据持续积累
```

未来无论使用 OpenAI API、本地视觉模型或专项训练模型，都应继续输出同一种结构化计划，再由本地处理和渲染系统执行。

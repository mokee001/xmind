# AI 手帐日历静态与动态装饰层规范 v1

版本日期：2026-07-30

## 1. 目的

装饰层与日历内容层分开管理，避免把模板固定装饰和内容相关贴纸混为一张不可调整的图片。

固定图层顺序：

```text
base
→ content
→ date
→ overlay_sticker_static
→ overlay_sticker_dynamic
```

图层顺序不能交换。

## 2. 静态装饰层

静态装饰层完全由设计模板提供，不根据相册内容变化。

包括：

- 模板固定猫头。
- 模板固定星星。
- 模板固定播放器、耳机等主题元素。
- 设计师预设且每个月都应保留的装饰。

渲染器优先读取：

```text
overlay_sticker_static.png
```

为兼容当前 Figma 导出命名，也支持：

```text
overlay_sticker_statistic.png
```

静态层只跟随模板版本更新，不进入 AI 选择。

## 3. 动态装饰层

动态装饰层根据当月已选内容重新选择贴纸、位置和大小。

AI 或人工规则只输出 `decoration_plan.json`，本地渲染器负责读取透明贴纸、缩放、旋转、碰撞检查和合成。

动态贴纸只能强化已存在的内容，不得虚构当天发生的事情。

## 4. 语义匹配

| 内容类型 | 推荐贴纸 |
|---|---|
| 纸质图片、信件、票据、手作卡片 | 图钉、别针、胶带、小贴纸 |
| 人物、宠物、亲密互动 | 爱心、吻、亲密关系符号 |
| 风景、旅行、户外空间 | 相机、星星、彩虹 |
| 音乐、演出、影视、专辑 | 音量、喇叭、音响、唱片、音符 |
| 空白处或纯版面平衡 | 轮廓星星、小闪光、抽象符号 |

空白处只能使用没有具体事件指向的抽象贴纸。

## 5. 数量与密度

- 一处日期格最多出现 1–2 个视觉贴纸。
- 一组由两个爱心组成的贴纸按 2 个视觉贴纸计数。
- 默认整月最多装饰 8 个日期格。
- 动态装饰不是每格必需；没有明显增强作用时不放。
- 单格动态贴纸的不透明像素覆盖率不得超过日期格面积的 25%。

## 6. 位置规则

- 优先放在照片留白、主体边缘或格子边界附近。
- 不得遮挡任何日期数字。
- 不得遮挡人物或动物面部。
- 不得遮挡图片中的重要文字、票据金额或主要物品。
- 可以轻微跨出所属日期格。
- 跨格后仍须能清楚理解贴纸属于哪个日期。
- 旋转角度绝对值不得超过 10°。

## 7. 数据结构

每个月使用独立的：

```text
runs/YYYY-MM/decoration_plan.json
```

核心结构：

```json
{
  "layer_order": [
    "base",
    "content",
    "date",
    "overlay_sticker_static",
    "overlay_sticker_dynamic"
  ],
  "static_layer": {
    "mode": "template_fixed"
  },
  "dynamic_layer": {
    "policy": {
      "maximum_visual_stickers_per_cell": 2,
      "maximum_decorated_cells_per_month": 8,
      "maximum_opaque_coverage_ratio_per_cell": 0.25
    },
    "items": [
      {
        "id": "day02_music_record",
        "owner_day": 2,
        "category": "music_and_film",
        "semantic_trigger": "现场唱歌与音乐活动",
        "asset": "assets/dynamic_stickers/music_record.png",
        "anchor_scope": "owner_cell",
        "box": [0.65, 0.60, 0.34, 0.36],
        "rotation": 4,
        "visual_count": 1
      }
    ]
  }
}
```

## 8. 本地执行流程

```text
读取已选照片与处理计划
→ 判断内容类别
→ 从透明贴纸库选择候选
→ 枚举日期格边缘和留白位置
→ 检查日期数字、主体和文字遮挡
→ 检查单格贴纸数量与覆盖率
→ 生成 decoration_plan.json
→ 本地渲染动态贴纸层
→ QA
```

## 9. 自动 QA

当前渲染器检查：

- 五层顺序是否正确。
- 日期层和静态装饰层是否存在。
- 动态贴纸资产是否存在。
- 每个动态贴纸是否记录语义匹配依据。
- 每格视觉贴纸是否超过 2 个。
- 整月装饰日期格是否超过 8 个。
- 动态贴纸是否遮挡任意日期数字保护区。
- 不透明像素覆盖率是否超过 25%。
- 旋转角度是否超过 10°。

人物或动物面部、重要文字的遮挡仍需要视觉模型或人工做最终复核；本地 QA 负责确定性边界。

## 10. 当前模板兼容说明

当前 Figma 模板已经提供：

```text
base.png
date.png
overlay_sticker_statistic.png
overlay_sticker_dynamic.png
```

其中 `overlay_sticker_dynamic.png` 是完整参考成图对应的动态装饰结果，只用于说明预期位置和效果，不是贴纸素材库，也不直接整张固定叠加。

当前独立贴纸来源目录为：

```text
/path/to/overlay_sticker_dynamic
```

当前流程：

```text
扫描独立贴纸目录
→ 生成带文件名的素材总览与 JSON 清单
→ 按当月内容选择素材
→ 将白底 JPG 本地转换为透明 PNG
→ 写入 decoration_plan.json
→ 渲染与 QA
```

对应工具：

```text
tools/index_dynamic_sticker_folder.py
tools/prepare_sticker_selection.py
```

当前清单：

```text
sticker_library/current_catalog/sticker_source_catalog.json
sticker_library/current_catalog/sticker_source_contact_sheet.jpg
sticker_library/current_catalog/selection_v1.json
```

当前目录仍视为设计师提供的临时素材池。后续正式素材库应增加稳定的素材 ID、语义分类、关键词、颜色、适用场景、禁用场景、透明背景版本和授权信息。

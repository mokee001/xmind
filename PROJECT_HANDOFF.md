# 项目交接文档 · pet-calendar

**用途**: 开新对话时把这份文档粘贴到开头, 让 AI 助手快速了解项目现状。

---

## 项目定位

产品名: **宠物拼贴海报** (v2, 内部代号 collage)
形态: 自动读取用户相册, 用 AI 选片 + 抠图 + 合成一张风格化拼贴海报
目标定位: 完全自动化, 用户零参与

当前风格: **denim** (牛仔拼贴风, Figma 手工设计)
未来计划: cute / fresh / 风景背景版 等更多风格模板

## 目录结构

```
/Users/xinzi/🗃️项目需求/📅X/pet-calendar/
├── venv-collage/                       Python 独立环境
├── raw/                                原始相册照片 (200 张宠物为主)
├── pet-only/                           人工筛选的宠物验证集
├── templates/denim/                    denim 风格 Figma 素材
│   ├── template.json                   Figma 布局配置
│   ├── background.png                  牛仔拼贴背景
│   └── sticker_*.png                   16 个装饰素材
├── cache/
│   ├── scores.json                     VLM 打分数据 (200 张 × 29 字段)
│   └── collage_denim_selection.json    选片结果
├── output/collage_denim.png            成品海报
├── assets/collage_denim-cutouts/       抠图缓存
├── archives/v1.5-single-cell-2026-08-05/  v1.5 单格日历存档 (已舍弃)
├── score_photos.py                     VLM 打分
├── select_for_collage.py               选片脚本
├── render_collage.py                   渲染脚本
├── cutout_apple.py                     Apple Vision 抠图
└── fetch_figma_template.py             Figma API 拉布局
```

## 环境

- **venv-collage**: `source venv-collage/bin/activate` 激活
- 依赖: pillow, pillow-heif, rembg (未使用), dashscope, pyobjc-framework-Vision, python-dotenv
- **rembg 在本机环境有兼容性问题**, 已放弃, 完全用 Apple Vision Framework 抠图
- macOS 26.5.2 + Apple Silicon + Swift 6.3
- Xcode Command Line Tools 已装 (swift 命令可用)

## VLM 打分数据结构 (cache/scores.json)

每张照片 29 个字段:

**基础与主体** (9)
- is_pet, pet_count, pet_relation, has_human, has_face, human_pet_interaction
- blur_type (none/motion/out_of_focus), subject_position, subject_ratio (0-100)

**质量与瞬间** (3)
- technical_quality (0-10), life_moment (0-10), face_score (0-10)

**描述** (3)
- scene, activity, caption (未在拼贴海报里显示但生成了)

**宠物特征** (3)
- pet_id (颜色-花纹-毛长-品种猜测, 用前两段聚类同一只猫)
- body_orientation (horizontal/vertical/square)
- pose_and_expression (姿态-表情 组合标签)

**拼贴海报选片专用** (4)
- hero_potential (0-10, 作为主图冲击力潜力)
- emotion_type (sleepy/alert/playful 等 10 种)
- has_nearby_objects (true/false, 是否有紧挨杂物/玩偶)
- background_complexity (0-5)

**色彩** (2)
- dominant_color (#RRGGBB), color_hex_list (top 3 hex 数组)

**v3 风景背景专用** (5, 目前 v2 未使用)
- landscape_score (0-10), landscape_type (nature/urban 等)
- image_orientation, brightness (0-10)
- color_family (blue/green/red/pink/purple/yellow/orange/earth/white/black/gray/mixed)

## 选片策略 (select_for_collage.py 当前 v2.1)

### 层一: 硬过滤 (strict, 一票否决)

- is_pet == true
- pet_count == 1 (单猫, 排除多猫混乱抠图)
- has_human == false (只过滤 has_human 不过滤 has_face, 猫脸会被 VLM 误判为 face)
- activity 不含 "无宠物" 关键词
- technical_quality >= 7
- blur_type != "out_of_focus" (允许 motion)
- subject_ratio >= 50
- face_score >= 7
- **hero_potential >= 7** (大脸冲击力关键门槛)
- has_nearby_objects == false
- background_complexity <= 3

### 层一: 兜底过滤 (loose, 严格池不足时启用)

- tech >= 6, subject_ratio >= 40, face_score >= 6, hero_potential >= 6

### 层二: 主角识别

- 按 pet_id **前两段** (颜色-毛长) 聚类, 例如 "white-longhair"
- 策略三: 池 >= 5 张 → 按 count + top10 均分 排序
- 策略一兜底: 放宽 tech, 找池最大者
- 极端兜底: 报错退出, **不允许强行生成劣质结果**

### 层三: 5 张分配到 slot

**综合分公式**:
```
综合分 = hero_potential × 0.4 + face_score × 0.3 + technical_quality × 0.2 + life_moment × 0.1
```

- Hero 位: 综合分最高
- 其他 4 位: 按跟 hero 的 dominant_color 色距最近排序 (RGB 欧式距离)
- **不再按 body_orientation 匹配 slot** (已放弃, render 端用 bbox 自适应)

## 渲染管线 (render_collage.py)

1. 读 template.json 拿画布尺寸和素材位置
2. 铺 background.png (强制 resize 到画布尺寸)
3. 从 poster_selection 读 5 张照片
4. 对每张跑 Apple Vision 抠图 (cutout_apple.py 内嵌 Swift):
   - subject mask 抠图
   - 多前景实例时选最大的
   - **不做 bbox 裁剪** (曾尝试用动物 bbox 裁, 但导致直边切割副作用, 已移除)
5. alpha 阈值化 (>128 视实心, 消除毛边雾)
6. 加 40px 白色实边描边
7. 色调统一 (降饱和 0.75, 微升对比)
8. 用 max ratio 让照片填满 slot (允许超出边界)
9. 按 Figma 坐标 + 旋转贴到画布
10. Sticker 用 PNG 真实尺寸 / scale_factor (从未旋转 sticker 反推)

## 抠图效果的关键约束

- Apple Vision 会把猫 + 紧挨的杂物识别为同一前景 → **靠选片阶段 has_nearby_objects + background_complexity <= 3 硬过滤保证输入干净**
- 不做 bbox 裁剪 (避免直边切割)
- 长毛猫边缘靠 alpha 阈值化 (128) + 40px 白描边补偿

## 已知限制 / 未来方向

1. **Apple Vision 只在 macOS 14+ 可用**, 未来 iOS app 可原生用 Vision Framework
2. 跨平台产品需要另想抠图方案 (rembg 已确认在部分机器上环境地狱)
3. pet_id 聚类基于颜色-毛长, 品种猜测不稳定 (VLM 会把同一只白猫标为
   ragdoll/persian/curly 等多个品种, 但颜色+毛长稳定)
4. v3 风景背景版待开发 (字段已就位: landscape_*, color_family, color_hex_list)

## 常用命令

```bash
# 激活环境
cd /Users/xinzi/🗃️项目需求/📅X/pet-calendar
source venv-collage/bin/activate

# 从 Figma 拉最新布局
python fetch_figma_template.py --file-id 0JEpW8F5de7b0L121TlMxc

# 选片
python select_for_collage.py --template templates/denim/template.json

# 抠图 + 渲染 (清缓存后重跑)
rm -rf assets/collage_denim-cutouts
python render_collage.py --template templates/denim/template.json
open output/collage_denim.png

# VLM 重新打分 (整批相册)
python score_photos.py --folder raw --model qwen3.7-plus
```

## 关键账号 / API

- .env 里: `FIGMA_ACCESS_TOKEN`, `DASHSCOPE_API_KEY`
- Figma file-id: `0JEpW8F5de7b0L121TlMxc`
- 阿里云百炼 (DashScope) 用支付宝支付, 目前用 qwen3.7-plus 模型

## 产品哲学 (贯穿所有选片和渲染)

**"有意义的、有趣的、好看的"** —— 三层递进的滤网

对拼贴海报特化: **单主角 + 大脸冲击 + 抠图友好 + 色调统一**

不允许用户手动参与 (完全自动化), 不允许强行生成劣质结果 (宁缺毋滥)

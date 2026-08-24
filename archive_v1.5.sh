#!/bin/bash
# 存档当前 v1.5 单格日历模板
# 用法: 在 pet-calendar 目录下运行 bash archive_v1.5.sh

set -e  # 遇到错误立刻停止

ARCHIVE_DIR="archives/v1.5-single-cell-2026-08-05"

echo "📦 开始存档 v1.5 单格日历模板"
echo "   目标目录: $ARCHIVE_DIR"
echo ""

# 创建存档目录
mkdir -p "$ARCHIVE_DIR"

# 拷贝代码
echo "─── 拷贝代码 ───"
cp render_calendar.py "$ARCHIVE_DIR/render_calendar.py"
cp select_photos.py "$ARCHIVE_DIR/select_photos.py"
cp score_photos.py "$ARCHIVE_DIR/score_photos.py"
echo "  ✅ render_calendar.py"
echo "  ✅ select_photos.py"
echo "  ✅ score_photos.py"

# 拷贝选片结果
echo ""
echo "─── 拷贝选片结果 ───"
if [ -f "cache/selection.json" ]; then
    cp cache/selection.json "$ARCHIVE_DIR/selection.json"
    echo "  ✅ selection.json"
else
    echo "  ⚠️  cache/selection.json 不存在, 跳过"
fi

# 拷贝成品图
echo ""
echo "─── 拷贝成品图 ───"
if [ -f "output/calendar.png" ]; then
    cp output/calendar.png "$ARCHIVE_DIR/calendar.png"
    echo "  ✅ calendar.png"
else
    echo "  ⚠️  output/calendar.png 不存在, 跳过"
fi

# 拷贝背景纹理 (让存档能独立重现效果)
echo ""
echo "─── 拷贝背景素材 ───"
if [ -f "assets/paper-texture.jpg" ]; then
    mkdir -p "$ARCHIVE_DIR/assets"
    cp assets/paper-texture.jpg "$ARCHIVE_DIR/assets/paper-texture.jpg"
    echo "  ✅ paper-texture.jpg"
fi

# 生成 README
echo ""
echo "─── 生成 README ───"
cat > "$ARCHIVE_DIR/README.md" << 'EOF'
# v1.5 单格日历模板存档

## 概述
这是"一天一格、一格一张照片"的日历模板存档,定格于 **2026-08-05**。

## 核心特征
- **布局**: 6 行 × 5 列, 每格严格对应一天
- **窗口**: 2026-07-07 → 2026-08-05 (今天往前推 30 天)
- **蒙版**: 14 种"每角弧度 ≥ 50%"的曲线形状,循环分配
- **裁切**: 基于 subject_ratio 动态放大 (1.0x / 1.2x / 1.4x / 1.7x)
- **主体位置**: 基于 subject_position 智能偏移裁切中心
- **周末视觉**: 深红数字 + 浅红描边;工作日深灰 + 浅灰
- **空档**: 无照片的日期完全不渲染格子

## 选片规则
详见 `SELECTION_RULES.md` (即"当前生效版本"总结)。

## 文件清单
- `render_calendar.py` - 渲染脚本
- `select_photos.py` - 选片脚本
- `score_photos.py` - VLM 打分脚本 (含新旧模型兼容)
- `selection.json` - 本次的 30 天选片结果
- `calendar.png` - 本次的成品图
- `assets/paper-texture.jpg` - 背景纹理素材
- `SELECTION_RULES.md` - 选片规则 (工程视角: 具体过滤条件和参数)
- `SELECTION_STRATEGY.md` - 选片策略 (产品视角: "有意义、有趣、好看"三层原则)

## 如何重现
如果未来想重跑这版:
1. 把三个 .py 脚本拷回项目根目录
2. 确保 assets/paper-texture.jpg 存在
3. 确保 cache/scores.json 里有 2026-07-07 → 2026-08-05 窗口内的 VLM 打分数据
4. 运行:
   ```
   python select_photos.py --end-date 2026-08-05
   rm -rf assets/processed
   python render_calendar.py
   ```

## 后续演化
这一版之后开始探索"跨格 + 破框"新样式 (v2.0 单张精选大图版)。
EOF
echo "  ✅ README.md"

# 生成 SELECTION_RULES.md (直接写死当前规则,不依赖对话记忆)
cat > "$ARCHIVE_DIR/SELECTION_RULES.md" << 'EOF'
# 选片规则 (v1.5 当前生效版本)

## 一、硬过滤 (一票否决)
1. 必须是宠物 (is_pet = true)
2. 必须有拍摄日期
3. 必须在时间窗口内 (今天往前推 30 天)
4. life_moment ≥ 5 (情感浓度门槛)
5. 不允许糊到看不出主体 (technical_quality ≤ 4 且 life_moment ≤ 5 双低分淘汰)
6. 单猫必须主体居中 (subject_position = center);多猫豁免
7. activity 描述不能包含"无宠物 / 没有宠物"

## 二、综合评分
综合分 = life_moment × 0.5 + technical_quality × 0.5 + 多猫加权

多猫加权 (仅对 pet_count ≥ 2 生效):
- 亲密关系 (打闹/依偎/一起/叠/抱/搭子等): +1.5
- 疏离关系 (各自/独自/背对/分开等): -2

## 三、每日选片
- 每天从合格照片里按综合分降序选 Top 1
- 打散规则: 若 Top 1 跟前一天的 scene + activity 完全相同,且 Top 2 分差不超过 2,用 Top 2 替换
- 无合格照片 → 该日留白 (格子不渲染)
EOF
echo "  ✅ SELECTION_RULES.md"

# 生成 SELECTION_STRATEGY.md (回忆日历选片策略,产品视角说明)
cat > "$ARCHIVE_DIR/SELECTION_STRATEGY.md" << 'EOF'
# 回忆日历 · 选片策略

## 总原则
**有意义的、有趣的、好看的。**

三者不是并列,而是层层递进的滤网——先过"有意义"这道底线,再选"有趣"的抓眼球,最后按"好看"排出高下。任何一张进入日历的照片都必须同时满足这三条,缺一不可。

---

## 一、"有意义的"——底线过滤

意义决定了照片**值不值得被记住**。这一层负责剔除所有本质上不该出现在纪念日历里的照片。

### 主体必须是宠物
- 画面主体是猫/狗/其他宠物,且清晰可辨认
- 剔除:截图、表情包、社交平台分享图、纯风景、纯人像、纯食物、二维码、文档扫描
- 剔除:宠物只是画面背景一角(占比 < 15%)、大合影里凑巧带宠物
- 允许:人物出现(含正脸)、多只宠物同框、宠物只露局部但主体清晰(脸/身)

### 必须有真实拍摄时间
- 从 EXIF 读到的原始拍摄日期存在
- 剔除:从微信/微博/社交平台下载的图(EXIF 时间戳丢失,无法归属到具体的一天)
- 隐含逻辑:**日历陈列的是"你亲身经历的日子",不是"你看过的图"**

### 必须在时间窗口内
- 拍摄日期落在"今天往前推 30 天"范围内
- 窗口外的照片再好也不入选
- 隐含逻辑:**日历是"最近的记忆流",不是相册精选集**

---

## 二、"有趣的"——内容筛选

有趣决定了照片**能不能勾起观看者的情绪**。这一层负责让日历有生活感、有故事感、有情感浓度。

### 生活瞬间价值(life_moment)门槛
- life_moment ≥ 5 才允许进入选片池
- 平淡无叙事的日常照片("猫在睡觉"这种没有具体细节的场景)会被淘汰
- **关键判断**:一张照片能不能配出一句"具体到只属于这张照片的 caption"——如果只能配"糊糊的猫"这种通用描述,就不够有趣

### 保留生活感的边界情况
- **动态模糊(motion blur)不视为废片**:抓到宠物跳跃/扑打/甩头瞬间的照片,即使不清晰也保留——这类照片的生活感浓度反而最高
- **只有失焦(out_of_focus)才淘汰**:真正糊到看不出宠物在做什么的才剔除
- **允许有人物**:人宠互动照片(抚摸、抱、脸贴脸)情感浓度最高
- **多猫同框加分**:亲密关系(依偎、打闹、共食、追打)加权 +1.5 分

### 剔除疏离和无叙事
- 多猫但互不理睬(各自、独自、背对、无视)加权 -2 分
- activity 描述包含"无宠物"关键词的直接淘汰(VLM 保守判断但内容其实空洞)

---

## 三、"好看的"——技术把关

好看决定了照片**放进日历配不配得上被裱起来**。这一层负责保证成品视觉质感。

### 技术质量(technical_quality)参与打分
- 综合分公式:`life_moment × 0.5 + technical_quality × 0.5 + 多猫加权`
- 权重 5:5 意味着"随性抓拍"和"精美大头照"分数持平时并列,技术更好的胜出
- 避免生活感优先度过高导致"糊照片挤掉精美大头照"

### 糊照片兜底
- technical_quality ≤ 4 且 life_moment ≤ 5 双低分直接淘汰
- 单一维度低但另一维度补足的照片依然可能保留(比如动态糊但生活感 9 分)

### 主体必须居中构图
- 单猫照片 subject_position 必须是 center
- 边缘构图的照片会在裁切时主体被切出画面,视觉一定翻车
- **多猫豁免**:多猫合影天然有主体分布两侧的合理性

### 渲染阶段的美化补充
- **主体动态放大**:根据 subject_ratio 分档放大(大特写 1.0x、中景 1.2x、半远景 1.4x、远景 2.0x)——让所有宠物在最终蒙版里都占合适比例
- **色调统一**:轻微降饱和 + 微升亮度对比,让不同光线下拍的照片视觉调性统一

---

## 四、每日选片的"打散"逻辑

通过三层过滤和综合评分后,每天可能有多张合格照片,选片时还有一层节奏控制:

- 默认选综合分最高的 Top 1
- 但如果 Top 1 跟前一天选中的照片 **scene + activity 完全相同**(比如连续两天都是"沙发上打盹"),且 Top 2 分数差不超过 2 分,则用 Top 2 替换
- 避免相邻日期视觉重复,让 30 天的回忆流有起伏

---

## 五、"留白"作为叙事

没有合格照片的日期**不填充、不占位、格子完全不渲染**。这是刻意设计的第四条策略:

- **留白是有意义的**:那一天可能没拍照、可能出差、可能生病,留白本身就是"这一天没有可回忆的宠物瞬间"的真实记录
- **留白让好照片更突出**:满格的日历观感平均、有留白的日历有节奏感
- **留白不需要强行"补内容"**(塞纯色卡片、塞情绪短句都不做)——克制是这个产品的底色

---

## 六、策略优先级速览

```
必要条件 (有意义)  →  加分维度 (有趣)  →  质量把关 (好看)  →  节奏调控 (打散)
      ↓                    ↓                  ↓                    ↓
  硬过滤淘汰         综合分加权           技术分门槛            相邻打散
```

**加分维度**(越高越优先):情感浓度、技术质量、多猫亲密互动

**减分维度**:多猫疏离、跟前一天视觉重复

**一票否决**:非宠物、无日期、窗口外、主体偏离(单猫)、无宠物内容
EOF
echo "  ✅ SELECTION_STRATEGY.md"

echo ""
echo "✨ 存档完成!"
echo ""
echo "存档位置: $ARCHIVE_DIR"
echo ""
echo "文件清单:"
ls -la "$ARCHIVE_DIR"

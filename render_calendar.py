"""
render_calendar.py — 从 selection.json 渲染最终日历 PNG

流程:
1. 读 cache/selection.json (30 天选片结果)
2. 对每张照片做统一色调处理 (降饱和 + 微升亮度对比) → 存到 assets/processed/
3. 用 Jinja2 填 HTML 模板 (含蒙版形状分配 + 周末色区分)
4. Playwright 打开 HTML, 截图成 output/calendar.png

用法:
    python render_calendar.py                    # 用默认设置
    python render_calendar.py --no-process       # 跳过照片色调处理 (调 CSS 时快)
"""

import json
import argparse
import shutil
from pathlib import Path
from datetime import datetime
from PIL import Image, ImageOps, ImageEnhance
import pillow_heif
from jinja2 import Template

pillow_heif.register_heif_opener()

SELECTION_FILE = "cache/selection.json"
ASSETS_DIR = Path("assets/processed")
OUTPUT_DIR = Path("output")
OUTPUT_HTML = OUTPUT_DIR / "calendar.html"
OUTPUT_PNG = OUTPUT_DIR / "calendar.png"

# 照片色调处理参数
COLOR_FACTOR = 0.85       # 饱和度: 1.0 原图, <1 降饱和
BRIGHTNESS_FACTOR = 1.05  # 亮度
CONTRAST_FACTOR = 1.05    # 对比度
PROCESSED_MAX_SIZE = 800  # 处理后照片长边像素 (够高清但不过大)

# 蒙版形状库 (14 种,全部满足: 每个角弧度 ≥ 50%,每条边都是明显曲线,无直线段)
MASK_SHAPES = [
    "60% 90% 70% 80% / 70% 80% 60% 90%",   # 大幅歪斜椭圆
    "90% 60% 80% 70% / 60% 90% 70% 80%",   # 反向大歪斜
    "100% 60% 80% 80% / 80% 80% 60% 100%", # 尖角软三角(右上尖)
    "60% 100% 80% 80% / 80% 80% 100% 60%", # 尖角软三角(左上尖)
    "80% 80% 60% 100% / 100% 60% 80% 80%", # 尖角软三角(左下尖)
    "80% 80% 100% 60% / 60% 100% 80% 80%", # 尖角软三角(右下尖)
    "50% 50% 50% 50% / 60% 90% 60% 90%",   # 扁椭圆
    "60% 90% 60% 90% / 50% 50% 50% 50%",   # 立椭圆
    "70% 90% 60% 80% / 80% 60% 90% 70%",   # 卵形歪斜
    "65% 85% 75% 55% / 55% 75% 65% 85%",   # 温和歪斜
    "80% 60% 90% 70% / 60% 80% 70% 90%",   # 水滴形
    "70% 80% 90% 60% / 90% 70% 80% 60%",   # 反向水滴
    "85% 65% 85% 65% / 65% 85% 65% 85%",   # 斜椭圆
    "65% 85% 65% 85% / 85% 65% 85% 65%",   # 反斜椭圆
]

# 位置和缩放变化 (方向 1A: 幅度收敛,避免蒙版被格子截断)
# 每项: (translate_x%, translate_y%, scale)
POSITION_VARIANTS = [
    (0, 0, 1.0),        # 居中
    (-2, -1, 1.02),     # 略左上
    (2, -1, 1.02),      # 略右上
    (-1, 2, 1.01),      # 略左下
    (2, 2, 1.02),       # 略右下
    (0, -2, 1.03),      # 顶部偏移
    (0, 2, 1.01),       # 底部偏移
    (-3, 0, 1.02),      # 左偏
    (3, 0, 1.02),       # 右偏
    (0, 0, 1.03),       # 居中略放大
]

# 主体裁切放大: 基于 subject_ratio 动态决定
# 目标是让宠物在最终蒙版里占约 60-80% 的合适比例
def compute_zoom(pet_count, subject_ratio):
    """根据宠物数量和主体占比决定放大倍数"""
    if pet_count >= 2:
        return 1.0  # 多猫: 保留完整构图
    if subject_ratio is None:
        return 1.35  # 旧照片 fallback
    if subject_ratio >= 70:
        return 1.0   # 已经是特写, 不放大
    if subject_ratio >= 40:
        return 1.2   # 中景, 温和放大
    if subject_ratio >= 20:
        return 1.4   # 半远景, 中等放大
    return 2.0       # 远景/主体小, 大幅放大 (激进档)

def process_photo(src_path, dst_path, pet_count=1, subject_position="center",
                  subject_ratio=None):
    """统一色调 + 智能裁切 + 尺寸压缩

    放大倍数由 compute_zoom(pet_count, subject_ratio) 决定
    裁切中心由 subject_position 决定 (center/left/right/top/bottom)
    """
    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")

    # 第一步: 决定"主体在照片里的位置"来切正方形
    # 而不是简单的中心切正方形
    w, h = img.size

    # 短边就是最终正方形的边长
    side = min(w, h)

    # 根据 subject_position 决定裁切窗口在长边上的位置
    if w > h:
        # 横构图, 需要在水平方向决定窗口左边界
        if subject_position == "left":
            left = 0
        elif subject_position == "right":
            left = w - side
        else:  # center / top / bottom 都走中心
            left = (w - side) // 2
        top = 0
    else:
        # 竖构图或方形, 需要在垂直方向决定窗口顶边界
        left = (w - side) // 2 if w > side else 0
        if subject_position == "top":
            top = 0
        elif subject_position == "bottom":
            top = h - side
        else:
            top = (h - side) // 2

    img = img.crop((left, top, left + side, top + side))

    # 第二步: 按 pet_count 和 subject_ratio 动态决定放大倍数
    zoom = compute_zoom(pet_count, subject_ratio)
    if zoom > 1.0:
        new_side = int(side / zoom)
        # 放大裁切时,裁切中心也根据 subject_position 偏移
        # 让主体保留在画面里而不是被切出去
        max_offset = side - new_side
        if subject_position == "left":
            crop_left = 0
        elif subject_position == "right":
            crop_left = max_offset
        else:
            crop_left = max_offset // 2

        if subject_position == "top":
            crop_top = 0
        elif subject_position == "bottom":
            crop_top = max_offset
        else:
            crop_top = max_offset // 2

        img = img.crop((crop_left, crop_top,
                        crop_left + new_side, crop_top + new_side))

    # 压缩
    if img.size[0] > PROCESSED_MAX_SIZE:
        img = img.resize((PROCESSED_MAX_SIZE, PROCESSED_MAX_SIZE), Image.LANCZOS)

    # 色调统一
    img = ImageEnhance.Color(img).enhance(COLOR_FACTOR)
    img = ImageEnhance.Brightness(img).enhance(BRIGHTNESS_FACTOR)
    img = ImageEnhance.Contrast(img).enhance(CONTRAST_FACTOR)

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst_path, "JPEG", quality=90)

def is_weekend(date_str):
    """返回 True 若日期是周六或周日"""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return d.weekday() >= 5

def prepare_cells(selection, do_process):
    """为每个格子准备渲染数据"""
    cells = []
    shape_idx = 0
    pos_idx = 0
    for i, entry in enumerate(selection):
        date_str = entry["date"]
        day_num = int(date_str.split("-")[-1])
        cell = {
            "date": date_str,
            "day_num": day_num,
            "is_weekend": is_weekend(date_str),
            "empty": entry["empty"],
            "photo_path": None,
            "mask_shape": MASK_SHAPES[shape_idx % len(MASK_SHAPES)],
            "pos_x": 0,
            "pos_y": 0,
            "scale": 1.0,
        }
        if not entry["empty"]:
            src = Path(entry["photo"]["path"])
            dst = ASSETS_DIR / f"{i:02d}_{src.stem}.jpg"
            pet_count = entry["photo"].get("pet_count", 1)
            subject_position = entry["photo"].get("subject_position", "center")
            subject_ratio = entry["photo"].get("subject_ratio")  # None 时 fallback
            if do_process:
                process_photo(src, dst, pet_count=pet_count,
                              subject_position=subject_position,
                              subject_ratio=subject_ratio)
            elif not dst.exists():
                process_photo(src, dst, pet_count=pet_count,
                              subject_position=subject_position,
                              subject_ratio=subject_ratio)
            cell["photo_path"] = str(dst.absolute())
            # 分配位置变体
            px, py, sc = POSITION_VARIANTS[pos_idx % len(POSITION_VARIANTS)]
            cell["pos_x"] = px
            cell["pos_y"] = py
            cell["scale"] = sc
            shape_idx += 1
            pos_idx += 1
        cells.append(cell)
    return cells

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Pet Calendar {{ start_date }} → {{ end_date }}</title>
<style>
    :root {
        --paper-bg: #F0F3F5;
        --card-white: #FFFFFF;
        --border-workday: #C1BEBB;
        --border-weekend: #DDA1A9;
        --text-workday: #1A1918;
        --text-weekend: #BD3A4B;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
        width: 1800px;
        height: 2400px;
        color: var(--text-workday);
        overflow: hidden;
        font-family: "Times New Roman", "Cormorant Garamond", "Songti SC", serif;
    }

    /* 背景层: 底色 + 60% 透明纹理叠加 */
    body {
        background-color: var(--paper-bg);
    }
    .bg-texture {
        position: fixed;
        inset: 0;
        background-image: url("file://{{ texture_path }}");
        background-size: cover;
        background-position: center;
        opacity: 0.6;
        pointer-events: none;
        z-index: 0;
    }

    .page {
        position: relative;
        width: 1800px;
        height: 2400px;
        padding: 80px 60px 60px 60px;
        z-index: 1;
    }

    /* 页眉右上 */
    .header {
        position: absolute;
        top: 80px;
        right: 60px;
        display: flex;
        align-items: baseline;
        gap: 24px;
    }
    .header-month-abbr {
        font-size: 42px;
        font-weight: 300;
        letter-spacing: 2px;
    }
    .header-number {
        font-size: 140px;
        font-weight: 400;
        letter-spacing: -4px;
        line-height: 1;
    }

    /* 左侧竖排 */
    .side-text {
        position: absolute;
        left: 40px;
        top: 380px;
        width: 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .side-jp {
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-size: 20px;
        letter-spacing: 8px;
        margin-bottom: 60px;
        font-family: "Hiragino Mincho ProN", "Songti SC", serif;
    }
    .side-en {
        writing-mode: vertical-rl;
        font-size: 14px;
        letter-spacing: 6px;
    }

    /* 主网格 6行×5列, 间距紧凑且严格一致 */
    /* 用 auto 行高让 cell 的 aspect-ratio: 1/1 决定行高, 避免拉伸导致纵向间距变大 */
    .grid {
        position: absolute;
        left: 130px;
        right: 60px;
        top: 260px;
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        grid-auto-rows: auto;
        column-gap: 8px;
        row-gap: 8px;
    }

    .cell {
        position: relative;
        background: var(--card-white);
        border: 1px solid var(--border-workday);
        aspect-ratio: 1 / 1;
        overflow: hidden;
    }
    .cell.weekend { border-color: var(--border-weekend); }
    .cell.empty { background: transparent; border: none; }

    .cell-date {
        position: absolute;
        top: 10px;
        left: 12px;
        font-size: 28px;
        font-weight: 400;
        color: var(--text-workday);
        z-index: 2;
        line-height: 1;
    }
    .cell.weekend .cell-date { color: var(--text-weekend); }

    /* 蒙版照片: 更大占比 (方向 X 主体突出) + 位置变体 */
    .cell-photo {
        position: absolute;
        top: 6%;
        left: 6%;
        width: 88%;
        height: 88%;
        object-fit: cover;
    }

    /* 页脚: 字号加大 */
    .footer {
        position: absolute;
        left: 130px;
        right: 60px;
        bottom: 60px;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
    }
    .footer-left {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 1px;
    }
    .footer-right {
        text-align: right;
        max-width: 620px;
        font-family: "Hiragino Mincho ProN", "Songti SC", serif;
        font-size: 15px;
        line-height: 1.7;
        color: rgba(0,0,0,0.55);
    }
</style>
</head>
<body>
<div class="bg-texture"></div>
<div class="page">

    <div class="header">
        <span class="header-month-abbr">{{ header_left }}</span>
        <span class="header-number">{{ header_number }}</span>
        {% if header_right %}<span class="header-month-abbr">{{ header_right }}</span>{% endif %}
    </div>

    <div class="side-text">
        <div class="side-jp">かわいい動物たちとの毎日</div>
        <div class="side-en">EVERY DAY SPENT WITH CUTE ANIMALS</div>
    </div>

    <div class="grid">
    {% for cell in cells %}
        {% if cell.empty %}
        <div class="cell empty"></div>
        {% else %}
        <div class="cell{% if cell.is_weekend %} weekend{% endif %}">
            <div class="cell-date">{{ cell.day_num }}</div>
            <img class="cell-photo"
                 src="file://{{ cell.photo_path }}"
                 style="border-radius: {{ cell.mask_shape }};
                        transform: translate({{ cell.pos_x }}%, {{ cell.pos_y }}%) scale({{ cell.scale }});">
        </div>
        {% endif %}
    {% endfor %}
    </div>

    <div class="footer">
        <div class="footer-left">PET Calendar</div>
        <div class="footer-right">ふわふわの小さな家族と過ごす時間は、何気ない毎日を少しだけ特別にしてくれます。今日も一緒に笑って、のんびりと幸せな時間を過ごそう。</div>
    </div>

</div>
</body>
</html>
"""

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-process", action="store_true",
                        help="跳过照片色调处理 (调 CSS 时快)")
    args = parser.parse_args()

    if not Path(SELECTION_FILE).exists():
        print(f"错误: {SELECTION_FILE} 不存在, 请先跑 select_photos.py")
        return

    with open(SELECTION_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    selection = data["selection"]
    start_date = data["start_date"]
    end_date = data["end_date"]

    print(f"📖 加载 selection.json: {start_date} → {end_date}")
    print(f"📸 处理照片中...")

    OUTPUT_DIR.mkdir(exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    cells = prepare_cells(selection, do_process=not args.no_process)
    print(f"   有照片格子: {sum(1 for c in cells if not c['empty'])}")
    print(f"   空档格子: {sum(1 for c in cells if c['empty'])}")

    # 计算动态页眉
    MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    start_m = int(start_date.split("-")[1])
    end_m = int(end_date.split("-")[1])
    if start_m == end_m:
        # 单月: 简洁式 "JUL 7"
        header_left = MONTH_ABBR[start_m - 1]
        header_number = str(start_m)
        header_right = ""
    else:
        # 跨月: "JUL 7/8 AUG"
        header_left = MONTH_ABBR[start_m - 1]
        header_number = f"{start_m}/{end_m}"
        header_right = MONTH_ABBR[end_m - 1]

    # 渲染 HTML
    texture_path = Path("assets/paper-texture.jpg").absolute()
    if not texture_path.exists():
        print(f"⚠️  背景纹理不存在: {texture_path}")
        print(f"   将使用纯色底,不叠加纹理")

    template = Template(HTML_TEMPLATE)
    html = template.render(
        cells=cells,
        start_date=start_date,
        end_date=end_date,
        texture_path=str(texture_path),
        header_left=header_left,
        header_number=header_number,
        header_right=header_right,
    )
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"📄 HTML 已生成: {OUTPUT_HTML}")

    # Playwright 截图
    print(f"🖨️  Playwright 渲染 PNG...")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(
            viewport={"width": 1800, "height": 2400},
            device_scale_factor=2,  # 2x 高清
        )
        page = context.new_page()
        page.goto(f"file://{OUTPUT_HTML.absolute()}")
        page.wait_for_load_state("networkidle")
        page.screenshot(path=str(OUTPUT_PNG), full_page=False)
        browser.close()

    print(f"✅ 完成! 输出: {OUTPUT_PNG}")
    print(f"   打开预览: open {OUTPUT_PNG}")

if __name__ == "__main__":
    main()

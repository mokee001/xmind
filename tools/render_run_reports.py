from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps


CANVAS_WIDTH = 1800
MARGIN = 80
GAP = 32
CARD_WIDTH = (CANVAS_WIDTH - MARGIN * 2 - GAP) // 2
CARD_HEIGHT = 260
CARD_GAP = 24
BACKGROUND = "#f4f5f3"
CARD = "#ffffff"
INK = "#202223"
MUTED = "#73787a"
BORDER = "#dfe2df"
GREEN = "#3f705c"
CORAL = "#c65f52"
FONT_MEDIUM = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"

TREATMENT_NAMES = {
    "proportional_full_image": "比例内完整图片",
    "irregular_cutout": "异形抠图",
    "multi_irregular_cutout": "多主体异形抠图",
    "non_cell_ratio_image": "保留原比例图片",
    "circle_image": "圆形图片",
    "oval_image_with_cutout": "椭圆/组合图片",
    "text_only": "纯文字",
    "illustration_with_text": "插画 + 文字",
    "illustration_only": "纯插画",
}

DECORATION_CATEGORY_NAMES = {
    "paper": "纸质素材",
    "people_and_animals": "人物与动物",
    "scenery": "风景与外出",
    "music_and_film": "音乐与影视",
    "abstract": "抽象留白",
}


def load_font(size: int, medium: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_MEDIUM if medium else FONT_LIGHT, size)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    selected_font: ImageFont.FreeTypeFont,
    maximum_width: int,
    maximum_lines: int,
) -> list[str]:
    lines: list[str] = []
    current = ""
    for character in text:
        candidate = current + character
        if current and draw.textlength(candidate, font=selected_font) > maximum_width:
            lines.append(current)
            current = character
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) > maximum_lines:
        lines = lines[:maximum_lines]
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def draw_lines(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    text: str,
    selected_font: ImageFont.FreeTypeFont,
    fill: str,
    maximum_width: int,
    maximum_lines: int,
    line_gap: int = 6,
) -> int:
    lines = wrap_text(draw, text, selected_font, maximum_width, maximum_lines)
    line_height = selected_font.getbbox("示例Ag")[3] - selected_font.getbbox("示例Ag")[1]
    for line in lines:
        draw.text((x, y), line, font=selected_font, fill=fill)
        y += line_height + line_gap
    return y


def report_thumbnail(run_dir: Path, item: dict[str, Any]) -> Image.Image:
    existing = run_dir / "reports" / "images" / f"day{item['day']:02d}.jpg"
    if existing.exists():
        return Image.open(existing).convert("RGB")
    source = Path(item["sources"][0])
    if not source.is_absolute():
        source = run_dir / source
    return ImageOps.exif_transpose(Image.open(source)).convert("RGB")


def card_position(index: int, top: int) -> tuple[int, int]:
    return (
        MARGIN + (index % 2) * (CARD_WIDTH + GAP),
        top + (index // 2) * (CARD_HEIGHT + CARD_GAP),
    )


def draw_card(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    run_dir: Path,
    item: dict[str, Any],
    position: tuple[int, int],
    mode: str,
) -> None:
    x, y = position
    draw.rounded_rectangle(
        (x, y, x + CARD_WIDTH, y + CARD_HEIGHT),
        radius=8,
        fill=CARD,
        outline=BORDER,
        width=2,
    )
    thumbnail = ImageOps.fit(
        report_thumbnail(run_dir, item),
        (260, 196),
        Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    canvas.paste(thumbnail, (x + 22, y + 42))
    draw.rectangle((x + 22, y + 42, x + 282, y + 238), outline=BORDER, width=2)

    text_x = x + 308
    text_width = CARD_WIDTH - 334
    draw.text((text_x, y + 22), f"7 月 {item['day']} 日", font=load_font(30, True), fill=GREEN)
    if mode == "selection":
        draw.text((text_x, y + 70), "选中素材", font=load_font(19, True), fill=CORAL)
        names = [Path(source).name for source in item["sources"]]
        filename = " / ".join(names) if names else "通用插画/文字填充"
        next_y = draw_lines(
            draw,
            text_x,
            y + 101,
            filename,
            load_font(19),
            INK,
            text_width,
            2,
            5,
        )
        draw.text((text_x, max(y + 155, next_y + 3)), "选择理由", font=load_font(19, True), fill=MUTED)
        draw_lines(
            draw,
            text_x,
            max(y + 187, next_y + 35),
            item["reason"],
            load_font(20),
            INK,
            text_width,
            3,
            5,
        )
    else:
        treatment = TREATMENT_NAMES.get(item["treatment"], item["treatment"])
        draw.text((text_x, y + 72), treatment, font=load_font(24, True), fill=CORAL)
        draw.text((text_x, y + 108), item["treatment"], font=load_font(16), fill=MUTED)
        draw_lines(
            draw,
            text_x,
            y + 150,
            item["reason"],
            load_font(20),
            INK,
            text_width,
            4,
            5,
        )


def draw_header(
    draw: ImageDraw.ImageDraw,
    title: str,
    subtitle: str,
    accent: str,
) -> int:
    draw.rectangle((MARGIN, 68, MARGIN + 62, 76), fill=accent)
    draw.text((MARGIN, 96), title, font=load_font(52, True), fill=INK)
    draw.text((MARGIN, 166), subtitle, font=load_font(24), fill=MUTED)
    return 228


def draw_footer(
    draw: ImageDraw.ImageDraw,
    top: int,
    title: str,
    lines: list[str],
    accent: str,
) -> None:
    height = 90 + len(lines) * 46
    draw.rounded_rectangle(
        (MARGIN, top, CANVAS_WIDTH - MARGIN, top + height),
        radius=8,
        fill=CARD,
        outline=BORDER,
        width=2,
    )
    draw.rectangle((MARGIN + 28, top + 26, MARGIN + 36, top + 68), fill=accent)
    draw.text((MARGIN + 54, top + 22), title, font=load_font(29, True), fill=INK)
    y = top + 78
    for line in lines:
        draw.text((MARGIN + 54, y), line, font=load_font(22), fill=INK)
        y += 46


def render_report(
    run_dir: Path,
    plan: dict[str, Any],
    title: str,
    subtitle: str,
    mode: str,
    footer_title: str,
    footer_lines: list[str],
    accent: str,
    output_name: str,
) -> Path:
    rows = (len(plan["days"]) + 1) // 2
    card_top = 228
    footer_top = card_top + rows * (CARD_HEIGHT + CARD_GAP) + 34
    footer_height = 90 + len(footer_lines) * 46
    canvas = Image.new(
        "RGB",
        (CANVAS_WIDTH, footer_top + footer_height + 70),
        BACKGROUND,
    )
    draw = ImageDraw.Draw(canvas)
    draw_header(draw, title, subtitle, accent)
    for index, item in enumerate(plan["days"]):
        draw_card(canvas, draw, run_dir, item, card_position(index, card_top), mode)
    draw_footer(draw, footer_top, footer_title, footer_lines, accent)
    output = run_dir / "reports" / output_name
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)
    return output


def render_decoration_report(
    run_dir: Path,
    decoration_plan: dict[str, Any],
    output_name: str = "2026年7月_动态装饰决策报告_图文版.png",
) -> Path:
    items = decoration_plan["dynamic_layer"]["items"]
    rows = (len(items) + 1) // 2
    card_top = 228
    footer_top = card_top + rows * (CARD_HEIGHT + CARD_GAP) + 34
    footer_lines = [
        "静态装饰由模板固定提供；动态装饰根据当月内容重新选择与摆放。",
        "每格最多 1–2 个视觉贴纸；整月默认最多装饰 8 个日期格。",
        "贴纸不得遮挡日期数字、人物或动物面部以及重要文字。",
        f"本月动态装饰覆盖 {len({item['owner_day'] for item in items})} 个日期格，空白日期只使用无事件指向的抽象贴纸。",
    ]
    footer_height = 90 + len(footer_lines) * 46
    canvas = Image.new(
        "RGB",
        (CANVAS_WIDTH, footer_top + footer_height + 70),
        BACKGROUND,
    )
    draw = ImageDraw.Draw(canvas)
    draw_header(
        draw,
        "2026 年 7 月动态装饰决策报告",
        "静态模板层保持不变 · 动态贴纸按内容语义选择",
        GREEN,
    )

    for index, item in enumerate(items):
        x, y = card_position(index, card_top)
        draw.rounded_rectangle(
            (x, y, x + CARD_WIDTH, y + CARD_HEIGHT),
            radius=8,
            fill=CARD,
            outline=BORDER,
            width=2,
        )
        asset_path = run_dir / item["asset"]
        sticker = Image.open(asset_path).convert("RGBA")
        thumbnail = ImageOps.contain(
            sticker,
            (220, 180),
            Image.Resampling.LANCZOS,
        )
        preview = Image.new("RGBA", (260, 196), "#f7f7f5")
        preview.alpha_composite(
            thumbnail,
            (
                (preview.width - thumbnail.width) // 2,
                (preview.height - thumbnail.height) // 2,
            ),
        )
        canvas.paste(preview.convert("RGB"), (x + 22, y + 42))
        draw.rectangle(
            (x + 22, y + 42, x + 282, y + 238),
            outline=BORDER,
            width=2,
        )

        text_x = x + 308
        text_width = CARD_WIDTH - 334
        category = DECORATION_CATEGORY_NAMES.get(
            item["category"],
            item["category"],
        )
        draw.text(
            (text_x, y + 22),
            f"7 月 {item['owner_day']} 日",
            font=load_font(30, True),
            fill=GREEN,
        )
        draw.text(
            (text_x, y + 70),
            category,
            font=load_font(22, True),
            fill=CORAL,
        )
        draw_lines(
            draw,
            text_x,
            y + 108,
            item["semantic_trigger"],
            load_font(19),
            MUTED,
            text_width,
            2,
            5,
        )
        draw_lines(
            draw,
            text_x,
            y + 162,
            item["reason"],
            load_font(19),
            INK,
            text_width,
            3,
            5,
        )

    draw_footer(
        draw,
        footer_top,
        "装饰层约束",
        footer_lines,
        GREEN,
    )
    output = run_dir / "reports" / output_name
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)

    markdown_lines = [
        "# 2026 年 7 月动态装饰决策报告",
        "",
        "静态装饰完全按模板，动态贴纸按日历内容语义重新选择。",
        "",
        "| 日期 | 分类 | 语义依据 | 贴纸素材 | 设计理由 |",
        "|---|---|---|---|---|",
    ]
    for item in items:
        markdown_lines.append(
            f"| 7/{item['owner_day']} | `{item['category']}` | "
            f"{item['semantic_trigger']} | {Path(item['asset']).name} | "
            f"{item['reason']} |"
        )
    markdown_lines.extend(
        [
            "",
            "## 固定约束",
            "",
            "- 一处日期格最多 1–2 个视觉贴纸。",
            "- 不遮挡日期数字、人物或动物面部及重要文字。",
            "- 空白日期只能使用没有具体事件指向的抽象贴纸。",
            "",
        ]
    )
    (run_dir / "reports" / "decoration_report.md").write_text(
        "\n".join(markdown_lines),
        encoding="utf-8",
    )
    return output


def write_selection_markdown(
    run_dir: Path,
    plan: dict[str, Any],
    manifest: dict[str, Any],
) -> Path:
    summary = manifest["summary"]
    lines = [
        "# 2026 年 7 月选图报告",
        "",
        "选图阶段仅在本机完成，未修改原始相册；外部 API 只用于后续图片处理决策。",
        "",
        f"- 源文件：{summary['source_file_count']} 个",
        f"- 属于 2026 年 7 月的静态照片：{summary['imported_static_count']} 张",
        f"- 最终使用：{sum(len(item['sources']) for item in plan['days'])} 张，覆盖 {len(plan['days'])} 个日期",
        f"- 留白日期：{', '.join(str(day) for day in range(1, 32) if day not in {item['day'] for item in plan['days']})}",
        "",
        "| 日期 | 选中素材 | 选择理由 |",
        "|---|---|---|",
    ]
    for item in plan["days"]:
        names = (
            " / ".join(Path(source).name for source in item["sources"])
            if item["sources"]
            else "通用插画/文字填充"
        )
        lines.append(f"| 7/{item['day']} | {names} | {item['reason']} |")
    lines.extend(
        [
            "",
            "## 排除与降权",
            "",
            f"- 视频与 Live Photo 动态部分：{summary['excluded_reason_counts'].get('video_or_live_photo_motion', 0)} 个。",
            f"- 非 2026 年 7 月素材：{summary['excluded_reason_counts'].get('outside_target_month', 0)} 个。",
            f"- 缺少可靠日期：{summary['excluded_reason_counts'].get('missing_capture_date', 0)} 个。",
            f"- 黑屏或不可用静态图：{summary['technical_status_counts'].get('REJECT', 0)} 张。",
            f"- 连拍组：{summary['burst_group_count']} 组，只保留每个事件中更有代表性的画面。",
            "",
        ]
    )
    output = run_dir / "reports" / "selection_report.md"
    output.write_text("\n".join(lines), encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    run_dir = args.run_dir.expanduser().resolve()
    plan = read_json(run_dir / "treatment_plan.json")
    manifest = read_json(run_dir / "manifest.json")
    summary = manifest["summary"]
    selected_photo_count = sum(len(item["sources"]) for item in plan["days"])
    blank_count = 31 - len(plan["days"])
    maximum_sources_per_day = max(
        (len(item["sources"]) for item in plan["days"]),
        default=0,
    )
    multi_source_days = [
        item["day"] for item in plan["days"] if len(item["sources"]) > 1
    ]
    decision = plan.get("decision", {})
    qwen_run = str(decision.get("backend", "")).startswith("qwen")
    report_prefix = "2026年7月_Qwen工作流" if qwen_run else "2026年7月_真实用户"

    selection = render_report(
        run_dir,
        plan,
        "2026 年 7 月日历选图报告",
        f"{selected_photo_count} 张照片 · {len(plan['days'])} 个日期 · {blank_count} 天留白",
        "selection",
        "素材过滤结果",
        [
            f"{summary['source_file_count']} 个源文件中，{summary['imported_static_count']} 张静态照片属于目标月份；最终选用 {selected_photo_count} 张。",
            f"排除视频/动态部分 {summary['excluded_reason_counts'].get('video_or_live_photo_motion', 0)} 个，跨月素材 {summary['excluded_reason_counts'].get('outside_target_month', 0)} 个。",
            f"检测到 {summary['burst_group_count']} 组连拍，按事件保留代表性画面；技术淘汰 {summary['technical_status_counts'].get('REJECT', 0)} 张。",
            "人物与宠物关系、明确活动、构图审美和生活意义优先；普通连拍与重复内容降权。",
        ],
        GREEN,
        f"{report_prefix}_选图报告_图文版.png",
    )

    counts = Counter(item["treatment"] for item in plan["days"])
    backend = decision.get("backend", "unknown")
    api_note = "已调用外部 API" if decision.get("api_used") else "未调用外部 API"
    distribution = " · ".join(
        f"{TREATMENT_NAMES.get(mode, mode)} {count} 天"
        for mode, count in sorted(counts.items())
    )
    treatment = render_report(
        run_dir,
        plan,
        "2026 年 7 月图片处理决策报告",
        f"依据处理规范逐日判断 · {backend} · {api_note} · 本地执行",
        "treatment",
        "处理约束与分布",
        [
            distribution,
            (
                f"每天原则上 1 张，最多 3 张；本月单日最多 {maximum_sources_per_day} 张"
                + (
                    "，多图日期为 " + "、".join(f"7 月 {day} 日" for day in multi_source_days) + "。"
                    if multi_source_days
                    else "，没有多图日期。"
                )
            ),
            "所有旋转角度不超过 10°；透明抠图不加白色描边、不加阴影。",
            "二维码、付款码、票据与视频均未进入最终日历；空白日期不强行填充。",
        ],
        CORAL,
        f"{report_prefix}_处理决策报告_图文版.png",
    )
    decoration = None
    decoration_plan_path = run_dir / "decoration_plan.json"
    if decoration_plan_path.exists():
        decoration = render_decoration_report(
            run_dir,
            read_json(decoration_plan_path),
            f"{report_prefix}_动态装饰决策报告_图文版.png",
        )
    markdown = write_selection_markdown(run_dir, plan, manifest)
    print(selection)
    print(treatment)
    if decoration:
        print(decoration)
    print(markdown)


if __name__ == "__main__":
    main()

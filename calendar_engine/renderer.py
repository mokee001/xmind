from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "runs" / "2026-07"
PLAN_PATH = RUN_DIR / "treatment_plan.json"
DECORATION_PLAN_PATH = RUN_DIR / "decoration_plan.json"
OUTPUT_DIR = RUN_DIR / "output"
REPORT_DIR = RUN_DIR / "reports"
FINAL_NAME = "2026年7月_AI手帐日历_v3_更新相册版.png"
PREVIEW_NAME = "2026年7月_AI手帐日历_v3_更新相册版_预览.jpg"
FONT_PATH = ROOT / "templates" / "calendar_template_v1" / "fonts.ttf"
TEMPLATE_DIR_OVERRIDE: Path | None = None
SOURCE_DATE_PATTERN = re.compile(r"^2026-07-(\d{2})__")

GRID_X = [161, 330, 498, 666, 834, 1002, 1170, 1338]
GRID_Y = [512, 708, 903, 1098, 1293, 1488]
DATE_RESERVED_BOX = [0.02, 0.01, 0.30, 0.26]
ALLOWED_TREATMENTS = {
    "proportional_full_image",
    "illustration_only",
    "illustration_with_text",
    "text_only",
    "non_cell_ratio_image",
    "multi_irregular_cutout",
    "circle_image",
    "oval_image_with_cutout",
    "irregular_cutout_with_text",
    "irregular_cutout",
    "blank",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_rgba(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGBA")


def load_canvas_layer(
    template_dir: Path,
    names: list[str],
    canvas_size: tuple[int, int],
) -> tuple[Image.Image, str | None]:
    for name in names:
        path = template_dir / name
        if not path.exists():
            continue
        layer = load_rgba(path)
        if layer.size == canvas_size:
            return layer, name
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        canvas.alpha_composite(layer, (0, 0))
        return canvas, name
    return Image.new("RGBA", canvas_size, (0, 0, 0, 0)), None


def run_path(path_value: str) -> Path:
    path = Path(path_value)
    return path if path.is_absolute() else RUN_DIR / path


def template_path(plan: dict[str, Any]) -> Path:
    if TEMPLATE_DIR_OVERRIDE is not None:
        return TEMPLATE_DIR_OVERRIDE
    path = Path(plan["calendar"]["template"])
    return path if path.is_absolute() else RUN_DIR / path


def day_cell(day: int) -> tuple[int, int, int, int]:
    # July 1, 2026 is Wednesday in a Sunday-first calendar.
    index = 3 + day - 1
    row, column = divmod(index, 7)
    x0, x1 = GRID_X[column], GRID_X[column + 1]
    y0, y1 = GRID_Y[row], GRID_Y[row + 1]
    return x0, y0, x1 - x0, y1 - y0


def absolute_box(
    cell: tuple[int, int, int, int],
    relative: list[float],
) -> tuple[int, int, int, int]:
    x, y, width, height = cell
    rx, ry, rw, rh = relative
    return (
        round(x + rx * width),
        round(y + ry * height),
        max(1, round(rw * width)),
        max(1, round(rh * height)),
    )


def crop_relative(image: Image.Image, crop: list[float] | None) -> Image.Image:
    if not crop:
        return image
    left, top, right, bottom = crop
    return image.crop(
        (
            round(left * image.width),
            round(top * image.height),
            round(right * image.width),
            round(bottom * image.height),
        )
    )


def trim_alpha(image: Image.Image) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    return image.crop(bbox) if bbox else image


def fit_contain(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    fitted = ImageOps.contain(image, size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.alpha_composite(
        fitted,
        (
            (size[0] - fitted.width) // 2,
            (size[1] - fitted.height) // 2,
        ),
    )
    return canvas


def fit_cover(
    image: Image.Image,
    size: tuple[int, int],
    focal: list[float] | None = None,
) -> Image.Image:
    centering = tuple(focal or [0.5, 0.5])
    return ImageOps.fit(
        image,
        size,
        Image.Resampling.LANCZOS,
        centering=centering,
    )


def wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    maximum_width: int,
) -> list[str]:
    lines: list[str] = []
    current = ""
    for character in text:
        if character == "\n":
            if current:
                lines.append(current)
                current = ""
            continue
        candidate = current + character
        if current and font.getlength(candidate) > maximum_width:
            lines.append(current)
            current = character
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def text_asset(
    text: str,
    size: tuple[int, int],
    font_size: int,
    maximum_lines: int,
) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    font_path = FONT_PATH if FONT_PATH.exists() else Path("/System/Library/Fonts/PingFang.ttc")
    current_size = font_size

    while current_size >= 12:
        font = ImageFont.truetype(str(font_path), current_size)
        lines = wrap_text(text, font, max(1, size[0] - 8))
        line_height = round(current_size * 1.28)
        if len(lines) <= maximum_lines and len(lines) * line_height <= size[1] - 4:
            break
        current_size -= 1
    else:
        font = ImageFont.truetype(str(font_path), 12)
        lines = wrap_text(text, font, max(1, size[0] - 8))
        line_height = 15

    lines = lines[:maximum_lines]
    block_height = len(lines) * line_height
    y = max(0, (size[1] - block_height) // 2)
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        line_width = bbox[2] - bbox[0]
        x = max(0, (size[0] - line_width) // 2)
        draw.text((x, y), line, font=font, fill="#202020")
        y += line_height
    return canvas


def ellipse_image(
    image: Image.Image,
    size: tuple[int, int],
    focal: list[float] | None = None,
) -> Image.Image:
    fitted = fit_cover(image, size, focal)
    scale = 4
    mask = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(mask).ellipse(
        (0, 0, mask.width - 1, mask.height - 1),
        fill=255,
    )
    mask = mask.resize(size, Image.Resampling.LANCZOS)
    fitted.putalpha(mask)
    return fitted


def prepare_placement(
    day: dict[str, Any],
    placement: dict[str, Any],
    target_size: tuple[int, int],
) -> Image.Image:
    kind = placement["kind"]
    if kind in {"cutout", "illustration"}:
        source_path = RUN_DIR / placement["asset"]
        image = trim_alpha(load_rgba(source_path))
        image = crop_relative(image, placement.get("crop"))
        return fit_contain(image, target_size)
    if kind == "text":
        return text_asset(
            placement["text"],
            target_size,
            int(placement.get("font_size", 22)),
            int(placement.get("maximum_lines", 4)),
        )

    source_index = int(placement.get("source_index", 0))
    source_path = run_path(day["sources"][source_index])
    image = crop_relative(load_rgba(source_path), placement.get("crop"))
    focal = placement.get("focal")

    if kind in {"circle", "oval"}:
        return ellipse_image(image, target_size, focal)
    if placement.get("fit", "cover") == "contain":
        return fit_contain(image, target_size)
    return fit_cover(image, target_size, focal)


def prepare_sticker(
    item: dict[str, Any],
    target_size: tuple[int, int],
) -> Image.Image:
    asset_path = run_path(item["asset"])
    image = trim_alpha(load_rgba(asset_path))
    return fit_contain(image, target_size)


def alpha_pixel_count(image: Image.Image) -> int:
    histogram = image.getchannel("A").histogram()
    return sum(histogram[1:])


def alpha_pixels_in_canvas_rect(
    image: Image.Image,
    paste_x: int,
    paste_y: int,
    rect: tuple[int, int, int, int],
) -> int:
    left = max(rect[0], paste_x)
    top = max(rect[1], paste_y)
    right = min(rect[0] + rect[2], paste_x + image.width)
    bottom = min(rect[1] + rect[3], paste_y + image.height)
    if right <= left or bottom <= top:
        return 0
    crop = image.crop(
        (
            left - paste_x,
            top - paste_y,
            right - paste_x,
            bottom - paste_y,
        )
    )
    return alpha_pixel_count(crop)


def decoration_target_box(
    item: dict[str, Any],
    canvas_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    if item.get("anchor_scope", "owner_cell") == "canvas":
        return absolute_box((0, 0, canvas_size[0], canvas_size[1]), item["box"])
    return absolute_box(day_cell(int(item["owner_day"])), item["box"])


def render() -> tuple[Path, dict[str, Any], dict[str, Any]]:
    global FONT_PATH

    plan = read_json(PLAN_PATH)
    decoration_plan = (
        read_json(DECORATION_PLAN_PATH)
        if DECORATION_PLAN_PATH.exists()
        else {
            "schema_version": "1.0",
            "layer_order": [
                "base",
                "content",
                "date",
                "overlay_sticker_static",
                "overlay_sticker_dynamic",
            ],
            "static_layer": {"mode": "template_fixed"},
            "dynamic_layer": {"items": []},
        }
    )
    template_dir = template_path(plan)
    bundled_font = template_dir / "fonts.ttf"
    if bundled_font.exists():
        FONT_PATH = bundled_font
    base = load_rgba(template_dir / "base.png")
    date_layer, date_asset = load_canvas_layer(
        template_dir,
        ["date.png", "overlay.png"],
        base.size,
    )
    static_layer, static_asset = load_canvas_layer(
        template_dir,
        ["overlay_sticker_static.png", "overlay_sticker_statistic.png"],
        base.size,
    )
    content_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    dynamic_sticker_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))

    render_items: list[dict[str, Any]] = []
    for day in sorted(plan["days"], key=lambda item: item["day"]):
        cell = day_cell(day["day"])
        for index, placement in enumerate(day["placements"]):
            x, y, width, height = absolute_box(cell, placement["box"])
            asset = prepare_placement(day, placement, (width, height))
            rotation = float(placement.get("rotation", 0))
            if rotation:
                asset = asset.rotate(
                    rotation,
                    resample=Image.Resampling.BICUBIC,
                    expand=True,
                )
            paste_x = round(x + (width - asset.width) / 2)
            paste_y = round(y + (height - asset.height) / 2)
            content_layer.alpha_composite(asset, (paste_x, paste_y))
            render_items.append(
                {
                    "day": day["day"],
                    "treatment": day["treatment"],
                    "placement_index": index,
                    "kind": placement["kind"],
                    "source": (
                        f"text:{placement['text']}"
                        if placement["kind"] == "text"
                        else (
                            placement.get("asset")
                            or day["sources"][int(placement.get("source_index", 0))]
                        )
                    ),
                    "owner_cell": {
                        "x": cell[0],
                        "y": cell[1],
                        "width": cell[2],
                        "height": cell[3],
                    },
                    "target_box": {
                        "x": x,
                        "y": y,
                        "width": width,
                        "height": height,
                    },
                    "actual_box": {
                        "x": paste_x,
                        "y": paste_y,
                        "width": asset.width,
                        "height": asset.height,
                    },
                    "rotation": rotation,
                    "white_outline": False,
                    "shadow": False,
                }
            )

    decoration_items: list[dict[str, Any]] = []
    for item in decoration_plan.get("dynamic_layer", {}).get("items", []):
        x, y, width, height = decoration_target_box(item, base.size)
        asset = prepare_sticker(item, (width, height))
        rotation = float(item.get("rotation", 0))
        if rotation:
            asset = asset.rotate(
                rotation,
                resample=Image.Resampling.BICUBIC,
                expand=True,
            )
        paste_x = round(x + (width - asset.width) / 2)
        paste_y = round(y + (height - asset.height) / 2)
        dynamic_sticker_layer.alpha_composite(asset, (paste_x, paste_y))

        owner_day = item.get("owner_day")
        owner_cell = day_cell(int(owner_day)) if owner_day else None
        date_overlap_pixels = 0
        date_overlap_days: list[int] = []
        owner_cell_alpha_pixels = 0
        owner_cell_coverage_ratio = 0.0
        if owner_cell:
            owner_cell_alpha_pixels = alpha_pixels_in_canvas_rect(
                asset,
                paste_x,
                paste_y,
                owner_cell,
            )
            owner_cell_coverage_ratio = owner_cell_alpha_pixels / (
                owner_cell[2] * owner_cell[3]
            )
        for calendar_day in range(1, 32):
            date_rect = absolute_box(day_cell(calendar_day), DATE_RESERVED_BOX)
            overlap_pixels = alpha_pixels_in_canvas_rect(
                asset,
                paste_x,
                paste_y,
                date_rect,
            )
            if overlap_pixels:
                date_overlap_pixels += overlap_pixels
                date_overlap_days.append(calendar_day)
        decoration_items.append(
            {
                "id": item["id"],
                "owner_day": owner_day,
                "category": item["category"],
                "semantic_trigger": item["semantic_trigger"],
                "asset": item["asset"],
                "source_library_file": item.get("source_library_file"),
                "anchor_scope": item.get("anchor_scope", "owner_cell"),
                "visual_count": int(item.get("visual_count", 1)),
                "target_box": {
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                },
                "actual_box": {
                    "x": paste_x,
                    "y": paste_y,
                    "width": asset.width,
                    "height": asset.height,
                },
                "rotation": rotation,
                "alpha_pixel_count": alpha_pixel_count(asset),
                "owner_cell_alpha_pixels": owner_cell_alpha_pixels,
                "owner_cell_coverage_ratio": round(
                    owner_cell_coverage_ratio,
                    4,
                ),
                "date_overlap_pixels": date_overlap_pixels,
                "date_overlap_days": date_overlap_days,
            }
        )

    result = Image.alpha_composite(base, content_layer)
    result = Image.alpha_composite(result, date_layer)
    result = Image.alpha_composite(result, static_layer)
    result = Image.alpha_composite(result, dynamic_sticker_layer)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    final_path = OUTPUT_DIR / FINAL_NAME
    result.convert("RGB").save(final_path, quality=96)

    preview = ImageOps.contain(result.convert("RGB"), (750, 1001))
    preview.save(OUTPUT_DIR / PREVIEW_NAME, quality=92)

    render_plan = {
        "schema_version": "1.1",
        "calendar": plan["calendar"],
        "canvas": {"width": result.width, "height": result.height},
        "grid": {"x": GRID_X, "y": GRID_Y},
        "layer_order": decoration_plan["layer_order"],
        "layers": {
            "base": "base.png",
            "content": "generated",
            "date": date_asset,
            "overlay_sticker_static": static_asset,
            "overlay_sticker_dynamic": "generated_from_decoration_plan",
        },
        "items": render_items,
        "decoration_items": decoration_items,
    }
    qa_report = validate(plan, decoration_plan, render_plan, final_path)
    return final_path, render_plan, qa_report


def validate(
    plan: dict[str, Any],
    decoration_plan: dict[str, Any],
    render_plan: dict[str, Any],
    final_path: Path,
) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    selected_days = [item["day"] for item in plan["days"]]

    calendar = plan.get("calendar", {})
    if (calendar.get("year"), calendar.get("month")) != (2026, 7):
        failures.append("当前渲染器只接受 2026 年 7 月计划")

    if len(selected_days) != len(set(selected_days)):
        failures.append("存在重复日期决策")
    if any(day < 1 or day > 31 for day in selected_days):
        failures.append("日期超出 2026 年 7 月范围")

    for day in plan["days"]:
        if day["treatment"] not in ALLOWED_TREATMENTS:
            failures.append(f"7 月 {day['day']} 日使用了未知处理方式")
        no_image_treatments = {
            "illustration_only",
            "illustration_with_text",
            "text_only",
            "blank",
        }
        source_count = len(day["sources"])
        if day["treatment"] in no_image_treatments:
            if source_count != 0:
                failures.append(f"7 月 {day['day']} 日无图片模式错误引用了照片")
        elif not 1 <= source_count <= 3:
            failures.append(f"7 月 {day['day']} 日素材数量不在 1–3 范围")
        for source in day["sources"]:
            source_path = run_path(source)
            suffix = source_path.suffix.lower()
            if suffix in {".gif", ".mov", ".mp4"}:
                failures.append(f"7 月 {day['day']} 日包含动态或视频素材")
            if not source_path.exists():
                failures.append(f"缺少源文件：{source_path}")
            match = SOURCE_DATE_PATTERN.match(source_path.name)
            if not match or int(match.group(1)) != day["day"]:
                failures.append(
                    f"7 月 {day['day']} 日引用了其他日期或无日期素材：{source}"
                )
        for placement in day["placements"]:
            if abs(float(placement.get("rotation", 0))) > 10:
                failures.append(f"7 月 {day['day']} 日旋转超过 10°")
            if placement["kind"] == "text":
                maximum = 24 if day["treatment"] == "text_only" else 14
                if len(placement["text"].replace("\n", "")) > maximum:
                    failures.append(f"7 月 {day['day']} 日文字超过 {maximum} 字")
                expected_design_size = (
                    10 if day["treatment"] == "text_only" else 8
                )
                if placement.get("design_font_size") != expected_design_size:
                    failures.append(
                        f"7 月 {day['day']} 日文字设计字号不是 "
                        f"{expected_design_size}"
                    )
            if placement["kind"] == "illustration":
                asset = RUN_DIR / placement["asset"]
                if not asset.exists():
                    failures.append(f"缺少插画素材：{asset}")
                if day.get("illustration_framing") != "close_up_or_single_focus":
                    failures.append(
                        f"7 月 {day['day']} 日插画未声明局部特写或单一视觉焦点"
                    )
                if day.get("human_full_body") is not False:
                    failures.append(f"7 月 {day['day']} 日插画未明确禁止人物全身构图")

    if plan["decision"]["cutout_style"]["white_outline"]:
        failures.append("抠图配置错误地启用了白色描边")
    if plan["decision"]["cutout_style"]["shadow"]:
        failures.append("抠图配置错误地启用了阴影")

    expected_layer_order = [
        "base",
        "content",
        "date",
        "overlay_sticker_static",
        "overlay_sticker_dynamic",
    ]
    if decoration_plan.get("layer_order") != expected_layer_order:
        failures.append("装饰层顺序与模板规范不一致")
    if render_plan.get("layers", {}).get("date") is None:
        failures.append("模板缺少日期层 date.png")
    if render_plan.get("layers", {}).get("overlay_sticker_static") is None:
        failures.append("模板缺少静态装饰层")

    dynamic_policy = decoration_plan.get("dynamic_layer", {}).get("policy", {})
    maximum_per_cell = int(dynamic_policy.get("maximum_visual_stickers_per_cell", 2))
    maximum_decorated_cells = int(
        dynamic_policy.get("maximum_decorated_cells_per_month", 8)
    )
    maximum_coverage_ratio = float(
        dynamic_policy.get("maximum_opaque_coverage_ratio_per_cell", 0.25)
    )
    visual_counts: dict[int, int] = {}
    decorated_days: set[int] = set()
    allowed_categories = {
        "paper",
        "people_and_animals",
        "scenery",
        "music_and_film",
        "abstract",
    }
    source_library = decoration_plan.get("source_library", {})
    source_library_value = source_library.get("directory", "")
    source_library_dir = (
        run_path(source_library_value) if source_library_value else None
    )
    if source_library.get("mode") == "user_provided_folder":
        if source_library_dir is None or not source_library_dir.is_dir():
            failures.append("用户动态贴纸素材目录不存在")
        if not source_library.get("reference_composite_is_not_asset_library"):
            failures.append("动态装饰参考合成层被错误标记为素材库")
    for item in render_plan.get("decoration_items", []):
        owner_day = item.get("owner_day")
        if owner_day is not None:
            owner_day = int(owner_day)
            if not 1 <= owner_day <= 31:
                failures.append(f"动态贴纸 {item['id']} 的所属日期无效")
                continue
            decorated_days.add(owner_day)
            visual_counts[owner_day] = visual_counts.get(owner_day, 0) + int(
                item.get("visual_count", 1)
            )
        if item["category"] not in allowed_categories:
            failures.append(f"动态贴纸 {item['id']} 使用了未知语义分类")
        if not item.get("semantic_trigger"):
            failures.append(f"动态贴纸 {item['id']} 缺少内容匹配依据")
        if not run_path(item["asset"]).exists():
            failures.append(f"缺少动态贴纸素材：{item['asset']}")
        else:
            prepared_asset = load_rgba(run_path(item["asset"]))
            alpha_minimum, alpha_maximum = prepared_asset.getchannel(
                "A"
            ).getextrema()
            if alpha_minimum >= 250 or alpha_maximum == 0:
                failures.append(f"动态贴纸 {item['id']} 没有有效透明背景")
        source_library_file = item.get("source_library_file")
        if source_library.get("mode") == "user_provided_folder":
            if not source_library_file:
                failures.append(f"动态贴纸 {item['id']} 缺少素材库来源文件")
            elif source_library_dir is None or not (
                source_library_dir / source_library_file
            ).exists():
                failures.append(
                    f"动态贴纸 {item['id']} 的素材库来源文件不存在"
                )
        if abs(float(item.get("rotation", 0))) > 10:
            failures.append(f"动态贴纸 {item['id']} 旋转超过 10°")
        if item.get("date_overlap_pixels", 0) > 0:
            failures.append(
                f"动态贴纸 {item['id']} 遮挡日期 "
                + "、".join(str(day) for day in item.get("date_overlap_days", []))
                + " 的数字保护区"
            )
        if item.get("owner_cell_coverage_ratio", 0) > maximum_coverage_ratio:
            failures.append(f"动态贴纸 {item['id']} 对所属日期格遮挡过多")

    for day, count in sorted(visual_counts.items()):
        if count > maximum_per_cell:
            failures.append(f"7 月 {day} 日动态贴纸超过 {maximum_per_cell} 个")
    if len(decorated_days) > maximum_decorated_cells:
        failures.append(
            f"动态装饰覆盖 {len(decorated_days)} 个日期格，"
            f"超过上限 {maximum_decorated_cells}"
        )

    day24 = next(
        (
            item
            for item in plan["days"]
            if item["day"] == 24 and item.get("ticket_qr_crop_required")
        ),
        None,
    )
    if day24 is not None and len(day24["placements"]) > 1:
        ticket = next(
            (
                placement
                for placement in day24["placements"]
                if placement.get("role") == "ticket"
            ),
            day24["placements"][1],
        )
        if ticket.get("crop", [0, 0, 1, 1])[3] > 0.80:
            failures.append("7 月 24 日小票未充分裁除底部二维码")

    for item in render_plan["items"]:
        box = item["actual_box"]
        if box["x"] + box["width"] <= 0 or box["y"] + box["height"] <= 0:
            failures.append(f"7 月 {item['day']} 日素材完全位于画布外")
        if box["x"] >= 1500 or box["y"] >= 2001:
            failures.append(f"7 月 {item['day']} 日素材完全位于画布外")

    if not final_path.exists():
        failures.append("最终日历未生成")
        output_size = None
    else:
        with Image.open(final_path) as output:
            output_size = list(output.size)
            if output.size != (1500, 2001):
                failures.append("最终日历尺寸与模板不一致")

    blank_days = [day for day in range(1, 32) if day not in set(selected_days)]
    consecutive_blank_pairs = [
        [left, right]
        for left, right in zip(blank_days, blank_days[1:])
        if right == left + 1
    ]
    if consecutive_blank_pairs:
        failures.append(
            "存在连续空白日期："
            + "、".join(f"{left}–{right}" for left, right in consecutive_blank_pairs)
        )
    if len(blank_days) < 1:
        warnings.append("整月没有留白日期，可能过于拥挤")

    art_direction_summary = plan.get("decision", {}).get(
        "art_direction_summary"
    )
    if art_direction_summary is not None:
        long_rectangular_runs = art_direction_summary.get(
            "consecutive_rectangular_runs_over_limit",
            [],
        )
        if long_rectangular_runs:
            failures.append(
                "存在连续三个以上完整矩形照片："
                + "、".join(
                    "-".join(str(day) for day in run)
                    for run in long_rectangular_runs
                )
            )
        if art_direction_summary.get("status") != "PASS":
            failures.append("全月艺术指导复核未通过")

    checks = {
        "date_ownership": "PASS",
        "one_to_three_sources_per_day": "PASS",
        "unsupported_media_excluded": "PASS",
        "qr_area_excluded": "PASS",
        "rotation_within_10_degrees": "PASS",
        "cutout_without_outline_or_shadow": "PASS",
        "text_lengths_within_limits": "PASS",
        "text_font_sizes_match_spec": "PASS",
        "illustration_assets_complete": "PASS",
        "illustration_closeup_framing": "PASS",
        "no_consecutive_blank_days": "PASS",
        "monthly_art_direction_review": "PASS",
        "no_three_consecutive_rectangular_cells": "PASS",
        "five_layer_order": "PASS",
        "static_decoration_from_template": "PASS",
        "dynamic_sticker_assets_complete": "PASS",
        "dynamic_stickers_from_user_library": "PASS",
        "dynamic_stickers_have_transparency": "PASS",
        "dynamic_sticker_semantic_match": "PASS",
        "dynamic_stickers_within_cell_limit": "PASS",
        "dynamic_stickers_avoid_date_numbers": "PASS",
        "dynamic_stickers_within_occlusion_limit": "PASS",
        "template_dimensions": "PASS",
        "output_readable": "PASS",
    }
    if failures:
        for key in checks:
            checks[key] = "REVIEW"

    return {
        "status": "PASS" if not failures else "FAIL",
        "selected_day_count": len(selected_days),
        "blank_days": blank_days,
        "consecutive_blank_pairs": consecutive_blank_pairs,
        "art_direction_summary": art_direction_summary,
        "rendered_placement_count": len(render_plan["items"]),
        "dynamic_decoration_item_count": len(
            render_plan.get("decoration_items", [])
        ),
        "dynamic_decorated_days": sorted(decorated_days),
        "output_size": output_size,
        "checks": checks,
        "failures": failures,
        "warnings": warnings,
    }


def write_processing_report(plan: dict[str, Any]) -> None:
    counts: dict[str, int] = {}
    decision = plan.get("decision", {})
    backend = decision.get("backend", "unknown")
    api_used = "已调用外部 API" if decision.get("api_used") else "未调用外部 API"
    maximum_sources = max((len(item["sources"]) for item in plan["days"]), default=0)
    lines = [
        "# 2026 年 7 月图片处理决策报告",
        "",
        f"本报告由 `{backend}` 依据交付规则逐日判断；{api_used}。",
        "",
        "| 日期 | 处理方式 | 图片数 | 判断理由 |",
        "|---|---|---:|---|",
    ]
    for item in plan["days"]:
        treatment = item["treatment"]
        counts[treatment] = counts.get(treatment, 0) + 1
        lines.append(
            f"| 7/{item['day']} | `{treatment}` | {len(item['sources'])} | "
            f"{item.get('reason', '')} |"
        )
    lines.extend(["", "## 处理方式分布", ""])
    for treatment, count in sorted(counts.items()):
        lines.append(f"- `{treatment}`：{count} 天")
    if DECORATION_PLAN_PATH.exists():
        decoration_plan = read_json(DECORATION_PLAN_PATH)
        decoration_items = decoration_plan.get("dynamic_layer", {}).get(
            "items",
            [],
        )
        lines.extend(
            [
                "",
                "## 动态装饰决策",
                "",
                "| 日期 | 语义分类 | 贴纸 | 选择依据 |",
                "|---|---|---|---|",
            ]
        )
        for item in decoration_items:
            lines.append(
                f"| 7/{item['owner_day']} | `{item['category']}` | "
                f"{Path(item['asset']).stem} | {item.get('reason', '')} |"
            )
    lines.extend(
        [
            "",
            "## 固定执行约束",
            "",
            f"- 每天最多 3 张素材，本月实际最多为 {maximum_sources} 张。",
            "- 所有旋转角度绝对值不超过 10°。",
            "- 所有透明抠图均不加白色描边、不加阴影。",
            "- 静态装饰完全按模板；动态贴纸每格最多 1–2 个。",
            "- 动态贴纸不得遮挡任意日期数字或重要主体。",
            (
                "- 票据或二维码素材均已在处理阶段裁除敏感区域。"
                if any(item.get("ticket_qr_crop_required") for item in plan["days"])
                else "- 本次未使用票据、二维码、付款码或条形码素材。"
            ),
            "- 空白日期不强行填充无关图片。",
            "",
        ]
    )
    (REPORT_DIR / "treatment_report.md").write_text(
        "\n".join(lines),
        encoding="utf-8",
    )


def write_report_images(plan: dict[str, Any]) -> None:
    image_dir = REPORT_DIR / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    preview_size = (420, 240)

    for item in plan["days"]:
        sources = [run_path(source) for source in item["sources"]]
        canvas = Image.new("RGB", preview_size, "#f2f2f2")
        if not sources:
            final = load_rgba(OUTPUT_DIR / FINAL_NAME).convert("RGB")
            x, y, width, height = day_cell(item["day"])
            cell_preview = final.crop((x, y, x + width, y + height))
            fitted = ImageOps.contain(
                cell_preview,
                (preview_size[0] - 12, preview_size[1] - 12),
                Image.Resampling.LANCZOS,
            )
            canvas.paste(
                fitted,
                (
                    (preview_size[0] - fitted.width) // 2,
                    (preview_size[1] - fitted.height) // 2,
                ),
            )
            canvas.save(
                image_dir / f"day{item['day']:02d}.jpg",
                quality=88,
                optimize=True,
            )
            continue
        slot_width = preview_size[0] // len(sources)
        for index, source in enumerate(sources):
            image = load_rgba(source).convert("RGB")
            if item["day"] == 24 and index == 1:
                image = image.crop((0, 0, image.width, round(image.height * 0.76)))
            fitted = ImageOps.contain(
                image,
                (slot_width - 12, preview_size[1] - 12),
                Image.Resampling.LANCZOS,
            )
            slot_x = index * slot_width
            paste_x = slot_x + (slot_width - fitted.width) // 2
            paste_y = (preview_size[1] - fitted.height) // 2
            canvas.paste(fitted, (paste_x, paste_y))
        canvas.save(
            image_dir / f"day{item['day']:02d}.jpg",
            quality=88,
            optimize=True,
        )


def configure_from_arguments() -> None:
    global RUN_DIR, PLAN_PATH, DECORATION_PLAN_PATH
    global OUTPUT_DIR, REPORT_DIR, FINAL_NAME, PREVIEW_NAME
    global TEMPLATE_DIR_OVERRIDE, FONT_PATH

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--run-dir",
        type=Path,
        default=RUN_DIR,
        help="包含 treatment_plan.json 的运行目录",
    )
    parser.add_argument("--final-name", default=FINAL_NAME)
    parser.add_argument("--preview-name", default=PREVIEW_NAME)
    parser.add_argument(
        "--template-dir",
        type=Path,
        help="覆盖计划中的模板目录，便于在其他机器运行",
    )
    parser.add_argument(
        "--font-path",
        type=Path,
        help="覆盖模板字体；默认读取模板目录中的 fonts.ttf",
    )
    args = parser.parse_args()

    RUN_DIR = args.run_dir.expanduser().resolve()
    PLAN_PATH = RUN_DIR / "treatment_plan.json"
    DECORATION_PLAN_PATH = RUN_DIR / "decoration_plan.json"
    OUTPUT_DIR = RUN_DIR / "output"
    REPORT_DIR = RUN_DIR / "reports"
    FINAL_NAME = args.final_name
    PREVIEW_NAME = args.preview_name
    TEMPLATE_DIR_OVERRIDE = (
        args.template_dir.expanduser().resolve() if args.template_dir else None
    )
    if args.font_path:
        FONT_PATH = args.font_path.expanduser().resolve()


def main() -> None:
    configure_from_arguments()
    final_path, render_plan, qa_report = render()
    write_json(RUN_DIR / "render_plan.json", render_plan)
    write_json(REPORT_DIR / "qa_report.json", qa_report)
    plan = read_json(PLAN_PATH)
    write_report_images(plan)
    write_processing_report(plan)
    print(final_path)
    print(f"QA: {qa_report['status']}")


if __name__ == "__main__":
    main()

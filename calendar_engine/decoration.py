from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any


ENGINE_ROOT = Path(__file__).resolve().parent
DEFAULT_LIBRARY_DIR = ENGINE_ROOT / "assets" / "dynamic_stickers"
DEFAULT_MANIFEST_PATH = DEFAULT_LIBRARY_DIR / "manifest.json"
DEFAULT_RULES_PATH = ENGINE_ROOT / "rules" / "treatment_rules_v1.json"
LAYER_ORDER = [
    "base",
    "content",
    "date",
    "overlay_sticker_static",
    "overlay_sticker_dynamic",
]

# Strong memory signals outrank generic words such as "person" or "outside".
CATEGORY_KEYWORDS: dict[str, dict[str, int]] = {
    "paper": {
        "手写": 8,
        "贺卡": 8,
        "卡片": 7,
        "纸张": 7,
        "便签": 6,
        "票据": 6,
        "小票": 6,
        "手作": 5,
        "海报": 2,
        "paper": 6,
        "card": 7,
        "note": 5,
        "ticket": 6,
    },
    "people_and_animals": {
        "双宠物": 10,
        "宠物": 8,
        "猫": 8,
        "狗": 8,
        "合照": 7,
        "亲密": 7,
        "人物": 3,
        "人像": 4,
        "pet": 8,
        "cat": 8,
        "dog": 8,
        "portrait": 4,
        "people": 3,
    },
    "scenery": {
        "晚霞": 10,
        "日落": 9,
        "风景": 8,
        "城市": 7,
        "旅行": 7,
        "湖": 6,
        "海": 6,
        "自然": 5,
        "草地": 4,
        "外出": 3,
        "展览": 3,
        "sunset": 9,
        "scenery": 8,
        "landscape": 8,
        "city": 7,
        "travel": 7,
        "nature": 5,
    },
    "music_and_film": {
        "现场音乐": 12,
        "演唱": 10,
        "演出": 9,
        "唱歌": 9,
        "音乐": 8,
        "电影": 8,
        "影视": 8,
        "专辑": 7,
        "海报": 3,
        "live music": 12,
        "concert": 10,
        "performance": 9,
        "music": 8,
        "movie": 8,
        "film": 8,
    },
}

ASSET_FOR_CATEGORY = {
    "paper": "pushpin_blue",
    "people_and_animals": "embroidered_hearts_pink",
    "scenery": "camera_purple",
    "music_and_film": "music_note_silver",
    "abstract": "outline_star_silver",
}

REASON_FOR_CATEGORY = {
    "paper": "图钉强化纸质、卡片或手作素材的真实贴入感。",
    "people_and_animals": (
        "爱心用于轻量呼应人物或宠物关系，不增加新的关系事实。"
    ),
    "scenery": "相机贴纸呼应风景与外出记录，保持画面主体可见。",
    "music_and_film": "银色音符呼应音乐、演出或影视娱乐内容。",
    "abstract": "空白格使用无具体事件指向的轮廓星星调节版面节奏。",
}

BLANK_DAY_PREFERENCE = [16, 6, 9, 13, 17, 23, 28, 2, 12, 19, 26, 31]


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def semantic_text(day: dict[str, Any]) -> str:
    values = [
        day.get("reason", ""),
        day.get("treatment", ""),
        day.get("illustration_category", ""),
        day.get("illustration_brief", ""),
    ]
    values.extend(
        placement.get("text", "")
        for placement in day.get("placements", [])
        if isinstance(placement, dict)
    )
    return " ".join(str(value) for value in values).lower()


def category_scores(day: dict[str, Any]) -> dict[str, int]:
    text = semantic_text(day)
    return {
        category: sum(weight for keyword, weight in keywords.items() if keyword in text)
        for category, keywords in CATEGORY_KEYWORDS.items()
    }


def strongest_category(day: dict[str, Any]) -> tuple[str | None, int]:
    scores = category_scores(day)
    category, score = max(scores.items(), key=lambda item: item[1])
    return (category, score) if score > 0 else (None, 0)


def category_candidate_score(day: dict[str, Any], category: str, score: int) -> int:
    text = semantic_text(day)
    if category == "scenery" and any(
        keyword in text
        for keyword in ("人物", "人像", "肖像", "面部", "侧脸", "portrait", "people")
    ):
        # A camera sticker is safer on a pure landscape than beside a face.
        return score - 8
    return score


def select_content_days(
    days: list[dict[str, Any]],
    maximum: int,
) -> list[tuple[dict[str, Any], str, int]]:
    best_by_category: dict[str, tuple[dict[str, Any], int]] = {}
    excluded_treatments = {"blank", "text_only", "illustration_only", "illustration_with_text"}
    for day in days:
        if day.get("treatment") in excluded_treatments:
            continue
        category, score = strongest_category(day)
        if category is None:
            continue
        score = category_candidate_score(day, category, score)
        if score <= 0:
            continue
        current = best_by_category.get(category)
        candidate_key = (score, int(day["day"]))
        current_key = (
            (current[1], int(current[0]["day"]))
            if current is not None
            else (-1, -1)
        )
        if candidate_key > current_key:
            best_by_category[category] = (day, score)

    selected = [
        (day, category, score)
        for category, (day, score) in best_by_category.items()
    ]
    selected.sort(key=lambda item: (-item[2], int(item[0]["day"]), item[1]))
    return selected[:maximum]


def choose_abstract_blank_day(
    occupied_days: set[int],
    decorated_days: set[int],
) -> int | None:
    for day in BLANK_DAY_PREFERENCE:
        if day in occupied_days or day in decorated_days:
            continue
        if any(abs(day - decorated) <= 1 for decorated in decorated_days):
            continue
        return day
    return None


def load_assets(manifest_path: Path) -> dict[str, dict[str, Any]]:
    manifest = read_json(manifest_path)
    return {str(item["id"]): item for item in manifest["assets"]}


def copy_library(library_dir: Path, manifest_path: Path, run_dir: Path) -> Path:
    target_dir = run_dir / "assets" / "dynamic_stickers"
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest = read_json(manifest_path)
    for item in manifest["assets"]:
        source = library_dir / item["file"]
        if not source.is_file():
            raise FileNotFoundError(f"missing dynamic sticker asset: {source}")
        shutil.copy2(source, target_dir / item["file"])
    sanitized_manifest = dict(manifest)
    write_json(target_dir / "manifest.json", sanitized_manifest)
    return target_dir


def decoration_item(
    day: int,
    category: str,
    asset: dict[str, Any],
    semantic_trigger: str,
) -> dict[str, Any]:
    return {
        "id": f"day{day:02d}_{asset['id']}",
        "owner_day": day,
        "category": category,
        "semantic_trigger": semantic_trigger,
        "asset": f"assets/dynamic_stickers/{asset['file']}",
        "source_library_file": asset["file"],
        "anchor_scope": "owner_cell",
        "box": list(asset["default_box"]),
        "rotation": float(asset["default_rotation"]),
        "visual_count": int(asset.get("visual_count", 1)),
        "reason": REASON_FOR_CATEGORY[category],
    }


def build_decoration_plan(
    run_dir: Path,
    *,
    library_dir: Path = DEFAULT_LIBRARY_DIR,
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
    rules_path: Path = DEFAULT_RULES_PATH,
    maximum_decorated_cells: int = 5,
    include_abstract_blank: bool = True,
) -> dict[str, Any]:
    run_dir = run_dir.expanduser().resolve()
    plan = read_json(run_dir / "treatment_plan.json")
    rules = read_json(rules_path)
    policy = rules["decoration_layer_policy"]["dynamic_layer"]
    hard_maximum = int(policy["maximum_decorated_cells_per_month"])
    maximum_decorated_cells = max(0, min(maximum_decorated_cells, hard_maximum))
    assets = load_assets(manifest_path)
    copy_library(library_dir, manifest_path, run_dir)

    selected = select_content_days(plan["days"], maximum_decorated_cells)
    items: list[dict[str, Any]] = []
    for day_data, category, _score in selected:
        asset = assets[ASSET_FOR_CATEGORY[category]]
        items.append(
            decoration_item(
                int(day_data["day"]),
                category,
                asset,
                semantic_text(day_data)[:160],
            )
        )

    if include_abstract_blank and len(items) < maximum_decorated_cells:
        occupied_days = {int(day["day"]) for day in plan["days"]}
        decorated_days = {int(item["owner_day"]) for item in items}
        blank_day = choose_abstract_blank_day(occupied_days, decorated_days)
        if blank_day is not None:
            asset = assets[ASSET_FOR_CATEGORY["abstract"]]
            items.append(
                decoration_item(
                    blank_day,
                    "abstract",
                    asset,
                    "独立空白日期的抽象节奏填充",
                )
            )

    items.sort(key=lambda item: int(item["owner_day"]))
    result = {
        "schema_version": "1.1",
        "decision_backend": "deterministic_semantic_sticker_rules_v1",
        "source_library": {
            "mode": "bundled_curated_library",
            "directory": "assets/dynamic_stickers",
            "catalog": "assets/dynamic_stickers/manifest.json",
            "reference_composite_is_not_asset_library": True,
        },
        "layer_order": LAYER_ORDER,
        "static_layer": {
            "mode": "template_fixed",
            "preferred_asset": "overlay_sticker_static.png",
            "compatible_asset": "overlay_sticker_statistic.png",
            "reason": "模板固定装饰保持品牌视觉，不随相册内容改变。",
        },
        "dynamic_layer": {
            "mode": "semantic_selection_then_rule_layout",
            "policy": {
                "maximum_visual_stickers_per_cell": int(
                    policy["maximum_visual_stickers_per_cell"]
                ),
                "maximum_decorated_cells_per_month": hard_maximum,
                "maximum_opaque_coverage_ratio_per_cell": float(
                    policy["maximum_opaque_coverage_ratio_per_cell"]
                ),
                "date_number_overlap_allowed": False,
                "rotation_absolute_maximum_degrees": int(
                    policy["maximum_absolute_rotation_degrees"]
                ),
                "cross_cell_allowed": bool(policy["cross_cell_allowed"]),
                "must_not_confuse_date_ownership": True,
            },
            "items": items,
        },
    }
    write_json(run_dir / "decoration_plan.json", result)
    return result

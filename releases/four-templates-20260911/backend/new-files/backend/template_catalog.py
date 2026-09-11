"""User-confirmed production catalog; legacy JSON files are not active templates."""

import json
from pathlib import Path

from . import template_packages

ROOT = Path(__file__).resolve().parent.parent
PREVIEW_ROOT = ROOT / "assets" / "template-previews"
ACTIVE_IDS = ("template_1", "template_2", "template_3", "denim_pet")
STANDARD_IDS = ACTIVE_IDS[:3]
NAMES = dict(zip(ACTIVE_IDS, ("日常拼贴", "圣诞手帐", "分层抠图拼贴", "宠物牛仔拼贴")))


def list_templates() -> list[dict]:
    entries = []
    for tid in ACTIVE_IDS:
        entry = {
            "id": tid, "name": NAMES[tid], "builtin": True,
            "description": ("5 张宠物照片，通过专属抠图流程生成" if tid == "denim_pet" else
                            "15 张照片的分层拼贴，其中 12 张需要抠图" if tid == "template_3" else
                            "8 张照片的节日主题拼贴" if tid == "template_2" else "8 张照片的日常手帐拼贴"),
            "qualified": False, "status": "unavailable", "reason": "",
            "width": 0, "height": 0, "slots": 0, "decorations": 0,
            "generation_mode": "pet_cutout" if tid == "denim_pet" else "standard",
            "preview_url": f"/api/template_preview/{tid}.png",
            "preview_kind": "repository_reference" if tid == "template_3" else "layout_placeholder",
        }
        try:
            if tid in template_packages.PACKAGE_IDS:
                config = template_packages.load_package(tid)
                folder = template_packages.ASSET_ROOT / tid
                if tid == "template_1":
                    required = [folder / "bg.png", folder / "fonts/momo-zhuanji-handwriting-4.0.ttf"]
                elif tid == "template_2":
                    required = [folder / "bg.jpg", folder / "sticker.png", folder / "assets/momo-zhuanji-handwriting-4.0.ttf"]
                else:
                    required = [folder / name for name in ("summary.yaml", "processing.json", "review.json")]
                entry.update(width=config["canvas"]["width"], height=config["canvas"]["height"],
                             slots=template_packages.required_photo_count(tid))
            else:
                folder = ROOT / "assets/templates/denim"
                config = json.loads((folder / "template.json").read_text(encoding="utf-8"))
                required = [folder / "background.png"] + [folder / s["asset_file"] for s in config["stickers"]]
                entry.update(width=round(config["canvas"]["width"]), height=round(config["canvas"]["height"]),
                             slots=len(config["photo_slots"]), decorations=len(config["stickers"]))
            missing = [p.name for p in required if not p.is_file()]
            if missing:
                raise ValueError("缺少模板资源：" + ", ".join(missing))
            if tid == "template_3":
                reason = template_packages.cutout_unavailable_reason()
                if reason:
                    raise ValueError(reason)
            entry.update(qualified=True, status="ready")
        except (OSError, ValueError, KeyError, TypeError) as error:
            entry["reason"] = str(error)
        entry["preview_available"] = (PREVIEW_ROOT / f"{tid}.png").is_file()
        entries.append(entry)
    return entries

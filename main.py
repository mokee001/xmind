"""
命令行入口：选一个手帐模版，把 photos/ 里的照片渲染成成品图。

示例：
    python3 main.py --template daily_polaroid --title "周末的一天" --date 2026-07-19
    python3 main.py --all --title "东京旅行" --date 2026-07-19
"""

import argparse
import glob
import os

import engine

BASE = os.path.dirname(__file__)
TEMPLATES_DIR = os.path.join(BASE, "templates")
PHOTOS_DIR = os.path.join(BASE, "photos")
OUTPUT_DIR = os.path.join(BASE, "output")


def list_photos() -> list[str]:
    exts = ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.PNG")
    files: list[str] = []
    for ext in exts:
        files.extend(glob.glob(os.path.join(PHOTOS_DIR, ext)))
    return sorted(files)


def render_one(template_id: str, photos: list[str], title: str, date: str) -> str:
    tpl_path = os.path.join(TEMPLATES_DIR, f"{template_id}.json")
    template = engine.load_template(tpl_path)
    img = engine.render(template, photos, {"title": title, "date": date})
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f"{template_id}.png")
    img.save(out_path)
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description="手帐照片墙排版引擎")
    parser.add_argument("--template", help="模版 id（templates/ 下的文件名，不含 .json）")
    parser.add_argument("--all", action="store_true", help="渲染所有模版")
    parser.add_argument("--title", default="我的一天", help="标题文字")
    parser.add_argument("--date", default="", help="日期文字，如 2026-07-19")
    args = parser.parse_args()

    photos = list_photos()
    if not photos:
        print("photos/ 里没有照片。先运行：python3 make_samples.py")
        return

    if args.all:
        ids = [
            os.path.splitext(os.path.basename(p))[0]
            for p in sorted(glob.glob(os.path.join(TEMPLATES_DIR, "*.json")))
        ]
    elif args.template:
        ids = [args.template]
    else:
        print("请指定 --template <id> 或 --all")
        return

    for tid in ids:
        out = render_one(tid, photos, args.title, args.date)
        print("已渲染:", out)


if __name__ == "__main__":
    main()

"""
内容创作路由（负责人 B）：贴纸上传/管理 + 模板上传/管理 + Studio 自动匹配预览。

这些端点从 server.py 抽离出来，让 B 只改这一个文件、A 只改 server.py，
两人日常开发互不冲突。所有路由挂在同一个 APIRouter 上，由 server.py 用
    from .routers import content
    app.include_router(content.router)
装载，路径和行为与拆分前完全一致。
"""

from __future__ import annotations

import datetime
import io
import json
import os
import random
import sys
import time
from typing import Optional

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

# engine.py 在项目根目录，保证能被导入
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import engine  # noqa: E402

from .. import stickers, store, templates_mgr  # noqa: E402

OUTPUT_DIR = os.path.join(_ROOT, "output")

router = APIRouter()


class StudioPreviewReq(BaseModel):
    template: Optional[str] = None   # 指定模板 id；留空=随机挑一个（多样惊喜）
    title: str = "我的一天"
    date: str = ""


# ---------- 贴纸 ----------

@router.post("/api/upload_sticker")
async def upload_sticker(files: list[UploadFile], themes: str = "") -> dict:
    """上传抠图贴纸到 stickers/ 目录并达标校验。
    themes：逗号分隔的主题（如 "food,mood_fresh" 或 "美食,清新"），留空则按文件名推断/通用。"""
    theme_list = [t.strip() for t in themes.split(",") if t.strip()]
    added: list[dict] = []
    for f in files:
        name = os.path.basename(f.filename or f"sticker_{int(time.time())}.png")
        dest = os.path.join(stickers.STICKERS_DIR, name)
        with open(dest, "wb") as out:
            out.write(await f.read())
        added.append(stickers.add_uploaded(dest, theme_list or None))
    ok = [a for a in added if a.get("qualified")]
    bad = [{"filename": a["filename"], "reason": a["reason"]} for a in added if not a.get("qualified")]
    return {"added": len(added), "qualified": len(ok), "rejected": bad, "stickers": stickers.load_all()}


@router.get("/api/stickers")
def list_stickers() -> dict:
    all_st = stickers.load_all()
    return {
        "count": len(all_st),
        "qualified": len([s for s in all_st if s.get("qualified")]),
        "stickers": all_st,
    }


@router.post("/api/ingest_stickers")
def ingest_stickers() -> dict:
    """重新扫描 stickers/ 目录（丢了新文件进去后调用），达标校验并入库。"""
    all_st = stickers.ingest_folder()
    return {
        "count": len(all_st),
        "qualified": len([s for s in all_st if s.get("qualified")]),
        "stickers": all_st,
    }


@router.get("/api/sticker.png/{name}")
def sticker_png(name: str):
    """预览某张贴纸原图。"""
    path = os.path.join(stickers.STICKERS_DIR, os.path.basename(name))
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path)


# ---------- 创作平台：模板维度 + 自动匹配预览 ----------

def _studio_sample(n: int) -> list[dict]:
    """给预览挑 n 张样片：优先用相册里的达标照片（随机，保证「换一批」有多样性），
    相册不够/为空时用占位图补齐。返回 [{path, tags}]。"""
    photos = [p for p in store.load("photos", []) if p.get("quality", 1) > 0]
    picked: list[dict] = []
    if len(photos) >= n:
        picked = random.sample(photos, n)
    elif photos:
        picked = list(photos)
        random.shuffle(picked)
    # 用占位图补齐（tags 为空，只会匹配 any 主题贴纸）
    if len(picked) < n:
        for ph in templates_mgr.placeholder_photos(n - len(picked)):
            picked.append({"path": ph, "tags": []})
    return [{"path": p["path"], "tags": p.get("tags", [])} for p in picked[:n]]


@router.get("/api/templates")
def list_templates() -> dict:
    """列出所有模板（内置 + 上传）及其达标状态、槽位数等元数据。"""
    entries = templates_mgr.list_templates()
    return {
        "count": len(entries),
        "qualified": len([t for t in entries if t.get("qualified")]),
        "templates": entries,
    }


@router.post("/api/upload_template")
async def upload_template(files: list[UploadFile]) -> dict:
    """上传模板 JSON 文件并达标校验（可一次传多个）。达标者写入 templates/ 目录。"""
    results: list[dict] = []
    for f in files:
        raw = await f.read()
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            results.append({"filename": f.filename, "qualified": False,
                            "reason": f"不是合法 JSON：{e}"})
            continue
        entry = templates_mgr.save_uploaded(data)
        entry["filename"] = f.filename
        results.append(entry)
    ok = [r for r in results if r.get("qualified")]
    bad = [{"filename": r.get("filename"), "reason": r.get("reason")}
           for r in results if not r.get("qualified")]
    return {"added": len(results), "qualified": len(ok), "rejected": bad,
            "templates": templates_mgr.list_templates()}


@router.post("/api/delete_template")
def delete_template(req: dict) -> dict:
    tid = str(req.get("id", ""))
    ok = templates_mgr.delete_template(tid)
    return {"deleted": ok, "templates": templates_mgr.list_templates()}


@router.get("/api/template_preview/{tid}.png")
def template_preview(tid: str):
    """渲染某个模板的缩略预览（用占位图/样片填充，不贴贴纸），给平台的模板卡片当封面。"""
    tpl = templates_mgr.load_template(tid)
    if not tpl:
        return JSONResponse({"error": "not found"}, status_code=404)
    n = len(tpl.get("slots", []))
    photos = templates_mgr.placeholder_photos(n)
    try:
        img = engine.render(tpl, photos, {"title": tpl.get("name", "预览"),
                                          "date": "2026-01-01"})
    except Exception as e:
        return JSONResponse({"error": f"render failed: {e}"}, status_code=500)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@router.post("/api/studio/preview")
def studio_preview(req: StudioPreviewReq) -> dict:
    """创作平台的核心预览：自动挑模板 + 自动匹配贴纸 + 用相册样片渲染，
    生成一张「多样有惊喜感」的照片墙效果图。不推屏、不覆盖正式画面（纯预览）。"""
    tpls = [t for t in templates_mgr.list_templates() if t.get("qualified")]
    if not tpls:
        return {"error": "没有达标的模板"}

    if req.template:
        tpl = templates_mgr.load_template(req.template)
        if not tpl:
            return {"error": f"模板 {req.template} 不存在"}
        tid = req.template
    else:
        choice = random.choice(tpls)          # 随机挑一个 -> 多样惊喜
        tpl = templates_mgr.load_template(choice["id"])
        tid = choice["id"]

    slot_n = len(tpl.get("slots", []))
    chosen = _studio_sample(slot_n)
    photo_paths = [c["path"] for c in chosen]

    canvas = tpl.get("canvas", {})
    W, H = int(canvas.get("width", 1280)), int(canvas.get("height", 720))
    # 自动匹配贴纸：预览里至少尝试贴 1 张，让用户直观看到「贴纸×模板」的组合
    try:
        plan = stickers.plan_for_wall(tpl, chosen, [], W, H, min_count=1)
        matched_by_theme = bool(plan)
        if not plan:                       # 主题没匹配上也放 1 张做展示（正式成墙才严格按主题）
            plan = stickers.plan_any(tpl, chosen, W, H, n=1)
    except Exception:
        plan = []
        matched_by_theme = False

    date = req.date or datetime.date.today().isoformat()
    img = engine.render(tpl, photo_paths, {"title": req.title, "date": date},
                        stickers=plan)
    out_name = f"_studio_{int(time.time() * 1000)}.png"
    img.save(os.path.join(OUTPUT_DIR, out_name))
    return {
        "image_url": f"/output/{out_name}",
        "template": tid,
        "template_name": tpl.get("name", tid),
        "slots": slot_n,
        "stickers": [os.path.basename(p["path"]) for p in plan],
        "stickers_by_theme": matched_by_theme,
        "using_placeholder": any("/output/_ph/" in c.get("path", "") for c in chosen),
    }

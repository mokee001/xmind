#!/usr/bin/env python3
"""Build a visual A/B report for the legacy and configurable curation strategy."""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from backend import curation, dedup, selector  # noqa: E402
from compare_immich import make_thumbnails  # noqa: E402


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def card(item: dict, thumb: str, status: str = "") -> str:
    reasons = "、".join(item.get("memory_reasons", [])) or "—"
    memory = item.get("memory_score")
    memory_line = f'<span>回忆 {memory:.3f} · {html.escape(reasons)}</span>' if memory is not None else ""
    return (
        f'<figure class="{status}"><img src="{thumb}" loading="lazy"><figcaption>'
        f'<b>{html.escape(item["filename"])}</b><span>最终 {item.get("final_score", 0):.4f}</span>'
        f'{memory_line}</figcaption></figure>'
    )


def main() -> None:
    source = ROOT / "outputs" / "immich-comparison"
    output = ROOT / "outputs" / "selection-strategy-comparison"
    output.mkdir(parents=True, exist_ok=True)
    local = load(source / "current-cache.json")
    embeddings = load(source / "immich-cache.json")
    all_items = list(local.values())
    valid = [dict(item) for item in all_items
             if item.get("quality", 0) > 0 and item.get("capture_source") != "non_photo"]
    slot_count = min(20, len(valid))

    legacy_policy = {
        "name": "legacy",
        "weights": {"quality": 0.30, "aesthetic": 0.25, "preference": 0.45, "memory": 0.0},
        "semantic_diversity": 0.0, "event_diversity": 0.0,
    }
    legacy_items = [{key: value for key, value in item.items()
                     if key not in {"clip_embedding", "memory_score", "memory_reasons", "event_id"}}
                    for item in valid]
    model = {"weights": {}, "bias": 0.5}
    old = selector.select_for_template(legacy_items, slot_count, model=model, policy=legacy_policy)

    enriched = []
    for item in valid:
        vector = embeddings.get(str(item["path"]), {}).get("embedding")
        if vector:
            item["clip_embedding"] = vector
        enriched.append(item)
    enriched = curation.prepare(enriched)
    kept, removed_duplicates = dedup.deduplicate(enriched)
    new = selector.select_for_template(kept, min(slot_count, len(kept)), model=model)

    old_names = {item["filename"] for item in old}
    new_names = {item["filename"] for item in new}
    thumbs = make_thumbnails(all_items, output)
    old_cards = "".join(card(item, thumbs[str(item["path"])], "removed" if item["filename"] not in new_names else "") for item in old)
    new_cards = "".join(card(item, thumbs[str(item["path"])], "added" if item["filename"] not in old_names else "") for item in new)
    rejected = len(all_items) - len(valid)
    document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>选片策略 A/B</title><style>
body{{margin:0;background:#0d0f14;color:#f4f5f7;font:15px system-ui,-apple-system,sans-serif}}main{{max-width:1450px;margin:auto;padding:28px}}h1{{font-size:34px;margin-bottom:5px}}p,figcaption span{{color:#9da5b4}}.stats,.cols{{display:grid;gap:16px}}.stats{{grid-template-columns:repeat(4,1fr);margin:24px 0}}.stat,.panel{{background:#151820;border:1px solid #292e3a;border-radius:14px;padding:17px}}.stat strong{{display:block;font-size:28px;margin-top:5px}}.cols{{grid-template-columns:1fr 1fr}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}figure{{margin:0;background:#0e1015;border:2px solid transparent;border-radius:12px;overflow:hidden}}figure.removed{{border-color:#d96670}}figure.added{{border-color:#59c99a}}img{{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}}figcaption{{padding:10px;overflow-wrap:anywhere}}figcaption span{{display:block;margin-top:4px;font-size:12px}}.legend{{display:flex;gap:16px;margin:14px 0 24px}}.red{{color:#ff8d96}}.green{{color:#76e2b3}}.note{{border-left:4px solid #e6ad55;background:#202431;padding:14px 18px;border-radius:8px}}@media(max-width:800px){{.stats,.cols{{grid-template-columns:1fr}}}}
</style><main><h1>旧选片策略 × 当前策略</h1><p>同一批 132 张照片，允许相机原图和通过内容检查的分享照片，明确非照片继续排除。</p>
<div class="stats"><div class="stat">原始图片<strong>{len(all_items)}</strong></div><div class="stat">照片候选<strong>{len(valid)}</strong></div><div class="stat">质量/内容淘汰<strong>{rejected}</strong></div><div class="stat">CLIP 去重<strong>{removed_duplicates}</strong></div></div>
<div class="legend"><span class="red">红框：新策略移出</span><span class="green">绿框：新策略加入</span></div>
<div class="cols"><section class="panel"><h2>改造前 Top {len(old)}</h2><p>画质 30% + 美观 25% + 偏好 45%</p><div class="grid">{old_cards}</div></section>
<section class="panel"><h2>当前 Top {len(new)}</h2><p>画质 25% + 美观 20% + 偏好 35% + 回忆 20%，叠加 CLIP/事件多样性</p><div class="grid">{new_cards}</div></section></div>
<p class="note">无 EXIF 不再直接淘汰；别人分享但画面属于真实摄影的图片可以参与选片。明确截图、文档、拼图及质量失败仍会排除。</p>
</main></html>'''
    target = output / "index.html"
    target.write_text(document, encoding="utf-8")
    print(target)


if __name__ == "__main__":
    main()

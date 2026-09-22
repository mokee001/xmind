#!/usr/bin/env python3
"""Render an Immich-style capability demo from cached CLIP image embeddings."""

from __future__ import annotations

import argparse
import html
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from compare_immich import images_in, load_json, make_thumbnails, vector_clusters  # noqa: E402


QUERIES = [
    ("人物", "a photo of people"),
    ("猫咪", "a photo of cats"),
    ("狗", "a photo of a dog"),
    ("晚霞与城市", "a sunset city skyline"),
    ("食物", "a photo of food"),
    ("截图或文字", "a screenshot or a document with text"),
]


def text_embedding(endpoint: str, model: str, query: str) -> list[float]:
    entries = json.dumps({"clip": {"textual": {"modelName": model}}})
    body = urllib.parse.urlencode({"entries": entries, "text": query}).encode()
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/predict",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        value = json.loads(response.read())["clip"]
    return json.loads(value) if isinstance(value, str) else value


def normalize(vector) -> np.ndarray:
    value = np.asarray(vector, dtype=np.float64)
    return value / max(float(np.linalg.norm(value)), 1e-12)


def card(item: dict, thumb: str, score: float | None = None) -> str:
    score_html = f'<span class="score">相关度 {score:.3f}</span>' if score is not None else ""
    return (
        f'<figure><img src="{thumb}" loading="lazy"><figcaption>'
        f'{html.escape(item["filename"])}{score_html}</figcaption></figure>'
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--endpoint", default="http://localhost:3003")
    parser.add_argument("--model", default="ViT-B-32__openai")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs" / "immich-capabilities")
    args = parser.parse_args()

    paths = images_in(args.folder.resolve())
    source = ROOT / "outputs" / "immich-comparison"
    image_cache = load_json(source / "immich-cache.json", {})
    local_cache = load_json(source / "current-cache.json", {})
    items = [local_cache[str(path)] for path in paths if str(path) in local_cache]
    vectors = {
        str(path): image_cache[str(path)]["embedding"]
        for path in paths
        if image_cache.get(str(path), {}).get("embedding")
    }
    if len(vectors) != len(paths):
        raise SystemExit(f"CLIP 图片特征不完整：{len(vectors)}/{len(paths)}")

    args.output.mkdir(parents=True, exist_ok=True)
    thumbs = make_thumbnails(items, args.output)
    matrix = np.asarray([normalize(vectors[str(item["path"])]) for item in items])
    query_sections = []
    for label, query in QUERIES:
        query_vector = normalize(text_embedding(args.endpoint, args.model, query))
        scores = matrix @ query_vector
        best = np.argsort(scores)[::-1][:8]
        cards = "".join(card(items[i], thumbs[str(items[i]["path"])], float(scores[i])) for i in best)
        query_sections.append(
            f'<section><div class="section-title"><h2>{html.escape(label)}</h2>'
            f'<code>{html.escape(query)}</code></div><div class="grid">{cards}</div></section>'
        )

    groups = vector_clusters(items, vectors, 0.03)
    group_sections = []
    for index, group in enumerate(groups, 1):
        cards = "".join(card(item, thumbs[str(item["path"])]) for item in group)
        group_sections.append(f'<section><h2>相似组 {index}</h2><div class="grid">{cards}</div></section>')

    document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Immich 能力演示</title><style>
body{{margin:0;background:#0b0d12;color:#f4f6fa;font:15px system-ui,-apple-system,sans-serif}}main{{max-width:1500px;margin:auto;padding:28px}}h1{{font-size:34px;margin-bottom:6px}}h2{{margin:0 0 12px}}p{{color:#9da5b4}}.notice{{background:#172033;border:1px solid #2b456d;border-radius:14px;padding:16px 18px;margin:22px 0}}section{{margin:34px 0}}.section-title{{display:flex;align-items:baseline;gap:12px}}code{{color:#8ea9dc}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}}figure{{margin:0;background:#151820;border:1px solid #292e3a;border-radius:12px;overflow:hidden}}img{{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}}figcaption{{padding:9px;font-size:12px;overflow-wrap:anywhere}}.score{{display:block;color:#80d4ae;margin-top:5px}}
</style><main><h1>Immich 在这 132 张照片上能呈现什么</h1>
<p>CLIP 模型：{html.escape(args.model)}。这不是“最佳照片排行榜”，而是以文字找图和发现相似内容。</p>
<div class="notice"><b>怎么读：</b>每一栏都是一句自然语言搜索返回的前 8 张；相关度只适合在同一次搜索内比较。下方是无需关键词的视觉相似分组。</div>
{''.join(query_sections)}
<section><h1>视觉相似照片</h1><p>CLIP cosine distance ≤ 0.03，共 {len(groups)} 组。</p></section>
{''.join(group_sections) if group_sections else '<p>当前阈值没有发现相似组。</p>'}
</main></html>'''
    target = args.output / "index.html"
    target.write_text(document, encoding="utf-8")
    print(f"报告：{target}")


if __name__ == "__main__":
    main()

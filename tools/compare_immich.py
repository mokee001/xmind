#!/usr/bin/env python3
"""Build a visual A/B report for the current photo-wall pipeline and Immich CLIP.

The script is deliberately standalone. It caches expensive per-image results, so it
can be rerun after the Immich ML endpoint becomes available without repeating the
local YOLO/image analysis pass.
"""

from __future__ import annotations

import argparse
import html
import json
import mimetypes
import os
import shutil
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import dedup, selector, tagger  # noqa: E402

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
TAGGER_CACHE_VERSION = "shared-photo-source-v3"


def images_in(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def local_results(paths: list[Path], cache_path: Path) -> list[dict]:
    cache = load_json(cache_path, {})
    changed = False
    results = []
    for index, path in enumerate(paths, 1):
        stat = path.stat()
        key = str(path)
        stamp = f"{stat.st_size}:{stat.st_mtime_ns}:{TAGGER_CACHE_VERSION}"
        item = cache.get(key)
        if not item or item.get("_stamp") != stamp:
            print(f"[current {index}/{len(paths)}] {path.name}", flush=True)
            item = tagger.tag_photo(str(path))
            item["_stamp"] = stamp
            cache[key] = item
            changed = True
        results.append(item)
    if changed:
        save_json(cache_path, cache)
    return results


def multipart(fields: dict[str, str], file_path: Path) -> tuple[bytes, str]:
    boundary = f"----photowall-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode(), b"\r\n",
        ])
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{file_path.name}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        file_path.read_bytes(), b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), boundary


def ping(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/ping", timeout=2) as response:
            return response.read().decode().strip() == "pong"
    except Exception:
        return False


def immich_embedding(endpoint: str, model: str, path: Path) -> list[float]:
    entries = {"clip": {"visual": {"modelName": model}}}
    body, boundary = multipart({"entries": json.dumps(entries)}, path)
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/predict",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        value = json.loads(response.read())
    embedding = value["clip"]
    return json.loads(embedding) if isinstance(embedding, str) else embedding


def immich_results(paths: list[Path], cache_path: Path, endpoint: str, model: str) -> dict[str, list[float]]:
    cache = load_json(cache_path, {})
    changed = False
    for index, path in enumerate(paths, 1):
        stat = path.stat()
        stamp = f"{stat.st_size}:{stat.st_mtime_ns}:{model}"
        key = str(path)
        item = cache.get(key)
        if item and item.get("_stamp") == stamp:
            continue
        print(f"[immich {index}/{len(paths)}] {path.name}", flush=True)
        cache[key] = {"_stamp": stamp, "embedding": immich_embedding(endpoint, model, path)}
        changed = True
        if changed and index % 5 == 0:
            save_json(cache_path, cache)
            changed = False
    save_json(cache_path, cache)
    return {key: value["embedding"] for key, value in cache.items() if value.get("embedding")}


def cached_immich_results(paths: list[Path], cache_path: Path, model: str) -> dict[str, list[float]]:
    cache = load_json(cache_path, {})
    results = {}
    for path in paths:
        item = cache.get(str(path), {})
        stamp = f"{path.stat().st_size}:{path.stat().st_mtime_ns}:{model}"
        if item.get("_stamp") == stamp and item.get("embedding"):
            results[str(path)] = item["embedding"]
    return results


def local_clusters(items: list[dict]) -> list[list[dict]]:
    clusters: list[list[dict]] = []
    for item in [x for x in items if x.get("quality", 0) > 0]:
        for cluster in clusters:
            representative = max(cluster, key=lambda x: x.get("quality", 0))
            if dedup._is_similar(item, representative, dedup.HAMMING_THRESHOLD):
                cluster.append(item)
                break
        else:
            clusters.append([item])
    return [cluster for cluster in clusters if len(cluster) > 1]


def vector_clusters(items: list[dict], vectors: dict[str, list[float]], distance: float) -> list[list[dict]]:
    candidates = [x for x in items if str(x["path"]) in vectors]
    if len(candidates) < 2:
        return []
    # Keep float64 here. Some Apple Accelerate / NumPy combinations emit bogus
    # overflow warnings for the float32 matmul even though CLIP vectors are unit
    # normalized and finite.
    matrix = np.asarray([vectors[str(x["path"])] for x in candidates], dtype=np.float64)
    matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-12)
    parent = list(range(len(candidates)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        a, b = find(a), find(b)
        if a != b:
            parent[b] = a

    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            similarity = float(np.sum(matrix[i] * matrix[j], dtype=np.float64))
            if 1.0 - similarity <= distance:
                union(i, j)
    groups: dict[int, list[dict]] = {}
    for i, item in enumerate(candidates):
        groups.setdefault(find(i), []).append(item)
    return [group for group in groups.values() if len(group) > 1]


def make_thumbnails(items: list[dict], output: Path) -> dict[str, str]:
    thumbs = output / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    mapping = {}
    for index, item in enumerate(items):
        target = thumbs / f"{index:04d}.jpg"
        mapping[str(item["path"])] = f"thumbs/{target.name}"
        if target.exists():
            continue
        try:
            with Image.open(item["path"]) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((420, 320), Image.Resampling.LANCZOS)
                canvas = Image.new("RGB", (420, 320), "#17191f")
                canvas.paste(image, ((420 - image.width) // 2, (320 - image.height) // 2))
                canvas.save(target, "JPEG", quality=84)
        except Exception:
            Image.new("RGB", (420, 320), "#333").save(target, "JPEG")
    return mapping


def cards(items: list[dict], thumbs: dict[str, str], badge: str = "") -> str:
    result = []
    for item in items:
        result.append(
            f'<figure><img src="{thumbs[str(item["path"])]}" loading="lazy">'
            f'<figcaption>{html.escape(item["filename"])}<br>'
            f'<span>质量 {item.get("quality", 0):.3f} · 美观 {item.get("aesthetic", 0):.3f}</span>'
            f'{badge}</figcaption></figure>'
        )
    return "".join(result)


def cluster_html(groups: list[list[dict]], thumbs: dict[str, str]) -> str:
    if not groups:
        return '<p class="empty">暂无分组结果</p>'
    sections = []
    for i, group in enumerate(sorted(groups, key=len, reverse=True), 1):
        keeper = max(group, key=lambda x: (x.get("quality", 0), x.get("aesthetic", 0)))
        sections.append(
            f'<section class="cluster"><h3>组 {i} · {len(group)} 张 · 建议保留 {html.escape(keeper["filename"])}</h3>'
            f'<div class="grid">{cards(group, thumbs)}</div></section>'
        )
    return "".join(sections)


def pair_distance(group: list[dict], vectors: dict[str, list[float]]) -> float | None:
    if len(group) != 2:
        return None
    left = np.asarray(vectors.get(str(group[0]["path"]), []), dtype=np.float64)
    right = np.asarray(vectors.get(str(group[1]["path"]), []), dtype=np.float64)
    if left.size == 0 or right.size == 0:
        return None
    left /= max(float(np.linalg.norm(left)), 1e-12)
    right /= max(float(np.linalg.norm(right)), 1e-12)
    return 1.0 - float(np.sum(left * right, dtype=np.float64))


def difference_html(groups: list[list[dict]], current_groups: list[list[dict]], vectors, thumbs) -> str:
    if not groups:
        return '<p class="empty">这个阈值下，Immich 没有比当前方案多发现重复组。</p>'
    current_pairs = {
        frozenset(str(item["path"]) for item in group)
        for group in current_groups
    }
    sections = []
    for index, group in enumerate(groups, 1):
        paths = frozenset(str(item["path"]) for item in group)
        caught = paths in current_pairs
        distance = pair_distance(group, vectors)
        metric = f" · CLIP 距离 {distance:.4f}" if distance is not None else ""
        current_label = "当前方案也命中" if caught else "当前方案漏检"
        current_class = "hit" if caught else "miss"
        sections.append(
            f'<section class="cluster diff"><div class="verdict"><b>差异组 {index}</b>'
            f'<span class="pill {current_class}">{current_label}</span>'
            f'<span class="pill hit">Immich 命中{metric}</span></div>'
            f'<div class="grid">{cards(group, thumbs)}</div></section>'
        )
    return "".join(sections)


def render(output: Path, items: list[dict], current_groups, immich_groups, vectors, endpoint, model) -> None:
    thumbs = make_thumbnails(items, output)
    current_kept, _ = dedup.deduplicate(items)
    current_selected = selector.select_for_template(current_kept, min(20, len(current_kept)))
    immich_remove = {str(x["path"]) for g in immich_groups for x in g}
    immich_keepers = {str(max(g, key=lambda x: (x.get("quality", 0), x.get("aesthetic", 0)))["path"]) for g in immich_groups}
    # Match the current deduplicator's first-stage junk/decode filter so the A/B
    # changes only the duplicate signal, not candidate eligibility.
    enhanced_pool = [
        x for x in items
        if x.get("quality", 0) > 0
        and (str(x["path"]) not in immich_remove or str(x["path"]) in immich_keepers)
    ]
    enhanced_selected = selector.select_for_template(enhanced_pool, min(20, len(enhanced_pool))) if vectors else []
    current_paths = [str(item["path"]) for item in current_selected]
    enhanced_paths = [str(item["path"]) for item in enhanced_selected]
    added = [item for item in enhanced_selected if str(item["path"]) not in set(current_paths)]
    removed = [item for item in current_selected if str(item["path"]) not in set(enhanced_paths)]
    selection_changed = bool(added or removed)
    zero_quality_in_groups = sum(
        1 for group in immich_groups for item in group if item.get("quality", 0) <= 0
    )
    status = "已连接并完成 Immich CLIP" if vectors else f"Immich ML 未连接：{endpoint}"
    document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Photo Wall × Immich 对比</title><style>
body{{margin:0;background:#0d0f14;color:#f4f5f7;font:15px system-ui,-apple-system,sans-serif}}main{{max-width:1500px;margin:auto;padding:28px}}
h1{{margin-bottom:6px}}h2{{margin-top:38px}}.muted,figcaption span{{color:#9da5b4}}.notice{{padding:14px 18px;background:#202431;border-radius:12px}}
.stats{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}}.stat{{padding:18px;background:#151820;border:1px solid #292e3a;border-radius:14px}}.stat strong{{display:block;font-size:30px;margin-top:6px}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}.panel,.cluster{{background:#151820;border:1px solid #292e3a;border-radius:14px;padding:16px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}}figure{{margin:0;background:#0e1015;border-radius:9px;overflow:hidden}}
img{{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}}figcaption{{padding:8px;font-size:12px;overflow-wrap:anywhere}}.cluster{{margin:12px 0}}.cluster h3{{font-size:14px}}.empty{{color:#e6ad55}}
.verdict{{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}}.pill{{padding:5px 9px;border-radius:999px;font-size:12px}}.miss{{background:#52252a;color:#ffb8bf}}.hit{{background:#173d31;color:#8de0bc}}.explain{{border-left:4px solid #e6ad55}}
@media(max-width:850px){{.cols,.stats{{grid-template-columns:1fr}}}}
</style><main><h1>Photo Wall × Immich</h1><p class="muted">{len(items)} 张照片 · 模型 {html.escape(model)} · {html.escape(status)}</p>
<div class="notice">本报告固定使用 photo-wall 的画质和最终选图器，仅替换重复候选信号，避免把不同产品目标混在一起比较。</div>
<div class="stats"><div class="stat">当前方案重复组<strong>{len(current_groups)}</strong></div><div class="stat">Immich 重复组<strong>{len(immich_groups)}</strong></div><div class="stat">最终 Top 20 变化<strong>{len(added)} 入 / {len(removed)} 出</strong></div></div>
<h2>真正有差异的样本</h2>
{difference_html(immich_groups, current_groups, vectors, thumbs) if vectors else '<p class="empty">等待 Immich ML 服务启动后补齐</p>'}
<h2>最终候选 Top 20</h2>
{f'<div class="cols"><div class="panel"><h3>当前方案</h3><div class="grid">{cards(current_selected, thumbs)}</div></div><div class="panel"><h3>Immich CLIP 增强</h3><div class="grid">{cards(enhanced_selected, thumbs)}</div></div></div>' if selection_changed else f'<div class="panel explain"><h3>最终结果没有变化</h3><p>Immich 找到的重复候选中有 {zero_quality_in_groups} 张质量分为 0，已经被当前质量门槛提前淘汰，因此不会进入 Top 20。这里不再重复展示两份完全相同的图片。</p><div class="grid">{cards(current_selected, thumbs)}</div></div>'}
<h2>完整重复分组</h2><div class="cols"><div><h3>当前：dHash + 灰度签名</h3>{cluster_html(current_groups, thumbs)}</div>
<div><h3>Immich：CLIP cosine</h3>{cluster_html(immich_groups, thumbs) if vectors else '<p class="empty">等待 Immich ML 服务启动后补齐</p>'}</div></div>
</main></html>'''
    (output / "index.html").write_text(document, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="可视化比较 photo-wall 与 Immich CLIP")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--endpoint", default="http://localhost:3003")
    parser.add_argument("--model", default="ViT-B-32__openai")
    parser.add_argument("--distance", type=float, default=0.03, help="Immich 疑似重复 cosine distance")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs" / "immich-comparison")
    args = parser.parse_args()
    paths = images_in(args.folder.expanduser().resolve())
    if not paths:
        raise SystemExit("没有找到支持的照片")
    args.output.mkdir(parents=True, exist_ok=True)
    items = local_results(paths, args.output / "current-cache.json")
    cache_path = args.output / "immich-cache.json"
    vectors = cached_immich_results(paths, cache_path, args.model)
    if ping(args.endpoint):
        try:
            vectors = immich_results(paths, cache_path, args.endpoint, args.model)
        except (urllib.error.URLError, KeyError, ValueError) as exc:
            print(f"Immich ML 暂时不可用：{exc}", file=sys.stderr)
    current_groups = local_clusters(items)
    immich_groups = vector_clusters(items, vectors, args.distance)
    render(args.output, items, current_groups, immich_groups, vectors, args.endpoint, args.model)
    save_json(args.output / "summary.json", {
        "photos": len(items), "immichReady": bool(vectors), "model": args.model,
        "currentDuplicateGroups": len(current_groups), "immichDuplicateGroups": len(immich_groups),
    })
    print(f"报告：{args.output / 'index.html'}")


if __name__ == "__main__":
    main()

"""Cached feature replay using the project's actual curation/dedup/selector code.

No image inference, uploads, production preference writes, or network calls occur
here. Ente exports stay read-only and never pass through our selector.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

from backend import curation, dedup, selection_policy, selector

ROOT = Path(__file__).resolve().parents[1]
TZ = dt.timezone(dt.timedelta(hours=8))
MODEL = "ViT-B-32__openai"
LABELS = {"selected": "入选", "non_photo": "基础非照片过滤", "quality": "画质过滤",
          "historical_content": "历史内容复核排除", "duplicate": "相似组未保留",
          "theme": "不属于本次主题", "not_selected": "通过过滤，未进入最终名额"}
THEMES = {"all": ("全部照片", set()), "people": ("人物", {"person", "portrait", "group", "selfie"}),
          "pet": ("宠物", {"pet", "cat", "dog"}), "food": ("美食", {"food"}),
          "scene": ("风景与城市", {"landscape", "city", "nature", "beach", "night", "travel", "flower"})}
MARKS = {"good": "很合适", "false_reject": "误杀好照片", "non_photo": "不是照片",
         "duplicate": "重复", "off_topic": "主题不对", "poor_quality": "质量不佳"}


class LabError(ValueError):
    pass


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path: Path, default=None):
    return json.loads(path.read_text("utf-8")) if path.exists() else default


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def bounded(value, low, high, name, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LabError(f"{name} 必须是有限数字")
    if value < low or value > high or (integer and int(value) != value):
        raise LabError(f"{name} 需在 {low}–{high} 之间" + ("且为整数" if integer else ""))
    return int(value) if integer else float(value)


def validate_config(raw: dict, defaults: dict) -> dict:
    if not isinstance(raw, dict) or set(raw) - set(defaults):
        raise LabError("包含未知的策略参数")
    config = {**copy.deepcopy(defaults), **raw}
    weights = config["weights"]
    if not isinstance(weights, dict) or set(weights) != set(selection_policy.SCORE_KEYS):
        raise LabError("权重必须包含画质、美观、偏好、回忆四项")
    weights = {k: bounded(v, 0, 1, k) for k, v in weights.items()}
    total = sum(weights.values())
    if total <= 0:
        raise LabError("至少有一项权重大于 0")
    # Quantization keeps normalized configs idempotent for save/replay hashes.
    divisor = 1.0 if abs(total - 1.0) <= 1e-10 else total
    config["weights"] = {k: round(v / divisor, 12) for k, v in weights.items()}
    for key, low, high, integer in [("count", 1, 100, True), ("quality_min", 0, 1, False),
                                   ("semantic_diversity", 0, 1, False), ("event_diversity", 0, 1, False),
                                   ("event_gap_hours", .25, 48, False), ("clip_distance", 0, .2, False),
                                   ("hash_distance", 0, 20, True)]:
        config[key] = bounded(config[key], low, high, key, integer)
    if config["theme"] not in THEMES:
        raise LabError("不支持这个主题")
    if not isinstance(config["as_of"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", config["as_of"]):
        raise LabError("测试日期必须是 YYYY-MM-DD")
    try:
        dt.date.fromisoformat(config["as_of"])
    except ValueError as error:
        raise LabError("测试日期无效") from error
    return config


class Lab:
    def __init__(self, cache_dir: Path, state_dir: Path, historical_path: Path | None = None):
        self.cache_dir, self.state_dir = cache_dir, state_dir
        self.historical_path = historical_path
        self.dataset_info = read_json(cache_dir / "dataset.json", {})
        self.lock = threading.RLock()
        local_path, vector_path = cache_dir / "current-cache.json", cache_dir / "immich-cache.json"
        local = read_json(local_path)
        vectors = read_json(vector_path, {})
        if not isinstance(local, dict) or not local:
            raise LabError("未找到照片特征缓存，请先运行照片分析再启动实验台")
        self.features, self.assets, self.source_stamps = [], {}, {}
        self.warnings = []
        stale, missing, invalid_vectors = 0, 0, 0
        manifest = []
        for key, original in local.items():
            path = Path(key).resolve()
            if not path.is_file():
                missing += 1
                continue
            stat = path.stat()
            stamp = f"{stat.st_size}:{stat.st_mtime_ns}:"
            if not str(original.get("_stamp", "")).startswith(stamp):
                stale += 1
                continue
            item = copy.deepcopy(original)
            sha = file_hash(path)
            # A full file hash plus path suffix distinguishes identical copies.
            asset_id = sha[:24] + "-" + hashlib.sha256(str(path).encode()).hexdigest()[:8]
            item.update(id=asset_id, sha256=sha, path=str(path))
            embedding = vectors.get(key, {})
            vector = embedding.get("embedding")
            if (embedding.get("_stamp") == stamp + MODEL and isinstance(vector, list)
                    and len(vector) == 512 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector)
                    and sum(x * x for x in vector) > 0):
                item["clip_embedding"] = vector
            else:
                invalid_vectors += 1
            self.assets[asset_id] = item
            self.source_stamps[asset_id] = (stat.st_size, stat.st_mtime_ns)
            self.features.append(item)
            manifest.append({"id": asset_id, "sha256": sha, "filename": item["filename"],
                             "taken_at": item.get("taken_at")})
        if not self.features:
            raise LabError("没有可用的原图／有效缓存；请重新分析后再试")
        if missing or stale:
            self.warnings.append(f"{missing} 张原图缺失、{stale} 张缓存过期，已排除；请重新分析，未静默沿用旧特征。")
        if invalid_vectors:
            self.warnings.append(f"{invalid_vectors} 张缺少有效的 {MODEL} 向量，相关批次将使用标签多样性回退。")
        self.history = set()
        history = read_json(historical_path, {}) if historical_path else {}
        counts = Counter(p["filename"] for p in self.features)
        for name in history.get("content_rejected", []):
            if counts[name] == 1:
                self.history.add(next(p["id"] for p in self.features if p["filename"] == name))
        self.dataset_id = digest(sorted((p["sha256"], p["filename"]) for p in manifest))
        self.feature_revision = digest({"local": file_hash(local_path),
                                       "vectors": file_hash(vector_path) if vector_path.exists() else None,
                                       "history": sorted(self.history)})
        code_paths = [Path(__file__), ROOT / "backend/curation.py", ROOT / "backend/dedup.py",
                      ROOT / "backend/selector.py", ROOT / "backend/trainer.py", ROOT / "backend/selection_policy.py"]
        self.engine_revision = digest({p.name: file_hash(p) for p in code_paths})
        self.manifest = {"schema_version": 1, "dataset_id": self.dataset_id, "assets": manifest}
        policy = selection_policy.resolve()
        self.defaults = {"weights": policy["weights"], "semantic_diversity": policy["semantic_diversity"],
                         "event_diversity": policy["event_diversity"], "count": 20, "quality_min": 0.0,
                         "clip_distance": dedup.CLIP_DISTANCE, "hash_distance": dedup.HAMMING_THRESHOLD,
                         "event_gap_hours": 4, "theme": "all", "as_of": dt.datetime.now(TZ).date().isoformat()}
        self.warnings.extend([
            "这是桌面缓存回放，不代表当前 iPhone 或线上运行结果；旧语义标签缓存没有记录具体检测器来源。",
            f"内容复核使用旧预览留下的 {len(self.history)} 张排除名单（按唯一文件名关联，非本次推理）；缺少逐张分数，暂不提供复核阈值滑块。",
            "旧缓存中已被置零的质量／美观分不能恢复。降低画质门槛不会复活基础过滤掉的照片，需重新提取原始特征。",
            "偏好模型固定为中性 0.5，不读取或训练线上用户偏好；当前人物主题是标签筛选，不是同一人的身份聚类。",
        ])

    def ensure_sources_current(self):
        for asset_id, item in self.assets.items():
            path = Path(item["path"])
            if not path.exists() or (path.stat().st_size, path.stat().st_mtime_ns) != self.source_stamps[asset_id]:
                raise LabError("原图已变化或被移动，请重新分析并重启实验台，不能继续使用旧缓存")

    def metadata(self):
        from .ente import ready
        ente_ready=ready(self)
        return {"dataset": {"id": self.dataset_id, "name": self.dataset_info.get("name", "七月照片 · 固定样本"), "count": len(self.features),
                            "sources": self.dataset_info.get("sources", ["七月照片"])},
                "feature_revision": self.feature_revision, "engine_revision": self.engine_revision,
                "defaults": self.defaults, "profiles": selection_policy.load_config().get("profiles", {}),
                "themes": {k: v[0] for k, v in THEMES.items()}, "marks": MARKS, "warnings": self.warnings,
                "clip": {"model": MODEL, "cached": sum(bool(p.get("clip_embedding")) for p in self.features),
                         "live_inference": False, "historical_rejections": len(self.history)},
                "ente": {"live_engine": ente_ready, "result_import": True,
                         "message": "本机运行环境就绪；结果状态见 Ente 独立入口，不套用本项目策略。" if ente_ready else "可导入结果包；本数据集尚无可用的 Ente 本机运行环境。"}}

    def public_photo(self, item):
        keys = ("id", "filename", "taken_at", "date_source", "source_album", "tags", "quality", "aesthetic", "capture_source",
                "junk_reason", "event_id", "memory_score", "memory_reasons", "final_score", "pref_score")
        result = {k: item[k] for k in keys if k in item}
        result["image"] = "/media/" + item["id"]
        return result

    def run(self, raw: dict):
        start = time.perf_counter()
        config = validate_config(raw, self.defaults)
        self.ensure_sources_current()
        decisions = {}
        valid = []
        for original in self.features:
            p = dict(original)
            status, reason = "", ""
            if p.get("capture_source") == "non_photo":
                status, reason = "non_photo", p.get("junk_reason") or "基础来源判定为非照片"
            elif p["id"] in self.history:
                status, reason = "historical_content", "旧预览内容复核排除名单；无本次推理分数"
            elif p.get("quality", 0) <= 0 or p.get("quality", 0) < config["quality_min"]:
                status, reason = "quality", f"质量 {p.get('quality', 0):.3f}，门槛 {config['quality_min']:.2f}（0 分固定排除）"
            if status:
                decisions[p["id"]] = {"status": status, "reason": reason}
            else:
                valid.append(p)
        now = dt.datetime.combine(dt.date.fromisoformat(config["as_of"]), dt.time(12), tzinfo=TZ).timestamp()
        valid = curation.prepare(valid, now=now, event_gap_seconds=config["event_gap_hours"] * 3600, timezone=TZ)
        enriched = {p["id"]: p for p in valid}
        theme_tags = THEMES[config["theme"]][1]
        themed = []
        for p in valid:
            if theme_tags and not set(p.get("tags", [])) & theme_tags:
                decisions[p["id"]] = {"status": "theme", "reason": "缓存标签未命中本次主题；这不是重新做语义识别"}
            else:
                themed.append(p)
        clusters = dedup.duplicate_clusters(themed, config["hash_distance"], clip_distance_limit=config["clip_distance"])
        kept, cluster_info = [], []
        for cluster in clusters:
            best = max(cluster, key=lambda p: p.get("quality", 0))
            kept.append(best)
            if len(cluster) > 1:
                cluster_info.append({"representative": best["id"], "members": [p["id"] for p in cluster]})
                for p in cluster:
                    if p["id"] != best["id"]:
                        decisions[p["id"]] = {"status": "duplicate", "representative": best["id"],
                            "reason": "按项目贪心相似分组，保留组内画质最高照片；成员不一定与最终代表直接相似"}
        policy = {"name": "lab", "weights": config["weights"], "semantic_diversity": config["semantic_diversity"],
                  "event_diversity": config["event_diversity"]}
        model = {"weights": {}, "bias": 0.5}
        selected = selector.select_for_template(kept, min(config["count"], len(kept)), model=model, policy=policy)
        ranked = selector.rank_photos(kept, model=model, policy=policy)
        enriched.update({p["id"]: p for p in ranked})
        selected_ids = [p["id"] for p in selected]
        for p in kept:
            status = "selected" if p["id"] in selected_ids else "not_selected"
            decisions[p["id"]] = {"status": status, "reason": LABELS[status]}
        photos = []
        for original in self.features:
            p = enriched.get(original["id"], original)
            item = {**self.public_photo(p), **decisions[p["id"]]}
            item["status_label"] = LABELS[item["status"]]
            if "final_score" in p:
                item["score_parts"] = {k: round(config["weights"][k] * p.get(field, 0), 4)
                    for k, field in [("quality", "quality"), ("aesthetic", "aesthetic"),
                                     ("preference", "pref_score"), ("memory", "memory_score")]}
            photos.append(item)
        buckets = {}
        for p in selected:
            event = p.get("event_id", "undated")
            buckets.setdefault(event, []).append(p)
        events = []
        for event, group in buckets.items():
            date = dt.datetime.fromtimestamp(group[0]["taken_at"], TZ).strftime("%m 月 %d 日") if group[0].get("taken_at") else "日期未知"
            events.append({"id": event, "title": date + " · 时间事件", "cover": group[0]["id"],
                           "photo_ids": [p["id"] for p in group]})
        counts = dict(Counter(p["status"] for p in photos))
        signature = {"config": config, "dataset": self.dataset_id, "features": self.feature_revision,
                     "engine_revision": self.engine_revision, "randomness": "none", "history": "empty", "timezone": "+08:00"}
        return {"schema_version": 1, "id": digest(signature)[:24], "engine": "photo-wall-cache-replay",
                "engine_label": "本项目 · 缓存回放", "signature": signature, "config": config,
                "photos": photos, "selected_ids": selected_ids, "events": events, "duplicate_groups": cluster_info,
                "counts": counts, "elapsed_ms": round((time.perf_counter() - start) * 1000, 1),
                "selection_mode": "全部候选入选，未执行多样性筛选" if len(kept) <= config["count"] else
                    ("CLIP 多样性 + 事件约束" if kept and all(p.get("clip_embedding") for p in kept) else "标签多样性回退"),
                "warnings": self.warnings, "created_at": dt.datetime.now(TZ).isoformat()}

    def list_runs(self):
        result = []
        for path in sorted((self.state_dir / "runs").glob("*.json"), reverse=True):
            try:
                record = read_json(path)
            except (OSError, ValueError):
                continue
            if record.get("dataset_id") == self.dataset_id:
                result.append({"id": record["id"], "name": record["name"], "created_at": record["created_at"],
                               "engine": record["result"]["engine"], "count": len(record["result"]["selected_ids"])})
        return sorted(result, key=lambda r: r["created_at"], reverse=True)

    def save_run(self, result, name):
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise LabError("方案名称需为 1–80 个字符")
        record = {"id": uuid.uuid4().hex, "name": name.strip(), "dataset_id": self.dataset_id,
                  "created_at": dt.datetime.now(TZ).isoformat(), "result": result}
        with self.lock:
            atomic_json(self.state_dir / "runs" / (record["id"] + ".json"), record)
        return record

    def get_run(self, run_id):
        if not re.fullmatch(r"[a-f0-9]{32}", run_id):
            raise LabError("无效的方案 ID")
        record = read_json(self.state_dir / "runs" / (run_id + ".json"))
        if not record or record.get("dataset_id") != self.dataset_id:
            raise LabError("找不到当前照片集的方案")
        return record

    def get_annotations(self):
        return read_json(self.state_dir / "annotations" / (self.dataset_id + ".json"), {})

    def annotate(self, asset_id, mark, note=""):
        if asset_id not in self.assets or mark not in {*MARKS, ""}:
            raise LabError("无效的照片或问题标记")
        if not isinstance(note, str) or len(note) > 1000:
            raise LabError("备注不能超过 1000 字")
        with self.lock:
            values = self.get_annotations()
            values[asset_id] = {"mark": mark, "note": note, "updated_at": dt.datetime.now(TZ).isoformat()}
            atomic_json(self.state_dir / "annotations" / (self.dataset_id + ".json"), values)
        return values[asset_id]

    def import_ente(self, data):
        """Validate provenance and dataset identity, not the truth of exporter claims."""
        self.ensure_sources_current()
        if not isinstance(data, dict) or data.get("schema_version") != 1 or data.get("engine") != "ente":
            raise LabError("需要 schema_version=1、engine=ente 的开发版结果包；不是任意 Ente 备份 JSON")
        if data.get("dataset_id") != self.dataset_id:
            raise LabError("Ente 结果不是同一照片集，请先下载并使用本实验台的照片清单")
        provenance = data.get("provenance")
        if not isinstance(provenance, dict):
            raise LabError("缺少 Ente 版本及执行来源")
        for field in ("commit", "app_version", "platform", "generated_at", "model", "exporter_version"):
            if not isinstance(provenance.get(field), str) or not provenance[field].strip() or len(provenance[field]) > 200:
                raise LabError("缺少或无效的来源字段：" + field)
        if not re.fullmatch(r"[a-fA-F0-9]{40}", provenance["commit"]):
            raise LabError("Ente commit 必须为完整的 40 位提交哈希")
        try:
            generated_at = dt.datetime.fromisoformat(provenance["generated_at"].replace("Z", "+00:00"))
            if generated_at.tzinfo is None:
                raise ValueError("timezone missing")
        except ValueError as error:
            raise LabError("Ente generated_at 必须是包含时区的 ISO 时间") from error
        if provenance.get("mode") not in {"natural", "debug_all_candidates"}:
            raise LabError("mode 必须明确是 natural 或 debug_all_candidates")
        memories = data.get("memories")
        if not isinstance(memories, list) or len(memories) > 200:
            raise LabError("memories 必须是最多 200 组的数组，允许原版自然结果为空")
        photos_by_hash = {}
        for p in self.features:
            photos_by_hash.setdefault(p["sha256"], []).append(p)
        events, selected_ids = [], []
        seen_groups = set()
        for memory in memories:
            if not isinstance(memory, dict) or not isinstance(memory.get("title"), str) or not 1 <= len(memory["title"]) <= 160:
                raise LabError("每组回忆需要有效标题")
            group_id = memory.get("id")
            if not isinstance(group_id, str) or not 1 <= len(group_id) <= 160 or group_id in seen_groups:
                raise LabError("回忆 ID 缺失或重复")
            seen_groups.add(group_id)
            hashes = memory.get("photo_sha256")
            if not isinstance(hashes, list) or not hashes or len(hashes) > 500 or not all(isinstance(h, str) for h in hashes):
                raise LabError("回忆照片必须是非空 SHA256 数组")
            if len(hashes) != len(set(hashes)):
                raise LabError("同一组包含重复文件哈希")
            ids = []
            for sha in hashes:
                matches = photos_by_hash.get(sha, [])
                if len(matches) != 1:
                    raise LabError("有照片无法唯一匹配原始文件 SHA256；不按文件名猜测，也不静默丢弃")
                ids.append(matches[0]["id"])
            cover_hash = memory.get("cover_sha256", hashes[0])
            if cover_hash not in hashes:
                raise LabError("封面必须在本组回忆中")
            events.append({"id": group_id, "title": memory["title"], "photo_ids": ids,
                           "cover": ids[hashes.index(cover_hash)]})
            selected_ids.extend(p for p in ids if p not in selected_ids)
        photos = []
        for original in self.features:
            status = "selected" if original["id"] in selected_ids else "not_selected"
            photos.append({**self.public_photo(original), "status": status, "status_label": LABELS[status],
                           "reason": "Ente 导入包中的回忆成员" if status == "selected" else "未出现在导入的回忆中；不推断淘汰原因"})
        return {"schema_version": 1, "id": digest(data)[:24], "engine": "ente-import",
                "engine_label": "Ente · 导入结果（只读）", "provenance": provenance, "config": None,
                "selected_ids": selected_ids, "photos": photos, "events": events,
                "counts": dict(Counter(p["status"] for p in photos)), "duplicate_groups": [],
                "selection_mode": "原版自然输出" if provenance["mode"] == "natural" else "调试模式：全候选展开",
                "warnings": ["这是外部导入的结果快照，不是在此运行 Ente。来源信息由导出方声明，实验台不替它认证。",
                             "照片顺序与分组按导入包保留；详情中的基础标签／画质仍来自本项目旧缓存，不是 Ente 评分。"],
                "signature": {"dataset": self.dataset_id, "import_hash": digest(data)},
                "created_at": dt.datetime.now(TZ).isoformat(), "elapsed_ms": None}

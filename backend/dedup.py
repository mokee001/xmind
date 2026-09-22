"""Conservative duplicate policy v2: file equality or corroborating image signals.
Semantic category, CLIP similarity and a coarse gray grid never independently
remove a photo. Complete-link groups cannot drift when their representative changes.
"""

from __future__ import annotations

import math
import os

# dHash 汉明距离阈值：0=完全相同，越大越宽松。8 对 64bit 是「肉眼几乎一样/连拍」。
HAMMING_THRESHOLD = 8
# csig（灰度网格）平均逐格差（0~255）。越小越像。
CSIG_STRICT = 12   # 很接近 -> 判为同场景重复（不看主体）
CSIG_LOOSE = 22    # 较接近 + 主体相同 -> 判为同主体多拍
CLIP_DISTANCE = float(os.environ.get("PHOTOWALL_CLIP_DUPLICATE_DISTANCE", "0.03"))

# 用于判断「主体是否相同」的语义分组（命中同组视为同主体）。
_SUBJECT_GROUPS = [
    {"person", "portrait", "group", "selfie"},
    {"pet", "dog", "cat"},
    {"food"},
    {"landscape", "nature", "beach", "flower", "mountain"},
    {"city", "night", "travel"},
    {"indoor"},
]


def _hamming(a: int, b: int) -> int:
    """两个整数哈希的汉明距离（不同 bit 的个数）。"""
    return bin(a ^ b).count("1")


def _csig_dist(c1, c2) -> float | None:
    """两张照片内容签名的平均逐格差（0~255）。任一为空返回 None。"""
    if not c1 or not c2 or len(c1) != len(c2):
        return None
    return sum(abs(int(a) - int(b)) for a, b in zip(c1, c2)) / len(c1)


def _primary_subject(tags) -> str | None:
    """取照片的主体分组标识（用于判断两张是否拍同一类主体）。"""
    tset = set(tags or [])
    for i, group in enumerate(_SUBJECT_GROUPS):
        if tset & group:
            return f"subj{i}"
    return None


def _clip_distance(p1: dict, p2: dict) -> float | None:
    left, right = p1.get("clip_embedding"), p2.get("clip_embedding")
    if not left or not right or len(left) != len(right):
        return None
    left_norm = math.sqrt(sum(float(value) ** 2 for value in left))
    right_norm = math.sqrt(sum(float(value) ** 2 for value in right))
    if left_norm <= 0 or right_norm <= 0:
        return None
    cosine = sum(float(a) * float(b) for a, b in zip(left, right)) / (left_norm * right_norm)
    return 1.0 - max(-1.0, min(1.0, cosine))


POLICY_VERSION = "dedup-v2-corroborated"


def duplicate_reason(p1: dict, p2: dict, threshold: int = HAMMING_THRESHOLD, *,
                     clip_distance_limit: float | None = None) -> str | None:
    if p1.get("sha256") and p1["sha256"] == p2.get("sha256"):
        return "identical_file"
    h1, h2 = p1.get("phash"), p2.get("phash")
    distance = _csig_dist(p1.get("csig"), p2.get("csig"))
    if h1 is None or h2 is None or distance is None:
        return None
    # Two spatial signals must agree. Constant gray fields have uninformative hashes.
    grids = [p.get("csig") for p in (p1, p2)]
    if any(max(g)-min(g) < 12 for g in grids):
        return None
    if _hamming(int(h1), int(h2)) <= threshold and distance <= CSIG_STRICT:
        return "hash_and_gray_grid"
    return None


def _is_similar(p1: dict, p2: dict, threshold: int, *,
                clip_distance_limit: float | None = None) -> bool:
    return duplicate_reason(p1, p2, threshold, clip_distance_limit=clip_distance_limit) is not None


def duplicate_clusters(photos: list[dict], threshold: int = HAMMING_THRESHOLD, *,
                       clip_distance_limit: float | None = None) -> list[list[dict]]:
    """Every member must agree with every other member; strongest photo first."""
    valid = [p for p in photos if p.get("quality", 0) > 0]
    clusters: list[list[dict]] = []
    for photo in sorted(valid, key=lambda p: -p.get("quality", 0)):
        for cluster in clusters:
            if all(_is_similar(photo, member, threshold, clip_distance_limit=clip_distance_limit)
                   for member in cluster):
                cluster.append(photo)
                break
        else:
            clusters.append([photo])
    order = {id(p): i for i, p in enumerate(valid)}
    clusters.sort(key=lambda g: min(order[id(p)] for p in g))
    return clusters


def deduplicate(photos: list[dict], threshold: int = HAMMING_THRESHOLD, *,
                clip_distance_limit: float | None = None) -> tuple[list[dict], int]:
    """
    对一批已打标照片去重。
    返回 (去重后的照片列表, 被移除的重复数量)。
    - 先丢掉完全读不出的废片（quality<=0）。
    - 再按文件内容或一致的图像信号聚类，每簇保留 quality 最高的代表。
    - 保留顺序尽量稳定（按代表照片首次出现的顺序）。
    """
    # 1) 去掉解码失败的废片
    valid = [p for p in photos if p.get("quality", 0) > 0]
    dropped_broken = len(photos) - len(valid)

    # 2) 组内两两符合重复证据，避免代表变化和相似链串组。
    clusters = duplicate_clusters(valid, threshold, clip_distance_limit=clip_distance_limit)

    # 3) 每簇留画质最高的代表
    kept: list[dict] = []
    for cluster in clusters:
        best = max(cluster, key=lambda x: x.get("quality", 0.0))
        kept.append(best)

    removed = len(valid) - len(kept) + dropped_broken
    return kept, removed

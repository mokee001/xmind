"""
照片去重器：去掉重复 / 高度相似（连拍、同一场景微调、同一主体多拍）的照片，
每一簇相似照片只保留「画质最好」的那一张。

原理（无需额外依赖，纯感知信号）：
- dHash（差值哈希）：抓「几乎逐像素一样」的连拍/微调。汉明距离越小越像。
- 内容签名 csig（低分辨率灰度网格）：抓「同一场景/同一主体、构图略有差异」的重复
  —— 比如同一只猫连拍好几张、同一桌菜换角度，dHash 差得多但 csig 很接近。
- 语义主体：结合 csig 时要求「主体一致」（都是猫 / 都是人），避免误伤不同题材。

判重规则（满足任一即视为同簇）：
  1) dHash 汉明距离 <= HAMMING_THRESHOLD               （近乎相同）
  2) csig 平均差 <= CSIG_STRICT                         （同场景，无需看主体）
  3) csig 平均差 <= CSIG_LOOSE 且 主体相同             （同主体多拍）

每簇只留 quality 最高的一张，保证上墙照片「各有其面、不重复」。
"""

from __future__ import annotations

# dHash 汉明距离阈值：0=完全相同，越大越宽松。8 对 64bit 是「肉眼几乎一样/连拍」。
HAMMING_THRESHOLD = 8
# csig（灰度网格）平均逐格差（0~255）。越小越像。
CSIG_STRICT = 12   # 很接近 -> 判为同场景重复（不看主体）
CSIG_LOOSE = 22    # 较接近 + 主体相同 -> 判为同主体多拍

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


def _is_similar(p1: dict, p2: dict, threshold: int) -> bool:
    """综合 dHash + 内容签名 + 主体 判断两张是否为重复。"""
    h1, h2 = p1.get("phash"), p2.get("phash")
    # 1) dHash 近乎相同
    if h1 is not None and h2 is not None and _hamming(int(h1), int(h2)) <= threshold:
        return True

    # 2)/3) 内容签名相似
    d = _csig_dist(p1.get("csig"), p2.get("csig"))
    if d is not None:
        if d <= CSIG_STRICT:
            return True  # 同场景，直接判重
        if d <= CSIG_LOOSE:
            s1, s2 = _primary_subject(p1.get("tags")), _primary_subject(p2.get("tags"))
            if s1 is not None and s1 == s2:
                return True  # 同主体多拍

    # 兜底：老数据无任何签名时按文件名
    if h1 is None and h2 is None and p1.get("csig") is None and p2.get("csig") is None:
        return p1.get("filename") == p2.get("filename")
    return False


def deduplicate(photos: list[dict], threshold: int = HAMMING_THRESHOLD) -> tuple[list[dict], int]:
    """
    对一批已打标照片去重。
    返回 (去重后的照片列表, 被移除的重复数量)。
    - 先丢掉完全读不出的废片（quality<=0）。
    - 再按「dHash + 内容签名 + 主体」聚类，每簇保留 quality 最高的代表。
    - 保留顺序尽量稳定（按代表照片首次出现的顺序）。
    """
    # 1) 去掉解码失败的废片
    valid = [p for p in photos if p.get("quality", 0) > 0]
    dropped_broken = len(photos) - len(valid)

    # 2) 贪心聚类：每张图和「每个簇的代表」比对，相似则并入，否则自成新簇
    #    代表用簇内当前画质最高的一张，聚类更稳。
    clusters: list[list[dict]] = []
    for p in valid:
        placed = False
        for cluster in clusters:
            rep = max(cluster, key=lambda x: x.get("quality", 0.0))
            if _is_similar(p, rep, threshold):
                cluster.append(p)
                placed = True
                break
        if not placed:
            clusters.append([p])

    # 3) 每簇留画质最高的代表
    kept: list[dict] = []
    for cluster in clusters:
        best = max(cluster, key=lambda x: x.get("quality", 0.0))
        kept.append(best)

    removed = len(valid) - len(kept) + dropped_broken
    return kept, removed

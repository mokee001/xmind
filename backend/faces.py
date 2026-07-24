"""
人物聚合（人脸识别聚类）。

流程：
- MTCNN 检测每张照片里的人脸（可多张）。
- InceptionResnetV1(vggface2) 把每张脸编码成 512 维向量。
- 用余弦相似度贪心聚类：同一个人的脸向量彼此很近，聚成一「人」。
- 每张照片打上它包含的人物标签（person_1 / person_2 …），
  这样「只看某个人的照片墙」就能直接用现有的按标签筛选实现。

设计取舍：
- 纯 CPU 跑（facenet-pytorch 基于已装的 torch），无需 GPU。
- 不依赖 sklearn：聚类用 numpy 手写贪心（在线更新质心）。
- 人脸向量按「路径+修改时间」缓存，避免重复照片反复推理。
- 任何一步失败都安全降级（返回空），不影响主流程去重/选图/上屏。
"""

from __future__ import annotations

import os
import threading
from typing import Any

from PIL import Image

from . import store

# 借鉴苹果 Photos 的两遍聚类：先严后松。
# 第一遍严格阈值（高精度，宁可拆多）：只有非常像才并簇。
_TIGHT_SIM = 0.62
# 第二遍合并阈值（提召回）：把同一人的小簇合起来。
_MERGE_SIM = 0.5
# 检测前把长边压到这个尺寸，加速 MTCNN。放大到 1280：小脸/合影里的脸也能检出，
# 之前压到 720 会把不少真人脸缩到尺寸阈值以下→漏检。
_MAX_SIDE = 1280
# 人脸置信度阈值：MTCNN prob 低于此值的脸视为误检/模糊，丢弃。
# 从 0.97 放宽到 0.90：0.97 太狠，把大量真人脸也一起杀了（66 张真人照只检出 10 张）。
# 误检防线已改由「EXIF 剔截图/下载图 + 聚类时 YOLO 真人交叉验证」承担，这里主收召回。
_MIN_FACE_PROB = 0.90
# 人脸尺寸过滤：只挡明显过小的背景路人/贴纸脸。大幅放宽——实测有 22 张真人照
# 其实检测到了 prob≈1.0 的真脸，只因面积占比 <0.4% 被误挡（合影/远景里的小脸）。
# 收紧只保留「极小脸」的下限，把这些高置信度小脸捞回人物库（以压缩后长边<=1280 为准）。
_MIN_FACE_PX = 22          # 脸框短边至少 22px
_MIN_FACE_AREA_FRAC = 0.0008  # 脸框面积至少占整图 0.08%
# 聚类里少于这么多张脸的「人」视为噪声/路人/一次性误检，不对外展示。
# 保持 2：实测降到 1 会让「单张海报印刷人脸 / 猫脸误检」冒充成一个人（person_7 猫、
# person_12 电视剧海报），而出现≥2次的簇几乎都是真人。用「重复出现」作可信度背书。
_MIN_CLUSTER_SIZE = 2

_LOCK = threading.Lock()
_mtcnn = None
_resnet = None
_CACHE_KEY = "face_embed_cache"  # {path: {"mtime": float, "embs": [[...512], ...]}}


def available() -> bool:
    """人脸依赖是否可用（未装则整块功能降级为不可用）。"""
    try:
        import facenet_pytorch  # noqa: F401
        import numpy  # noqa: F401
        return True
    except Exception:
        return False


def _get_models():
    """惰性加载 MTCNN + 人脸编码器（首次会下载 vggface2 权重，之后本地缓存）。"""
    global _mtcnn, _resnet
    if _mtcnn is None or _resnet is None:
        from facenet_pytorch import MTCNN, InceptionResnetV1
        # keep_all=True：一张合影里的多张脸都要
        _mtcnn = MTCNN(keep_all=True, device="cpu")
        _resnet = InceptionResnetV1(pretrained="vggface2").eval()
    return _mtcnn, _resnet


def _embed_faces(path: str) -> list[list[float]]:
    """检测并编码一张照片里的所有人脸，返回若干 512 维向量（无脸则空）。

    先用 detect 拿到人脸框，按「置信度 + 尺寸」双重过滤，丢掉传单/海报/车贴/
    桌游盒/背景路人这类又小又不可靠的误检脸，再对留下的脸编码。这样人物库只收
    真正的主体人脸，避免非人物照片被误判进「人物」相簿。
    """
    import numpy as np
    import torch

    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        return []
    # 压缩长边加速检测
    w, h = img.size
    scale = _MAX_SIDE / max(w, h)
    if scale < 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    iw, ih = img.size
    img_area = float(iw * ih) or 1.0

    mtcnn, resnet = _get_models()
    # 第一步：只做检测，拿到人脸框 + 置信度（不直接裁剪，便于按尺寸筛选）
    try:
        boxes, probs = mtcnn.detect(img)
    except Exception:
        return []
    if boxes is None:
        return []

    keep_boxes = []
    for box, pr in zip(boxes, probs if probs is not None else [None] * len(boxes)):
        if pr is None or pr < _MIN_FACE_PROB:
            continue
        x1, y1, x2, y2 = box
        bw, bh = float(x2 - x1), float(y2 - y1)
        if bw <= 0 or bh <= 0:
            continue
        # 尺寸过滤：脸太小（多为传单/背景/贴纸误检）直接丢
        if min(bw, bh) < _MIN_FACE_PX:
            continue
        if (bw * bh) / img_area < _MIN_FACE_AREA_FRAC:
            continue
        keep_boxes.append(box)

    if not keep_boxes:
        return []

    # 第二步：只对通过筛选的脸做对齐裁剪 + 编码
    try:
        faces = mtcnn.extract(img, np.array(keep_boxes), None)
    except Exception:
        return []
    if faces is None:
        return []
    if faces.ndim == 3:
        faces = faces.unsqueeze(0)
    with torch.no_grad():
        embs = resnet(faces).numpy()
    # 归一化成单位向量，便于用点积当余弦相似度
    out = []
    for e in embs:
        n = np.linalg.norm(e)
        if n > 0:
            out.append((e / n).tolist())
    return out


def _cached_embeddings(photos: list[dict]) -> dict[str, list[list[float]]]:
    """取每张照片的人脸向量，带缓存（按文件修改时间失效）。"""
    cache: dict[str, Any] = store.load(_CACHE_KEY, {})
    result: dict[str, list[list[float]]] = {}
    changed = False
    for p in photos:
        path = p.get("path")
        if not path or not os.path.exists(path):
            continue
        mtime = os.path.getmtime(path)
        hit = cache.get(path)
        if hit and abs(hit.get("mtime", -1) - mtime) < 1e-6:
            result[path] = hit["embs"]
        else:
            embs = _embed_faces(path)
            cache[path] = {"mtime": mtime, "embs": embs}
            result[path] = embs
            changed = True
    if changed:
        store.save(_CACHE_KEY, cache)
    return result


def _greedy_cluster(all_faces: list[tuple[str, list[float]]], threshold: float):
    """
    第一遍：贪心在线聚类（严格阈值，高精度）。逐张脸和已有各簇质心比余弦相似度，
    >= 阈值并入最相似簇并更新质心，否则新建一簇。
    返回 (centroids, members, counts)。
    """
    import numpy as np

    centroids: list[np.ndarray] = []
    members: list[list[str]] = []
    counts: list[int] = []

    for path, emb in all_faces:
        v = np.asarray(emb, dtype="float32")
        best_i, best_sim = -1, -1.0
        for i, c in enumerate(centroids):
            sim = float(np.dot(v, c) / (np.linalg.norm(c) or 1.0))
            if sim > best_sim:
                best_i, best_sim = i, sim
        if best_i >= 0 and best_sim >= threshold:
            n = counts[best_i]
            centroids[best_i] = (centroids[best_i] * n + v) / (n + 1)
            counts[best_i] += 1
            members[best_i].append(path)
        else:
            centroids.append(v.copy())
            members.append([path])
            counts.append(1)

    return centroids, members, counts


def _merge_clusters(centroids, members, counts, threshold: float):
    """
    第二遍：层次合并（提召回）。反复找质心最相似的两个簇，
    若相似度 >= 阈值就合并，直到没有可合并的为止。借鉴苹果的 HAC 二次合并。
    """
    import numpy as np

    cents = [c.copy() for c in centroids]
    mems = [list(m) for m in members]
    cnts = list(counts)

    while len(cents) > 1:
        best_pair, best_sim = None, -1.0
        for i in range(len(cents)):
            for j in range(i + 1, len(cents)):
                a, b = cents[i], cents[j]
                sim = float(np.dot(a, b) / ((np.linalg.norm(a) or 1.0) * (np.linalg.norm(b) or 1.0)))
                if sim > best_sim:
                    best_pair, best_sim = (i, j), sim
        if best_pair is None or best_sim < threshold:
            break
        i, j = best_pair
        ni, nj = cnts[i], cnts[j]
        cents[i] = (cents[i] * ni + cents[j] * nj) / (ni + nj)
        mems[i].extend(mems[j])
        cnts[i] += nj
        del cents[j]
        del mems[j]
        del cnts[j]

    clusters = [{"members": mems[k], "size": cnts[k]} for k in range(len(cents))]
    return clusters


def cluster_album(photos: list[dict]) -> dict:
    """
    对整册照片做人物聚合。
    返回 {
      "photo_persons": {path: [person_id,...]},   # 每张照片包含哪些人
      "people": [{"id": "person_1", "count": n, "cover": path}, ...],  # 发现的人
      "faces_total": int, "photos_with_face": int
    }
    """
    if not available():
        return {"photo_persons": {}, "people": [], "faces_total": 0, "photos_with_face": 0}

    with _LOCK:  # 模型不是线程安全，串行跑
        emb_map = _cached_embeddings(photos)

    # 交叉验证：只有 YOLO 也在这张照片里看到「真人」，才把它的人脸算进人物库。
    # 电视/显示器翻拍、社媒截图、卡通插画上的「脸」，YOLO 通常不认作 person，
    # 借此把这类「屏幕里的脸/截图里的脸」挡在人物库之外（配合尺寸/置信度过滤）。
    _PERSON_TAGS = {"person", "portrait", "group", "selfie"}
    person_paths = {
        p.get("path") for p in photos
        if _PERSON_TAGS & set(p.get("tags", []))
    }

    all_faces: list[tuple[str, list[float]]] = []
    photos_with_face = 0
    for path, embs in emb_map.items():
        if not embs:
            continue
        if path not in person_paths:
            continue  # 检测到脸但 YOLO 没看到真人 → 多半是屏幕/截图/卡通脸，跳过
        photos_with_face += 1
        for e in embs:
            all_faces.append((path, e))

    if not all_faces:
        return {"photo_persons": {}, "people": [], "faces_total": 0, "photos_with_face": 0}

    # 两遍聚类：先严格贪心（高精度），再层次合并（提召回）
    centroids, members, counts = _greedy_cluster(all_faces, _TIGHT_SIM)
    clusters = _merge_clusters(centroids, members, counts, _MERGE_SIM)
    # 大的人在前（照片多的更可能是「主角」）
    clusters.sort(key=lambda c: c["size"], reverse=True)

    photo_persons: dict[str, list[str]] = {}
    people = []
    pid = 0
    for c in clusters:
        if c["size"] < _MIN_CLUSTER_SIZE:
            continue
        pid += 1
        person_id = f"person_{pid}"
        uniq_paths = list(dict.fromkeys(c["members"]))  # 去重（一张合影同人只算一次）
        for path in uniq_paths:
            photo_persons.setdefault(path, []).append(person_id)
        people.append({"id": person_id, "count": len(uniq_paths), "cover": uniq_paths[0]})

    return {
        "photo_persons": photo_persons,
        "people": people,
        "faces_total": len(all_faces),
        "photos_with_face": photos_with_face,
    }

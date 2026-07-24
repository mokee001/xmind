"""
选图器：根据画质分 + 训练后的偏好模型，从候选照片里挑出最适合的 N 张。
这是「AI 智能挑图」的核心：不是把所有照片堆上去，而是挑你喜欢又好看的。

两层策略：
  1) 综合评分 = 0.4*画质 + 0.6*偏好，先排序。
  2) 多样性选图（MMR）：在高分基础上，避免一墙全是同类照片
     （比如全是合影 / 全是美食），按维度配比出「有变化、有代表性」的一墙。
"""

from __future__ import annotations

from . import trainer

# 用于衡量「题材相似度」的维度分组：同组标签越重叠，两张照片题材越像。
_THEME_GROUPS = {
    "people": {"person", "portrait", "group", "selfie"},
    "pet": {"pet", "dog", "cat"},
    "food": {"food"},
    "scene": {"landscape", "city", "indoor", "nature", "beach", "flower", "night", "travel", "sport"},
    "color": {"red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "neutral"},
    "mood": {"warm", "cool", "vibrant", "muted", "monochrome", "high_key", "low_key"},
}

# 多样性权重：越大越强调「题材各异」，越小越接近纯按分数排。
_DIVERSITY_LAMBDA = 0.35


def _theme_signature(tags: list[str]) -> set[str]:
    """把一张照片的标签压成「题材签名」：它命中了哪些维度分组。"""
    tset = set(tags)
    sig = set()
    for group, members in _THEME_GROUPS.items():
        for m in tset & members:
            sig.add(f"{group}:{m}")
    return sig


def _similarity(sig_a: set[str], sig_b: set[str]) -> float:
    """两张照片题材签名的 Jaccard 相似度（0~1）。"""
    if not sig_a and not sig_b:
        return 0.0
    inter = len(sig_a & sig_b)
    union = len(sig_a | sig_b)
    return inter / union if union else 0.0


def filter_photos(photos: list[dict], filters: list[str] | None) -> list[dict]:
    """
    按用户「吩咐的筛选维度」过滤候选照片（色彩/主题/情绪等）。
    filters 是一组标签（如 ["warm", "food"]），照片需同时命中全部所选标签才保留（AND）。
    返回命中的照片列表，可能为空——由调用方决定是否回退到不过滤。
    """
    if not filters:
        return photos
    fset = {f.strip().lower() for f in filters if f and f.strip()}
    if not fset:
        return photos
    return [p for p in photos if fset.issubset({t.lower() for t in p.get("tags", [])})]



def rank_photos(photos: list[dict], model: dict | None = None) -> list[dict]:
    """给每张照片算综合分并排序（高分在前）。
    综合分 = 0.3*画质 + 0.25*美观度 + 0.45*偏好。"""
    model = model or trainer.load_model()
    ranked = []
    for p in photos:
        pref = trainer.score_tags(p.get("tags", []), model)
        quality = p.get("quality", 0.5)
        aesthetic = p.get("aesthetic", quality)
        final = round(0.3 * quality + 0.25 * aesthetic + 0.45 * pref, 4)
        ranked.append({**p, "pref_score": round(pref, 4), "final_score": final})
    ranked.sort(key=lambda x: x["final_score"], reverse=True)
    return ranked


def _primary_subject(tags: list[str]) -> str:
    """取照片的主体分组（people/pet/food/scene/other），用于按主体轮流选图。"""
    tset = set(tags or [])
    for group in ("people", "pet", "food", "scene"):
        if tset & _THEME_GROUPS[group]:
            return group
    return "other"


# 子分类叉乘用的次级维度词表（按优先级取第一个命中的作为该照片在此维度的子类）
_COLOR_VOCAB = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "monochrome", "neutral"]
_MOOD_VOCAB = ["mood_vivid", "mood_fresh", "mood_vintage", "mood_calm"]


def _dominant(tset: set, vocab: list[str]) -> str:
    for v in vocab:
        if v in tset:
            return v
    return "-"


def _subcat_key(tags: list[str]) -> tuple:
    """照片的「子分类签名」= (主体, 主色, 情绪)。
    同一主题下不同签名的照片就是不同子分类，选图时按签名轮流取即实现「叉乘混搭」，
    避免一墙全是同一子类；配合 rotate 轮换，避免每次刷新都是同一批照片（同质化）。"""
    tset = set(tags or [])
    return (_primary_subject(tags), _dominant(tset, _COLOR_VOCAB), _dominant(tset, _MOOD_VOCAB))


def select_for_template(photos: list[dict], slot_count: int, model: dict | None = None,
                        rotate: int = 0, avoid: set | None = None) -> list[dict]:
    """
    选出用于填充某模版的 N 张：高分优先 + 子分类叉乘 + 轮换 + 最近去重。

    1) 先按综合分排序；
    2) 按「子分类签名(主体×主色×情绪)」分组，跨子分类轮流取一张——保证一墙照片
       在多个维度上都铺开（叉乘混搭），而不是同一子类扎堆；
    3) rotate（每次生成自增的轮换序号）会旋转「领衔子分类」和「每组起始位置」，
       所以同一主题反复刷新会取到不同的照片组合，从根本上避免时间久了同质化；
    4) avoid（最近几屏已经上过的文件名集合）里的照片被降到各子分类末尾，
       优先选没露过脸的，让「换一批」差异更明显；池子不够时才回头用它们。
    """
    ranked = rank_photos(photos, model)
    avoid = avoid or set()
    if slot_count >= len(ranked):
        return ranked[:slot_count]

    from collections import OrderedDict
    groups: "OrderedDict[tuple, list[dict]]" = OrderedDict()
    for p in ranked:
        groups.setdefault(_subcat_key(p.get("tags", [])), []).append(p)

    # 子分类轮询顺序：按各组最高分排序，再按 rotate 旋转，让每次刷新由不同子类领衔
    keys = sorted(groups.keys(), key=lambda k: groups[k][0]["final_score"], reverse=True)
    n = len(keys)
    off = rotate % n if n else 0
    keys = keys[off:] + keys[:off]

    # 每个子分类内部：先按 rotate 做环形起始偏移，再把「最近上过屏的」稳定地挪到末尾，
    # 这样每次刷新优先取新鲜照片，最近露过脸的排最后（池子不够才会用到）。
    order_in_group: dict = {}
    for i, k in enumerate(groups):
        g = groups[k]
        start = (rotate + i) % len(g)
        rotated = g[start:] + g[:start]
        fresh = [p for p in rotated if (p.get("filename") or "") not in avoid]
        recent = [p for p in rotated if (p.get("filename") or "") in avoid]
        order_in_group[k] = fresh + recent

    pos = {k: 0 for k in groups}
    seen: set = set()
    selected: list[dict] = []
    active = list(keys)
    while len(selected) < slot_count and active:
        progressed = False
        for k in list(active):
            g = order_in_group[k]
            picked = False
            while pos[k] < len(g):
                cand = g[pos[k]]
                pos[k] += 1
                fid = cand.get("filename") or id(cand)
                if fid not in seen:
                    seen.add(fid)
                    selected.append(cand)
                    picked = True
                    progressed = True
                    break
            if not picked and pos[k] >= len(g):
                active.remove(k)
            if len(selected) >= slot_count:
                break
        if not progressed:
            break

    return selected[:slot_count]



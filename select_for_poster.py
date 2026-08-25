"""
select_for_poster.py — 拼贴海报专用选片

流程:
1. 从 scores.json 读所有可用照片
2. 按 pet_id 前两段(颜色-毛长)聚类,统计每只宠物的池子
3. 用"策略三"选主角:
   - 优先: 高清池 ≥ 5 张 且 body_orientation 覆盖至少 2 种
   - 平票靠 top 10 平均综合分
4. 兜底"策略一": 若无一满足,放宽 tech 门槛到 7,再选池最大的
5. 极端兜底: 无视一切门槛,综合分 top N 强行选
6. 挑 N 张 (N = template 里的 photo_slots 数量):
   - hero 位: 综合分最高
   - 其余按 body_orientation 匹配 photo_slot 的宽高比,尽量对齐
7. 输出 poster_selection.json + poster_info.json

用法:
    python select_for_poster.py --template templates/blue-mood/template.json
"""

import json
import argparse
from pathlib import Path
from collections import defaultdict, Counter

SCORES_FILE = "cache/scores.json"
OUTPUT_SELECTION = "cache/poster_selection.json"
OUTPUT_INFO = "cache/poster_info.json"

# 硬门槛 (策略三主选)
TECH_STRICT = 8
BLUR_ALLOW = {"none"}
POS_ALLOW = {"center"}

# 兜底门槛 (策略一)
TECH_LOOSE = 7

# 综合分权重
W_TECH = 0.5
W_LIFE = 0.3
W_FACE = 0.2

def get_pet_cluster(record):
    """把 pet_id 前两段作为聚类 key (颜色-毛长)"""
    pid = record.get("pet_id", "") or ""
    if not pid or pid == "none":
        return None
    parts = pid.split("-")
    if len(parts) < 2:
        return None
    return f"{parts[0]}-{parts[1]}"

def composite_score(r):
    """拼贴海报综合分"""
    tech = r.get("technical_quality", 0)
    life = r.get("life_moment", 0)
    face = r.get("face_score", 0)
    return tech * W_TECH + life * W_LIFE + face * W_FACE

def pass_strict(r):
    """严格门槛 (拼贴海报追求猫脸突出可爱的冲击力)"""
    if not r.get("is_pet"): return False
    tech = r.get("technical_quality", 0)
    if tech < TECH_STRICT: return False
    if r.get("blur_type") not in BLUR_ALLOW: return False
    if r.get("subject_position") not in POS_ALLOW: return False
    if r.get("has_human") or r.get("has_face"): return False
    # 加严: 主体必须占画面 60%+
    if r.get("subject_ratio", 0) < 60: return False
    # 加严: 脸部综合评分必须 ≥ 7
    if r.get("face_score", 0) < 7: return False
    return True

def pass_loose(r):
    """宽松门槛 (兜底)"""
    if not r.get("is_pet"): return False
    tech = r.get("technical_quality", 0)
    if tech < TECH_LOOSE: return False
    if r.get("blur_type") == "out_of_focus": return False
    if r.get("has_human") or r.get("has_face"): return False
    if r.get("subject_ratio", 0) < 50: return False  # 兜底也 ≥ 50
    if r.get("face_score", 0) < 6: return False       # 兜底 face_score ≥ 6
    return True

def parse_hex_color(hex_str):
    """解析 #RRGGBB 为 (r, g, b) tuple"""
    if not hex_str or not hex_str.startswith("#") or len(hex_str) != 7:
        return None
    try:
        return tuple(int(hex_str[i:i+2], 16) for i in (1, 3, 5))
    except ValueError:
        return None

def color_distance(c1_hex, c2_hex):
    """两个 hex 颜色的欧式距离"""
    c1 = parse_hex_color(c1_hex)
    c2 = parse_hex_color(c2_hex)
    if not c1 or not c2:
        return 9999
    return sum((a - b) ** 2 for a, b in zip(c1, c2)) ** 0.5

def cluster_stats(photos):
    """按 pet_cluster 分组统计"""
    by_cluster = defaultdict(list)
    for r in photos:
        c = get_pet_cluster(r)
        if c:
            by_cluster[c].append(r)
    return by_cluster

def orientation_set(photos):
    """返回照片池覆盖的 body_orientation 种类"""
    return set(r.get("body_orientation", "") for r in photos
               if r.get("body_orientation") in ("horizontal", "vertical", "square"))

def rank_clusters_strategy3(scores):
    """策略三: 能凑齐好海报的宠物"""
    all_photos = [r for r in scores.values() if pass_strict(r)]
    by_cluster = cluster_stats(all_photos)

    ranked = []
    for cluster, photos in by_cluster.items():
        if len(photos) < 5:
            continue
        orients = orientation_set(photos)
        if len(orients) < 2:
            continue
        top10 = sorted(photos, key=composite_score, reverse=True)[:10]
        avg = sum(composite_score(p) for p in top10) / len(top10)
        ranked.append({
            "cluster": cluster,
            "count": len(photos),
            "orientations": sorted(orients),
            "top10_avg": round(avg, 2),
            "photos": photos,
        })

    # 排序: 覆盖 orientation 多的优先 → count 多的优先 → 平均分高的优先
    ranked.sort(key=lambda x: (len(x["orientations"]), x["count"], x["top10_avg"]),
                reverse=True)
    return ranked

def rank_clusters_strategy1(scores):
    """策略一兜底: 谁池子最大就选谁"""
    all_photos = [r for r in scores.values() if pass_loose(r)]
    by_cluster = cluster_stats(all_photos)

    ranked = []
    for cluster, photos in by_cluster.items():
        if len(photos) < 5:
            continue
        top10 = sorted(photos, key=composite_score, reverse=True)[:10]
        avg = sum(composite_score(p) for p in top10) / len(top10)
        ranked.append({
            "cluster": cluster,
            "count": len(photos),
            "orientations": sorted(orientation_set(photos)),
            "top10_avg": round(avg, 2),
            "photos": photos,
        })
    ranked.sort(key=lambda x: (x["count"], x["top10_avg"]), reverse=True)
    return ranked

def slot_orientation(slot):
    """根据 photo_slot 的宽高比推断它期待什么方向的照片"""
    w = slot.get("width", 1)
    h = slot.get("height", 1)
    ratio = w / h
    if ratio > 1.15:
        return "horizontal"
    if ratio < 0.87:
        return "vertical"
    return "square"

def assign_photos_to_slots(photos, slots):
    """把选中的照片分配到 photo_slots
    hero 位: 综合分最高
    其他位: 从剩余里选跟 hero dominant_color 最接近的 (追求色调一致)
    body_orientation 不再做硬匹配 (放宽,不影响主要选片)
    """
    photos_sorted = sorted(photos, key=composite_score, reverse=True)

    hero_slot = next((s for s in slots if s.get("priority") == "hero"), None)
    other_slots = [s for s in slots if s.get("priority") != "hero"]

    assignments = {}

    # hero 位: 综合分最高
    if hero_slot:
        hero_photo = photos_sorted[0]
        assignments[hero_slot["name"]] = hero_photo
        hero_color = hero_photo.get("dominant_color", "")
        remaining_photos = photos_sorted[1:]
    else:
        hero_color = ""
        remaining_photos = photos_sorted

    # 其他位: 按跟 hero 色调接近程度选 (color_distance 越小越接近)
    # 同时保留综合分的影响 (综合分高的加分)
    if hero_color:
        def color_score(p):
            dist = color_distance(hero_color, p.get("dominant_color", ""))
            # 综合分 - 色距/50 (色距越远越扣分)
            return composite_score(p) - dist / 50
        remaining_photos = sorted(remaining_photos, key=color_score, reverse=True)

    # 分配剩余 slot
    used = set()
    for slot in other_slots:
        for p in remaining_photos:
            if id(p) in used:
                continue
            assignments[slot["name"]] = p
            used.add(id(p))
            break

    return assignments

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True,
                        help="template.json 路径")
    args = parser.parse_args()

    with open(args.template) as f:
        template = json.load(f)
    slots = template["photo_slots"]
    n_slots = len(slots)

    with open(SCORES_FILE) as f:
        scores = json.load(f)

    print(f"📊 加载 scores.json: {len(scores)} 条")
    print(f"🎨 模板需要 {n_slots} 张照片")
    print()

    # 打印 slot 的方向需求
    print("📐 照片位方向需求:")
    for s in slots:
        want = slot_orientation(s)
        print(f"   {s['name']} ({s['priority']}): {s['width']:.0f}×{s['height']:.0f} → 期望 {want}")
    print()

    # 策略三主选
    print("🎯 策略三: 找能撑起完整海报的宠物...")
    ranked_s3 = rank_clusters_strategy3(scores)

    chosen_cluster = None
    strategy_used = None
    if ranked_s3:
        for r in ranked_s3[:5]:
            print(f"  · {r['cluster']}  高清池={r['count']}  方向={r['orientations']}  top10均分={r['top10_avg']}")
        chosen_cluster = ranked_s3[0]
        strategy_used = "strategy_3"
        print(f"\n✅ 选中主角: {chosen_cluster['cluster']}")
    else:
        print("  ⚠️  没有宠物能满足策略三的门槛,进入兜底")
        print()
        print("🔄 策略一兜底: 放宽 tech 门槛,选池最大...")
        ranked_s1 = rank_clusters_strategy1(scores)
        if ranked_s1:
            for r in ranked_s1[:5]:
                print(f"  · {r['cluster']}  宽松池={r['count']}  方向={r['orientations']}  top10均分={r['top10_avg']}")
            chosen_cluster = ranked_s1[0]
            strategy_used = "strategy_1_fallback"
            print(f"\n✅ 兜底选中: {chosen_cluster['cluster']}")

    if not chosen_cluster:
        print()
        print("💥 无法生成海报: 没有任何一只宠物能凑齐 5 张合格照片")
        print("   建议: 提供更多宠物照片,或降低质量门槛")
        return

    print()

    # 从选中主角的池子里分配到 slot
    photos = chosen_cluster["photos"]
    assignments = assign_photos_to_slots(photos, slots)

    print(f"📸 最终选片 ({len(assignments)} 张):")
    for slot in slots:
        p = assignments.get(slot["name"])
        if not p:
            print(f"  ✗ {slot['name']}: 未分配")
            continue
        want_orient = slot_orientation(slot)
        got_orient = p.get("body_orientation")
        match = "✓" if want_orient == got_orient else "△"
        print(f"  {match} {slot['name']} ({slot['priority']}):  "
              f"score={composite_score(p):.1f}  face={p.get('face_score')}  "
              f"orient={got_orient}(需要 {want_orient})  "
              f"pose={p.get('pose_and_expression')}  "
              f"{p['filename']}")

    # 输出选片
    selection = {
        slot["name"]: {
            "photo": assignments[slot["name"]],
            "slot_info": slot,
        }
        for slot in slots if slot["name"] in assignments
    }
    Path(OUTPUT_SELECTION).parent.mkdir(exist_ok=True, parents=True)
    with open(OUTPUT_SELECTION, "w", encoding="utf-8") as f:
        json.dump(selection, f, ensure_ascii=False, indent=2)

    # 输出诊断信息
    info = {
        "strategy_used": strategy_used,
        "chosen_pet_cluster": chosen_cluster["cluster"],
        "cluster_photo_count": chosen_cluster["count"],
        "cluster_orientations": chosen_cluster["orientations"],
        "cluster_top10_avg_score": chosen_cluster["top10_avg"],
        "photos_selected": [
            {
                "slot_id": slot_id,
                "filename": s["photo"]["filename"],
                "score": round(composite_score(s["photo"]), 2),
                "face_score": s["photo"].get("face_score"),
                "body_orientation": s["photo"].get("body_orientation"),
                "pose_and_expression": s["photo"].get("pose_and_expression"),
                "pet_id": s["photo"].get("pet_id"),
            }
            for slot_id, s in selection.items()
        ],
    }
    with open(OUTPUT_INFO, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    print()
    print(f"💾 选片结果: {OUTPUT_SELECTION}")
    print(f"💾 诊断信息: {OUTPUT_INFO}")

if __name__ == "__main__":
    main()

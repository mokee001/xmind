"""
select_for_collage.py — 拼贴海报专用选片

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
7. 输出 collage_selection.json + collage_info.json

用法:
    python select_for_collage.py --template templates/blue-mood/template.json
"""

import json
import re
import argparse
from pathlib import Path
from collections import defaultdict, Counter

SCORES_FILE = "cache/scores.json"
# 通用抠图缓存 (原名 hero_cutouts, 现在给所有 slot 用), key=md5, value=RGBA PNG
CUTOUT_EDGE_CACHE = Path("cache/hero_cutouts")
HERO_CANDIDATE_TOP_N = 10   # hero 位从综合分 top N 里挑截断边数最少的
SIDE_CANDIDATE_TOP_N = 15   # 侧向 slot (photo_1/2/3/4) 从 color_score top N 里挑


def extract_style_name(template_path):
    """从 template 路径提取风格名, 如 templates/denim/template.json → 'denim'"""
    parts = Path(template_path).parts
    if "templates" in parts:
        idx = parts.index("templates")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return "default"

# 硬门槛 (策略三主选)
# tech 门槛从 8 降到 7: qwen3.7-plus 加 10 字段后整体打分偏保守, 8 分门槛过严
TECH_STRICT = 7
BLUR_ALLOW = {"none"}
POS_ALLOW = {"center"}

# 兜底门槛 (策略一)
TECH_LOOSE = 6

# 综合分权重 (v2.4 拼贴海报)
# 变更来由:
#   v2.3 移除了 hero_potential 后仍然选出全身照 (脸小), 根因是没有字段区分
#   "大头/半身/全身" 取景类型. 现在依赖新增的 shot_type 字段:
#     - shot_type 作为硬过滤: 只保留 close_up + half_body (排除 full_body/other)
#     - shot_type 硬过滤后, subject_ratio 不再有"大身子小脸"的误导问题
#       (因为取景类型已限定, subject 大 = 脸就大)
#   综合分只保留三个维度: subject_ratio (主体占比) + tech + life.
#   face_score 不再入综合分, 但仍作硬过滤下限 (>=7 strict / >=6 loose).
W_SUBJECT = 0.40   # 主体占画面 (subject_ratio/10 归一化, 在限定取景后含义变清晰)
W_TECH = 0.40      # 技术质量
W_LIFE = 0.20      # 生活感

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
    """拼贴海报综合分 (v2.4: subject + tech + life 三维加权)

    face_score 不入综合分 (已作硬过滤下限, >=7 strict).
    shot_type 也不入综合分 (作硬过滤, 只留 close_up + half_body).
    经过两道硬过滤后, subject_ratio 的物理含义已变清晰: 主体占画面越大, 脸就越大.
    """
    tech = r.get("technical_quality", 0)
    subject = r.get("subject_ratio", 0) / 10.0  # 0-100 归一化到 0-10
    life = r.get("life_moment", 0)
    return subject * W_SUBJECT + tech * W_TECH + life * W_LIFE

def pass_strict(r):
    """严格门槛 (v2.4.1 拼贴海报: 结构性 + 取景 + 基本质量下限)

    v2.4.1 变更:
    - 移除 has_nearby_objects 硬过滤 (实测 92% 现实照片被误判为有邻近物体,
      而 render 端已有"多前景选最大"防御 [handoff line 131], 硬过滤属于双保险过度)

    保留硬过滤:
    - 结构性: is_pet / pet_count==1 / !has_human
    - 失焦: blur_type != out_of_focus
    - 背景复杂度: bg_complexity < 4 (仍保留, 但阈值放宽)
    - 基本质量下限: technical_quality >= 7 / face_score >= 7
    - 取景类型: shot_type in {close_up, half_body}
    """
    if not r.get("is_pet"): return False
    # 只允许单猫 (多猫互相挨着容易被 Vision 抠成一整块导致视觉混乱)
    if r.get("pet_count", 1) != 1: return False
    tech = r.get("technical_quality", 0)
    if tech < TECH_STRICT: return False
    # 允许 motion blur (动态瞬间值得保留), 只剔除失焦
    if r.get("blur_type") == "out_of_focus": return False
    if r.get("has_human"): return False  # 不允许人物
    if r.get("face_score", 0) < 7: return False
    if r.get("background_complexity", 0) >= 4: return False
    # 取景类型硬过滤: 只要大头照 + 半身照, 排除全身照 / 背影 / 无脸
    if r.get("shot_type") not in ("close_up", "half_body"): return False
    return True

def pass_loose(r):
    """宽松门槛 (兜底, v2.4.1)

    loose 只在拍摄质量维度上让一步 (tech 7→6, face 7→6, bg 4→5).
    shot_type 硬过滤保留 —— 取景类型是产品核心, 兜底也不能出全身照.
    has_nearby_objects 已从 strict 和 loose 两层都删除 (v2.4.1).
    """
    if not r.get("is_pet"): return False
    if r.get("pet_count", 1) != 1: return False
    tech = r.get("technical_quality", 0)
    if tech < TECH_LOOSE: return False
    if r.get("blur_type") == "out_of_focus": return False
    if r.get("has_human"): return False
    if r.get("face_score", 0) < 6: return False
    if r.get("background_complexity", 0) >= 5: return False
    # 取景类型硬过滤 (兜底也不放宽 —— 大头/半身是产品核心)
    if r.get("shot_type") not in ("close_up", "half_body"): return False
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
        top10 = sorted(photos, key=composite_score, reverse=True)[:10]
        avg = sum(composite_score(p) for p in top10) / len(top10)
        ranked.append({
            "cluster": cluster,
            "count": len(photos),
            "top10_avg": round(avg, 2),
            "photos": photos,
        })

    # 排序: 池大的优先, 平票靠 top10 平均分
    ranked.sort(key=lambda x: (x["count"], x["top10_avg"]), reverse=True)
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

def is_hero_shot_eligible(r):
    """hero 位取景类型硬约束: close_up + half_body 都可 (跟策略层保持一致)"""
    return r.get("shot_type") in ("close_up", "half_body")


def slot_preferred_clean_side(slot_name):
    """按 photo_N 编号奇偶推断这个 slot"内侧"是哪一侧 (那一侧的截断在海报里会暴露).
    - photo_hero: None (走 hero 逻辑, 截断最少)
    - photo_1, photo_3, photo_5... (奇数): 需要 right 侧无截断 (它们朝海报中心/右)
    - photo_2, photo_4, photo_6... (偶数): 需要 left 侧无截断
    """
    if slot_name == "photo_hero":
        return None
    m = re.search(r"(\d+)$", slot_name)
    if not m:
        return None
    n = int(m.group(1))
    return "right" if n % 2 == 1 else "left"


def photo_cutout_edge_check(photo):
    """对一张候选照片做抠图 + 四边截断检测, 结果缓存.

    Returns:
        dict {"top", "bottom", "left", "right"} 每个 bool True 表示该边被截断
        或 None (抠图失败)
    """
    from PIL import Image
    from cutout_apple import cutout as apple_cutout, detect_edge_truncation

    md5 = photo.get("md5")
    if not md5:
        return None
    CUTOUT_EDGE_CACHE.mkdir(parents=True, exist_ok=True)
    cache_path = CUTOUT_EDGE_CACHE / f"{md5}.png"

    if cache_path.exists():
        try:
            rgba = Image.open(cache_path).convert("RGBA")
            rgba.load()
        except Exception:
            cache_path.unlink(missing_ok=True)
            rgba = None
    else:
        rgba = None

    if rgba is None:
        try:
            src = Image.open(photo["path"])
            rgba = apple_cutout(src)
            rgba.save(cache_path)
        except Exception as e:
            print(f"  ⚠️  抠图检查失败 {photo['filename']}: {e}")
            return None

    return detect_edge_truncation(rgba)


def pick_hero_by_cutout(photos_sorted, top_n=HERO_CANDIDATE_TOP_N):
    """从综合分 top_n 的 close_up/half_body 里, 挑"截断边数最少"的作为 hero.
    平局按综合分.
    Returns: (hero_photo, tag, mirror_bool)  mirror 始终 False (hero 不做镜像)
    """
    print(f"  🔍 hero 位: 从综合分 top {top_n} 挑截断最少的...")
    candidates = []
    checked = 0
    for p in photos_sorted:
        if checked >= top_n:
            break
        if not is_hero_shot_eligible(p):
            continue
        checked += 1
        edges = photo_cutout_edge_check(p)
        if edges is None:
            print(f"     ?  {p['filename']}  抠图失败, 跳过")
            continue
        trunc_sides = [s for s, v in edges.items() if v]
        candidates.append((len(trunc_sides), -composite_score(p), p, trunc_sides))
        marker = "✓" if not trunc_sides else "-"
        print(f"     {marker}  {p['filename']}  截断: "
              f"{'/'.join(trunc_sides) if trunc_sides else '无'}  "
              f"score={composite_score(p):.2f}")

    if not candidates:
        fallback = photos_sorted[0]
        print(f"  ⚠️  没有可评估候选, hero 回退到综合分最高的 {fallback['filename']}")
        return fallback, "fallback_first", False

    candidates.sort(key=lambda x: (x[0], x[1]))
    trunc_count, _, best, trunc_sides = candidates[0]
    if trunc_count == 0:
        print(f"     ⇒ {best['filename']}  ✓ 四边干净")
        return best, "cutout_clean", False
    else:
        print(f"     ⇒ {best['filename']}  ⚠️ 截断 {trunc_count} 边 "
              f"({'/'.join(trunc_sides)}), 但已是 top {top_n} 里最少")
        return best, "cutout_min_truncation", False


def pick_photo_for_side_slot(remaining_sorted, preferred_side,
                             used_ids, slot_name, top_n=SIDE_CANDIDATE_TOP_N):
    """给 photo_1/3 (右侧无截断) 或 photo_2/4 (左侧无截断) 选片.

    优先级:
      1. 原图 preferred_side 侧无截断 → 直接用, 不镜像
      2. 原图 opposite 侧无截断 → 水平镜像后使用 (原 opposite 变成新 preferred)
      3. 两侧都截断 → 综合分最高的, 无救助, 不镜像

    Returns: (photo, mirror_bool, tag) 或 (None, False, "empty") 如无候选
    """
    opposite = "left" if preferred_side == "right" else "right"
    print(f"  📷 {slot_name}: 期望 {preferred_side} 侧无截断, 逐个查 top {top_n}...")
    tier1, tier2, tier3 = [], [], []
    checked = 0
    for p in remaining_sorted:
        if id(p) in used_ids:
            continue
        if checked >= top_n:
            break
        checked += 1
        edges = photo_cutout_edge_check(p)
        if edges is None:
            continue
        pref_clean = not edges[preferred_side]
        opp_clean = not edges[opposite]
        if pref_clean:
            tier1.append((p, edges))
        elif opp_clean:
            tier2.append((p, edges))
        else:
            tier3.append((p, edges))

    if tier1:
        p, edges = tier1[0]
        print(f"     ✓ {p['filename']}  {preferred_side}侧干净, 不镜像")
        return p, False, "native"
    if tier2:
        p, edges = tier2[0]
        print(f"     ↔ {p['filename']}  {opposite}侧干净 ({preferred_side}=T), 镜像后使用")
        return p, True, "mirror"
    if tier3:
        p, edges = tier3[0]
        trunc = [s for s, v in edges.items() if v]
        print(f"     ⚠️ {p['filename']}  两侧都截断 ({'/'.join(trunc)}), 无救助")
        return p, False, "fallback"
    print(f"     ✗ top {top_n} 全部抠图失败或无候选")
    return None, False, "empty"


def assign_photos_to_slots(photos, slots):
    """把选中的照片分配到 photo_slots (v2.5.3: 每张带 mirror 标志).

    hero 位: 从综合分 top N 里挑截断边数最少的 (放宽 v2.5.1 的"四边全干净"要求)
    photo_1/3/5... (奇数): 优先右侧无截断; 若无, 挑左侧无截断的做水平镜像
    photo_2/4/6... (偶数): 优先左侧无截断; 若无, 挑右侧无截断的做水平镜像
    其他 slot (无编号): 按跟 hero 色距接近程度选, 不做镜像

    Returns:
        dict: {slot_name: {"photo": photo_dict, "mirror": bool}}
    """
    photos_sorted = sorted(photos, key=composite_score, reverse=True)

    hero_slot = next((s for s in slots if s.get("priority") == "hero"), None)
    other_slots = [s for s in slots if s.get("priority") != "hero"]

    assignments = {}
    used_ids = set()

    # 1. hero 位: 截断最少
    hero_color = ""
    if hero_slot:
        hero_photo, _, hero_mirror = pick_hero_by_cutout(photos_sorted)
        assignments[hero_slot["name"]] = {"photo": hero_photo, "mirror": hero_mirror}
        used_ids.add(id(hero_photo))
        hero_color = hero_photo.get("dominant_color", "")

    # 2. 其他 slot 按 color_score 排序 (跟 hero 色调靠近的加分)
    def color_score(p):
        dist = color_distance(hero_color, p.get("dominant_color", ""))
        return composite_score(p) - dist / 50
    remaining_sorted = sorted(
        [p for p in photos_sorted if id(p) not in used_ids],
        key=color_score if hero_color else composite_score,
        reverse=True,
    )

    # 3. 逐个非-hero slot 挑照片 (按侧向偏好 or 无偏好)
    for slot in other_slots:
        pref_side = slot_preferred_clean_side(slot["name"])
        if pref_side is None:
            # 无侧向偏好 (可能是 photo_extra 之类命名), 取第一个可用
            for p in remaining_sorted:
                if id(p) in used_ids:
                    continue
                assignments[slot["name"]] = {"photo": p, "mirror": False}
                used_ids.add(id(p))
                print(f"  📷 {slot['name']}: 无侧向偏好 → {p['filename']}")
                break
            continue

        p, mirror, tag = pick_photo_for_side_slot(
            remaining_sorted, pref_side, used_ids, slot["name"])
        if p:
            assignments[slot["name"]] = {"photo": p, "mirror": mirror}
            used_ids.add(id(p))

    return assignments

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True,
                        help="template.json 路径")
    parser.add_argument("--cluster", default=None,
                        help="手动指定主角 pet_cluster (如 orange-tabby). 缺省自动选池最大者")
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

    # 策略三主选 (可能被 --cluster 覆盖)
    print("🎯 策略三: 找能撑起完整海报的宠物...")
    ranked_s3 = rank_clusters_strategy3(scores)
    ranked_s1 = None  # 需要时才算

    chosen_cluster = None
    strategy_used = None
    if ranked_s3:
        for r in ranked_s3[:5]:
            print(f"  · {r['cluster']}  高清池={r['count']}  top10均分={r['top10_avg']}")

    if args.cluster:
        # 用户指定了主角: 优先在策略三里找, 再退到策略一
        print(f"\n🎯 --cluster 指定主角: {args.cluster}")
        chosen_cluster = next((r for r in (ranked_s3 or []) if r["cluster"] == args.cluster), None)
        if chosen_cluster:
            strategy_used = "strategy_3_manual"
            print(f"   ✅ 在策略三严格池里找到 (共 {chosen_cluster['count']} 张)")
        else:
            print(f"   严格池里没有, 退到策略一宽松池找...")
            ranked_s1 = rank_clusters_strategy1(scores)
            chosen_cluster = next((r for r in (ranked_s1 or []) if r["cluster"] == args.cluster), None)
            if chosen_cluster:
                strategy_used = "strategy_1_manual"
                print(f"   ✅ 在策略一宽松池里找到 (共 {chosen_cluster['count']} 张)")
            else:
                print(f"   ✗ 严格池和宽松池都找不到 {args.cluster}")
                available = sorted(set(
                    [r["cluster"] for r in (ranked_s3 or [])] +
                    [r["cluster"] for r in (ranked_s1 or [])]
                ))
                print(f"   可选 cluster: {', '.join(available) if available else '(无)'}")
                return
    elif ranked_s3:
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
                print(f"  · {r['cluster']}  宽松池={r['count']}  top10均分={r['top10_avg']}")
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
        entry = assignments.get(slot["name"])
        if not entry:
            print(f"  ✗ {slot['name']}: 未分配")
            continue
        p = entry["photo"]
        mirror = entry["mirror"]
        mirror_tag = "↔ 镜像" if mirror else "  正向"
        print(f"  · {slot['name']} ({slot['priority']}) {mirror_tag}:  "
              f"score={composite_score(p):.1f}  shot={p.get('shot_type')}  "
              f"face={p.get('face_score')}  subj={p.get('subject_ratio')}  "
              f"pose={p.get('pose_and_expression')}  "
              f"{p['filename']}")

    # 输出选片 (每个 slot 记录 photo + mirror + slot_info)
    selection = {
        slot["name"]: {
            "photo": assignments[slot["name"]]["photo"],
            "mirror": assignments[slot["name"]]["mirror"],
            "slot_info": slot,
        }
        for slot in slots if slot["name"] in assignments
    }
    style = extract_style_name(args.template)
    output_selection = f"cache/collage_{style}_selection.json"
    output_info = f"cache/collage_{style}_info.json"

    Path(output_selection).parent.mkdir(exist_ok=True, parents=True)
    with open(output_selection, "w", encoding="utf-8") as f:
        json.dump(selection, f, ensure_ascii=False, indent=2)

    # 输出诊断信息
    info = {
        "strategy_used": strategy_used,
        "chosen_pet_cluster": chosen_cluster["cluster"],
        "cluster_photo_count": chosen_cluster["count"],
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
                "mirror": s.get("mirror", False),
            }
            for slot_id, s in selection.items()
        ],
    }
    with open(output_info, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    print()
    print(f"💾 选片结果: {output_selection}")
    print(f"💾 诊断信息: {output_info}")
    print(f"🎨 风格: {style}")

if __name__ == "__main__":
    main()

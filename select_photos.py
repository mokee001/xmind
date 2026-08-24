"""
select_photos.py — 从 scores.json 挑出最终 30 张进入日历

日历规格 v1:
- 日期范围: 2026-06-30 到 2026-07-29 (30 天)
- 布局: 6 行 × 5 列, 老日期左上, 按行优先
- 每天 1 张 S 单格, 空档留白
- 输出: selection.json (给排版脚本用)

选片逻辑:
1. 过滤: is_pet=false / shot_date 为空/超出窗口 / 技术+生活双低分 的剔除
2. 每天从候选中按 综合分 = life_moment × 0.7 + technical_quality × 0.3 排序
3. 每天选综合分最高的那张
4. 多样性打散: 若相邻日期 scene/activity 相似, 尝试用备选照片替换
5. 输出 30 天的排布 (含空档标记)

用法:
    python select_photos.py                              # 用今天作为窗口末尾
    python select_photos.py --end-date 2026-07-29        # 指定窗口末尾
    python select_photos.py --dry-run                    # 只打印, 不写文件
"""

import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

SCORES_FILE = "cache/scores.json"
OUTPUT_FILE = "cache/selection.json"

# 过滤阈值
# life_moment 门槛: 新旧模型打分标尺不同(老模型偏高、新模型偏低),
# 用 5 作为兼容门槛,让两个模型的照片都有公平进池机会,靠综合分排序决胜
MIN_LIFE_MOMENT = 5
BLUR_REJECT_TQ = 4    # technical_quality ≤ 此值 且 life_moment ≤ 门槛 视为糊照剔除
BLUR_REJECT_LM = 5

# 打分权重 (5:5 平衡, 避免"随性抓拍"挤掉"精美大头照")
W_LIFE = 0.5
W_TECH = 0.5

# 多猫关系加权关键词
MULTI_PET_POSITIVE = ["打闹", "依偎", "互相", "一起", "叠", "抱", "亲", "搭子",
                      "并排", "共食", "陪伴", "靠", "贴", "缠", "追", "对峙"]
MULTI_PET_NEGATIVE = ["各自", "独自", "远处", "背对", "无视", "分开", "距离",
                      "各在", "各占", "无交流", "背向"]
MULTI_PET_BONUS = 1.5  # 亲密多猫 +1.5 分
MULTI_PET_PENALTY = -2.0  # 疏离多猫 -2 分

WINDOW_DAYS = 30

def load_scores():
    with open(SCORES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def is_usable(record):
    """判断照片是否值得进入选片池"""
    if not record.get("is_pet"):
        return False
    if not record.get("shot_date"):
        return False
    tq = record.get("technical_quality", 0)
    lm = record.get("life_moment", 0)
    # 兜底剔除糊照片: technical 极差 且 生活感也不突出
    if tq <= BLUR_REJECT_TQ and lm <= BLUR_REJECT_LM:
        return False
    if lm < MIN_LIFE_MOMENT:
        return False
    # 主体必须居中 (方向 A: 避免裁切时主体被切出画面)
    # 但多猫照片豁免: 多猫构图天然有主体偏两侧的合理性,且渲染时不放大裁切
    if record.get("pet_count", 1) < 2 and record.get("subject_position") != "center":
        return False
    # 活动描述含"无宠物"直接过滤 (VLM 边缘案例: is_pet=true 但实际主体不是宠物)
    activity = str(record.get("activity", "") or "")
    if "无宠物" in activity or "没有宠物" in activity:
        return False
    return True

def multi_pet_bonus(record):
    """多猫照片的关系加权: 亲密加分, 疏离减分"""
    if record.get("pet_count", 1) < 2:
        return 0
    relation = str(record.get("pet_relation", "") or "")
    if not relation:
        return 0
    if any(k in relation for k in MULTI_PET_POSITIVE):
        return MULTI_PET_BONUS
    if any(k in relation for k in MULTI_PET_NEGATIVE):
        return MULTI_PET_PENALTY
    return 0

def score(record):
    lm = record.get("life_moment", 0)
    tq = record.get("technical_quality", 0)
    return lm * W_LIFE + tq * W_TECH + multi_pet_bonus(record)

def is_similar(a, b):
    """两张照片是否相似(用于多样性打散)"""
    if not a or not b:
        return False
    # 场景相同 + 活动相同 = 太像
    return (a.get("scene", "") == b.get("scene", "")
            and a.get("activity", "") == b.get("activity", ""))

def build_date_range(end_date_str):
    """生成日期窗口列表, 从老到新"""
    end = datetime.strptime(end_date_str, "%Y-%m-%d")
    start = end - timedelta(days=WINDOW_DAYS - 1)
    return [(start + timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(WINDOW_DAYS)]

def select_for_date(candidates, prev_selected):
    """
    从当天候选照片里选一张。
    candidates: 该日期的所有可用照片(已按 score 降序排列)
    prev_selected: 上一天选中的照片(用于多样性打散)
    """
    if not candidates:
        return None
    # 首选: 综合分最高
    top = candidates[0]
    # 如果 top 跟上一天相似 且 还有其他候选, 尝试用第二名
    if len(candidates) > 1 and is_similar(top, prev_selected):
        # 找第一个不相似的
        for cand in candidates[1:]:
            if not is_similar(cand, prev_selected):
                # 但如果备选分数掉太多(超过 2 分),还是用 top
                if score(top) - score(cand) > 2:
                    return top
                return cand
    return top

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--end-date", default=None,
                        help="窗口末尾日期 YYYY-MM-DD, 默认今天")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印结果, 不写 selection.json")
    args = parser.parse_args()

    end_date = args.end_date or datetime.now().strftime("%Y-%m-%d")
    date_range = build_date_range(end_date)

    print(f"📅 日历窗口: {date_range[0]} → {date_range[-1]} ({WINDOW_DAYS} 天)")
    print()

    # 加载 scores
    scores = load_scores()
    print(f"📊 加载 scores.json: 共 {len(scores)} 条记录")

    # 过滤 + 按日期分组
    by_date = defaultdict(list)
    filter_stats = {"not_pet": 0, "no_date": 0, "out_of_window": 0,
                    "low_score": 0, "off_center": 0, "no_pet_activity": 0,
                    "usable": 0}

    for r in scores.values():
        if not r.get("is_pet"):
            filter_stats["not_pet"] += 1
            continue
        d = r.get("shot_date")
        if not d:
            filter_stats["no_date"] += 1
            continue
        if d not in date_range:
            filter_stats["out_of_window"] += 1
            continue
        tq = r.get("technical_quality", 0)
        lm = r.get("life_moment", 0)
        if (tq <= BLUR_REJECT_TQ and lm <= BLUR_REJECT_LM) or lm < MIN_LIFE_MOMENT:
            filter_stats["low_score"] += 1
            continue
        # 主体偏离过滤: 单猫必须居中, 多猫豁免
        if r.get("pet_count", 1) < 2 and r.get("subject_position") != "center":
            filter_stats["off_center"] += 1
            continue
        activity = str(r.get("activity", "") or "")
        if "无宠物" in activity or "没有宠物" in activity:
            filter_stats["no_pet_activity"] += 1
            continue
        by_date[d].append(r)
        filter_stats["usable"] += 1

    print(f"   过滤 非宠物: {filter_stats['not_pet']}")
    print(f"   过滤 无日期: {filter_stats['no_date']}")
    print(f"   过滤 窗口外: {filter_stats['out_of_window']}")
    print(f"   过滤 低分/糊照: {filter_stats['low_score']}")
    print(f"   过滤 主体偏离: {filter_stats['off_center']}")
    print(f"   过滤 无宠物活动: {filter_stats['no_pet_activity']}")
    print(f"   可用: {filter_stats['usable']}")
    print()

    # 每天按综合分排序
    for d in by_date:
        by_date[d].sort(key=score, reverse=True)

    # 顺序遍历日期, 每天选 1 张 (带多样性打散)
    selection = []
    prev = None
    for d in date_range:
        cands = by_date.get(d, [])
        chosen = select_for_date(cands, prev)
        if chosen:
            selection.append({
                "date": d,
                "empty": False,
                "photo": chosen,
                "candidates_count": len(cands),
            })
            prev = chosen
        else:
            selection.append({
                "date": d,
                "empty": True,
                "photo": None,
                "candidates_count": 0,
            })

    # 打印结果概览
    print(f"📸 选片结果 (6 行 × 5 列):")
    print()
    for row in range(6):
        line = ""
        for col in range(5):
            idx = row * 5 + col
            entry = selection[idx]
            date_num = entry["date"][-2:]  # 只取日期数字部分
            if entry["empty"]:
                line += f"[{date_num} ─────] "
            else:
                p = entry["photo"]
                cap = p.get("caption", "")
                # 截断长 caption
                if len(cap) > 8:
                    cap = cap[:8] + "…"
                line += f"[{date_num} {cap:<8}] "
        print(line)
    print()

    # 打印详细列表
    print(f"📋 每日详情:")
    empty_count = 0
    for entry in selection:
        if entry["empty"]:
            print(f"  {entry['date']}  ─── 空档 ───")
            empty_count += 1
        else:
            p = entry["photo"]
            print(f"  {entry['date']}  {p['filename']:<25}  "
                  f"lm={p['life_moment']} tq={p['technical_quality']}  "
                  f"{p['layout_suggestion']}  {p['caption']}")

    print()
    print(f"✅ 完成: {WINDOW_DAYS - empty_count} 天有照片 / {empty_count} 天空档")

    if not args.dry_run:
        Path("cache").mkdir(exist_ok=True)
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "end_date": end_date,
                "start_date": date_range[0],
                "window_days": WINDOW_DAYS,
                "layout": {"rows": 6, "cols": 5},
                "selection": selection,
                "filter_stats": filter_stats,
            }, f, ensure_ascii=False, indent=2)
        print(f"💾 已保存到 {OUTPUT_FILE}")

if __name__ == "__main__":
    main()

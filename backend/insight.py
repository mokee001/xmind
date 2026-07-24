"""
照片洞察引擎（验证版）：读一组照片的「标签 + EXIF 时间」，挖出藏在背后的故事，
产出心声腔的标题/副标题（供照片墙做主题标题、或给选片加「叙事」维度）。

两条路径，自动择一：
  · 配了大模型（环境变量 INSIGHT_API_KEY / OPENAI_API_KEY）→ 走真模型，
    只上传「文本化标签 + 拍摄时间」，绝不上传原图（隐私友好、便宜）。
  · 没配 → 走离线桩 _generate_stub()：纯本地、确定性，用真实标签/EXIF 规则化产出
    一份 schema 合法的洞察，让整条链路先跑通、先看效果，再决定要不要深投大模型。

对外只暴露 generate(photos)。返回结构对齐提示词 schema（nodes/connections/
storylines/insights），额外带一个 "engine" 字段标明本次是 "llm" 还是 "stub"。
"""

from __future__ import annotations

import datetime
import json
import os
import urllib.request
from typing import Any

_PROMPT_PATH = os.path.join(os.path.dirname(__file__), "prompts", "insight_prompt.txt")

# 主体分组：把标签归成「人物/宠物/美食/风景」四类主体，用于统计「一直在拍什么」。
_SUBJECTS: dict[str, set[str]] = {
    "人物": {"person", "group", "portrait", "selfie"},
    "宠物": {"pet", "dog", "cat"},
    "美食": {"food"},
    "风景": {"landscape", "city", "nature", "beach", "flower", "night", "travel", "sport", "indoor"},
}

# 情绪标签 -> 中文氛围词
_MOODS = {
    "mood_fresh": "清新", "mood_vivid": "活力",
    "mood_vintage": "复古", "mood_calm": "静谧",
}


# ---------- 输入组装：把照片压成「文本化元数据」，不含原图 ----------

def _fmt_time(ts: Any) -> str:
    try:
        return datetime.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "未知时间"


def _subject_of(tags: list[str]) -> str:
    tset = {t.lower() for t in tags}
    for name, members in _SUBJECTS.items():
        if tset & members:
            return name
    return "其它"


def _mood_of(tags: list[str]) -> str:
    for t in tags:
        if t in _MOODS:
            return _MOODS[t]
    return ""


def build_photo_context(photos: list[dict]) -> str:
    """把每张照片拼成 `[pXX] meta: {...}` 文本块——只含标签+时间，隐私友好。"""
    lines: list[str] = []
    for i, p in enumerate(photos, 1):
        pid = f"p{i:02d}"
        meta = {
            "taken_at": _fmt_time(p.get("taken_at")),
            "tags": p.get("tags", []),
        }
        lines.append(f"[{pid}] meta: {json.dumps(meta, ensure_ascii=False)}")
    return "\n".join(lines)


# ---------- 真模型路径（可选，配了 key 才走） ----------

def _api_key() -> str | None:
    return os.environ.get("INSIGHT_API_KEY") or os.environ.get("OPENAI_API_KEY")


def llm_available() -> bool:
    return bool(_api_key())


def _load_system_prompt() -> str:
    try:
        with open(_PROMPT_PATH, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return "你是照片洞察引擎，从标签和时间里挖出用户没意识到的故事，输出严格 JSON。"


def _strip_fences(text: str) -> str:
    """去掉模型偶尔加的 ```json ... ``` 围栏。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _generate_llm(photos: list[dict]) -> dict:
    base = os.environ.get("INSIGHT_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("INSIGHT_MODEL", "gpt-4o-mini")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _load_system_prompt()},
            {"role": "user", "content": build_photo_context(photos)},
        ],
        "temperature": 0.9,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_api_key()}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    data = json.loads(_strip_fences(content))
    data["engine"] = "llm"
    data.setdefault("nodes", [])
    data.setdefault("connections", [])
    data.setdefault("storylines", [])
    data.setdefault("insights", [])
    return data


# ---------- 离线桩：用真实标签/EXIF 规则化产出，确定性、纯本地 ----------

def _distinct_event_days(items: list[dict]) -> int:
    """按「拍摄日期」去重，估算独立事件数（同一天多张算 1 个事件，满足反复硬规则）。"""
    days = set()
    for p in items:
        ts = p.get("taken_at")
        try:
            days.add(datetime.datetime.fromtimestamp(float(ts)).date())
        except Exception:
            pass
    return len(days)


def _span_label(photos: list[dict]) -> str:
    ts = [p.get("taken_at") for p in photos if p.get("taken_at")]
    if not ts:
        return ""
    try:
        lo = datetime.datetime.fromtimestamp(float(min(ts)))
        hi = datetime.datetime.fromtimestamp(float(max(ts)))
    except Exception:
        return ""
    if lo.strftime("%Y-%m") == hi.strftime("%Y-%m"):
        return lo.strftime("%Y年%m月")
    return f"{lo.strftime('%m月')}→{hi.strftime('%m月')}"


def _generate_stub(photos: list[dict]) -> dict:
    n = len(photos)
    ids = [f"p{i:02d}" for i in range(1, n + 1)]

    # Step1 nodes：逐图，用真实标签压出 summary + hidden_signal
    nodes = []
    by_subject: dict[str, list[int]] = {}
    for idx, p in enumerate(photos):
        tags = p.get("tags", [])
        subj = _subject_of(tags)
        mood = _mood_of(tags)
        by_subject.setdefault(subj, []).append(idx)
        desc = f"{subj}主题" + (f"·{mood}氛围" if mood else "")
        if "warm" in tags:
            desc += "·暖调"
        elif "cool" in tags:
            desc += "·冷调"
        nodes.append({
            "id": ids[idx],
            "summary": desc[:30],
            "hidden_signal": (f"反复出现的{subj}" if len(by_subject.get(subj, [])) > 1
                              else f"独一份的{subj}瞬间")[:30],
        })

    # Step2 connections：按主体聚合 + 时间聚合
    connections = []
    cn = 1
    for subj, members in by_subject.items():
        if len(members) >= 2:
            connections.append({
                "id": f"conn-{cn:02d}",
                "photos": [ids[i] for i in members[:6]],
                "type": "sameObject" if subj in ("美食", "宠物") else "activitySimilar",
                "narrative_hint": f"镜头一次次回到{subj}——不是随手，是这段时间真正在意的东西。",
            })
            cn += 1

    # Step3 storylines：挑「出现最多且跨≥3 天」的主体，织一条「唯一→反复」故事线
    storylines = []
    insights = []
    ranked = sorted(by_subject.items(), key=lambda kv: len(kv[1]), reverse=True)
    span = _span_label(photos)
    if ranked:
        subj, members = ranked[0]
        events = _distinct_event_days([photos[i] for i in members])
        if len(members) >= 3 and events >= 2:
            seq = [ids[i] for i in members[:5]]
            storylines.append({
                "id": "story-01",
                "thread": f"{subj}在这组照片里反复出现，跨了好几天",
                "arc": "唯一→反复",
                "photo_sequence": seq,
                "hidden_truth": f"最常被举起相机对准的，其实是{subj}",
            })
            # Step4 insight（心声腔）
            title_map = {
                "宠物": "最稳定的陪伴，原来是它",
                "美食": "镜头里最多的，是那一桌饭",
                "人物": "一直想留住的，是那些人",
                "风景": "原来一直在追的，是路上的光",
                "其它": "有个东西，一直在你镜头里",
            }
            kw_map = {"宠物": "PET", "美食": "FOOD", "人物": "PEOPLE", "风景": "SCENE", "其它": "MOTIF"}
            insights.append({
                "id": "ins-01",
                "from_storyline": "story-01",
                "kind": "recurrenceVsOnce",
                "keyword": kw_map.get(subj, "MOTIF"),
                "title": title_map.get(subj, "有个东西一直在你镜头里")[:20],
                "subtitle": (f"这段时间里，{subj}在你的照片里出现了 {len(members)} 次、跨了 {events} 天。"
                             f"别的都只是路过，只有它一次次被你举起相机对准。"),
                "time_anchor": span,
                "contrast_phrase": "唯一/反复",
                "takeaway": f"你最常拍的，是{subj}。",
                "photos": [
                    {"photo_id": ids[i],
                     "caption": f"{_subject_of(photos[i].get('tags', []))}·"
                                f"{_mood_of(photos[i].get('tags', [])) or '日常'}氛围，"
                                f"拍于{_fmt_time(photos[i].get('taken_at'))}"}
                    for i in members[:4]
                ],
                "self_score": {"confidence": 0.5, "surprise": 0.4, "specificity": 0.55},
            })

    return {
        "engine": "stub",
        "nodes": nodes,
        "connections": connections,
        "storylines": storylines,
        "insights": insights,
    }


# ---------- 对外入口 ----------

def generate(photos: list[dict], max_photos: int = 40) -> dict:
    """对一组照片产出洞察。配了大模型走真模型，否则走离线桩；真模型异常自动回退桩。"""
    photos = [p for p in (photos or []) if "junk" not in p.get("tags", [])][:max_photos]
    if not photos:
        return {"engine": "empty", "nodes": [], "connections": [], "storylines": [], "insights": []}
    if llm_available():
        try:
            return _generate_llm(photos)
        except Exception as e:  # 网络/额度/解析失败都安全回退，不让端点 500
            fallback = _generate_stub(photos)
            fallback["engine"] = "stub_fallback"
            fallback["llm_error"] = str(e)[:200]
            return fallback
    return _generate_stub(photos)

"""Full-library memory proposals and a small, diverse local recommendation feed."""
from __future__ import annotations

import datetime as dt
import math
import os
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from .core import ROOT, TZ, LabError, atomic_json, digest, file_hash, read_json
from .collections import prepare_candidates, date_span
from .ente import latest_result
from .memories import combined_content, recalled, dated
from .memory_experiment import deduplicate, chronological, quality
from .stories import load_evidence, person_pools, trip_pools, infer_base, day, cosine, unit, CITY_LABELS

VERSION = "recollection-feed-v1"
RULES = {"minimum_photos":12,"maximum_photos":24,"featured_count":4,
         "text_only_min":.245,"text_margin":.025,"vision_min":.5,
         "album_containment":.65,"recent_days":7}
TOPICS = {
    "art": {"title":"光影中的艺术", "label":"艺术与展品", "prompts":["a photograph of paintings and artwork in an art gallery or museum", "a photograph of sculptures and art exhibits"], "labels":["art","painting","sculpture"], "theme":None},
    "pets": {"title":"毛茸茸的日常", "label":"宠物时光", "prompts":["a photograph of a pet cat or dog at home", "a photograph of a cute cat playing or resting"], "labels":["cat","dog","feline","canine"], "theme":"pet"},
    "table": {"title":"餐桌上的好时光", "label":"餐桌记忆", "prompts":["a photograph of delicious food and dishes on a dining table", "a photograph of a meal at a restaurant"], "labels":["food"], "theme":"food"},
    "outdoors": {"title":"走进山野与天空", "label":"自然风景", "prompts":["a photograph of mountains forests lakes and beautiful natural scenery", "a photograph of the sea and sky outdoors"], "labels":["landscape","mountain","lake","ocean","forest"], "theme":None},
    "stage": {"title":"舞台亮起的时候", "label":"演出片段", "prompts":["a photograph of a live concert or theater performance on stage", "a photograph of performers on stage with stage lighting"], "labels":["performance","entertainer"], "theme":"stage"},
}
NEGATIVES = ["a screenshot of a phone application interface", "a photograph of a receipt document or page of text", "a photograph of an ordinary indoor room and furniture"]
TOPIC_NEGATIVES = {
    "art":["a photograph of a person posing for a portrait outdoors", "a photograph of a bouquet or flower arrangement", "a photograph of clothing and accessories displayed for sale"],
    "pets":["a photograph of animal figurines toys and souvenirs on a shelf", "a printed illustration of a cat on a poster or product"],
    "table":["a photograph of wild mushrooms growing in a forest", "a photograph of plants and leaves growing outdoors"],
}


def text_features(lab, models):
    prompts=[p for t in TOPICS.values() for p in t["prompts"]]+NEGATIVES+[p for qs in TOPIC_NEGATIVES.values() for p in qs]
    runtime_path=ROOT/"outputs/selection-lab/ente/runtime.json"
    runtime=read_json(runtime_path,{})
    binary=ROOT/"outputs/selection-lab/engines/ente-upstream/rust/target/debug/examples/photo_wall_lab"
    if runtime.get("model_sha256") != models or not binary.is_file():
        raise LabError("当前 Ente 文本模型与图片缓存不匹配")
    identity={"models":models,"prompts":prompts,"binary":file_hash(binary)}
    path=lab.state_dir/"recollections/text-features.json"
    cached=read_json(path,{})
    if cached.get("identity")==identity:
        return {p:unit(cached["vectors"][p],512) for p in prompts},digest(cached)
    for key in ("clip_text","clip_text_vocab","clip_image"):
        if file_hash(Path(runtime["models"][key])) != models[key]:
            raise LabError("Ente 模型文件已变化")
    if file_hash(Path(runtime["ort_library"])) != runtime["ort_sha256"]:
        raise LabError("本地推理运行库校验失败")
    import json
    process=subprocess.run([str(binary),str(runtime_path)],
        input="".join(json.dumps({"text":p})+"\n" for p in prompts),text=True,capture_output=True,
        env={**os.environ,"ORT_DYLIB_PATH":runtime["ort_library"]},timeout=90)
    if process.returncode:
        raise LabError("本地主题文本编码未完成；没有生成替代向量")
    values=[json.loads(line) for line in process.stdout.splitlines() if line.strip()]
    if [v.get("text") for v in values] != prompts:
        raise LabError("主题文本编码结果不完整")
    vectors={p:list(unit(v["embedding"],512)) for p,v in zip(prompts,values)}
    cached={"identity":identity,"vectors":vectors}
    atomic_json(path,cached)
    return vectors,digest(cached)


def theme_pools(photos,evidence,index,texts):
    result=[]
    for key,topic in TOPICS.items():
        accepted=[];supports={}
        for p in photos:
            v=evidence["vectors"][p["id"]]
            score=max(cosine(v,texts[q]) for q in topic["prompts"])
            negative=max(cosine(v,texts[q]) for q in NEGATIVES)
            competing=max((cosine(v,texts[q]) for q in TOPIC_NEGATIVES.get(key,[])),default=-1)
            if competing>=score:continue
            labels={x["identifier"]:x["confidence"] for x in index["assets"][p["id"]].get("labels",[])}
            vision=max((labels.get(k,0) for k in topic["labels"]),default=0)
            prior=bool(topic["theme"] and topic["theme"] in p["album_themes"])
            # Qualified existing detectors supply positive evidence independently;
            # cosine is not a probability and varies substantially by topic.
            if ((vision>=RULES["vision_min"] or prior) and score>negative) or (score>=RULES["text_only_min"] and score-negative>=RULES["text_margin"]):
                accepted.append(p);supports[p["id"]]={"text_similarity":round(score,4),"vision_supported":vision>=RULES["vision_min"],"existing_theme_supported":prior}
        years=defaultdict(list)
        for p in accepted:years[day(p).year if dated(p) else None].append(p)
        substantial=[y for y,ps in years.items() if y is not None and len(ps)>=RULES["minimum_photos"]]
        # Do not turn a small recurring theme into multiple thin yearly albums.
        partitions=[(y,years[y]) for y in sorted(substantial,reverse=True)] if len(substantial)>=2 else [(None,accepted)]
        for year,ps in partitions:
            if len(ps)<RULES["minimum_photos"]:continue
            if year is not None and len({day(p) for p in ps})<2:continue
            result.append({"id":"recollection-"+digest([key,year,sorted(p["id"] for p in ps)])[:16],
                "kind":"theme","topic":key,"title":topic["title"],"label":topic["label"],"year":year,"pool":ps,
                "supports":{p["id"]:supports[p["id"]] for p in ps},
                "description":"从完整图库寻找同一内容主题，跨日期串联。主题相似不代表同一次活动，也不代表同一人物或宠物。"})
    return result


def select_photos(group,evidence,memberships):
    available,removed=deduplicate(group["pool"],evidence,memberships)
    if len(available)<RULES["minimum_photos"]:return None
    remaining=list(available);selected=[]
    while remaining and len(selected)<RULES["maximum_photos"]:
        dates=Counter(day(p).isoformat() if dated(p) else "unknown" for p in selected)
        def score(p):
            similar=max((cosine(evidence["vectors"][p["id"]],evidence["vectors"][q["id"]]) for q in selected),default=0)
            repeat=dates[day(p).isoformat() if dated(p) else "unknown"]
            return (quality(p)-.35*similar-.035*min(repeat,4),p["id"])
        chosen=max(remaining,key=score);selected.append(chosen);remaining.remove(chosen)
    selected.sort(key=chronological)
    known=[p for p in selected if dated(p)];unknown=len(selected)-len(known)
    period=date_span(known) if known else "拍摄日期待补"
    if unknown and known:period+=f" · 另 {unknown} 张日期待补"
    cover=max(selected,key=lambda p:(.65*p.get("aesthetic",0)+.35*p.get("quality",0),p["id"]))
    public={k:v for k,v in group.items() if k not in {"pool"}}
    public.update(photo_ids=[p["id"] for p in selected],cover=cover["id"],subtitle=period,
                  candidate_count=len(group["pool"]),available_count=len(available),removed=removed,
                  selected_dates=len({day(p) for p in known}),unknown_dates=unknown,
                  quality_score=round(sum(quality(p) for p in selected)/len(selected),5))
    return public


def feedback(lab):
    value=read_json(lab.state_dir/"recollections/feedback.json",{})
    return value if value.get("dataset_id")==lab.dataset_id else {"dataset_id":lab.dataset_id,"albums":{}}


def recommend(albums,preferences,now):
    remaining=[a for a in albums if not preferences.get(a["id"],{}).get("hidden")]
    selected=[];used=set();topics=set()
    while remaining and len(selected)<RULES["featured_count"]:
        viable=[]
        for a in remaining:
            ids=set(a["photo_ids"])
            if a["topic"] in topics:continue
            if any(len(ids&set(b["photo_ids"]))/min(len(ids),len(b["photo_ids"]))>=RULES["album_containment"] for b in selected):continue
            viable.append(a)
        if not viable:break
        def score(a):
            ids=set(a["photo_ids"]);pref=preferences.get(a["id"],{})
            seen=pref.get("seen_at")
            recent=bool(seen and 0<=now-dt.datetime.fromisoformat(seen).timestamp()<RULES["recent_days"]*86400)
            trip_bonus=.15 if a["kind"]=="trip" and not any(b["kind"]=="trip" for b in selected) else 0
            return (a["quality_score"]+.25*len(ids-used)/len(ids)+.12*min(len(ids)/24,1)+trip_bonus
                    +.2*bool(pref.get("favorite"))-.3*recent,a["id"])
        best=max(viable,key=score);selected.append(best);remaining.remove(best)
        used.update(best["photo_ids"]);topics.add(best["topic"])
    return [a["id"] for a in selected]


def build_feed(lab):
    record=latest_result(lab)
    if not record:raise LabError("请先完成本批 Ente 识别")
    content=combined_content(lab,record)
    config,photos,excluded,dates,index,vision_revision=prepare_candidates(lab,{},content=content)
    evidence=load_evidence(lab,record)
    texts,text_revision=text_features(lab,evidence["models"])
    _,memberships,_=person_pools(photos,evidence,record["result"]["ente_diagnostics"]["person_groups"])
    proposals=theme_pools(photos,evidence,index,texts)
    base=infer_base(photos,evidence["locations"])
    for seed in trip_pools(photos,evidence)[0]:
        ps=recalled(seed,photos,evidence,"trip",base_position=base["position"] if base else None)
        if len(ps)<RULES["minimum_photos"]:continue
        cities=Counter(evidence["cities"][p["id"]] for p in seed["pool"] if p["id"] in evidence["cities"])
        place="与".join(CITY_LABELS[c] for c,_ in cities.most_common(2) if c in CITY_LABELS)
        proposals.append({"id":"recollection-"+digest([seed["id"],sorted(p["id"] for p in ps)])[:16],
            "kind":"trip","topic":"trip","title":f"{place}的远行" if place else "远行的日子",
            "label":"旅途片段","pool":ps,"year":None,"supports":{},
            "anchor_count":len(seed["pool"]),"trip_confirmed":False,
            "description":"按已有出行段串联多日照片，并从完整图库补充有时间与地点／内容依据的画面。行程由照片推测，尚未人工确认。"})
    albums=[a for g in proposals if (a:=select_photos(g,evidence,memberships))]
    albums.sort(key=lambda a:(-len(a["photo_ids"]),a["id"]))
    ids={i for a in albums for i in a["photo_ids"]}
    provenance={"dataset_id":lab.dataset_id,"version":VERSION,"rules":RULES,"topics":TOPICS,"topic_negatives":TOPIC_NEGATIVES,
        "ente_snapshot":record["id"],"models":evidence["models"],"text_revision":text_revision,
        "evidence_revision":evidence["revision"],"feature_revision":lab.feature_revision,"vision_revision":vision_revision,
        "code_revision":file_hash(Path(__file__)),"dependencies":{n:file_hash(Path(__file__).with_name(n)) for n in ["memory_experiment.py","memories.py","stories.py","collections.py","hybrid.py"]},
        "note":"复用本地图片缓存，新增主题文本向量编码；非生成式视觉大模型推理。分组和排序仍为待校准规则。"}
    result={"id":digest({"provenance":provenance,"albums":albums})[:24],"engine":VERSION,"albums":albums,
        "photos":[lab.public_photo(p) for p in photos if p["id"] in ids],"provenance":provenance,
        "diagnostics":{"input_count":len(lab.features),"eligible_count":len(photos),"excluded":excluded,
            "date_sources":dates,"proposal_count":len(proposals),"substantial_albums":len(albums)}}
    with lab.lock:
        path=lab.state_dir/"recollections"/(result["id"]+".json")
        if not path.exists():atomic_json(path,result)
        atomic_json(lab.state_dir/"recollections/latest.json",{"id":result["id"],"dataset_id":lab.dataset_id})
    return result


def get_feed(lab):
    pointer=read_json(lab.state_dir/"recollections/latest.json",{})
    if pointer.get("dataset_id")!=lab.dataset_id:return None
    import re
    if not re.fullmatch(r"[a-f0-9]{24}",pointer.get("id","")):raise LabError("回忆快照标识无效")
    result=read_json(lab.state_dir/"recollections"/(pointer["id"]+".json"))
    if not result or result["provenance"]["dataset_id"]!=lab.dataset_id:raise LabError("回忆快照与当前相簿不符")
    prefs=feedback(lab)
    return {**result,"featured_ids":recommend(result["albums"],prefs["albums"],dt.datetime.now(TZ).timestamp()),"feedback":prefs["albums"]}


def update_feedback(lab,data):
    result=get_feed(lab);album_id=data.get("album_id");action=data.get("action")
    if not result or album_id not in {a["id"] for a in result["albums"]}:raise LabError("回忆不存在")
    if action not in {"seen","favorite","unfavorite","hide","restore"}:raise LabError("未知的偏好操作")
    with lab.lock:
        prefs=feedback(lab);value=prefs["albums"].setdefault(album_id,{})
        if action=="seen":value["seen_at"]=dt.datetime.now(TZ).isoformat()
        if action in {"favorite","unfavorite"}:value["favorite"]=action=="favorite"
        if action in {"hide","restore"}:value["hidden"]=action=="hide"
        atomic_json(lab.state_dir/"recollections/feedback.json",prefs)
    return value

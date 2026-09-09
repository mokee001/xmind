"""Run pinned Ente Rust ML and Dart Memories locally on the lab's whole dataset.

No app account, uploads, or replacement ML/selection implementations. Source dates
use the existing lab's explicit filename-date policy; that has day precision.
"""
from __future__ import annotations
import datetime as dt
import argparse
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from selection_lab.core import Lab, TZ, atomic_json, file_hash, digest, read_json
from selection_lab.collections import sample_date
from selection_lab.ente import recognition_result, people_result
from prepare_ente_lab import COMMIT, STATE, ENGINE, UPSTREAM
from selection_lab.datasets import paths

MODEL_STATE = STATE
ACTIVE_DATASET_ID = None


def note(stage, message, state="running"):
    atomic_json(STATE / "ente/status.json", {"dataset_id":ACTIVE_DATASET_ID,"state":state,
        "stage":stage,"message":message,"commit":COMMIT,"updated_at":dt.datetime.now(TZ).isoformat()})
    print(stage+": "+message,flush=True)


def rebase_cached_ml(value, file_id):
    """Inference is reusable by asset; upstream face IDs embed dataset-local IDs."""
    result=copy.deepcopy(value)
    prefix=str(result["id"])+"_"
    for face in result.get("faces",[]):
        if not face["face_id"].startswith(prefix):
            raise RuntimeError("缓存人脸 ID 与照片 ID 不一致")
        face["face_id"]=str(file_id)+"_"+face["face_id"][len(prefix):]
    result["id"]=file_id
    return result


def install_harness():
    source=UPSTREAM / "mobile/apps/photos/lib/services/smart_memories_service.dart"
    original=subprocess.check_output(["git","show",f"{COMMIT}:mobile/apps/photos/lib/services/smart_memories_service.dart"],cwd=UPSTREAM,text=True)
    hook="part 'photo_wall_lab_bridge.dart';\n"
    marker='part "smart_memories_clip_calculator.dart";'
    expected=original.replace(marker,hook+marker)
    if source.read_text() not in (original,expected):
        raise RuntimeError("Ente 回忆源码发生未认可修改，拒绝冒充固定版本")
    source.write_text(expected)
    shutil.copyfile(ROOT / "tools/ente_memories_bridge.dart",source.parent / "photo_wall_lab_bridge.dart")
    shutil.copyfile(ROOT / "tools/ente_memories_test.dart",UPSTREAM / "mobile/apps/photos/test/photo_wall_lab_test.dart")
    # Generated bindings may differ; actual recognition/selection code must not.
    guarded=["rust/crates/ml/src", "rust/crates/location/src", "mobile/apps/photos/lib/models/memories",
        "mobile/apps/photos/lib/models/ml", "mobile/apps/photos/lib/services/memories",
        "mobile/apps/photos/lib/services/machine_learning", "mobile/apps/photos/lib/services/smart_memories*.dart"]
    changed=subprocess.check_output(["git","diff","--name-only",COMMIT,"--",*guarded],cwd=UPSTREAM,text=True).splitlines()
    if set(changed)-{"mobile/apps/photos/lib/services/smart_memories_service.dart"}:
        raise RuntimeError("原版识别或选片代码发生修改；请改为独立实验引擎，不得标记原版")


def read_queries():
    service=(UPSTREAM / "mobile/apps/photos/lib/services/smart_memories_service.dart").read_text()
    positive=re.search(r'"Photo of a precious and nostalgic memory[^"\n]+"',service)
    if not positive:
        raise RuntimeError("找不到固定版本的回忆评分提示词")
    queries=[json.loads(positive[0])]
    for name,enum,count in [("clip_memory.dart","ClipMemoryType",48),("people_memory.dart","PeopleActivity",10)]:
        source=(UPSTREAM / "mobile/apps/photos/lib/models/memories" / name).read_text()
        values=re.findall(r'case '+enum+r'\.\w+:\s*return\s*"([^"\n]+)";',source)
        if len(values)!=count:
            raise RuntimeError("原版提示词枚举变化，需要更新适配器")
        queries.extend(values)
    return queries


def gps_from(path):
    with Image.open(path) as image:
        gps=image.getexif().get_ifd(34853)
    try:
        def angle(values):
            return float(values[0])+float(values[1])/60+float(values[2])/3600
        lat=angle(gps[2])*(-1 if gps[1] in ("S",b"S") else 1)
        lon=angle(gps[4])*(-1 if gps[3] in ("W",b"W") else 1)
        return {"latitude":lat,"longitude":lon}
    except (KeyError,TypeError,ValueError,ZeroDivisionError):
        return {}


def main():
    global STATE, ACTIVE_DATASET_ID
    parser=argparse.ArgumentParser()
    parser.add_argument("--cache-dir",type=Path)
    parser.add_argument("--state-dir",type=Path)
    parser.add_argument("--historical",type=Path)
    args=parser.parse_args()
    lab=Lab(*paths(args.cache_dir,args.state_dir,args.historical))
    STATE=lab.state_dir
    ACTIVE_DATASET_ID=lab.dataset_id
    lab.ensure_sources_current()
    runtime=read_json(MODEL_STATE / "ente/runtime.json")
    if not runtime or runtime["commit"]!=COMMIT:
        raise RuntimeError("先完成 prepare_ente_lab.py")
    if subprocess.check_output(["git","rev-parse","HEAD"],cwd=UPSTREAM,text=True).strip()!=COMMIT:
        raise RuntimeError("源码版本不匹配")
    for key,path in runtime["models"].items():
        if file_hash(Path(path))!=runtime["model_sha256"][key]:
            raise RuntimeError("模型哈希不匹配："+key)
    if file_hash(Path(runtime["ort_library"]))!=runtime["ort_sha256"]:
        raise RuntimeError("运行库哈希不匹配")
    install_harness()
    queries=read_queries()
    binary=UPSTREAM / "rust/target/debug/examples/photo_wall_lab"
    env={**os.environ,"ORT_DYLIB_PATH":runtime["ort_library"],"CI":"true","FLUTTER_SUPPRESS_ANALYTICS":"true",
        "PUB_CACHE":str(ENGINE / "pub-cache"),"CARGO_HOME":str(ENGINE / "cargo"),"RUSTUP_HOME":str(ENGINE / "rustup"),
        "PATH":str(ENGINE / "flutter-sdk/bin")+os.pathsep+str(ENGINE / "cargo/bin")+os.pathsep+os.environ["PATH"]}
    identity={"dataset":lab.dataset_id,"commit":COMMIT,"models":runtime["model_sha256"],"harness":file_hash(ROOT / "tools/ente_ml_probe.rs")}
    cache_path=STATE / "ente/ml-index.json"
    cached=read_json(cache_path,{})
    if cached.get("identity")!=identity:
        cached={"identity":identity,"photos":{},"texts":{}}
    previous=read_json(MODEL_STATE / "ente/ml-index.json",{})
    compatible=lambda key:{k:v for k,v in key.items() if k!="dataset"}
    if compatible(previous.get("identity",{}))==compatible(identity):
        for photo in lab.features:
            value=previous.get("photos",{}).get(photo["id"])
            if value:
                cached["photos"].setdefault(photo["id"],value)
        for query,value in previous.get("texts",{}).items():
            cached["texts"].setdefault(query,value)
    # Read-only local inference; the Rust harness has no networking path.
    with subprocess.Popen([str(binary),str(MODEL_STATE / "ente/runtime.json")],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env,bufsize=1) as process:
        def request(payload):
            process.stdin.write(json.dumps(payload)+"\n");process.stdin.flush()
            line=process.stdout.readline()
            if not line:
                raise RuntimeError("Ente ML 未返回结果，检查本机执行日志")
            return json.loads(line)
        ordered=sorted(lab.features,key=lambda p:p["id"])
        for index,photo in enumerate(ordered,1):
            key=photo["id"]
            if key not in cached["photos"]:
                note("Ente 正在识别照片",f"{index} / {len(ordered)} · 人脸与内容识别均在本机。")
                value=request({"id":index,"path":photo["path"]})
                if len(value.get("embedding",[]))!=512:
                    raise RuntimeError("Ente 未提供有效图片向量")
                cached["photos"][key]=value
                atomic_json(cache_path,cached)
            cached["photos"][key]=rebase_cached_ml(cached["photos"][key],index)
        for index,query in enumerate(queries,1):
            if query not in cached["texts"]:
                value=request({"text":query})
                if len(value.get("embedding",[]))!=512:
                    raise RuntimeError("Ente 未提供有效文本向量")
                cached["texts"][query]=value["embedding"]
                atomic_json(cache_path,cached)
        items=[]
        for photo in ordered:
            timestamp,date_source=sample_date(photo)
            items.append({**cached["photos"][photo["id"]],"sha256":photo["sha256"],"filename":photo["filename"],
                "creation_time":int(timestamp*1_000_000) if timestamp is not None else None,"date_source":date_source,**gps_from(photo["path"])})
        located=[p for p in items if "latitude" in p]
        if located:
            cities=request({"coordinates":[[p["latitude"],p["longitude"]] for p in located]})["cities"]
            for city in cities:
                for index in city["indices"]:
                    located[index]["city"]={k:v for k,v in city.items() if k!="indices"}
        process.stdin.close()
        if process.wait(timeout=30)!=0:
            raise RuntimeError("Ente ML 进程异常退出")
    atomic_json(cache_path,cached)
    now=dt.datetime.now(TZ).isoformat()
    input_path=STATE / "ente/memories-input.json"
    output_path=STATE / "ente/memories-output.json"
    atomic_json(input_path,{"photos":items,"texts":cached["texts"],"positive_query":queries[0],"as_of":now})
    env.update(ENTE_LAB_INPUT=str(input_path),ENTE_LAB_OUTPUT=str(output_path))
    note("Ente 正在生成回忆","使用原版人脸聚类和回忆规则，分别记录自然展示与调试候选。")
    log_path=STATE / "ente/flutter-test.log"
    with log_path.open("w") as log:
        os.chmod(log_path,0o600)
        completed=subprocess.run([str(ENGINE / "flutter-sdk/bin/flutter"),"test","--no-pub","test/photo_wall_lab_test.dart"],cwd=UPSTREAM / "mobile/apps/photos",env=env,stdout=log,stderr=subprocess.STDOUT,timeout=900)
    if completed.returncode:
        print("\n".join(log_path.read_text().splitlines()[-35:]))
        raise RuntimeError("Ente 回忆测试未通过；详情保留在本地 flutter-test.log")
    os.chmod(output_path,0o600)
    output=read_json(output_path)
    lab.ensure_sources_current()
    for mode,value in output.items():
        export={"schema_version":1,"engine":"ente","dataset_id":lab.dataset_id,
            "provenance":{"commit":COMMIT,"app_version":"1.3.64+2158 source replay","platform":"macos-rust-ml+flutter-test",
                "generated_at":now,"model":"Ente YOLOv5-face + MobileFaceNet + MobileCLIP-S2; hashes in local runtime.json",
                "exporter_version":"photo-wall-ente-v1","mode":mode,
                "date_policy":"shared lab dates: legacy filename day / EXIF original / fxn filename; undated excluded from Memories, kept for recognition",
                "execution":"upstream algorithms via local harness; not full mobile app; no Photos DB/history"},"memories":value["memories"]}
        atomic_json(STATE / "ente" / (mode+".json"),export)
        imported=lab.import_ente(export)
        imported["ente_diagnostics"]=value.get("diagnostics",{})
        imported["ente_recognition"]=recognition_result(lab,value["diagnostics"])
        imported["ente_people"]=people_result(lab,value["diagnostics"])
        imported["engine_label"]="Ente · 源码本机实跑"
        imported["warnings"]=["原版 Rust ML + Dart 人脸聚类/回忆计算，本机测试入口运行，不是完整手机 App 运行。",
            "沿用实验台日期：七月样本为文件名日期，新相簿优先 EXIF、其次明确文件名时间；未知日期仍识别，但不进入原版回忆计算。",
            "原版分组/顺序保留，未套用本项目照片-only和画质过滤；可能包含非拍照图片。",
            "无账号命名、已看历史或编辑反馈。自然为空时不补成自定义相册；调试候选另存。"]
        label="自然结果" if mode=="natural" else "调试候选（非自然展示）"
        record=lab.save_run(imported,"Ente · "+label)
        if mode=="natural":
            atomic_json(STATE / "ente/latest.json",{"dataset_id":lab.dataset_id,"run_id":record["id"]})
    note("Ente 本机实跑完成",f"自然结果 {len(output['natural']['memories'])} 组；调试候选 {len(output['debug_all_candidates']['memories'])} 组。两者分别保存。","complete")


if __name__=="__main__":
    try:
        main()
    except Exception:
        note("Ente 运行未完成","本次未成功生成新结果，保留现有方案和以前的独立快照。","failed")
        raise

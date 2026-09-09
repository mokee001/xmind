"""Prepare pinned Ente ML assets locally. Downloads code/models, never photos."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import Lab, TZ, atomic_json
import datetime as dt

COMMIT = "7dc875ce12c781733b289cd27bbb0f3a99675aa2"
STATE = ROOT / "outputs/selection-lab"
ENGINE = STATE / "engines"
UPSTREAM = ENGINE / "ente-upstream"
_dataset_id = None


def note(stage, message, state="running"):
    global _dataset_id
    if _dataset_id is None:
        _dataset_id = Lab(ROOT / "outputs/immich-comparison", STATE).dataset_id
    atomic_json(STATE / "ente/status.json", {"dataset_id":_dataset_id, "state":state,
        "stage":stage, "message":message, "commit":COMMIT, "updated_at":dt.datetime.now(TZ).isoformat()})
    print(stage + ": " + message, flush=True)


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(spec, name):
    destination = STATE / "ente/assets" / name
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists() and sha(destination) == spec["sha256"]:
        return str(destination)
    partial = destination.with_suffix(destination.suffix + ".part")
    subprocess.run(["curl", "--http1.1", "--fail", "--location", "--silent", "--show-error",
        "--retry", "3", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "180",
        "--continue-at", "-", "--output", str(partial), spec["url"]], check=True)
    if sha(partial) != spec["sha256"]:
        raise RuntimeError("下载校验失败：" + name)
    partial.replace(destination)
    print("校验完成：" + name, flush=True)
    return str(destination)


def main():
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip()
    if actual != COMMIT:
        raise RuntimeError("Ente 源码版本不匹配，不使用未知版本")
    note("准备 Ente 模型", "下载并校验原版模型；照片仍只在本机。")
    assets = json.loads((UPSTREAM / "infra/ml/test/ml_indexing/assets.json").read_text())
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {key:pool.submit(download, value, value["file_name"]) for key,value in assets["models"].items()}
        models = {key:future.result() for key,future in futures.items()}
    runtime = assets["onnx_runtime"]["archives"]["aarch64-apple-darwin"]
    archive = Path(download(runtime, "onnxruntime.tar.gz"))
    library = archive.parent / "libonnxruntime.1.28.1.dylib"
    if not library.exists() or sha(library) != runtime["library_sha256"]:
        with tarfile.open(archive) as tar:
            member = tar.getmember(runtime["library_path"])
            if not member.isfile():
                raise RuntimeError("运行库不是常规文件")
            with tar.extractfile(member) as source, library.open("wb") as target:
                shutil.copyfileobj(source, target)
        if sha(library) != runtime["library_sha256"]:
            raise RuntimeError("运行库校验失败")
    atomic_json(STATE / "ente/runtime.json", {"commit":COMMIT, "models":models,
        "model_sha256":{key:spec["sha256"] for key,spec in assets["models"].items()},
        "ort_library":str(library), "ort_sha256":runtime["library_sha256"]})
    runtime_config=json.loads((STATE / "ente/runtime.json").read_text())
    for key,name,expected in [("cities","cities.bin","898dca892a71fd601ae8e75e5c55fd6d4591e4c98de335d9b33e7f076aa668f5"),
                              ("urban","urban-centres.bin","e981b0383e6502ede56b52d5be96cda66f53d7352492e677d8978467c106dab0")]:
        runtime_config[key]=download({"url":"https://assets.ente.com/location/v2/"+name,"sha256":expected},name)
    atomic_json(STATE / "ente/runtime.json",runtime_config)
    example = UPSTREAM / "rust/crates/ml/examples/photo_wall_lab.rs"
    example.parent.mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "tools/ente_ml_probe.rs", example)
    manifest=UPSTREAM / "rust/crates/ml/Cargo.toml"
    content=manifest.read_text()
    if "[dev-dependencies]\nente-location.workspace = true\n" not in content:
        content=content.replace("[dev-dependencies]\n","[dev-dependencies]\nente-location.workspace = true\n")
        manifest.write_text(content)
    note("编译 Ente 识别模块", "运行原版 Rust 识别代码，未使用现有 Vision 或 Immich 向量替代。")
    env = {**os.environ, "CARGO_HOME":str(ENGINE / "cargo"), "RUSTUP_HOME":str(ENGINE / "rustup"),
        "PATH":str(ENGINE / "cargo/bin") + os.pathsep + os.environ["PATH"]}
    subprocess.run([str(ENGINE / "cargo/bin/cargo"), "build", "-p", "ente-ml",
        "--example", "photo_wall_lab"], cwd=UPSTREAM / "rust", env=env, check=True)
    note("识别模块就绪", "Ente 模型及识别程序已就绪，下一步建立本批照片的独立索引。", "prepared")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        note("准备未完成", "模型下载或构建失败，尚未产生 Ente 相册。", "failed")
        raise

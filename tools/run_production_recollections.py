#!/usr/bin/env python3
"""Run real baseline inference for one immutable, account-scoped upload job.

Execution takes place with the frozen runtime first on sys.path. The legacy
working-tree deduplicator and local sample library are never imported as input.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import runpy
import fcntl


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--scope', required=True)
    args = parser.parse_args()
    runtime, job = args.runtime.resolve(), args.job.resolve()
    # Serialize even across API restarts: Flutter's generated harness is shared.
    # Acquire before loading models, so queued jobs consume minimal memory.
    runtime_lock = (runtime/'.production-inference.lock').open('a')
    fcntl.flock(runtime_lock, fcntl.LOCK_EX)
    sys.path.insert(0, str(runtime))
    verifier = runpy.run_path(str(Path(__file__).with_name('verify_recollection_baseline.py')))
    verify, BASELINE_COMMIT = verifier['verify'], verifier['BASELINE_COMMIT']
    report = verify(runtime, models=True)
    if not report['ok']:
        raise RuntimeError(json.dumps(report, ensure_ascii=False))
    # The baseline data-import procedure explicitly uses real YOLO, never its
    # historical demo fallback. Keep that same adapter here.
    model = Path(os.environ.get('PHOTOWALL_YOLO_MODEL', runtime/'yolov8s.pt'))
    if not model.is_file():
        raise RuntimeError('Required YOLOv8s model absent; no smaller-model fallback')
    if hashlib.sha256(model.read_bytes()).hexdigest() != '1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a':
        raise RuntimeError('YOLOv8s checksum mismatch; inference stopped')
    os.environ['PHOTOWALL_YOLO_MODEL'] = str(model)
    os.environ['PHOTOWALL_TAGGER'] = 'yolo'
    from backend import tagger, real_tagger
    from ultralytics import YOLO
    real_tagger._model = YOLO(str(model))
    tagger._detect_semantic = real_tagger.detect
    from selection_lab.core import Lab, atomic_json, file_hash
    from selection_lab.recollection_feed import build_feed
    from tools.add_lab_photos import capture_date
    source = json.loads((job/'input.json').read_text())
    if source['scope'] != args.scope:
        raise RuntimeError('Input owner mismatch')
    cache, state = job/'cache', job/'state'
    cache.mkdir(exist_ok=True)
    state.mkdir(exist_ok=True)
    tagged = {}
    by_path = {}
    feature_cache = job.parents[1]/'base-features.json'
    old_features = json.loads(feature_cache.read_text()) if feature_cache.exists() else {}
    feature_version = hashlib.sha256((runtime/'backend/tagger.py').read_bytes() + model.read_bytes()).hexdigest()
    for sha, item in source['photos'].items():
        path = Path(item['path']).resolve()
        if job.parents[1] not in path.parents or file_hash(path) != sha:
            raise RuntimeError('Source path/hash mismatch')
        if item.get('local_engine') != 'apple-vision-local-v1' or not item.get('vision'):
            raise RuntimeError('Missing real on-device evidence; no substituted labels')
        saved = old_features.get(sha, {})
        value = dict(saved['value']) if saved.get('version') == feature_version else tagger.tag_photo(str(path))
        if value.get('mock') or value.get('semantic_mode') == 'mock':
            raise RuntimeError('Mock recognition forbidden')
        stamp = path.stat()
        value['_stamp'] = f'{stamp.st_size}:{stamp.st_mtime_ns}:production-recollection-input'
        # EXIF/filename policy is unchanged. Never invent dates from upload time.
        value['taken_at'], value['date_source'] = capture_date(path)
        value['sha256'] = sha
        old_features[sha] = {'version':feature_version,'value':value}
        tagged[str(path)] = value
        by_path[str(path)] = item
    atomic_json(feature_cache, old_features)
    atomic_json(cache/'current-cache.json', tagged)
    atomic_json(cache/'dataset.json', {'name':'Account upload candidates', 'scope':args.scope})
    lab = Lab(cache, state)
    observations = {}
    for photo in lab.features:
        vision = by_path[photo['path']]['vision']
        if vision.get('error'):
            raise RuntimeError('On-device Vision observation failed')
        observations[photo['id']] = {**vision, 'id':photo['id'], 'sha256':photo['sha256']}
    atomic_json(state/'album-features.json', {'dataset_id':lab.dataset_id,
                'extractor':{'engine':'Apple Vision on iOS', 'classification_revision':1,
                             'face_detection_revision':3, 'human_detection_revision':2,
                             'preprocess':'classification-640-face-human-1600-oriented'}, 'assets':observations})
    # The initial wall needs neither an invented theme nor a relaxed album size.
    # Apply the same negative content checks before making provisional candidates.
    from selection_lab.collections import prepare_candidates
    _, eligible, _, _, _, _ = prepare_candidates(lab, {})
    from backend import dedup
    eligible, _ = dedup.deduplicate(eligible)
    common = {'scope':args.scope, 'input_revision':source['revision'], 'baseline_commit':BASELINE_COMMIT}
    atomic_json(job/'provisional.json', {**common, 'engine':'strong-rules-provisional-v1',
                                       'albums':[], 'photos':eligible})
    model_runtime = json.loads((runtime/'outputs/selection-lab/ente/runtime.json').read_text())
    ml_cache = job.parents[1]/'ml-features.json'
    cached = json.loads(ml_cache.read_text()) if ml_cache.exists() else {}
    identity = {'dataset':lab.dataset_id, 'commit':model_runtime['commit'],
                'models':model_runtime['model_sha256'], 'harness':file_hash(runtime/'tools/ente_ml_probe.rs')}
    comparable = lambda value:{k:v for k,v in value.items() if k!='dataset'}
    if comparable(cached.get('identity',{})) == comparable(identity):
        allowed = {p['id'] for p in lab.features}
        atomic_json(state/'ente/ml-index.json', {**cached,'identity':identity,
                    'photos':{k:v for k,v in cached.get('photos',{}).items() if k in allowed}})
    # This runs the pinned Rust ML + upstream Dart recognition harness, NOT any
    # previous export. Each input job has its own caches, history and result path.
    subprocess.run([sys.executable, str(runtime/'tools/run_ente_lab.py'),
                    '--cache-dir', str(cache), '--state-dir', str(state)], cwd=runtime, check=True, timeout=3000)
    atomic_json(ml_cache, json.loads((state/'ente/ml-index.json').read_text()))
    result = build_feed(lab)
    by_id = {p['id']:p for p in lab.features}
    photos = [{**by_id[p['id']], **p} for p in result['photos']]
    from selection_lab.ente import latest_result
    record = latest_result(lab)
    result['person_groups'] = record['result']['ente_diagnostics']['person_groups']
    atomic_json(job/'result.json', {**result, **common, 'photos':photos})
    print(json.dumps({'scope':args.scope, 'revision':source['revision'], 'engine':result['engine'],
                      'albums':len(result['albums']), 'photos':len(photos)}))


if __name__ == '__main__':
    main()

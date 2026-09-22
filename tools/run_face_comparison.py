#!/usr/bin/env python3
"""Run/export actual isolated Immich services. No substitute clustering."""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sqlite3
import sys
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import atomic_json, read_json

BASE = ROOT / 'outputs/selection-lab/engine-comparison'
COMPOSE = ['/opt/homebrew/bin/docker-compose', '-f', str(BASE / 'compose.json')]
ENV = {**os.environ, 'DOCKER_CONTEXT': 'colima-photo-wall-eval'}


def compose(*args):
    return subprocess.check_output([*COMPOSE, *args], env=ENV, text=True)


def api(route, data=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request('http://127.0.0.1:2283/api/' + route,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def login():
    creds = read_json(BASE / 'credentials.json')
    return api('auth/login', {'email': 'evaluation@photo-wall.local', 'password': creds['immich']})


def init():
    creds = read_json(BASE / 'credentials.json')
    try:
        session = login()
    except urllib.error.HTTPError as e:
        if e.code not in [400, 401]:
            raise
        api('auth/admin-sign-up', {'email': 'evaluation@photo-wall.local',
            'password': creds['immich'], 'name': 'Local Photo Evaluation'})
        session = login()
    token = session['accessToken']
    config = api('system-config', token=token)
    if not (BASE / 'immich-config.original.json').exists():
        atomic_json(BASE / 'immich-config.original.json', config)
    # Isolate the identity comparison. Do not alter facial recognition defaults.
    config['machineLearning']['clip']['enabled'] = False
    if 'ocr' in config['machineLearning']:
        config['machineLearning']['ocr']['enabled'] = False
    if 'reverseGeocoding' in config:
        config['reverseGeocoding']['enabled'] = False
    api('system-config', config, token, 'PUT')
    atomic_json(BASE / 'immich-config.test.json', config)
    libraries = api('libraries', token=token)
    if not libraries:
        lib = api('libraries', {'ownerId': session['userId'], 'name': '677-photo identical input',
            'importPaths': ['/comparison'], 'exclusionPatterns': []}, token)
    else:
        lib = libraries[0]
    api('libraries/' + lib['id'] + '/scan', {}, token)
    print('Immich: library scan queued; facial defaults preserved.', flush=True)


def status():
    session = login()
    jobs = api('jobs', token=session['accessToken'])
    atomic_json(BASE / 'immich-jobs.json', jobs)
    print(json.dumps(jobs, ensure_ascii=False), flush=True)


def sql(query):
    raw = compose('exec', '-T', 'database', 'psql', '-U', 'postgres', '-d', 'immich', '-t', '-A', '-c', query)
    return json.loads(raw.strip())


def export_immich():
    manifest = read_json(BASE / 'manifest.json')
    known = {p['name']: p['id'] for p in manifest['photos']}
    rows = sql('''SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (
        SELECT a."originalPath", f.id, f."personId", f."imageWidth", f."imageHeight",
            f."boundingBoxX1", f."boundingBoxX2", f."boundingBoxY1", f."boundingBoxY2"
        FROM asset_face f JOIN asset a ON a.id=f."assetId" WHERE a."deletedAt" IS NULL
        ORDER BY f."personId", f.id) t''')
    assets = sql('''SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (
        SELECT "originalPath" FROM asset WHERE "deletedAt" IS NULL) t''')
    actual = {known.get(Path(a['originalPath']).name) for a in assets}
    if len(assets) != len(known) or actual != set(known.values()):
        raise RuntimeError(f'Incomplete input: {len(actual)}/{len(known)}')
    coverage = sql('''SELECT json_build_object('detected_assets', count(j."facesRecognizedAt"),
        'metadata_assets', count(j."metadataExtractedAt"))
        FROM asset a LEFT JOIN asset_job_status j ON j."assetId"=a.id WHERE a."deletedAt" IS NULL''')
    if any(coverage[k] != len(known) for k in ['detected_assets', 'metadata_assets']):
        raise RuntimeError(f'Incomplete per-photo processing: {coverage}')
    by = {}
    for f in rows:
        key = f['personId'] or 'unassigned-' + f['id']
        w, h = f['imageWidth'], f['imageHeight']
        entry = {'face_id': f['id'], 'asset_id': known[Path(f['originalPath']).name],
            'box': [f['boundingBoxX1']/w, f['boundingBoxY1']/h, f['boundingBoxX2']/w, f['boundingBoxY2']/h]}
        by.setdefault(key, {'id': key, 'assigned': bool(f['personId']), 'faces': []})['faces'].append(entry)
    jobs = api('jobs', token=login()['accessToken'])
    # Every relevant queue must be drained before calling the result complete.
    for name in ['library', 'metadataExtraction', 'thumbnailGeneration', 'faceDetection', 'facialRecognition']:
        if name not in jobs:
            raise RuntimeError(f'Missing queue completion evidence: {name}')
        item = jobs[name]
        counts = item.get('jobCounts', item.get('statistics'))
        if not isinstance(counts, dict):
            raise RuntimeError(f'Unknown queue response: {name}')
        if item.get('queueStatus', {}).get('isPaused') or any(counts.get(k, 0) for k in ['active', 'waiting', 'delayed', 'failed', 'paused']):
            raise RuntimeError(f'Queue not complete: {name}: {counts}')
    atomic_json(BASE / 'immich-jobs.final.json', jobs)
    atomic_json(BASE / 'immich-result.json', {'id': 'immich', 'name': 'Immich 完整人物流程',
        'dataset_id': manifest['dataset_id'], 'status': 'complete', 'version': 'v3.1.0',
        'input_count': len(assets), 'face_count': len(rows), 'processing_coverage': coverage,
        'detected_photo_count': len({f['originalPath'] for f in rows}), 'groups': list(by.values()),
        'note': '官方完整服务检测与数据库人物聚类，默认人物参数；未套用本项目质量筛选。无人工合并，未分配的脸单列。',
        'created_at': time.time()})
    print(f'Immich exported: {len(rows)} faces, {len(by)} groups including unassigned faces')


def export_photoprism():
    manifest = read_json(BASE / 'manifest.json')
    known = {p['name']: p['id'] for p in manifest['photos']}
    run = read_json(BASE / 'photoprism-run.json', {})
    if run.get('index_exit') != 0 or run.get('faces_exit') != 0:
        raise RuntimeError('PhotoPrism index/face commands have not successfully completed')
    db = BASE / 'photoprism-storage/index.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    # Single read transaction keeps file and marker views consistent.
    conn.execute('BEGIN')
    files = [dict(r) for r in conn.execute('SELECT file_uid, file_name FROM files WHERE file_missing=0')]
    if {Path(f['file_name']).name for f in files} != set(known):
        raise RuntimeError('PhotoPrism file list contains missing or foreign inputs')
    mapping = {f['file_uid']: known[Path(f['file_name']).name] for f in files if Path(f['file_name']).name in known}
    if set(mapping.values()) != set(known.values()):
        raise RuntimeError(f'PhotoPrism indexed files differ from input: {len(set(mapping.values()))}/{len(known)}')
    rows = [dict(r) for r in conn.execute("SELECT * FROM markers WHERE marker_type='face' AND marker_invalid=0")]
    conn.close()
    groups, count = {}, 0
    for f in rows:
        if f['file_uid'] not in mapping:
            continue
        assigned = f['subj_uid'] or f['face_id']
        key = assigned or 'unassigned-' + f['marker_uid']
        g = groups.setdefault(key, {'id': key, 'assigned': bool(assigned), 'faces': []})
        g['faces'].append({'face_id': f['marker_uid'], 'asset_id': mapping[f['file_uid']],
                          'box': [f['x'], f['y'], f['x']+f['w'], f['y']+f['h']], 'score': f['score']})
        count += 1
    atomic_json(BASE / 'photoprism-result.json', {'id': 'photoprism', 'name': 'PhotoPrism 完整人物流程',
        'dataset_id': manifest['dataset_id'], 'status': 'complete',
        'version': run['version'], 'input_count': len(known), 'face_count': count,
        'detected_photo_count': len({f['asset_id'] for g in groups.values() for f in g['faces']}),
        'groups': list(groups.values()), 'created_at': time.time(),
        'note': '官方稳定版安装包（版本标识 Plus）的检测、FaceNet 和数据库聚类；默认人物参数，未套用本项目精选。未激活付费功能，未分配的脸单列。'})
    print(f'PhotoPrism exported: {count} face markers, {len(groups)} groups including unassigned faces')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['init', 'status', 'export', 'export-photoprism'])
    action = parser.parse_args().action
    {'init': init, 'status': status, 'export': export_immich, 'export-photoprism': export_photoprism}[action]()

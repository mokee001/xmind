"""Original curation first; Immich identity is used only by display preferences."""
from __future__ import annotations

import datetime as dt
import math
import json
import subprocess
import sys
import re
from collections import Counter
from pathlib import Path

from .core import ROOT, TZ, LabError, atomic_json, digest, file_hash, read_json
from .collections import prepare_candidates
from .ente import latest_result
from .memories import combined_content, recalled
from .stories import load_evidence, trip_pools, infer_base, CITY_LABELS, person_pools
from .recollection_feed import (RULES, TOPICS, TOPIC_NEGATIVES, text_features,
    theme_pools, select_photos, recommend, get_feed as get_baseline)

VERSION = 'recollections-preferences-v1'
DIRECTORY = 'recollections-preferences'
SOURCE = ROOT / 'outputs/selection-lab/engine-comparison'


def verify_upgrade_inputs():
    check = subprocess.run([sys.executable, str(ROOT/'tools/verify_recollection_baseline.py'), '--models'],
                           capture_output=True, text=True, timeout=60)
    report = json.loads(check.stdout)
    authorized = {'backend/dedup.py', 'selection_lab/server.py', 'selection_lab/static/index.html',
                  'tests/test_selection_lab.py', 'tests/test_story_albums.py', 'tests/test_hybrid_albums.py'}
    if (not report.get('manifest_verified') or report.get('model_issues') or not report.get('models_checked')
            or any(x['file'] not in authorized or x['problem'] != 'changed' for x in report['file_issues'])):
        raise LabError('基准出现未核对的差异；请先运行 verify_recollection_baseline.py --models')
    return report


def validate_index(lab, result, manifest):
    """Reject incomplete/foreign exports, but preserve every valid detection."""
    if (result.get('dataset_id') != lab.dataset_id or manifest.get('dataset_id') != lab.dataset_id
            or result.get('status') != 'complete' or result.get('id') != 'immich'):
        raise LabError('Immich 人物索引未完成或不属于当前图库')
    expected = {p['id']: p['sha256'] for p in lab.features}
    inputs = manifest.get('photos', [])
    if len(inputs) != len(expected) or {p['id']: p['sha256'] for p in inputs} != expected:
        raise LabError('Immich 输入清单与当前完整图库不符')
    coverage = result.get('processing_coverage', {})
    if (result.get('input_count') != len(expected)
            or coverage.get('detected_assets') != len(expected)
            or coverage.get('metadata_assets') != len(expected)):
        raise LabError('Immich 缺少逐张完成证据')
    groups, face_ids, group_ids = [], set(), set()
    for group in result.get('groups', []):
        gid = group.get('id')
        if not isinstance(gid, str) or not gid or gid in group_ids or not isinstance(group.get('assigned'), bool):
            raise LabError('Immich 人物组标识无效')
        group_ids.add(gid)
        faces = []
        for f in group.get('faces', []):
            fid, pid, box = f.get('face_id'), f.get('asset_id'), f.get('box')
            if not isinstance(fid, str) or fid in face_ids or pid not in expected:
                raise LabError('Immich 人脸与照片映射无效')
            if (not isinstance(box, list) or len(box) != 4 or
                    not all(isinstance(x, (float, int)) and math.isfinite(x) for x in box)
                    or box[2] <= box[0] or box[3] <= box[1]):
                raise LabError('Immich 人脸框无效')
            face_ids.add(fid)
            faces.append({'face_id': fid, 'asset_id': pid, 'box': box})
        if not faces:
            raise LabError('Immich 人物组为空')
        groups.append({'id': gid, 'assigned': group['assigned'], 'faces': faces,
                       'photo_ids': sorted({f['asset_id'] for f in faces})})
    if len(face_ids) != result.get('face_count'):
        raise LabError('Immich 人脸覆盖不完整')
    groups.sort(key=lambda g: (-len(g['photo_ids']), g['id']))
    numbered = 0
    for g in groups:
        if g['assigned']:
            numbered += 1
            g['title'] = f'人物 {numbered} · 待确认'
        else:
            g['title'] = '未归组的人脸'
    return groups


def build_feed(lab):
    baseline_check = verify_upgrade_inputs()
    lab.ensure_sources_current()
    source = read_json(SOURCE / 'immich-result.json', {})
    manifest = read_json(SOURCE / 'manifest.json', {})
    groups = validate_index(lab, source, manifest)
    record = latest_result(lab)
    if not record:
        raise LabError('当前图库尚未完成主题内容识别')
    content = combined_content(lab, record)
    _, photos, excluded, dates, index, vision_revision = prepare_candidates(lab, {}, content=content)
    evidence = load_evidence(lab, record)
    texts, text_revision = text_features(lab, evidence['models'])
    # Preserve V1 exactly: new identity preferences cannot influence first-layer selection.
    _, memberships, _ = person_pools(photos, evidence, record["result"]["ente_diagnostics"]["person_groups"])
    proposals = theme_pools(photos, evidence, index, texts)
    base = infer_base(photos, evidence['locations'])
    for seed in trip_pools(photos, evidence)[0]:
        ps = recalled(seed, photos, evidence, 'trip', base_position=base['position'] if base else None)
        if len(ps) < RULES['minimum_photos']:
            continue
        cities = Counter(evidence['cities'][p['id']] for p in seed['pool'] if p['id'] in evidence['cities'])
        place = '与'.join(CITY_LABELS[c] for c, _ in cities.most_common(2) if c in CITY_LABELS)
        proposals.append({'id': 'recollection-' + digest([seed['id'], sorted(p['id'] for p in ps)])[:16],
            'kind': 'trip', 'topic': 'trip', 'title': f'{place}的远行' if place else '远行的日子',
            'label': '旅途片段', 'pool': ps, 'year': None, 'supports': {},
            'anchor_count': len(seed['pool']), 'trip_confirmed': False,
            'description': '沿用 V1 的时间、地点和内容证据串联旅途照片，行程待确认。'})
    albums = [a for g in proposals if (a := select_photos(g, evidence, memberships))]
    albums.sort(key=lambda a: (-len(a['photo_ids']), a['id']))
    baseline = get_baseline(lab)
    provenance = {'dataset_id': lab.dataset_id, 'version': VERSION, 'rules': dict(RULES),
        'baseline_commit': 'c1c5683eb00c232123832a47f25ddd0d5e3e6e56',
        'baseline_check': baseline_check,
        'baseline_snapshot': baseline['id'] if baseline else None,
        'immich_version': source['version'], 'immich_export_sha256': file_hash(SOURCE/'immich-result.json'),
        'immich_manifest_sha256': file_hash(SOURCE/'manifest.json'),
        'models': evidence['models'], 'text_revision': text_revision, 'topics': TOPICS,
        'topic_negatives': TOPIC_NEGATIVES, 'evidence_revision': evidence['revision'],
        'feature_revision': lab.feature_revision, 'vision_revision': vision_revision,
        'dependencies': {str(p.relative_to(ROOT)): file_hash(p) for p in [Path(__file__),
            Path(__file__).with_name('recollection_feed.py'), Path(__file__).with_name('memory_experiment.py'),
            Path(__file__).with_name('stories.py'), Path(__file__).with_name('collections.py'),
            Path(__file__).with_name('memories.py'), Path(__file__).with_name('hybrid.py'), ROOT/'backend/dedup.py']},
        'note': '本批复用真实 Immich 完整导出，不是再次推理。新照片须先完成其对应的完整人物索引。'}
    eligible_ids = {p['id'] for p in photos}
    selected_ids = {pid for a in albums for pid in a['photo_ids']}
    quality_by_id = {p['id']: p.get('quality', 0) for p in lab.features}
    for g in groups:
        g['eligible_photo_count'] = len(set(g['photo_ids']) & eligible_ids)
        g['selected_photo_count'] = len(set(g['photo_ids']) & selected_ids)
        g['portrait'] = max(g['faces'], key=lambda f: (f['asset_id'] in eligible_ids,
            (f['box'][2]-f['box'][0])*(f['box'][3]-f['box'][1])*max(.1, quality_by_id[f['asset_id']]), f['face_id']))
    result = {'engine': VERSION, 'provenance': provenance, 'albums': albums,
        'people': groups, 'photos': [lab.public_photo(p) for p in lab.features],
        'diagnostics': {'input_count': len(lab.features), 'eligible_count': len(photos),
            'excluded': excluded, 'date_sources': dates, 'face_count': source['face_count'],
            'assigned_groups': sum(g['assigned'] for g in groups),
            'multi_photo_groups': sum(g['assigned'] and len(g['photo_ids']) >= 2 for g in groups),
            'unassigned_faces': sum(len(g['faces']) for g in groups if not g['assigned']),
            'person_albums': sum(a['kind'] == 'person' for a in albums), 'substantial_albums': len(albums)}}
    result['identity_revision'] = digest([{'id': g['id'], 'assigned': g['assigned'],
        'faces': sorted(g['faces'], key=lambda f:f['face_id'])} for g in groups])
    result['id'] = digest(result)[:24]
    with lab.lock:
        path = lab.state_dir / DIRECTORY / (result['id']+'.json')
        if not path.exists():
            atomic_json(path, result)
        atomic_json(lab.state_dir / DIRECTORY / 'latest.json', {'id': result['id'], 'dataset_id': lab.dataset_id})
    return result


def feedback(lab):
    value = read_json(lab.state_dir / DIRECTORY / 'feedback.json', {})
    return value if value.get('dataset_id') == lab.dataset_id else {'dataset_id': lab.dataset_id, 'albums': {}}


def get_feed(lab):
    pointer = read_json(lab.state_dir / DIRECTORY / 'latest.json', {})
    if pointer.get('dataset_id') != lab.dataset_id:
        return None
    if not re.fullmatch(r'[a-f0-9]{24}', pointer.get('id', '')):
        raise LabError('V2 快照标识无效')
    result = read_json(lab.state_dir / DIRECTORY / (pointer['id']+'.json'))
    if not result or result['provenance']['dataset_id'] != lab.dataset_id:
        raise LabError('V2 快照与当前图库不符')
    prefs = feedback(lab)['albums']
    from .display_preferences import display_view, load_preferences, load_confirmations
    view = {**result, 'feedback': prefs, 'featured_ids': recommend(result['albums'], prefs, dt.datetime.now(TZ).timestamp())}
    view.update(load_confirmations(lab, view))
    return {**view, **display_view(view, load_preferences(lab))}


def update_feedback(lab, data):
    result = get_feed(lab)
    aid, action = data.get('album_id'), data.get('action')
    if not result or aid not in {a['id'] for a in result['albums']}:
        raise LabError('V2 回忆不存在')
    if action not in {'seen', 'favorite', 'unfavorite', 'hide', 'restore'}:
        raise LabError('未知操作')
    with lab.lock:
        prefs = feedback(lab)
        value = prefs['albums'].setdefault(aid, {})
        if action == 'seen': value['seen_at'] = dt.datetime.now(TZ).isoformat()
        if action in {'favorite', 'unfavorite'}: value['favorite'] = action == 'favorite'
        if action in {'hide', 'restore'}: value['hidden'] = action == 'hide'
        atomic_json(lab.state_dir / DIRECTORY / 'feedback.json', prefs)
    return value

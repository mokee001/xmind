#!/usr/bin/env python3
"""Reproducible current-pipeline audit and read-only upstream comparison export."""
from pathlib import Path
from collections import Counter
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import Lab, atomic_json, read_json
from selection_lab.datasets import paths
from selection_lab.collections import prepare_candidates, sample_date
from selection_lab.ente import latest_result
from selection_lab.stories import latest_stories, load_evidence, RULES
from backend import dedup


def main():
    lab = Lab(*paths())
    config, eligible, excluded, *_ = prepare_candidates(lab, {})
    eligible_ids = {p['id'] for p in eligible}
    upstream = latest_result(lab)
    evidence = load_evidence(lab, upstream)
    faces = evidence['faces']
    groups = upstream['result']['ente_diagnostics']['person_groups']
    stories = latest_stories(lab)
    snapshot = stories['result']['collection_snapshot']
    duplicate_review = []
    for cluster in dedup.duplicate_clusters(eligible):
        representative = max(cluster, key=lambda p: p['quality'])
        for p in cluster:
            if p is representative:
                continue
            h = dedup._hamming(p['phash'], representative['phash'])
            d = dedup._csig_dist(p['csig'], representative['csig'])
            c = dedup._clip_distance(p, representative)
            if (h > 8 and (c is None or c > .03) and d is not None and 12 < d <= 22
                    and dedup._primary_subject(p['tags']) == dedup._primary_subject(representative['tags'])):
                duplicate_review.append({'left': p['id'], 'right': representative['id'],
                    'gray_distance': round(d, 2), 'hash_distance': h,
                    'date_gap': abs((sample_date(p)[0] or 0)-(sample_date(representative)[0] or 0))})
    duplicate_review.sort(key=lambda p: -p['date_gap'])
    def face(f):
        return {'asset_id': f['photo_id'], 'box': f['box'], 'score': f['score'], 'face_id': f['face_id']}
    def group(g):
        return {'id': g['cluster_id'], 'faces': [face(faces[x['face_id']]) for x in g['faces']]}
    filtered = Counter()
    examples = {}
    for f in faces.values():
        b = f['box']
        reason = ('photo_excluded' if f['photo_id'] not in eligible_ids else
            'score' if f['score'] < RULES['face_score_min'] else
            'blur' if f['blur'] < RULES['face_blur_min'] else
            'area' if (b[2]-b[0])*(b[3]-b[1]) < RULES['face_area_min'] else 'pass')
        filtered[reason] += 1
        examples.setdefault(reason, []).append(face(f))
    current_groups = []
    for g in snapshot['albums']:
        if g['kind'] == 'person':
            current_groups.append({'id': g['id'], 'title': g['title'], 'faces': [
                {'asset_id': pid, 'box': f['box'], 'face_id': f['face_id'], 'score': f['score']}
                for pid, fs in g['faces'].items() for f in fs]})
    vision = read_json(lab.state_dir / 'album-features.json', {})['assets']
    upstream_dir = ROOT / 'outputs/selection-lab/engine-comparison'
    result = {'schema_version': 1, 'dataset_id': lab.dataset_id, 'created_at': time.time(),
        'photos': [{'id': p['id'], 'filename': p['filename'], 'image': '/media/' + p['id'],
                    'date': sample_date(p)[0]} for p in lab.features],
        'audit': {'input': len(lab.features), 'eligible': len(eligible), 'excluded': excluded,
            'unknown_date': sum(sample_date(p)[0] is None for p in lab.features),
            'dedup_vectors': sum(bool(p.get('clip_embedding')) for p in lab.features),
            'vision_face_photos': sum(bool(x.get('faces')) for x in vision.values()),
            'face_filters': dict(filtered), 'face_filter_examples': examples,
            'story_snapshot_id': stories['id'], 'story_counts': snapshot['diagnostics'],
            'duplicate_review': duplicate_review,
            'person_rules': {k: v for k, v in RULES.items() if k.startswith('face_') or k == 'minimum_photos'}},
        'engines': [
            {'id': 'local', 'name': '当前人物精选', 'status': 'complete', 'groups': current_groups,
             'note': '现有精选快照；包含附加质量与最少张数规则，不等同于全部识别结果。'},
            {'id': 'ente', 'name': 'Ente 原版人物聚类', 'status': 'complete',
             'version': upstream['result']['provenance']['commit'], 'groups': [group(g) for g in groups],
             'face_count': len(faces), 'detected_photo_count': len({f['photo_id'] for f in faces.values()}),
             'note': '固定源码回放的原始人物簇；单脸簇不是确认的人物，不是原版最终回忆。'},
        ]}
    for engine in ['immich', 'photoprism']:
        value = read_json(upstream_dir / (engine + '-result.json'), None)
        if value is not None:
            if value['dataset_id'] != lab.dataset_id:
                raise RuntimeError('Upstream result belongs to another dataset')
            result['engines'].append(value)
        else:
            result['engines'].append({'id': engine, 'name': engine.title(), 'status': 'preparing',
                                     'groups': [], 'note': '本机测试尚未完成，不用其他引擎补齐。'})
    atomic_json(lab.state_dir / 'engine-comparison.json', result)
    atomic_json(upstream_dir / 'audit.json', result['audit'])
    print({k: v for k, v in result['audit'].items() if k not in ['face_filter_examples', 'story_counts']})


if __name__ == '__main__':
    main()

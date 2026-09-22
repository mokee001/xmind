#!/usr/bin/env python3
"""Generate the authorized independent V2; preserve the baseline and raw evidence."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selection_lab.core import Lab, atomic_json, file_hash, read_json
from selection_lab.datasets import paths
from selection_lab.recollection_v2 import build_feed, DIRECTORY, SOURCE


def main():
    check = subprocess.run([sys.executable, str(ROOT/'tools/verify_recollection_baseline.py'), '--models'],
                           capture_output=True, text=True)
    report = json.loads(check.stdout)
    authorized = {'backend/dedup.py', 'selection_lab/server.py', 'selection_lab/static/index.html', 'tests/test_selection_lab.py', 'tests/test_story_albums.py', 'tests/test_hybrid_albums.py'}
    if (not report.get('manifest_verified') or report.get('model_issues') or not report.get('models_checked')
            or any(x['file'] not in authorized for x in report['file_issues'])):
        raise RuntimeError('基准出现未获授权的差异：'+json.dumps(report, ensure_ascii=False))
    lab = Lab(*paths())
    protected = [p for p in lab.state_dir.rglob('*.json') if DIRECTORY not in p.relative_to(lab.state_dir).parts]
    protected += list(lab.cache_dir.rglob('*.json'))
    protected += [SOURCE/'immich-result.json', SOURCE/'manifest.json']
    before = {p: file_hash(p) for p in protected}
    first = build_feed(lab)
    if first != build_feed(lab): raise RuntimeError('V2 不能确定性重放')
    if any(file_hash(p) != sha for p, sha in before.items()): raise RuntimeError('基准或证据被修改')
    for a in first['albums']:
        if not 12 <= len(a['photo_ids']) <= 24 or len(set(a['photo_ids'])) != len(a['photo_ids']):
            raise RuntimeError('成册张数或成员唯一性错误')
    result = {'snapshot': first['id'], 'dataset_id': lab.dataset_id,
        'baseline_check': report, 'protected_files': len(before), 'deterministic_replay': True,
        'diagnostics': first['diagnostics'],
        'albums': [{'kind': a['kind'], 'title': a['title'], 'photos': len(a['photo_ids'])} for a in first['albums']]}
    atomic_json(lab.state_dir/DIRECTORY/'verification.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()

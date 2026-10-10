"""Account-isolated, immutable candidate snapshots for both first and later walls.

The worker runs the frozen recollections baseline in a separate interpreter.
No lab sample, legacy selector, or another account's library is a fallback.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

CONTRACT = 'unified-recollections-v1'
BASELINE = 'c1c5683eb00c232123832a47f25ddd0d5e3e6e56'
_guard = threading.RLock()
_running = set()
_inference = threading.Semaphore(1)


def library_scope(account, sources):
    if not isinstance(sources, list) or not sources or len(sources)>100 or any(not isinstance(x,str) or len(x)>200 for x in sources):
        raise SelectionUnavailable('照片来源范围无效')
    normalized = ['all'] if 'all' in sources else sorted(set(sources))
    return account+'-'+hashlib.sha256(json.dumps(normalized).encode()).hexdigest()[:20]


class SelectionUnavailable(ValueError):
    pass


def directory(scope):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', scope) or scope == 'legacy':
        raise SelectionUnavailable('需要有效账户才能读取选片结果')
    root = Path(os.environ.get('PHOTOWALL_SELECTION_DIR', Path(__file__).parent/'data/selection'))
    result = root / scope
    result.mkdir(parents=True, exist_ok=True, mode=0o700)
    return result


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x') as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def runtime():
    root = os.environ.get('PHOTOWALL_RECOLLECTION_ROOT', '')
    if not root or not (Path(root)/'selection_lab/recollection_feed.py').is_file():
        raise SelectionUnavailable('正式选片服务尚未部署，未切换为旧选片器')
    return Path(root)


def run_inference(cmd, log):
    """Bound the entire Linux process tree, including abandoned Flutter children."""
    unit = None
    manager = ['--user'] if os.environ.get('PHOTOWALL_SELECTION_SYSTEMD_USER') == '1' else []
    if sys.platform.startswith('linux'):
        memory_gib = int(os.environ.get('PHOTOWALL_SELECTION_MEMORY_GIB', '2'))
        cpu_percent = int(os.environ.get('PHOTOWALL_SELECTION_CPU_PERCENT', '100'))
        if not 1 <= memory_gib <= 5 or not 50 <= cpu_percent <= 200:
            raise SelectionUnavailable('选片进程资源配置超出已验证范围')
        unit = 'photowall-selection-' + uuid.uuid4().hex + '.scope'
        cmd = ['systemd-run', *manager, '--scope', '--quiet', '--collect', '--unit', unit,
               '-p', f'MemoryMax={memory_gib}G', '-p', 'MemorySwapMax=0',
               '-p', f'CPUQuota={cpu_percent}%', '-p', 'TasksMax=256',
               '-p', 'RuntimeMaxSec=3300', '-p', 'TimeoutStopSec=15s',
               '-p', 'KillMode=control-group', '-p', 'OOMPolicy=kill', *cmd]
    try:
        subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=3400)
    finally:
        if unit:
            # A Python timeout only terminates its direct subprocess. Stop the
            # named scope as well, even after a failed child or a successful run.
            # An already collected scope may legitimately return non-zero.
            subprocess.run(['systemctl', *manager, 'stop', unit], stdout=log,
                           stderr=subprocess.STDOUT, check=False, timeout=30)


def ingest(scope, items):
    """Merge content-addressed files; caller has validated ownership and metadata."""
    runtime()
    root = directory(scope)
    with _guard:
        library = read(root/'library.json', {'scope':scope, 'photos':{}})
        if library['scope'] != scope:
            raise SelectionUnavailable('候选图库归属不符')
        for item in items:
            path = Path(item['path']).resolve()
            if root.resolve() not in path.parents or not path.is_file():
                raise SelectionUnavailable('照片不属于当前账户候选目录')
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != item['sha256']:
                raise SelectionUnavailable('照片内容校验失败')
            library['photos'][actual] = item
        library['revision'] = hashlib.sha256(json.dumps(library['photos'], sort_keys=True).encode()).hexdigest()
        atomic(root/'library.json', library)
    if len(library['photos']) >= 8:
        enqueue(scope)
    return library['revision']


def enqueue(scope):
    root = directory(scope)
    with _guard:
        if scope in _running:
            return
        if read(root/'status.json', {}).get('retry_after', 0) > time.time():
            return
        _running.add(scope)
    def work():
        processed_revision = None
        failed = False
        try:
            # Read a new snapshot after each completed batch; don't mutate an
            # in-flight source set, or lose uploads arriving during inference.
            while True:
                with _guard:
                    library = read(root/'library.json')
                    status = read(root/'status.json', {})
                    processed_revision = (library or {}).get('revision')
                    if not library or len(library['photos']) < 8 or status.get('completed_revision') == library['revision']:
                        return
                    revision = library['revision']
                    if status.get('state') == 'awaiting_photos' and status.get('revision') == revision:
                        return
                    job = root/'jobs'/revision
                    atomic(job/'input.json', library)
                atomic(root/'status.json', {'state':'running', 'phase':'provisional', 'revision':revision})
                cmd = [os.environ.get('PHOTOWALL_RECOLLECTION_PYTHON', sys.executable),
                       str(Path(__file__).resolve().parents[1]/'tools/run_production_recollections.py'),
                       '--runtime', str(runtime()), '--job', str(job), '--scope', scope]
                with (job/'worker.log').open('a') as log:
                    os.chmod(job/'worker.log', 0o600)
                    # Model runtime is large and its generated harness is shared.
                    # Serialize across accounts; input/output directories stay isolated.
                    with _inference:
                        run_inference([*cmd, '--phase', 'provisional'], log)
                    quick = provisional_snapshot(scope, library, revision)
                    if quick is None:
                        raise SelectionUnavailable('初筛快照与账户、规则或输入不符')
                    atomic(root/'provisional-current.json', {'scope':scope, 'revision':revision})
                    with _guard:
                        latest = read(root/'library.json', {})
                        # Auto currently selects template_1. Below both its real
                        # size and the baseline's 12-photo album minimum, running
                        # the full album engine cannot unblock the initial wall.
                        from .template_packages import required_photo_count
                        initial_count = min(required_photo_count('template_1'), 12)
                        if len(quick['photos']) < initial_count:
                            if latest.get('revision') != revision:
                                continue
                            atomic(root/'status.json', {'state':'awaiting_photos', 'phase':'provisional', 'revision':revision})
                            return
                    # Once a first wall can be made, let this immutable input
                    # finish even as uploads continue; do not starve formal albums.
                    with _inference:
                        atomic(root/'status.json', {'state':'running', 'phase':'canonical', 'revision':revision})
                        run_inference([*cmd, '--phase', 'canonical'], log)
                result = read(job/'result.json')
                publish(scope, result, library)
                atomic(root/'status.json', {'state':'ready', 'revision':revision, 'completed_revision':revision})
        except Exception as error:
            failed = True
            # Keep the last valid snapshot; never pretend old features are new.
            atomic(root/'status.json', {'state':'failed', 'error':str(error), 'retry_after':time.time()+60})
        finally:
            with _guard:
                _running.discard(scope)
                # An upload can race the decision to wait/finish. Hand it off
                # after releasing ownership instead of losing its enqueue call.
                latest = read(root/'library.json', {})
                follow_up = not failed and latest.get('revision') not in (None, processed_revision)
            if follow_up:
                enqueue(scope)
    threading.Thread(target=work, daemon=True, name='recollection-worker').start()


def publish(scope, result, library):
    """Validate the exact source manifest before atomically promoting a result."""
    if (not isinstance(result, dict) or result.get('scope') != scope
            or result.get('input_revision') != library['revision']
            or result.get('baseline_commit') != BASELINE
            or result.get('engine') != 'recollection-feed-v1'):
        raise SelectionUnavailable('正式选片快照与账户、规则或输入不符')
    allowed = set(library['photos'])
    by_id = {p['id']:p for p in result.get('photos', [])}
    for p in by_id.values():
        if p.get('sha256') not in allowed or p.get('path') != library['photos'][p['sha256']]['path']:
            raise SelectionUnavailable('选片结果含非本次候选照片')
    for album in result.get('albums', []):
        ids = album.get('photo_ids', [])
        if not 12 <= len(ids) <= 24 or len(ids) != len(set(ids)) or not set(ids) <= set(by_id):
            raise SelectionUnavailable('正式相册成员不完整或数量违规')
    selected_ids = {pid for album in result.get('albums',[]) for pid in album['photo_ids']}
    if set(by_id) != selected_ids or len(by_id)!=len(result.get('photos',[])):
        raise SelectionUnavailable('正式候选必须恰好来自第一层成册结果')
    root = directory(scope)
    result = attach_people(root, result)
    topics = {'pets':'pet','table':'food','outdoors':'nature','stage':'stage','art':'art','trip':'travel'}
    album_tags = {}
    for album in result.get('albums', []):
        for pid in album['photo_ids']:
            album_tags.setdefault(pid, set()).update({'collection_'+album['id'], topics.get(album.get('topic'), album.get('topic',''))})
    result['photos'] = [{**p, 'tags':sorted((set(p.get('tags',[])) | album_tags.get(p['id'],set()))-{''})} for p in result['photos']]
    name = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    atomic(root/'snapshots'/f'{name}.json', result)
    atomic(root/'current.json', {'id':name, 'scope':scope})


def attach_people(root, result):
    """Stable identifiers by unchanged face observations, never by display order.

    Ambiguous cluster merges/splits get new IDs; saved old preferences then fail
    closed instead of silently referring to a different person.
    """
    old = read(root/'person-index.json', {})
    groups = []
    for group in result.get('person_groups', []):
        faces = group.get('faces', [])
        keys = {f['sha256']+':'+','.join(f'{x:.5f}' for x in f['box']) for f in faces}
        if keys:
            matches = [key for key, values in old.items() if keys.intersection(values)]
            groups.append((faces, keys, matches))
    index, people, tags = {}, [], {}
    available = {p['sha256']:p for p in result['photos']}
    for faces, keys, matches in groups:
        same = len(matches)==1 and sum(matches[0] in g[2] for g in groups)==1
        pid = matches[0] if same else 'person_'+hashlib.sha256(json.dumps(sorted(keys)).encode()).hexdigest()[:24]
        index[pid] = sorted(keys)
        members = {f['sha256'] for f in faces} & available.keys()
        if not members:
            continue
        for sha in members: tags.setdefault(sha, []).append(pid)
        cover = available[sorted(members)[0]]
        people.append({'id':pid, 'count':len(members), 'cover':cover['sha256']})
    people.sort(key=lambda p:(-p['count'],p['id']))
    people = [{**p,'label':f'人物 {i+1}'} for i,p in enumerate(people)]
    atomic(root/'person-index.json', index)
    return {**{k:v for k,v in result.items() if k!='person_groups'}, 'people':people,
            'photos':[{**p,'tags':sorted(set(p.get('tags',[])) | set(tags.get(p['sha256'],[])))} for p in result['photos']]}


def provisional_snapshot(scope, library, revision):
    """Read only verified members of the immutable job's original input."""
    if (not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{64}', revision)
            or not isinstance(library, dict) or library.get('scope') != scope
            or not isinstance(library.get('photos'), dict)):
        return None
    root = directory(scope)
    try:
        quick = read(root/'jobs'/revision/'provisional.json')
        source = read(root/'jobs'/revision/'input.json', {})
    except (OSError, ValueError):
        return None
    if (not isinstance(quick, dict) or not isinstance(source, dict) or quick.get('scope') != scope
            or quick.get('input_revision') != revision or quick.get('baseline_commit') != BASELINE
            or quick.get('engine') != 'strong-rules-provisional-v1'
            or source.get('scope') != scope or source.get('revision') != revision
            or not isinstance(quick.get('photos'), list) or quick.get('albums') != []
            or not isinstance(source.get('photos'), dict)
            or hashlib.sha256(json.dumps(source['photos'], sort_keys=True).encode()).hexdigest() != revision):
        return None
    originals, current = source.get('photos', {}), library.get('photos', {})
    ids, hashes, photos = set(), set(), []
    for photo in quick['photos']:
        if not isinstance(photo, dict):
            return None
        sha, pid, path = photo.get('sha256'), photo.get('id'), photo.get('path')
        quality = photo.get('quality')
        if (not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha)
                or not isinstance(pid, str) or not pid or not isinstance(path, str)
                or not isinstance(quality, (int, float)) or not math.isfinite(quality) or quality <= 0
                or pid in ids or sha in hashes or sha not in originals
                or not isinstance(originals[sha], dict)
                or path != originals[sha].get('path') or root.resolve() not in Path(path).resolve().parents):
            return None
        ids.add(pid); hashes.add(sha)
        if isinstance(current.get(sha), dict) and path == current[sha].get('path') and Path(path).is_file():
            photos.append(photo)
    return {**quick, 'photos':photos, 'snapshot_id':'provisional-'+revision, 'phase':'provisional'}


def candidates(scope):
    root = directory(scope)
    library = read(root/'library.json', {})
    if not library or library.get('scope') != scope:
        raise SelectionUnavailable('尚无当前账户的合格照片')
    pointer = read(root/'current.json', {})
    if pointer.get('scope') == scope and re.fullmatch(r'[a-f0-9]{64}', pointer.get('id','')):
        result = read(root/'snapshots'/f"{pointer['id']}.json")
        # Deleted/replaced source assets must never survive through a cache.
        current = library['photos']
        result = {**result, 'photos':[p for p in result['photos']
                  if p['sha256'] in current and Path(p['path']).is_file()]}
        if result['photos']:
            return {**result, 'snapshot_id':pointer['id'], 'phase':'canonical'}
    # Before the first formal feed is ready, use only the worker's verified
    # strong-rule candidates. This is a provisional wall, not a 12-photo album.
    status = read(root/'status.json', {})
    pointer = read(root/'provisional-current.json', {})
    revisions = [status.get('revision') or library.get('revision')]
    if pointer.get('scope') == scope:
        revisions.append(pointer.get('revision'))
    for revision in dict.fromkeys(r for r in revisions if isinstance(r, str)):
        quick = provisional_snapshot(scope, library, revision)
        if quick and quick['photos']:
            return quick
    raise SelectionUnavailable('照片尚未完成初筛，请稍后重试')


def select(scope, count, *, prefer=(), exclude=(), rotate=0, avoid=(), snapshot=None):
    result = snapshot if snapshot is not None else candidates(scope)
    excluded, preferred, avoided = set(exclude), set(prefer), set(avoid)
    known = {t for p in result['photos'] for t in p.get('tags', []) if t.startswith('person_')}
    if {t for t in excluded|preferred if t.startswith('person_')} - known:
        raise SelectionUnavailable('人物识别分组已变化或尚未完成，请重新确认人物偏好；未忽略原有范围')
    available = {p['id']:p for p in result['photos']
                 if not excluded.intersection(p.get('tags', [])) and p.get('quality', 0)>0}
    # Explicit people selection is a hard boundary, topics are soft preferences.
    people = {t for t in preferred if t.startswith('person_')}
    if people:
        available = {key:p for key,p in available.items() if people.intersection(p.get('tags', []))}
    groups = [[available[i] for i in a['photo_ids'] if i in available] for a in result.get('albums', [])]
    groups = [g for g in groups if len(g) >= count]
    if groups:
        groups.sort(key=lambda g: (-sum(bool(preferred.intersection(p.get('tags', []))) for p in g), g[0]['id']))
        pool = groups[rotate % len(groups)]
    else:
        # The union still stays strictly within the already-selected first layer.
        pool = list(available.values())
    if len(pool) < count:
        raise SelectionUnavailable('当前展示范围内合格照片不足；不会补入未入选或被排除的照片')
    # Stable sort retains baseline album order; no second scoring model/weights.
    pool.sort(key=lambda p: (p.get('filename') in avoided,
                            -bool(preferred.intersection(p.get('tags', [])))))
    # Rotate within the first layer for successive walls, never reread raw uploads.
    if not avoided and len(pool) > count:
        offset = (rotate*count) % len(pool)
        pool = pool[offset:]+pool[:offset]
    chosen = [dict(p) for p in pool[:count]]
    return chosen, {k:result.get(k) for k in ('snapshot_id','phase','engine','baseline_commit','input_revision')}

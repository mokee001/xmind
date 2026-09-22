"""A narrowing projection over immutable first-layer results, never a new selector."""
from .core import LabError, atomic_json, read_json

POLICY_VERSION = "confirmed-frequent-people-v3"


def load_preferences(lab):
    from .recollection_v2 import DIRECTORY
    value = read_json(lab.state_dir / DIRECTORY / 'display-preferences.json', {})
    return value if value.get('dataset_id') == lab.dataset_id else {'mode': 'all', 'person_ids': []}


def load_confirmations(lab, result):
    """Explicit user corrections, scoped to one dataset and recognition revision."""
    from .recollection_v2 import DIRECTORY
    import hashlib
    import json
    value = read_json(lab.state_dir / DIRECTORY / 'person-confirmations.json', {})
    if not value:
        return {'person_merges': [], 'person_confirmation_revision': None}
    if value.get('dataset_id') != lab.dataset_id or value.get('identity_revision') != result['identity_revision']:
        raise LabError('人物合并确认与当前识别版本不符，请重新确认')
    return {'person_merges': value.get('merges', []),
            'person_confirmation_revision': hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()}


def effective_people(result):
    """Union only user-confirmed identities; retain raw groups for diagnostics."""
    raw = {g['id']: g for g in result['people'] if g['assigned']}
    aliases = {}
    merged = {}
    for correction in result.get('person_merges', []):
        ids = correction.get('source_person_ids', [])
        canonical = correction.get('id')
        if (correction.get('source') != 'user_confirmation' or len(ids) < 2
                or canonical not in ids or len(set(ids)) != len(ids)
                or not set(ids) <= set(raw) or set(ids).intersection(aliases)):
            raise LabError('人物合并确认无效，请检查人工确认记录')
        aliases.update({gid: canonical for gid in ids})
        group = dict(raw[canonical])
        group.update(title=correction['title'], source_person_ids=ids, confirmed=True,
                     photo_ids=list(dict.fromkeys(pid for gid in ids for pid in raw[gid]['photo_ids'])),
                     faces=list({f['face_id']: f for gid in ids for f in raw[gid].get('faces', [])}.values()))
        merged[canonical] = group
    return [merged.get(gid, group) for gid, group in raw.items()
            if aliases.get(gid, gid) == gid], aliases


def first_layer_ids(result):
    """Independent of the current person preference, so options do not disappear on selection."""
    by_id = {a['id']: a for a in result['albums']}
    ordered = [by_id[k] for k in result.get('featured_ids', []) if k in by_id]
    ordered += [a for a in result['albums'] if a['id'] not in result.get('featured_ids', [])]
    return list(dict.fromkeys(pid for a in ordered if not result.get('feedback', {}).get(a['id'], {}).get('hidden') for pid in a['photo_ids']))


def preference_people(result):
    base = set(first_layer_ids(result))
    options = []
    for group in effective_people(result)[0]:
        matched = base.intersection(group['photo_ids'])
        if not group['assigned'] or not matched:
            continue
        item = {'id': group['id'], 'title': group.get('title', group['id']),
                'selected_photo_count': len(matched), 'confirmed': group.get('confirmed', False),
                'source_person_ids': group.get('source_person_ids', [group['id']])}
        faces = [f for f in group.get('faces', []) if f['asset_id'] in matched]
        if faces:
            item['portrait'] = max(faces, key=lambda f: ((f['box'][2]-f['box'][0])*(f['box'][3]-f['box'][1]), f['face_id']))
        options.append(item)
    return sorted(options, key=lambda g: (-g['selected_photo_count'], g['id']))


def display_view(result, preferences):
    """Selected IDs are OR-ed, then intersected with the first layer; zero stays zero."""
    base = first_layer_ids(result)
    scope = {k: preferences.get(k, default) for k, default in [('mode', 'all'), ('person_ids', [])]}
    groups, aliases = effective_people(result)
    people = {g['id']: g for g in groups}
    scope['person_ids'] = list(dict.fromkeys(aliases.get(gid, gid) for gid in scope['person_ids']))
    stale = scope['mode'] == 'include' and (preferences.get('identity_revision') != result.get('identity_revision')
            or not set(scope['person_ids']) <= set(people))
    options = preference_people(result)
    allowed = {g['id'] for g in options}
    inactive = set(scope['person_ids']) - allowed
    scope['person_ids'] = [gid for gid in scope['person_ids'] if gid in allowed]
    if scope['mode'] == 'all':
        visible = base
    elif stale:
        visible = []
    else:
        matching = {pid for gid in scope['person_ids'] for pid in people[gid]['photo_ids']}
        visible = [pid for pid in base if pid in matching]
    return {'display_photo_ids': visible, 'preference_people': options, 'display_policy_version': POLICY_VERSION,
            'person_confirmation_revision': result.get('person_confirmation_revision'),
            'display_scope': {**scope, 'needs_review': stale, 'inactive_person_count': len(inactive)},
            'display_counts': {'first_layer': len(base), 'visible': len(visible)}}


def update_preferences(lab, data, *, preview=False):
    from .recollection_v2 import DIRECTORY, get_feed
    with lab.lock:
        result = get_feed(lab)
        if not result:
            raise LabError('请先完成第一层精选')
        if data.get('snapshot_id') != result['id'] or data.get('identity_revision') != result.get('identity_revision'):
            raise LabError('精选或人物识别已更新，请刷新后重新选择')
        if data.get('person_confirmation_revision') != result.get('person_confirmation_revision'):
            raise LabError('人物合并确认已更新，请刷新后重新选择')
        if data.get('mode') not in {'all', 'include'}:
            raise LabError('展示范围无效')
        ids = data.get('person_ids')
        if not isinstance(ids, list) or len(ids) > len(result['people']) or any(not isinstance(i, str) for i in ids):
            raise LabError('人物选择无效')
        allowed = {g['id'] for g in preference_people(result)}
        if not set(ids) <= allowed:
            raise LabError('只能选择第一层精选照片中出现的人物')
        preferences = {'dataset_id': lab.dataset_id, 'identity_revision': result['identity_revision'],
                       'mode': data['mode'], 'person_ids': sorted(set(ids))}
        view = display_view(result, preferences)
        if not preview:
            atomic_json(lab.state_dir / DIRECTORY / 'display-preferences.json', preferences)
        return view

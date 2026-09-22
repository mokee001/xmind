"""Read-only whole-wall interaction demo; never publishes to a physical device."""
import hashlib
import json
import re
from .core import LabError, atomic_json, read_json

DIRECTORY = 'wall-interaction-demo-v1'


def scope_key(lab, result):
    return hashlib.sha256(json.dumps([lab.dataset_id, result['id'], result['display_photo_ids']], sort_keys=True).encode()).hexdigest()


def manifest(lab):
    from .recollection_v2 import get_feed
    result = get_feed(lab)
    value = read_json(lab.state_dir / DIRECTORY / 'manifest.json', {})
    if not result or value.get('scope') != scope_key(lab, result):
        raise LabError('当前精选或偏好已变化，请重新生成照片墙演示')
    return value


def image_path(lab, wall_id):
    value = manifest(lab)
    if not re.fullmatch(r'[a-f0-9]{24}', wall_id) or wall_id not in {w['id'] for w in value['walls']}:
        raise LabError('照片墙不存在')
    return lab.state_dir / DIRECTORY / (wall_id + '.jpg')


def build(lab):
    from .recollection_v2 import get_feed
    from backend.template_packages import render, required_photo_count
    result = get_feed(lab)
    if not result:
        raise LabError('请先生成精选结果')
    ids = result['display_photo_ids']
    root = lab.state_dir / DIRECTORY
    root.mkdir(exist_ok=True, parents=True)
    walls = []
    for template, title in [('template_1', '日常拼贴'), ('template_2', '生活剪贴')]:
        count = required_photo_count(template)
        if len(ids) < count:
            continue
        offsets = list(dict.fromkeys([0, min(count, len(ids)-count)]))
        for offset in offsets:
            members = ids[offset:offset+count]
            wall_id = hashlib.sha256(json.dumps([scope_key(lab, result), template, members]).encode()).hexdigest()[:24]
            paths = []
            for pid in members:
                from pathlib import Path
                path = Path(lab.assets[pid]['path'])
                stat = path.stat()
                if (stat.st_size, stat.st_mtime_ns) != lab.source_stamps[pid]:
                    raise LabError('原图已变化，请重新分析')
                paths.append(str(path))
            wall = render(template, paths, {'nickname': 'My', 'line1':'', 'line2':'', 'line3':'', 'tag':''})
            wall.thumbnail((900, 1200))
            wall.save(root / (wall_id + '.jpg'), quality=90)
            walls.append({'id':wall_id, 'template_id':template, 'title':title,
                          'photo_ids':members, 'image':'/wall-demo-image/'+wall_id})
    if not walls:
        raise LabError('当前展示范围不足以填满现有 8 照片模板；未补入未入选照片')
    value = {'scope':scope_key(lab,result), 'snapshot_id':result['id'], 'walls':walls, 'demo':True}
    atomic_json(root / 'manifest.json', value)
    return value

"""Demo-only preference projection; does not change the saved curation engine."""
from selection_lab.display_preferences import effective_people

VERSION = 'onboarding-library-people-themes-v1'
# Same labels and IDs as App.js PREVIEW_RECOGNIZED_CONTENT.topics.
# Map only to existing saved album evidence, never new inferred labels.
THEMES = (
    {'id': 'topic-pets', 'label': '毛孩子', 'detail': '猫猫狗狗的日常', 'icon': '宠', 'topic': 'pets'},
    {'id': 'topic-travel', 'label': '出去玩的照片', 'detail': '旅行、周末出游和散步', 'icon': '旅', 'topic': 'trip'},
    {'id': 'topic-food', 'label': '吃到的好东西', 'detail': '美食、探店和自己做的饭', 'icon': '食', 'topic': 'table'},
    {'id': 'topic-scenery', 'label': '山海与风景', 'detail': '大海、山川和森林', 'icon': '景', 'topic': 'outdoors'},
    {'id': 'topic-stage', 'label': '看过的演出', 'detail': '演唱会、音乐节和舞台', 'icon': '演', 'topic': 'stage'},
    {'id': 'topic-art', 'label': '逛过的展览', 'detail': '美术馆、博物馆和展览', 'icon': '展', 'topic': 'art'},
)


def library_people(result, library_ids, selected_ids):
    """All assigned groups, including zero selected matches; retain confirmed merges."""
    library, selected = set(library_ids), set(selected_ids)
    options = []
    for group in effective_people(result)[0]:
        ids = set(group['photo_ids'])
        faces = group.get('faces', [])
        if not ids or not ids <= library or not faces or any(f['asset_id'] not in ids for f in faces):
            raise ValueError('完整人物索引与当前图库不匹配；没有使用精选人物代替')
        # Avatar comes from the whole recognized group, not only selected photos.
        portrait = max(faces, key=lambda f: (
            (f['box'][2]-f['box'][0])*(f['box'][3]-f['box'][1]), f['face_id']))
        options.append({'id': group['id'], 'title': group.get('title', group['id']),
                        'library_photo_count': len(ids), 'selected_photo_count': len(ids & selected),
                        'photo_ids': [pid for pid in selected_ids if pid in ids],
                        'confirmed': group.get('confirmed', False),
                        'source_person_ids': group.get('source_person_ids', [group['id']]),
                        'portrait': portrait, 'image': '/person/' + group['id']})
    return sorted(options, key=lambda p: (-p['library_photo_count'], p['id']))


def theme_options(result, selected_ids):
    options = []
    for theme in THEMES:
        ids = {pid for album in result['albums'] if album.get('topic') == theme['topic']
               and not result.get('feedback', {}).get(album['id'], {}).get('hidden')
               for pid in album['photo_ids']}
        members = [pid for pid in selected_ids if pid in ids]
        options.append({**theme, 'photo_ids': members, 'selected_photo_count': len(members)})
    return options


def prioritize_themes(ids, themes, selected_themes):
    """Stable priority for preview order, not a filter or curation rescore.

    Other themes remain reachable via next-wall; no preferred evidence means unchanged.
    """
    preferred = {pid for theme in themes if theme['id'] in selected_themes for pid in theme['photo_ids']}
    return [pid for pid in ids if pid in preferred] + [pid for pid in ids if pid not in preferred]

"""Independent Ente runner: no arbitrary commands and no local-selector fallback."""
import datetime as dt
import math
import os
import subprocess
import sys
import threading
from .core import ROOT, TZ, LabError, atomic_json, read_json

_lock = threading.Lock()
_job = None


def recognition_result(lab, diagnostics):
    """Display every upstream theme match; no album-size or project filters."""
    by_hash = {}
    for photo in lab.features:
        by_hash.setdefault(photo['sha256'], []).append(photo)
    albums, photos = [], {}
    threshold = diagnostics['clip_threshold']
    for theme in diagnostics['themes']:
        matches = theme['matches']
        if len(matches) != theme['matching_count']:
            raise LabError('Ente 主题照片数量与诊断不一致')
        ids, scores = [], {}
        for match in sorted(matches, key=lambda m: -m['score']):
            candidates = by_hash.get(match['sha256'], [])
            if len(candidates) != 1:
                raise LabError('Ente 识别照片无法唯一匹配当前数据集')
            photo = candidates[0]
            score = match['score']
            if not math.isfinite(score) or score <= threshold or photo['id'] in scores:
                raise LabError('Ente 主题匹配分数或成员无效')
            ids.append(photo['id'])
            scores[photo['id']] = score
            photos[photo['id']] = lab.public_photo(photo)
        if ids:
            albums.append({'id': 'ente-theme-' + theme['type'], 'title': theme['title'],
                'photo_ids': ids, 'cover': ids[0], 'scores': scores,
                'subtitle': '主题识别 · 全部匹配照片',
                'description': f'显示语义相似度高于 {threshold} 的全部照片，按相似度排序；不设最低张数，不做回忆选片或额外去重。'})
    return {'engine': 'ente-theme-recognition', 'albums': albums,
            'photos': list(photos.values()), 'threshold': threshold,
            'minimum_count': 1, 'mode': 'all_theme_matches'}


def _read_state(path):
    try:
        return read_json(path, {})
    except (OSError, ValueError):
        return {}


def people_result(lab, diagnostics):
    """Expose all face detections and upstream clusters, including singletons."""
    from .collections import sample_date
    by_hash = {}
    for photo in lab.features:
        by_hash.setdefault(photo['sha256'], []).append(photo)
    photos, albums, known_faces = {}, [], {}
    def album(group_id, title, faces, kind):
        members, boxes = [], {}
        for face in faces:
            matches = by_hash.get(face['sha256'], [])
            if len(matches) != 1:
                raise LabError('Ente 人脸照片无法唯一匹配当前数据集')
            p = matches[0]
            box = face['box']
            if (len(box) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
                    or not 0 <= box[0] < box[2] <= 1 or not 0 <= box[1] < box[3] <= 1):
                raise LabError('Ente 人脸位置无效')
            if p['id'] not in boxes:
                members.append(p['id']); boxes[p['id']] = []
            boxes[p['id']].append({'face_id': face['face_id'], 'box': box, 'score': face['score']})
            timestamp, date_source = sample_date(p)
            photos[p['id']] = {**lab.public_photo(p), 'taken_at': timestamp, 'date_source': date_source}
        if members:
            albums.append({'id': group_id, 'title': title, 'photo_ids': members, 'cover': members[0],
                'kind': kind, 'faces': boxes, 'face_count': len(faces),
                'subtitle': '全部检测到人脸的照片' if kind == 'all_faces' else f'{len(faces)} 张脸 · 未确认身份',
                'description': '绿色框标出本组的人脸。保留 Ente 原版检测和聚类结果，单张也展示；分组不代表已确认的同一个人。'})
    detected = diagnostics['detected_faces']
    for face in detected:
        if face['face_id'] in known_faces:
            raise LabError('重复的人脸 ID')
        known_faces[face['face_id']] = face
    if len(detected) != diagnostics['face_count']:
        raise LabError('人脸检测数量与诊断不一致')
    album('ente-all-faces', '全部人物照片', detected, 'all_faces')
    assigned = set()
    groups = diagnostics['person_groups']
    if len(groups) != diagnostics['cluster_count']:
        raise LabError('人脸分组数量与诊断不一致')
    groups = sorted(groups, key=lambda g: (-len(g['faces']), sorted(f['face_id'] for f in g['faces'])))
    for index, group in enumerate(groups, 1):
        if not group['faces']:
            raise LabError('人脸分组不能为空')
        for face in group['faces']:
            if known_faces.get(face['face_id']) != face or face['face_id'] in assigned:
                raise LabError('人脸分组成员无效或重复')
            assigned.add(face['face_id'])
        album('ente-person-' + group['cluster_id'], f'人脸组 {index}', group['faces'], 'face_cluster')
    return {'engine': 'ente-face-recognition', 'mode': 'all_face_clusters', 'albums': albums,
            'photos': list(photos.values()), 'group_count': len(groups), 'face_count': len(detected)}


def ready(lab):
    state = ROOT / "outputs/selection-lab"
    upstream = state / "engines/ente-upstream"
    dataset_root=(state / "datasets").resolve()
    is_base=(lab.state_dir.resolve()==state.resolve() and lab.cache_dir.resolve()==(ROOT / "outputs/immich-comparison").resolve())
    is_dataset=(dataset_root in lab.state_dir.resolve().parents and dataset_root in lab.cache_dir.resolve().parents)
    return ((is_base or is_dataset)
            and all(path.is_file() for path in [state / "ente/runtime.json",
                upstream / "rust/target/debug/examples/photo_wall_lab",
                upstream / "mobile/.dart_tool/package_config.json",
                upstream / "mobile/apps/photos/lib/src/rust/frb_generated.dart",
                upstream / "mobile/packages/strings/lib/l10n/strings_localizations.dart"]))


def status(lab):
    state = _read_state(lab.state_dir / "ente" / "status.json")
    if not isinstance(state, dict) or state.get("dataset_id") != lab.dataset_id:
        state = {}
    result = None
    latest = _read_state(lab.state_dir / "ente" / "latest.json")
    if isinstance(latest, dict) and latest.get("dataset_id") == lab.dataset_id:
        try:
            candidate = lab.get_run(latest.get("run_id", ""))
            if candidate["result"].get("engine") == "ente-import" and candidate["result"].get("provenance", {}).get("mode") == "natural":
                result = candidate
        except (LabError, OSError, ValueError, TypeError):
            pass
    for row in lab.list_runs():
        if result is None and row.get("engine") == "ente-import":
            record = lab.get_run(row["id"])
            if (record["result"].get("signature", {}).get("dataset") == lab.dataset_id
                    and record["result"].get("provenance", {}).get("mode") == "natural"):
                result = record
                break
    return {"state": state.get("state", "not_ready"), "can_run": ready(lab),
            "message": state.get("message", "尚未完成 Ente 本机实跑。这里不会显示本项目的替代结果。"),
            "stage": state.get("stage", "等待运行环境"),
            "commit": state.get("commit"), "updated_at": state.get("updated_at"),
            "record": result}


def start(lab):
    global _job
    if not ready(lab):
        raise LabError("Ente 运行环境尚未完成准备，暂不能重跑；不会使用替代算法。")
    with _lock:
        if (_job is not None and _job.poll() is None) or status(lab)["state"] == "running":
            raise LabError("Ente 已在运行，请等待当前任务结束。")
        lab.ensure_sources_current()
        atomic_json(lab.state_dir / "ente/status.json", {"dataset_id":lab.dataset_id,
            "state":"running", "stage":"启动 Ente", "message":"正在启动本地独立引擎。",
            "updated_at":dt.datetime.now(TZ).isoformat()})
        log_path = lab.state_dir / "ente/runner.log"
        with log_path.open("w") as log:
            os.chmod(log_path,0o600)
            try:
                command=[sys.executable,"-u",str(ROOT / "tools/run_ente_lab.py"),
                    "--cache-dir",str(lab.cache_dir.resolve()),"--state-dir",str(lab.state_dir.resolve())]
                if lab.historical_path:
                    command.extend(["--historical",str(lab.historical_path.resolve())])
                _job = subprocess.Popen(command,
                    cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
            except OSError as error:
                atomic_json(lab.state_dir / "ente/status.json", {"dataset_id":lab.dataset_id,
                    "state":"failed", "stage":"启动失败", "message":"无法启动本地进程。"})
                raise LabError("无法启动 Ente 本地进程") from error
        threading.Thread(target=_watch, args=(lab, _job), daemon=True).start()
        return status(lab)


def _watch(lab, job):
    job.wait()
    with _lock:
        path = lab.state_dir / "ente/status.json"
        state = _read_state(path)
        if job is _job and state.get("state") == "running":
            atomic_json(path, {"dataset_id":lab.dataset_id, "state":"failed",
                "stage":"运行进程已结束", "message":"未产出完整新结果；以前的快照仍保留，可重试。",
                "updated_at":dt.datetime.now(TZ).isoformat()})


def latest_result(lab):
    value = status(lab)
    if value["record"] is None:
        raise LabError("尚无同一批照片的 Ente 结果；请等待原版运行完成，或导入实跑结果包。")
    return value["record"]

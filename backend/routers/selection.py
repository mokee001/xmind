"""Versioned upload contract; native metadata and files share one transaction."""
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path

from fastapi import File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from .. import unified_selection as selection

logger = logging.getLogger(__name__)


def validated_photo_suffix(data, filename, content_type):
    """Validate encoded bytes; an asset's display name is not its file format."""
    from PIL import Image

    suffix = Path(filename or '').suffix.lower()
    supported = {'JPEG': ('.jpg', '.jpeg'), 'PNG': ('.png',), 'HEIF': ('.heic', '.heif')}
    # Log format categories only: never filenames, asset IDs, bytes or EXIF.
    safe_suffix = suffix if suffix in {
        '.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.webp', '.dng',
        '.tif', '.tiff', '.bmp', '.avif', '.jxl', '',
    } else '[other]'
    safe_mime = content_type if content_type in {
        'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/gif',
        'image/webp', 'image/tiff', 'image/bmp', 'image/avif', 'application/octet-stream',
    } else '[other]'
    detected = 'unknown'
    try:
        with Image.open(io.BytesIO(data)) as image:
            detected = image.format
            if detected not in supported:
                raise HTTPException(422, '不支持的照片格式', headers={
                    'X-Photo-Error-Code': 'unsupported_photo_format',
                })
            image.verify()
        # JPEG verify() only checks headers; decode before accepting a file that
        # would otherwise stop the asynchronous worker with a truncated stream.
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except HTTPException:
        safe_format = detected if detected in {'GIF', 'WEBP', 'TIFF', 'BMP', 'AVIF', 'JPEG2000'} else '[other]'
        logger.warning('Photo upload rejected: code=unsupported_photo_format suffix=%s mime=%s format=%s',
                       safe_suffix, safe_mime, safe_format)
        raise
    except Exception:
        logger.warning('Photo upload rejected: code=unreadable_photo suffix=%s mime=%s format=%s',
                       safe_suffix, safe_mime, detected if detected in supported else 'unknown')
        raise HTTPException(422, '照片文件损坏或无法读取', headers={
            'X-Photo-Error-Code': 'unreadable_photo',
        })
    allowed_suffixes = supported[detected]
    if suffix in allowed_suffixes:
        return suffix
    logger.info('Photo upload filename normalized: suffix=%s mime=%s format=%s',
                safe_suffix, safe_mime, detected)
    return allowed_suffixes[0]


def normalized_region(region):
    """Intersect a real detection with the visible image, retaining its source box."""
    def reject(reason):
        logger.warning('Vision observation region rejected: %s', reason)
        raise ValueError('Invalid observation region')

    if not isinstance(region, dict):
        reject('not_object')
    box, score = region.get('box'), region.get('confidence')
    if (not isinstance(box, list) or len(box) != 4
            or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                       and math.isfinite(x) for x in box)):
        reject('invalid_coordinates')
    if not box[0] < box[2] or not box[1] < box[3]:
        reject('empty_or_reversed_box')
    if (not isinstance(score, (int, float)) or isinstance(score, bool)
            or not math.isfinite(score) or not 0 <= score <= 1):
        reject('invalid_confidence')
    visible = [max(0, box[0]), max(0, box[1]), min(1, box[2]), min(1, box[3])]
    if not visible[0] < visible[2] or not visible[1] < visible[3]:
        reject('outside_image')
    if visible == box:
        return region
    return {**region, 'box': visible, 'source_box': box}


def validate_observation(value):
    if not isinstance(value, dict) or value.get('error') or value.get('version') != 1:
        raise ValueError('Missing supported Vision observation')
    labels = value.get('labels')
    if not isinstance(labels, list) or not labels or len(labels) > 2000:
        raise ValueError('Incomplete Vision labels')
    for label in labels:
        score = label.get('confidence')
        if not isinstance(label.get('identifier'), str) or isinstance(score,bool) or not isinstance(score, (float,int)) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('Invalid Vision label')
    if not isinstance(value.get('faces'), int) or not 0 <= value['faces'] <= 500:
        raise ValueError('Invalid face observation count')
    normalized = dict(value)
    for key in ('face_regions','humans'):
        regions = value.get(key, [])
        if not isinstance(regions,list) or len(regions)>500:
            raise ValueError('Invalid observation regions')
        if key in value:
            normalized[key] = [normalized_region(region) for region in regions]
    return normalized


def register(app, account_scope, account_authorized=None):
    def authorize(token):
        if not token:
            raise HTTPException(401, '需要账户')
        if account_authorized is not None and not account_authorized(token):
            raise HTTPException(403, '请先连接有权限的照片墙')

    @app.post('/api/selection/upload')
    async def upload(files: list[UploadFile] = File(...), metadata: str = Form(...), sources: str = Form('["all"]'),
                     x_account_token: str = Header(default='')):
        authorize(x_account_token)
        try:
            if not (selection.runtime()/'production-ready.json').is_file():
                raise selection.SelectionUnavailable('正式选片运行环境尚未通过验收')
        except selection.SelectionUnavailable as e:
            raise HTTPException(503, str(e))
        if not 1 <= len(files) <= 4 or len(metadata) > 1000000:
            raise HTTPException(413, '上传批次过大')
        try:
            values = json.loads(metadata)
            if len(values) != len(files):
                raise ValueError('Metadata/file count mismatch')
            for item in values:
                if item.get('local_engine') != 'apple-vision-local-v1':
                    raise ValueError('Local strong-rule filtering required')
                item['vision'] = validate_observation(item.get('vision'))
        except (ValueError, TypeError, AttributeError) as e:
            raise HTTPException(422, str(e))
        try:
            scope = selection.library_scope(account_scope(x_account_token), json.loads(sources))
        except (ValueError, TypeError):
            raise HTTPException(422, '照片来源范围无效')
        root = selection.directory(scope)
        photo_dir = root/'photos'
        photo_dir.mkdir(exist_ok=True, mode=0o700)
        items = []
        for file, item in zip(files, values):
            data = await file.read(32*1024*1024+1)
            if not data or len(data) > 32*1024*1024:
                raise HTTPException(413, '照片大小不符合要求')
            sha = hashlib.sha256(data).hexdigest()
            # Content addressing avoids filename collisions across cameras/phones.
            suffix = validated_photo_suffix(data, file.filename, file.content_type)
            path = photo_dir/(sha+suffix)
            if not path.exists():
                with path.open('xb') as stream:
                    os.chmod(path, 0o600)
                    stream.write(data)
            items.append({'path':str(path.resolve()), 'sha256':sha, 'local_engine':item['local_engine'],
                          'vision':item['vision']})
        revision = selection.ingest(scope, items)
        return {'saved':len(items), 'contract':selection.CONTRACT, 'revision':revision}

    @app.post('/api/selection/session')
    def session(body: dict, x_account_token: str = Header(default='')):
        authorize(x_account_token)
        try:
            root = selection.runtime()
            if not (root/'production-ready.json').is_file():
                raise selection.SelectionUnavailable('正式选片运行环境尚未通过验收')
            scope = selection.library_scope(account_scope(x_account_token), body.get('sources',['all']))
            # Resume a persisted job after a server restart, without another upload.
            selection.enqueue(scope)
            return {'contract':selection.CONTRACT, 'scope':scope}
        except selection.SelectionUnavailable as error:
            raise HTTPException(503, str(error))
        except (ValueError, TypeError):
            raise HTTPException(422, '照片来源范围无效')

    @app.get('/api/selection/capabilities')
    def capabilities():
        try:
            root = selection.runtime()
            ready = (root/'production-ready.json').is_file()
        except selection.SelectionUnavailable:
            ready = False
        return {'contract':selection.CONTRACT, 'ready':ready, 'baseline_commit':selection.BASELINE}

    @app.post('/api/selection/content')
    def content(body: dict, x_account_token: str = Header(default='')):
        authorize(x_account_token)
        try:
            scope = selection.library_scope(account_scope(x_account_token), body.get('sources',['all']))
        except (ValueError, TypeError):
            raise HTTPException(422, '照片来源范围无效')
        try:
            result = selection.candidates(scope)
        except selection.SelectionUnavailable:
            return {'total':0,'goodTotal':0,'peopleAvailable':False,'people':[],'albums':[]}
        library = selection.read(selection.directory(scope)/'library.json', {})
        return {'total':len(library.get('photos',{})), 'goodTotal':len(result['photos']),
                'peopleAvailable':result['phase']=='canonical',
                'people':[{**p,'cover':f'/api/selection/thumb/{scope}/{p["cover"]}'} for p in result.get('people',[])],
                'albums':[{'id':a['id'], 'label':a.get('title','精选'), 'count':len(a['photo_ids']),
                           'group':'精选', 'filter':['collection_'+a['id']]} for a in result.get('albums',[])]}

    @app.get('/api/selection/thumb/{scope}/{sha}')
    def thumbnail(scope: str, sha: str, x_account_token: str = Header(default='')):
        account = account_scope(x_account_token) if x_account_token else ''
        if not account or not scope.startswith(account+'-'):
            raise HTTPException(403, '无权访问照片')
        import re
        if not re.fullmatch(r'[a-f0-9]{64}', sha):
            raise HTTPException(404, '照片不存在')
        try:
            result = selection.candidates(scope)
            photo = next((p for p in result['photos'] if p['sha256']==sha), None)
            if not photo:
                raise selection.SelectionUnavailable('照片不存在')
        except selection.SelectionUnavailable as error:
            raise HTTPException(404, str(error))
        import io
        from PIL import Image, ImageOps
        with Image.open(photo['path']) as image:
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((200,200))
            buffer = io.BytesIO()
            image.save(buffer, format='JPEG', quality=80)
        return Response(buffer.getvalue(), media_type='image/jpeg', headers={'Cache-Control':'private, no-store'})

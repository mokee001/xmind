"""Versioned upload contract; native metadata and files share one transaction."""
import hashlib
import io
import json
import math
import os
from pathlib import Path

from fastapi import File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from .. import unified_selection as selection


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
    for key in ('face_regions','humans'):
        regions = value.get(key, [])
        if not isinstance(regions,list) or len(regions)>500:
            raise ValueError('Invalid observation regions')
        for region in regions:
            box, score = region.get('box'), region.get('confidence')
            if (not isinstance(box,list) or len(box)!=4 or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in box)
                    or not 0<=box[0]<box[2]<=1 or not 0<=box[1]<box[3]<=1
                    or not isinstance(score,(int,float)) or not math.isfinite(score) or not 0<=score<=1):
                raise ValueError('Invalid observation region')
    return value


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
                validate_observation(item.get('vision'))
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
            suffix = Path(file.filename or '').suffix.lower()
            if suffix not in {'.jpg','.jpeg','.heic','.heif','.png'}:
                raise HTTPException(422, '不支持的照片格式')
            from PIL import Image
            try:
                with Image.open(io.BytesIO(data)) as image:
                    image.verify()
            except Exception:
                raise HTTPException(422, '照片文件损坏或无法读取')
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

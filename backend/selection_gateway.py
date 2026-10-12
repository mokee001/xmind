"""Additive rollout lane for the existing production backend.

Only requests explicitly carrying the new contract are routed here. Existing
device/BLE/Wi-Fi/publish handlers remain in the deployed service unchanged.
Both lanes use the same account resolver, renderer, output and last-wall store.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import server as existing
from . import unified_selection as selection
from .routers.selection import register

app = FastAPI(title='PhotoWall unified selection rollout')
register(app, existing._account_scope,
         lambda token:any(existing._account_auth(device,token) for device in existing._devices().values()))
_generation_lock = None
logger = logging.getLogger(__name__)


def _selection_failure(error, phase):
    reason = str(error)
    pending = {
        '尚无当前账户的合格照片': 'selection_pending',
        '照片尚未完成初筛，请稍后重试': 'selection_pending',
        '当前展示范围内合格照片不足；不会补入未入选或被排除的照片': 'insufficient_candidates',
    }
    if reason in pending:
        return {'code': pending[reason], 'retryable': True}
    if reason == '人物识别分组已变化或尚未完成，请重新确认人物偏好；未忽略原有范围':
        waiting = phase == 'provisional'
        return {'code': 'people_pending' if waiting else 'people_selection_changed', 'retryable': waiting}
    return {'code': 'selection_invalid', 'retryable': False}


def _generation_rejection(req, detail, failure, diagnostics, template):
    """Log categories/counts only; never include the request or error text."""
    counts = {
        'code': failure['code'], 'retryable': failure['retryable'],
        'phase': diagnostics.get('phase', 'unknown'),
        'stage': diagnostics.get('stage', 'selection'),
        'template': template if template in ('auto', 'template_1', 'template_2', 'template_3') else 'other',
        'candidate_count': diagnostics.get('candidate_count'),
        'required_count': diagnostics.get('required_count'),
        'source_type': 'all' if 'all' in req.selection_sources else 'scoped',
        'source_count': 1 if 'all' in req.selection_sources else len(set(req.selection_sources)),
        'preferred_count': len(req.filters),
        'preferred_person_count': sum(tag.startswith('person_') for tag in req.filters),
        'excluded_count': len(req.exclude_filters),
        'excluded_person_count': sum(tag.startswith('person_') for tag in req.exclude_filters),
    }
    logger.warning('Generation rejected: %s', json.dumps(counts, sort_keys=True))
    return JSONResponse(status_code=409, content={'detail': detail, **failure})


class GenerateRequest(BaseModel):
    selection_contract: str
    selection_sources: list[str] = Field(default_factory=lambda:['all'])
    template: str = 'auto'
    title: str = '今日精选'
    date: str = ''
    filters: list[str] = Field(default_factory=list)
    exclude_filters: list[str] = Field(default_factory=list)
    device_id: str
    preference_revision_id: str = ''


def _selection_request(req, token):
    if req.selection_contract != selection.CONTRACT:
        raise HTTPException(409, '不支持的选片链路版本')
    device = existing._devices().get(req.device_id)
    auth = getattr(existing, '_device_publish_auth', existing._account_auth)
    if not device or not auth(device, token):
        raise HTTPException(403, '设备授权无效')
    try:
        ready = (selection.runtime()/'production-ready.json').is_file()
    except selection.SelectionUnavailable as error:
        raise HTTPException(503, str(error)) from error
    if not ready:
        raise HTTPException(503, '正式选片服务尚未完成验收')
    account = existing._account_scope(token)
    try:
        scope = selection.library_scope(account, req.selection_sources)
    except selection.SelectionUnavailable as error:
        raise HTTPException(422, str(error)) from error
    template = 'template_1' if req.template == 'auto' else req.template
    # No retired layouts, minimum-count fallbacks, or placeholder cutouts.
    if template not in ('template_1','template_2','template_3'):
        raise HTTPException(409, '模板不适用于此生成链路')
    if not existing.template_packages.is_package(template):
        raise HTTPException(503, '当前服务器尚未部署此模板')
    return account, scope, template


def _select_requested_wall(req, account, scope, template, snapshot=None, diagnostics=None):
    count = existing.template_packages.required_photo_count(template)
    if diagnostics is not None:
        diagnostics['required_count'] = count
    if snapshot is None:
        snapshot = selection.candidates(scope)
    if diagnostics is not None:
        diagnostics['phase'] = snapshot.get('phase') if snapshot.get('phase') in ('provisional', 'canonical') else 'unknown'
        diagnostics['candidate_count'] = len(snapshot['photos'])
    history_key = existing._scoped_store_name('recent_shown', account)
    recent = existing.store.load(history_key, [])
    chosen, provenance = selection.select(scope, count, prefer=req.filters,
        exclude=req.exclude_filters, avoid=recent, snapshot=snapshot)
    return chosen, provenance, history_key, recent, count


@app.post('/api/selection/readiness')
def readiness(req: GenerateRequest, x_account_token: str = Header(default='')):
    """Check the real generation selector, without rendering or publishing.

    Ready is advisory: generation validates again after any intervening library
    or preference changes. A raw candidate count cannot prove filter readiness.
    """
    account, scope, template = _selection_request(req, x_account_token)
    snapshot = None
    try:
        snapshot = selection.candidates(scope)
        _, provenance, _, _, _ = _select_requested_wall(req, account, scope, template, snapshot)
    except selection.SelectionUnavailable as error:
        failure = _selection_failure(error, snapshot.get('phase') if snapshot else None)
        return {'contract': selection.CONTRACT, 'ready': False,
                'reason': str(error), **failure}
    return {'contract': selection.CONTRACT, 'ready': True,
            'snapshot_id': provenance.get('snapshot_id'),
            'input_revision': provenance.get('input_revision')}


@app.post('/api/generate')
async def generate(req: GenerateRequest, x_account_token: str = Header(default='')):
    global _generation_lock
    if _generation_lock is None:
        _generation_lock = asyncio.Lock()
    diagnostics = {'stage': 'request'}
    try:
        account, scope, template = _selection_request(req, x_account_token)
    except HTTPException as error:
        if error.status_code != 409:
            raise
        code = ('selection_contract_invalid' if error.detail == '不支持的选片链路版本'
                else 'template_unavailable')
        return _generation_rejection(req, error.detail, {'code': code, 'retryable': False}, diagnostics, req.template)
    async with _generation_lock:
        diagnostics['stage'] = 'selection'
        try:
            chosen, provenance, history_key, recent, count = _select_requested_wall(req, account, scope, template, diagnostics=diagnostics)
            diagnostics['stage'] = 'render'
            image = await asyncio.to_thread(existing.template_packages.render, template,
                [p['path'] for p in chosen], {'title':req.title,'date':req.date,'nickname':req.title})
        except (selection.SelectionUnavailable, ValueError, FileNotFoundError) as error:
            if isinstance(error, selection.SelectionUnavailable):
                failure = _selection_failure(error, diagnostics.get('phase'))
            else:
                code = 'render_dependency_missing' if isinstance(error, FileNotFoundError) else 'render_failed'
                failure = {'code': code, 'retryable': False}
            return _generation_rejection(req, str(error), failure, diagnostics, template)
        wall_id = f'{account}_{template}_{time.time_ns()}'
        filename = wall_id+'.png'
        await asyncio.to_thread(image.save, Path(existing.OUTPUT_DIR)/filename)
        wall = {'wall_id':wall_id,'template':template,'title':req.title,'date':req.date,
                'image_url':'/output/'+filename,'elements':sorted({t for p in chosen for t in p.get('tags',[])}),
                'filters':req.filters,'exclude_filters':req.exclude_filters,'filter_fallback':False,
                'selection_provenance':provenance,'preference_revision_id':req.preference_revision_id,
                'chosen':[{'filename':p['filename'],'final_score':p.get('final_score')} for p in chosen],
                'stickers':0}
        existing.store.save(existing._scoped_store_name('last_wall',account),wall)
        existing.store.save(history_key,([p['filename'] for p in chosen]+recent)[:max(20,count*2)])
        # Generation is preview only. Existing publish + real device ACK remain
        # authoritative; this worker never invents a displayed event.
        return wall


@app.get('/healthz')
def health():
    return {'status':'ok','contract':selection.CONTRACT}

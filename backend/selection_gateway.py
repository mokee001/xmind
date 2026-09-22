"""Additive rollout lane for the existing production backend.

Only requests explicitly carrying the new contract are routed here. Existing
device/BLE/Wi-Fi/publish handlers remain in the deployed service unchanged.
Both lanes use the same account resolver, renderer, output and last-wall store.
"""
import asyncio
import os
from pathlib import Path
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import server as existing
from . import unified_selection as selection
from .routers.selection import register

app = FastAPI(title='PhotoWall unified selection rollout')
register(app, existing._account_scope,
         lambda token:any(existing._account_auth(device,token) for device in existing._devices().values()))
_generation_lock = None


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


@app.post('/api/generate')
async def generate(req: GenerateRequest, x_account_token: str = Header(default='')):
    global _generation_lock
    if _generation_lock is None:
        _generation_lock = asyncio.Lock()
    if req.selection_contract != selection.CONTRACT:
        raise HTTPException(409, '不支持的选片链路版本')
    device = existing._devices().get(req.device_id)
    auth = getattr(existing, '_device_publish_auth', existing._account_auth)
    if not device or not auth(device, x_account_token):
        raise HTTPException(403, '设备授权无效')
    if not (selection.runtime()/'production-ready.json').is_file():
        raise HTTPException(503, '正式选片服务尚未完成验收')
    account = existing._account_scope(x_account_token)
    scope = selection.library_scope(account, req.selection_sources)
    template = 'template_1' if req.template == 'auto' else req.template
    # No retired layouts, minimum-count fallbacks, or placeholder cutouts.
    if template not in ('template_1','template_2','template_3'):
        raise HTTPException(409, '模板不适用于此生成链路')
    if not existing.template_packages.is_package(template):
        raise HTTPException(503, '当前服务器尚未部署此模板')
    async with _generation_lock:
        try:
            count = existing.template_packages.required_photo_count(template)
            snapshot = selection.candidates(scope)
            history_key = existing._scoped_store_name('recent_shown', account)
            recent = existing.store.load(history_key, [])
            chosen, provenance = selection.select(scope, count, prefer=req.filters,
                exclude=req.exclude_filters, avoid=recent, snapshot=snapshot)
            image = await asyncio.to_thread(existing.template_packages.render, template,
                [p['path'] for p in chosen], {'title':req.title,'date':req.date,'nickname':req.title})
        except (selection.SelectionUnavailable, ValueError, FileNotFoundError) as error:
            raise HTTPException(409, str(error))
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

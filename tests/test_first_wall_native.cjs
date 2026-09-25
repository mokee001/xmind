const test = require('node:test');
const assert = require('node:assert/strict');
const { runFirstWall } = require('../photo-wall-app/src/firstWall.cjs');
function fixture(saved = {}, device = {device_id:'d', revision:''}) {
  const calls=[]; let state=structuredClone(saved), live=device;
  return { calls, state:()=>state, setDevice:v=>live=v, deps:{
    load:async()=>state, save:async v=>{state=structuredClone(v);calls.push('save:'+v.state)},
    readDevice:async()=>{calls.push('read');return live},
    prepare:async()=>calls.push('prepare'), generate:async()=>{calls.push('generate');return {wall_id:'w',image_url:'/w.png'}},
    publish:async()=>{calls.push('publish'); live={device_id:'d',revision:'r',displayed_revision:'r'};return {device:live,revision:'r'}},
    stage:v=>calls.push(v), sleep:async()=>{}, polls:2,
  }};
}
test('first connection automatically prepares, generates, publishes and requires matching receipt',async()=>{
  const f=fixture();await runFirstWall(f.deps);assert.equal(f.state().state,'done');
  assert.ok(f.calls.indexOf('save:publishing')<f.calls.indexOf('publish'));
  assert.deepEqual(f.calls.filter(x=>['prepare','generate','publish','done'].includes(x)),['prepare','generate','publish','done']);
});
test('accepted publication alone times out; retry checks receipt without uploading or republishing',async()=>{
  const f=fixture({state:'waiting',revision:'r'},{revision:'r',displayed_revision:'old'});
  await assert.rejects(runFirstWall(f.deps),/还未收到/);assert.ok(!f.calls.includes('done'));
  f.setDevice({revision:'r',displayed_revision:'r'});await runFirstWall(f.deps);
  assert.ok(!f.calls.includes('publish'));assert.equal(f.state().state,'done');
});
test('old connected empty home gets first wall',async()=>{const f=fixture();await runFirstWall(f.deps);assert.ok(f.calls.includes('publish'))});
test('changed binding stops before generating/publishing',async()=>{
 const f=fixture();let active=true;await assert.rejects(runFirstWall({...f.deps,active:()=>active,prepare:async()=>{active=false}}),/暂停/);assert.ok(!f.calls.includes('publish'));
});
test('uncertain dispatch survives relaunch, never blindly publishes a duplicate',async()=>{
 const f=fixture({state:'publishing',wallId:'w',beforeRevision:''});await assert.rejects(runFirstWall(f.deps),/发送结果未确认/);assert.ok(!f.calls.includes('publish'));
 f.setDevice({revision:'r',displayed_revision:'r'});await runFirstWall(f.deps);assert.equal(f.state().state,'done');
});
test('worker not ready retries boundedly, non-readiness errors propagate',async()=>{
 const f=fixture();let n=0;await runFirstWall({...f.deps,generate:async()=>{if(++n<3)throw Object.assign(Error('照片尚未完成初筛'),{status:409});return {wall_id:'w',image_url:'/w'}}});assert.equal(n,3);
 const g=fixture();await assert.rejects(runFirstWall({...g.deps,generate:async()=>{throw Object.assign(Error('人物识别分组已变化'),{status:409})}}),/人物/);assert.ok(!g.calls.includes('publish'));
});
test('error receipt and unrelated revision never count as success',async()=>{
 for(const device of [{revision:'r',displayed_revision:'r',error:'failed'},{revision:'other',displayed_revision:'other'}]){const f=fixture({state:'waiting',revision:'r'},device);await assert.rejects(runFirstWall(f.deps));assert.ok(!f.calls.includes('done'))}
});

test('explicit resend of an uncertain empty screen escapes interruption without an automatic duplicate',async()=>{
 const f=fixture({state:'publishing',wallId:'w',beforeRevision:''}); await runFirstWall({...f.deps,retryUncertain:true});assert.equal(f.calls.filter(x=>x==='publish').length,1);assert.equal(f.state().state,'done');
});
test('worker readiness retries stop and only request one additional bounded batch',async()=>{
 const f=fixture();let attempts=0,batches=0;await assert.rejects(runFirstWall({...f.deps,prepare:async()=>{batches++},generate:async()=>{attempts++;throw Object.assign(Error('合格照片不足'),{status:409})}}),/不足/);assert.equal(attempts,24);assert.equal(batches,2);assert.ok(!f.calls.includes('publish'));
});
test('failed intent persistence prevents publication',async()=>{
 const f=fixture();await assert.rejects(runFirstWall({...f.deps,save:async()=>{throw Error('storage unavailable')}}),/storage/);assert.ok(!f.calls.includes('publish'));
});
test('explicit recovery from device failure prepares a new wall rather than rereading the failed revision forever',async()=>{
 const f=fixture({state:'waiting',revision:'old'},{revision:'old',state:'failed',error:'download'});
 await runFirstWall({...f.deps,retryUncertain:true});assert.ok(f.calls.includes('publish'));assert.equal(f.state().state,'done');
});

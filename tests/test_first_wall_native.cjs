const test = require('node:test');
const assert = require('node:assert/strict');
const { runFirstWall, needsFirstWallRun } = require('../photo-wall-app/src/firstWall.cjs');
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
test('legacy server people_pending retries without extra uploads and publishes exactly once',async()=>{
 const f=fixture();let attempts=0,batches=0;const sleeps=[];
 await runFirstWall({...f.deps,prepare:async()=>{batches++},sleep:async ms=>sleeps.push(ms),
  generate:async()=>{
   if(++attempts<8)throw Object.assign(Error('人物分组正在完成'),{status:409,data:{code:'people_pending',retryable:true}});
   return {wall_id:'w',image_url:'/w'};
  }});
 assert.equal(attempts,8);assert.equal(batches,1);assert.deepEqual(sleeps,Array(7).fill(5000));
 assert.equal(f.calls.filter(x=>x==='publish').length,1);assert.equal(f.state().state,'done');
});
test('terminal or legacy person error containing 尚未完成 stops immediately with the original reason',async()=>{
 const reason='人物识别分组已变化或尚未完成，请重新确认人物偏好；未忽略原有范围';
 for(const data of [{code:'people_changed',retryable:false},undefined]){
  const f=fixture();let attempts=0,sleeps=0;
  const rejected=Object.assign(Error(reason),{status:409,...(data ? {data} : {})});
  await assert.rejects(runFirstWall({...f.deps,generate:async()=>{attempts++;throw rejected},sleep:async()=>sleeps++}),error=>error===rejected);
  assert.equal(attempts,1);assert.equal(sleeps,0);assert.equal(f.calls.filter(x=>x==='prepare').length,1);
  assert.ok(!f.calls.includes('publish'));assert.deepEqual(f.state(),{});
 }
});
test('old servers retry only the three exact known lack-of-data reasons',async()=>{
 for(const reason of ['尚无当前账户的合格照片','照片尚未完成初筛，请稍后重试','当前展示范围内合格照片不足；不会补入未入选或被排除的照片']){
  const f=fixture();let attempts=0;
  await runFirstWall({...f.deps,generate:async()=>{
   if(++attempts===1)throw Object.assign(Error(reason),{status:409});
   return {wall_id:'w',image_url:'/w'};
  }});
  assert.equal(attempts,2);assert.equal(f.calls.filter(x=>x==='publish').length,1);
 }
});
test('explicit false and invalid retryability never fall back to a matching legacy reason',async()=>{
 for(const retryable of [false,'true',1,null]){
  const f=fixture();let attempts=0;
  const rejected=Object.assign(Error('照片尚未完成初筛，请稍后重试'),{status:409,data:{retryable}});
  await assert.rejects(runFirstWall({...f.deps,generate:async()=>{attempts++;throw rejected}}),error=>error===rejected);
  assert.equal(attempts,1);assert.ok(!f.calls.includes('publish'));
 }
});
test('non-409 errors and unrecognized legacy messages cannot trigger generation retries',async()=>{
 for(const fields of [
  {status:503,data:{retryable:true},message:'照片尚未完成初筛，请稍后重试'},
  {status:409,message:'初筛快照与账户、规则或输入不符'},
  {status:409,message:'照片尚未完成初筛，请稍后重试（其他错误）'},
 ]){
  const f=fixture();let attempts=0;const rejected=Object.assign(Error(fields.message),fields);
  await assert.rejects(runFirstWall({...f.deps,generate:async()=>{attempts++;throw rejected}}),error=>error===rejected);
  assert.equal(attempts,1);assert.ok(!f.calls.includes('publish'));
 }
});
test('error receipt and unrelated revision never count as success',async()=>{
 for(const device of [{revision:'r',displayed_revision:'r',error:'failed'},{revision:'other',displayed_revision:'other'}]){const f=fixture({state:'waiting',revision:'r'},device);await assert.rejects(runFirstWall(f.deps));assert.ok(!f.calls.includes('done'))}
});

test('explicit resend of an uncertain empty screen escapes interruption without an automatic duplicate',async()=>{
 const f=fixture({state:'publishing',wallId:'w',beforeRevision:''}); await runFirstWall({...f.deps,retryUncertain:true});assert.equal(f.calls.filter(x=>x==='publish').length,1);assert.equal(f.state().state,'done');
});
test('24 retryable failures stop with the exact last error and only one additional preparation',async()=>{
 const f=fixture();let attempts=0,batches=0,lastError;const sleeps=[];
 await assert.rejects(runFirstWall({...f.deps,prepare:async()=>{batches++},sleep:async ms=>sleeps.push(ms),
  generate:async()=>{
   attempts++;lastError=Object.assign(Error('当前展示范围内合格照片不足；不会补入未入选或被排除的照片'),{status:409,data:{code:'insufficient_candidates',retryable:true}});
   throw lastError;
  }}),error=>error===lastError);
 assert.equal(attempts,24);assert.equal(batches,2);assert.deepEqual(sleeps,Array(23).fill(5000));
 assert.ok(!f.calls.includes('publish'));assert.deepEqual(f.state(),{});
});
test('failed intent persistence prevents publication',async()=>{
 const f=fixture();await assert.rejects(runFirstWall({...f.deps,save:async()=>{throw Error('storage unavailable')}}),/storage/);assert.ok(!f.calls.includes('publish'));
});
test('explicit recovery from device failure prepares a new wall rather than rereading the failed revision forever',async()=>{
 const f=fixture({state:'waiting',revision:'old'},{revision:'old',state:'failed',error:'download'});
 await runFirstWall({...f.deps,retryUncertain:true});assert.ok(f.calls.includes('publish'));assert.equal(f.state().state,'done');
});
test('background receipt reconciles a paused visible attempt instead of leaving its spinner mounted',async()=>{
 const device={revision:'r',displayed_revision:'r'};
 assert.equal(needsFirstWallRun({visibleState:'waiting',savedState:'waiting',device}),true);
 const f=fixture({state:'waiting',revision:'r'},device);await runFirstWall(f.deps);
 assert.equal(f.calls.at(-1),'done');assert.equal(f.state().state,'done');assert.ok(!f.calls.includes('publish'));
 assert.equal(needsFirstWallRun({visibleState:'done',savedState:'done',device}),false);
});
test('persisted completion converges paused UI without republishing; unrelated receipt still fails exact revision check',async()=>{
 const device={revision:'r',displayed_revision:'r'};
 assert.equal(needsFirstWallRun({visibleState:'preparing',savedState:'done',device}),true);
 const done=fixture({state:'done',revision:'r'},device);await runFirstWall(done.deps);
 assert.equal(done.calls.at(-1),'done');assert.ok(!done.calls.includes('publish'));
 const unrelated={revision:'other',displayed_revision:'other'};
 assert.equal(needsFirstWallRun({visibleState:'waiting',savedState:'waiting',device:unrelated}),true);
 const waiting=fixture({state:'waiting',revision:'r'},unrelated);await assert.rejects(runFirstWall(waiting.deps),/画面已变化/);
 assert.ok(!waiting.calls.includes('done'));
});

const status = action => ({contract:'unified-recollections-v1', action, ready:action === 'generate', retryable:action !== 'review'});
test('active worker can wait longer than 24 polls with one preparation and one generation', async()=>{
 const f=fixture();let checks=0,batches=0;
 await runFirstWall({...f.deps, readiness:async()=>{
  checks++;return status(checks === 1 ? 'upload' : checks < 34 ? 'wait' : 'generate');
 },prepare:async()=>{batches++}});
 assert.equal(checks,34);assert.equal(batches,1);
 assert.equal(f.calls.filter(x=>x==='generate').length,1);assert.equal(f.calls.filter(x=>x==='publish').length,1);
});
test('resumed pending people uses read-only checks and no preparation',async()=>{
 const f=fixture();let checks=0;
 await runFirstWall({...f.deps,readiness:async()=>({...status(++checks < 4 ? 'wait':'generate'),code:'people_pending'})});
 assert.ok(!f.calls.includes('prepare'));assert.equal(f.calls.filter(x=>x==='generate').length,1);
});
test('restart resumes interrupted processing once without reuploading',async()=>{
 const f=fixture();let checks=0,resumes=0;
 await runFirstWall({...f.deps,readiness:async()=>({...status(++checks < 4 ? 'wait':'generate'),resumeRequired:true}),resume:async()=>{resumes++}});
 assert.equal(resumes,1);assert.ok(!f.calls.includes('prepare'));assert.equal(f.calls.filter(x=>x==='generate').length,1);
});
test('only explicit upload readiness requests a bounded additional batch',async()=>{
 const f=fixture();const actions=['upload','wait','upload','wait','generate'],batches=[];
 await runFirstWall({...f.deps,readiness:async()=>status(actions.shift()),prepare:async options=>batches.push(options)});
 assert.deepEqual(batches,[{additional:false},{additional:true}]);assert.equal(f.calls.filter(x=>x==='generate').length,1);
});
test('current completed people mismatch immediately asks review, without upload or generation',async()=>{
 const f=fixture();await assert.rejects(runFirstWall({...f.deps,readiness:async()=>({...status('review'),
  code:'people_selection_changed',reason:'重新确认人物偏好',currentRevisionComplete:true})}),
  error=>error.code==='people_selection_changed'&&error.data.retryable===false);
 assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('generate'));assert.ok(!f.calls.includes('publish'));
});
test('a generation race returns to readiness polling without another upload',async()=>{
 const f=fixture();let checks=0,generates=0;
 await runFirstWall({...f.deps,readiness:async()=>status(++checks===2?'wait':'generate'),generate:async()=>{
  if(++generates===1)throw Object.assign(Error('pending'),{status:409,data:{code:'people_pending',retryable:true}});
  return {wall_id:'w',image_url:'/w'};
 }});
 assert.equal(checks,3);assert.equal(generates,2);assert.ok(!f.calls.includes('prepare'));assert.equal(f.calls.filter(x=>x==='publish').length,1);
});
test('readiness wait has a bounded processing timeout without false network blame',async()=>{
 const f=fixture();let checks=0;
 await assert.rejects(runFirstWall({...f.deps,preparationPolls:3,readiness:async()=>{checks++;return status('wait')}}),
  error=>error.code==='selection_timed_out'&&!error.message.includes('检查网络'));
 assert.equal(checks,3);assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('generate'));
});
test('insufficient library cannot schedule unbounded additional upload batches',async()=>{
 const f=fixture();let batches=0;
 await assert.rejects(runFirstWall({...f.deps,maxPreparationBatches:2,readiness:async()=>status('upload'),prepare:async()=>{batches++}}),
  error=>error.code==='insufficient_candidates');
 assert.equal(batches,2);assert.ok(!f.calls.includes('generate'));
});
test('scope cancellation during readiness or sleep prevents later work',async()=>{
 for(const cancelAt of ['readiness','sleep']) {
  const f=fixture();let active=true;
  await assert.rejects(runFirstWall({...f.deps,active:()=>active,readiness:async()=>{
   if(cancelAt==='readiness')active=false;return status('wait');
  },sleep:async()=>{active=false}}),/暂停/);
  assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('generate'));assert.ok(!f.calls.includes('publish'));
 }
});
test('invalid generation output never falls back to another upload attempt',async()=>{
 const f=fixture();await assert.rejects(runFirstWall({...f.deps,readiness:async()=>status('generate'),generate:async()=>null}),/有效画面/);
 assert.ok(!f.calls.includes('prepare'));assert.ok(!f.calls.includes('publish'));
});
test('persisted publication reconciliation bypasses readiness entirely',async()=>{
 const f=fixture({state:'waiting',revision:'r'},{revision:'r',displayed_revision:'r'});
 await runFirstWall({...f.deps,readiness:async()=>{throw Error('must not re-read readiness')}});
 assert.equal(f.state().state,'done');assert.ok(!f.calls.includes('generate'));
});

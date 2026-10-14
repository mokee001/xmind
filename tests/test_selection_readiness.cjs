const test=require('node:test');const assert=require('node:assert/strict');
const {createReadinessProbe,generationPayload,SELECTION_CONTRACT}=require('../photo-wall-app/src/selectionReadiness.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const waiting={contract:SELECTION_CONTRACT,ready:false,retryable:true};

test('readiness and generate share every template/preference/source field',()=>{
  const payload=generationPayload({template:'denim_pet',title:'a',filters:['p1'],excludeFilters:['p2'],deviceId:'d',preferenceRevisionId:'r',selectionSources:['album']});
  assert.deepEqual(payload,{template:'denim_pet',title:'a',filters:['p1'],exclude_filters:['p2'],device_id:'d',preference_revision_id:'r',selection_contract:SELECTION_CONTRACT,selection_sources:['album']});
  assert.equal(generationPayload({},false).selection_contract,undefined);
});
test('poll is nonblocking, joins pending check, and throttles retries',async()=>{
  const gate=deferred();let calls=0,clock=0;
  const probe=createReadinessProbe({check:()=>{calls++;return gate.promise},now:()=>clock});
  assert.equal(probe.poll(),false);assert.equal(probe.poll(),false);
  gate.resolve(waiting);await probe.refresh();assert.equal(calls,1);
  assert.equal(probe.poll(),false);assert.equal(calls,1);
  clock=2001;probe.poll();await probe.refresh();assert.equal(calls,2);
});
test('only server ready stops; false remains retryable; closed check cannot publish late readiness',async()=>{
  let response=waiting;const probe=createReadinessProbe({check:async()=>response});
  assert.equal(await probe.refresh(),false);response={contract:SELECTION_CONTRACT,ready:true};
  assert.equal(await probe.refresh(),true);assert.equal(probe.poll(),true);
  const gate=deferred();const stale=createReadinessProbe({check:()=>gate.promise});
  const pending=stale.refresh();stale.close();gate.resolve(response);assert.equal(await pending,false);
});
test('404 disables optimization and network failures retain original bounded path',async()=>{
  let calls=0;const old=createReadinessProbe({check:async()=>{calls++;throw Object.assign(Error('old'),{status:404})}});
  assert.equal(await old.refresh(),false);assert.equal(await old.refresh(),false);assert.equal(calls,1);
  const offline=createReadinessProbe({check:async()=>{throw Error('offline')}});
  assert.equal(await offline.refresh(),false);
});
test('401/403 and terminal preference errors propagate; invalid contract is never ready',async()=>{
  for(const status of [401,403]) {
    const probe=createReadinessProbe({check:async()=>{throw Object.assign(Error('auth'),{status})}});
    await assert.rejects(probe.refresh(),{status});assert.throws(()=>probe.poll(),{status});
  }
  const preference=createReadinessProbe({check:async()=>({...waiting,retryable:false,reason:'invalid person'})});
  await assert.rejects(preference.refresh(),/invalid person/);
  const wrong=createReadinessProbe({check:async()=>({ready:true,contract:'old'})});await assert.rejects(wrong.refresh(),/版本不匹配/);
});
test('inactive or cancelled requests cannot start or change readiness',async()=>{
  let active=false,calls=0;const probe=createReadinessProbe({active:()=>active,check:async()=>{calls++;return {contract:SELECTION_CONTRACT,ready:true}}});
  assert.equal(await probe.refresh(),false);assert.equal(calls,0);
  active=true;assert.equal(await probe.refresh(),true);active=false;assert.equal(probe.poll(),false);
});

test('read exposes structured action and revalidates a previously ready response',async()=>{
 let response={...waiting,action:'wait',code:'people_pending',workerActive:true};
 const probe=createReadinessProbe({check:async()=>response});
 assert.deepEqual(await probe.read(),response);assert.equal(probe.pauseUploads(),false);
 response={...waiting,ready:true,action:'generate'};assert.deepEqual(await probe.read(),response);
 response={...waiting,action:'upload'};assert.deepEqual(await probe.read(),response);
 assert.equal(probe.pauseUploads(),false);
});
test('readiness transport failure waits without authorizing upload or stale generation',async()=>{
 let fail=false;const probe=createReadinessProbe({check:async()=>{
  if(fail)throw Error('offline');return {...waiting,ready:true,action:'generate'};
 }});
 assert.equal((await probe.read()).action,'generate');fail=true;
 assert.equal((await probe.read()).action,'wait');assert.equal(probe.pauseUploads(),true);
});
test('only a verified legacy 404 permits fallback; a fresh transport failure waits',async()=>{
 const old=createReadinessProbe({check:async()=>{throw Object.assign(Error('old'),{status:404})}});
 assert.equal(await old.read(),null);
 const network=createReadinessProbe({check:async()=>{throw Error('network')}});
 assert.equal((await network.read()).action,'wait');
});

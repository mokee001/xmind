const test = require('node:test');
const assert = require('node:assert/strict');
const {createPhotoPrewarm,createPrewarmOwner,prewarmContextKey} = require('../photo-wall-app/src/photoPrewarm.cjs');
const deferred = () => {let resolve,reject; const promise=new Promise((r,j)=>{resolve=r;reject=j}); return {promise,resolve,reject};};
const assets=[{id:'a',modificationTime:1},{id:'b',modificationTime:2}];

test('first unbound account claim keeps cache; different account and logout isolate it', async () => {
  const owner=createPrewarmOwner(); let calls=0;
  const cache=createPhotoPrewarm({curate:async list=>{calls++;return list},observe:async()=>null});
  const context = account => prewarmContextKey({owner:owner(account),sources:['all'],permission:{status:'granted',accessPrivileges:'all'}});
  const unbound=context('');
  const warmed=await cache.curate(unbound,assets);
  assert.equal(context('account-a'),unbound);
  assert.equal(await cache.curate(context('account-a'),assets),warmed);
  assert.equal(calls,1);
  await cache.curate(context('account-b'),assets); assert.equal(calls,2);
  const loggedOut=context(''); assert.notEqual(loggedOut,unbound);
  await cache.curate(loggedOut,assets); assert.equal(calls,3);
});

test('same in-flight native work is joined, and observation keeps original URI', async () => {
  const gate=deferred(); let calls=0; const uris=[];
  const cache=createPhotoPrewarm({curate:async()=>{calls++;return gate.promise},observe:async uri=>{uris.push(uri);return {original:true}}});
  const warm=cache.curate('a',assets), foreground=cache.curate('a',assets);
  assert.equal(warm,foreground); gate.resolve({candidates:[{id:'b'},{id:'a'}]});
  assert.deepEqual((await foreground).candidates.map(a=>a.id),['b','a']); assert.equal(calls,1);
  await cache.observe('a',assets[0],'file:///original.heic');
  await cache.observe('a',assets[0],'file:///original.heic');
  assert.deepEqual(uris,['file:///original.heic']);
});

test('asset stamp, order, engine, source and permission scope cannot share results', async () => {
  let calls=0;const cache=createPhotoPrewarm({curate:async()=>++calls,observe:async()=>++calls});
  const base={owner:'a',sources:['all'],permission:{status:'granted',accessPrivileges:'all'}};
  const key=prewarmContextKey(base);
  await cache.curate(key,assets);await cache.curate(key,[...assets].reverse());
  await cache.curate(key,[{...assets[0],modificationTime:3},assets[1]]);
  for(const override of [{sources:['album']},{permission:{status:'granted',accessPrivileges:'limited'}},{libraryRevision:1},{engine:'next'}]) {
    await cache.curate(prewarmContextKey({...base,...override}),assets);
  }
  assert.equal(calls,7);
});

test('invalidation discards current work and cancels queued native calls', async () => {
  const gate=deferred(); let observations=0;
  const cache=createPhotoPrewarm({curate:async()=>gate.promise,observe:async()=>observations++});
  const curation=cache.curate('a',assets); const observation=cache.observe('a',assets[0],'file:///a');
  const rejected=Promise.all([assert.rejects(curation,{code:'PREWARM_INVALIDATED'}),assert.rejects(observation,{code:'PREWARM_INVALIDATED'})]);
  await Promise.resolve(); cache.invalidate(); gate.resolve({}); await rejected;
  assert.equal(observations,0);
});

test('old producer cannot re-enter after a different context takes ownership', async () => {
  let oldActive=true,calls=0;
  const cache=createPhotoPrewarm({curate:async()=>++calls,observe:async()=>++calls});
  await cache.curate('old',assets,()=>oldActive);oldActive=false;
  const current=await cache.curate('new',assets);
  await assert.rejects(cache.observe('old',assets[0],'file:///a',()=>oldActive),{code:'PREWARM_INVALIDATED'});
  assert.equal(await cache.curate('new',assets),current); assert.equal(calls,2);
});

test('background before queued native execution skips it; failure can be retried', async () => {
  const gate=deferred();let active=true,calls=0,fail=true;
  const cache=createPhotoPrewarm({curate:async()=>gate.promise,observe:async()=>{calls++;if(fail)throw Error('native');return 'ok'}});
  const first=cache.curate('a',assets);
  const queued=cache.observe('a',assets[0],'file:///a',()=>active);
  const rejected=assert.rejects(queued,{code:'PREWARM_INVALIDATED'});
  active=false;gate.resolve({});await first;await rejected;assert.equal(calls,0);
  await assert.rejects(cache.observe('a',assets[0],'file:///a'),/native/);
  fail=false;assert.equal(await cache.observe('a',assets[0],'file:///a'),'ok');assert.equal(calls,2);
});

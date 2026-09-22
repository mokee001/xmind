const test = require('node:test');
const assert = require('node:assert/strict');
const { runSelectionSync } = require('../photo-wall-app/src/selectionSync.cjs');
function fixture() {
  let stored, active = true;
  const sent=[];
  const deps={readPage:async()=>({assets:[{id:'a'},{id:'b'},{id:'junk'}],endCursor:'end',hasNextPage:false}),
    curate:async assets=>({assets:assets.filter(a=>a.id!=='junk'),reviewedIds:assets.map(a=>a.id)}),
    upload:async asset=>sent.push(asset.id),load:async()=>stored,
    save:async s=>{stored=structuredClone(s)},active:()=>active};
  return {deps,sent,state:()=>stored,stop:()=>{active=false}};
}
test('no candidate-count fallback uploads rejected photos',async()=>{
  const f=fixture(); await runSelectionSync(f.deps); assert.deepEqual(f.sent,['a','b']);
});
test('checkpoint resumes after confirmed first batch',async()=>{
  const f=fixture(); await runSelectionSync({...f.deps,maxUploads:1});
  await runSelectionSync(f.deps); assert.deepEqual(f.sent,['a','b']);
});
test('failed upload retries without marking the photo confirmed',async()=>{
  const f=fixture(); await assert.rejects(runSelectionSync({...f.deps,upload:async()=>{throw Error('offline')}}));
  assert.equal(f.state().pending.index,0); await runSelectionSync(f.deps); assert.deepEqual(f.sent,['a','b']);
});
test('already reviewed and uploaded photos are not uploaded on revisit',async()=>{
  const f=fixture(); await runSelectionSync(f.deps); await runSelectionSync(f.deps); assert.deepEqual(f.sent,['a','b']);
});
test('cancelled binding does not continue upload',async()=>{
  const f=fixture(); await runSelectionSync({...f.deps,upload:async a=>{f.sent.push(a.id);f.stop()}});
  assert.deepEqual(f.sent,['a']); assert.equal(f.state().pending.index,1);
});
test('temporarily unavailable original does not block later photos or become confirmed',async()=>{
  const f=fixture(); await runSelectionSync({...f.deps,upload:async a=>a.id==='a'?false:f.sent.push(a.id)});
  assert.deepEqual(f.sent,['b']); assert.equal(f.state().seen.a,undefined);
  await runSelectionSync(f.deps); assert.deepEqual(f.sent,['b','a']);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initial,reduce}=require('./state.js');
test('only a receipt for the sending job changes the displayed wall',()=>{
  let s=reduce(initial(),{type:'START'});
  assert.equal(reduce(s,{type:'RECEIPT',job:s.job,at:'09:41'}).displayed,0);
  s=reduce(s,{type:'PREPARED',job:s.job});
  assert.equal(s.displayed,0);
  assert.equal(reduce(s,{type:'RECEIPT',job:s.job-1}).phase,'sending');
  s=reduce(s,{type:'RECEIPT',job:s.job,at:'09:41'});
  assert.equal(s.displayed,1);assert.equal(s.updatedAt,'09:41');
  assert.equal(reduce(s,{type:'RECEIPT',job:s.job}).displayed,1);
});
test('failed replacement preserves existing wall and rejects late receipts',()=>{
  let s=reduce(initial(),{type:'START'});
  s=reduce(s,{type:'PREPARED',job:s.job});s=reduce(s,{type:'RECEIPT',job:s.job,at:'09:41'});
  s=reduce(s,{type:'START'});const previous=s.job;
  s=reduce(s,{type:'PREPARED',job:s.job});s=reduce(s,{type:'FAIL',job:s.job,reason:'offline'});
  assert.equal(s.displayed,1);assert.equal(s.updatedAt,'09:41');
  assert.equal(reduce(s,{type:'RECEIPT',job:s.job}).phase,'failed');
  s=reduce(s,{type:'START'});
  assert.equal(reduce(s,{type:'PREPARED',job:previous}).phase,'preparing');
  s=reduce(s,{type:'PREPARED',job:s.job});s=reduce(s,{type:'RECEIPT',job:s.job,at:'10:00'});
  assert.equal(s.displayed,2);
});

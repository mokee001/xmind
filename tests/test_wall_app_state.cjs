const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initial,transition,DAY}=require('../photo-wall-app/src/wallExperienceState.cjs');
const walls=[{id:'wall-a',template_id:'a',photo_ids:['1','2']},{id:'wall-b',template_id:'b',photo_ids:['3','4']}];
test('first preview is not current until explicitly confirmed',()=>{
  let s=initial();s=transition(s,'preview-next',walls,10);assert.equal(s.currentId,null);
  assert.equal(s.events.length,0);s=transition(s,'start',walls,10);assert.equal(s.currentId,'wall-b');
});
test('hold binds template and the entire wall once and preserves input',()=>{
  const s=transition(initial(),'start',walls,10);const before=JSON.stringify(s);
  const held=transition(s,'hold',walls,20);assert.equal(held.holdUntil,20+DAY);
  assert.deepEqual(held.events[0],{type:'positive_wall_hold',wall_id:'wall-a',template_id:'a',photo_ids:['1','2'],at:20,hold_until:20+DAY});
  assert.deepEqual(transition(held,'hold',walls,30),held);assert.equal(JSON.stringify(s),before);
});
test('whole-wall advance clears hold without a negative preference',()=>{
  const held=transition(transition(initial(),'start',walls,10),'hold',walls,20);
  const next=transition(held,'next',walls,30);assert.equal(next.currentId,'wall-b');assert.equal(next.holdUntil,null);
  assert.deepEqual(next.events.map(e=>e.type),['positive_wall_hold','advance']);
});
test('resume keeps the positive evidence; no feedback before first display',()=>{
  assert.throws(()=>transition(initial(),'hold',walls,10));
  const held=transition(transition(initial(),'start',walls,10),'hold',walls,20);
  const resumed=transition(held,'resume',walls,30);assert.equal(resumed.holdUntil,null);assert.deepEqual(resumed.events,held.events);
});

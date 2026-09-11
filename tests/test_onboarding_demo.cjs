const assert=require('node:assert/strict');
const test=require('node:test');
const M=require('../demos/onboarding/onboarding-state.js');
const f={scope:'fixture-a',photos_per_wall:8,photo_ids:Array.from({length:16},(_,i)=>`p${i}`),people:[
  {id:'a',photo_ids:['p0','p1','p2','p3','p4','p5','p6','p7','outside']},
  {id:'b',photo_ids:['p7','p8','p9']}, {id:'c',photo_ids:['p15']}]};
const apply=(s,...events)=>events.reduce((s,e)=>M.reduce(s,e,f),s);
const connect=()=>apply(M.initial(),{type:'START'},{type:'GRANT'},{type:'DEVICE_FOUND'},{type:'CONNECTED'});
const settings=s=>apply(s,{type:'MODE',mode:'include'},{type:'PERSON',id:'a'},{type:'CONFIRM_SCOPE'},{type:'SCHEDULE',value:'off'},{type:'CONFIRM_SCHEDULE'});
const wall={status:'ready',scope:f.scope,id:'wall-a',photo_ids:f.photo_ids.slice(0,8)};
test('Nothing is allowed, scheduled or published by default',()=>{const s=M.initial();assert.equal(s.mode,null);assert.equal(s.schedule,null);assert.equal(s.current,null);assert.equal(M.canPreview(s),false);});
test('Denied permission cannot connect or prepare a preview',()=>{const s=apply(M.initial(),{type:'START'},{type:'DENY'},{type:'CONNECTED'},{type:'READY'});assert.equal(s.connected,false);assert.equal(s.processing,'idle');assert.equal(s.current,null);});
test('Results ready first never bypass required preferences',()=>{let s=apply(connect(),{type:'READY'});assert.equal(s.step,'scope');assert.equal(M.canPreview(s),false);s=settings(s);assert.equal(s.step,'waiting');assert.equal(M.canPreview(s),true);assert.equal(s.current,null);});
test('Settings ready first stay saved while processing catches up',()=>{let s=settings(connect());assert.equal(s.step,'waiting');assert.equal(M.canPreview(s),false);s=apply(s,{type:'READY'});assert.equal(M.canPreview(s),true);assert.deepEqual(s.personIds,['a']);assert.equal(s.schedule,'off');});
test('Multi-person selection is a union intersected with first layer',()=>{const s=apply(connect(),{type:'MODE',mode:'include'},{type:'PERSON',id:'a'},{type:'PERSON',id:'b'});assert.deepEqual(M.allowedIds(s,f),f.photo_ids.slice(0,10));assert.equal(M.allowedIds(s,f).includes('outside'),false);});
test('Empty and foreign selections never become all photos',()=>{let s=apply(connect(),{type:'MODE',mode:'include'},{type:'PERSON',id:'unknown'},{type:'CONFIRM_SCOPE'});assert.equal(s.scopeConfirmed,false);assert.deepEqual(M.allowedIds(s,f),[]);});
test('Retry preserves preferences but does not publish',()=>{let s=apply(settings(connect()),{type:'FAILED'},{type:'RETRY'},{type:'READY'});assert.deepEqual(s.personIds,['a']);assert.equal(s.schedule,'off');assert.equal(s.current,null);assert.equal(M.canPreview(s),true);});
test('Only explicit preview confirmation publishes an in-scope wall',()=>{let s=apply(settings(connect()),{type:'READY'},{type:'WALL',wall},{type:'PUBLISH'});assert.equal(s.current,null);s=apply(s,{type:'CONSENT',value:true},{type:'PUBLISH'});assert.equal(s.current.id,'wall-a');});
test('Foreign snapshot, outside photo, duplicate and incomplete walls are blocked',()=>{const s=apply(settings(connect()),{type:'READY'});for(const w of [{...wall,scope:'other'},{...wall,photo_ids:[...wall.photo_ids.slice(0,7),'p15']},{...wall,photo_ids:Array(8).fill('p0')},{...wall,photo_ids:['p0']}])assert.equal(apply(s,{type:'WALL',wall:w}).wall,null);});
test('Changing scope invalidates the old wall and confirmation',()=>{let s=apply(settings(connect()),{type:'READY'},{type:'WALL',wall},{type:'CONSENT',value:true},{type:'MODE',mode:'all'},{type:'PUBLISH'});assert.equal(s.wall,null);assert.equal(s.current,null);assert.equal(s.scopeConfirmed,false);});
test('Update schedule is a deliberate choice, not a fallback',()=>{let s=apply(connect(),{type:'MODE',mode:'all'},{type:'CONFIRM_SCOPE'},{type:'CONFIRM_SCHEDULE'});assert.equal(s.step,'schedule');s=apply(s,{type:'SCHEDULE',value:'daily'},{type:'TIME',value:'08:30'},{type:'CONFIRM_SCHEDULE'});assert.equal(s.time,'08:30');assert.equal(s.scheduleConfirmed,true);s=apply(s,{type:'TIME',value:'99:00'});assert.equal(s.time,'08:30');});
test('Next wall does not change confirmed current wall or create negative feedback',()=>{let s=apply(settings(connect()),{type:'READY'},{type:'WALL',wall},{type:'CONSENT',value:true},{type:'PUBLISH'},{type:'HOLD'},{type:'NEXT'});assert.equal(s.current.id,'wall-a');assert.equal(s.held,true);assert.equal(s.wall,null);assert.deepEqual(s.personIds,['a']);assert.equal('excluded' in s,false);});
test('Reset clears the simulated permissions, wall and consent',()=>{assert.deepEqual(M.initial('slow'),{...M.initial(),scenario:'slow'});});

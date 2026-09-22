const assert=require('node:assert/strict');
const test=require('node:test');
const M=require('../demos/onboarding/v2-state.js');
const f={scope:'fixture-v2',photos_per_wall:8,photo_ids:Array.from({length:16},(_,i)=>`p${i}`),people:[
  {id:'a',photo_ids:['p0','p1','p2','p3','p4','p5','p6','p7','outside']},
  {id:'b',photo_ids:['p7','p8','p9']}, {id:'c',photo_ids:['p15']},
  {id:'library-only',photo_ids:[],library_photo_count:12}],
  themes:[{id:'topic-pets',photo_ids:['p0','p1']},{id:'topic-art',photo_ids:[]}]};
const wall={status:'ready',scope:f.scope,id:'wall-v2',photo_ids:f.photo_ids.slice(0,8)};
const apply=(s,...events)=>events.reduce((s,e)=>M.reduce(s,e,f),s);
const connect=()=>apply(M.initial(),{type:'START'},{type:'GRANT'},{type:'DEVICE_FOUND'},{type:'CONNECT'},{type:'CONNECTED'});
const prepare=()=>apply(connect(),{type:'CONFIRM_SETTINGS'},{type:'READY'},{type:'WALL',wall});

test('Four guide stages; the permission dialog stays within authorization',()=>{
  assert.deepEqual(M.guideSteps,['授权相册','连接照片墙','展示设置','预览上墙']);
  for(const [step,index] of Object.entries({welcome:0,permission:0,device:1,settings:2,preview:3,current:4})){
    assert.equal(M.guideIndex({...M.initial(),step}),index);
  }
  let s=M.initial();assert.equal(M.guideIndex(s),0);
  s=apply(s,{type:'START'});assert.equal(M.guideIndex(s),0);
  s=apply(s,{type:'CANCEL_PERMISSION'});assert.equal(M.guideIndex(s),0);
});
test('Background progress and preview completion do not create guide stages',()=>{
  let s=connect();assert.equal(M.guideIndex(s),2);
  s=apply(s,{type:'PHASE',phase:2});assert.equal(M.guideIndex(s),2);
  s=apply(s,{type:'CONFIRM_SETTINGS'});assert.equal(M.guideIndex(s),3);
  s=apply(s,{type:'READY'},{type:'WALL',wall});assert.equal(M.guideIndex(s),3);
  s=apply(s,{type:'CONFIRM_WALL'});assert.equal(M.guideIndex(s),3);
  s=apply(s,{type:'PUBLISHED',wallId:wall.id});assert.equal(M.guideIndex(s),M.guideSteps.length);
});
test('Static navigation has four tasks, consistent with the guide model',()=>{
  const fs=require('node:fs');
  const html=fs.readFileSync(require.resolve('../demos/onboarding/index.html'),'utf8');
  const journey=html.match(/<ol id="journey">(.*?)<\/ol>/s)[1];
  assert.deepEqual([...journey.matchAll(/<li>(.*?)<\/li>/g)].map(m=>m[1]),M.guideSteps);
  assert.match(html,/1 \/ 4 · 授权相册/);
  assert.doesNotMatch(html,/5 次操作|1 \/ 5|允许访问权限<\/li>/);
});
test('Exactly FIVE primary clicks, including permission; automatic results do not add clicks',()=>{
  let s=M.initial();
  const click=e=>{const before=s.actionCount;s=apply(s,e);assert.equal(s.actionCount,before+1);};
  click({type:'START'});assert.equal(s.step,'permission');
  click({type:'GRANT'});assert.equal(s.step,'device');
  s=apply(s,{type:'DEVICE_FOUND'});assert.equal(s.actionCount,2);
  click({type:'CONNECT'});s=apply(s,{type:'CONNECTED'});
  assert.equal(s.step,'settings');assert.equal(s.mode,null);assert.equal(s.actionCount,3);
  click({type:'CONFIRM_SETTINGS'});assert.equal(s.step,'preview');assert.equal(s.mode,'all');
  s=apply(s,{type:'READY'},{type:'WALL',wall});assert.equal(s.actionCount,4);assert.equal(s.current,null);
  click({type:'CONFIRM_WALL'});s=apply(s,{type:'PUBLISHED',wallId:wall.id});
  assert.equal(s.actionCount,5);assert.equal(s.step,'current');assert.equal(s.schedule,'off');
});
test('No initial permission, display scope or auto-update consent',()=>{
  const s=M.initial();assert.equal(s.permission,false);assert.equal(s.mode,null);assert.equal(s.schedule,'off');
  assert.equal(s.scheduleConfirmed,false);assert.deepEqual(M.allowedIds(s,f),[]);assert.equal(M.canPreview(s),false);
});
test('Permission denial and dialog cancellation do not advance',()=>{
  let s=apply(M.initial(),{type:'START'},{type:'DENY'},{type:'CONNECT'},{type:'CONNECTED'},{type:'READY'});
  assert.equal(s.step,'welcome');assert.equal(s.processing,'idle');assert.equal(s.connected,false);
  s=apply(M.initial(),{type:'START'},{type:'CANCEL_PERMISSION'});assert.equal(s.step,'welcome');assert.equal(s.permission,false);
});
test('All is only authorized by the explicit confirm-settings action',()=>{
  let s=apply(connect(),{type:'PHASE',phase:2},{type:'READY'},{type:'WALL',wall});
  assert.equal(s.mode,null);assert.equal(s.scopeConfirmed,false);assert.equal(s.wall,null);
  s=apply(s,{type:'CONFIRM_SETTINGS'});assert.equal(s.mode,'all');assert.equal(s.scopeConfirmed,true);
});
test('Ready first stays on settings; no extra continue after results arrive',()=>{
  let s=apply(connect(),{type:'READY'});assert.equal(s.step,'settings');
  s=apply(s,{type:'CONFIRM_SETTINGS'},{type:'WALL',wall});assert.equal(s.step,'preview');assert.equal(s.wall.id,wall.id);assert.equal(s.actionCount,4);
});
test('Settings first: waiting and ready share the same preview page',()=>{
  let s=apply(connect(),{type:'CONFIRM_SETTINGS'});assert.equal(s.step,'preview');assert.equal(s.wall,null);
  s=apply(s,{type:'READY'},{type:'WALL',wall});assert.equal(s.step,'preview');assert.equal(s.actionCount,4);
});
test('Unprepared or empty person selection never falls back to all',()=>{
  let s=apply(connect(),{type:'MODE',mode:'include'},{type:'PERSON',id:'a'},{type:'CONFIRM_SETTINGS'});
  assert.equal(s.step,'settings');assert.deepEqual(s.personIds,[]);assert.equal(s.mode,'include');
  s=apply(s,{type:'PHASE',phase:2},{type:'PERSON',id:'unknown'},{type:'CONFIRM_SETTINGS'});
  assert.equal(s.scopeConfirmed,false);assert.deepEqual(M.allowedIds(s,f),[]);
});
test('People are OR-matched strictly within the first layer',()=>{
  const s=apply(connect(),{type:'PHASE',phase:2},{type:'MODE',mode:'include'},{type:'PERSON',id:'a'},{type:'PERSON',id:'b'},{type:'CONFIRM_SETTINGS'});
  assert.deepEqual(M.allowedIds(s,f),f.photo_ids.slice(0,10));assert.equal(s.mode,'include');
});
test('Identity selection that becomes foreign cannot be confirmed',()=>{
  let s={...connect(),mode:'include',personIds:['foreign'],phase:2};s=apply(s,{type:'CONFIRM_SETTINGS'});
  assert.equal(s.scopeConfirmed,false);assert.equal(s.mode,'include');
});
test('An avatar click selects directly; clicking again deselects without silently using all',()=>{
  let s=apply(connect(),{type:'PHASE',phase:2},{type:'PERSON',id:'a'});
  assert.equal(s.mode,'include');assert.deepEqual(s.personIds,['a']);
  s=apply(s,{type:'PERSON',id:'a'},{type:'CONFIRM_SETTINGS'});
  assert.deepEqual(s.personIds,[]);assert.equal(s.mode,'include');assert.equal(s.step,'settings');
  s=apply(s,{type:'MODE',mode:'all'},{type:'CONFIRM_SETTINGS'});assert.equal(s.step,'preview');
});
test('A full-library person with no selected photos stays selectable but cannot backfill',()=>{
  const s=apply(connect(),{type:'PHASE',phase:2},{type:'PERSON',id:'library-only'},{type:'THEME',id:'topic-pets'},{type:'CONFIRM_SETTINGS'});
  assert.deepEqual(s.personIds,['library-only']);assert.deepEqual(M.allowedIds(s,f),[]);
  assert.equal(s.step,'settings');assert.equal(s.scopeConfirmed,false);
});
test('Theme toggles preserve the people boundary, stay optional, and survive retry',()=>{
  let s=apply(connect(),{type:'PHASE',phase:2},{type:'PERSON',id:'a'},{type:'THEME',id:'topic-pets'},{type:'THEME',id:'topic-art'});
  assert.deepEqual(s.themeIds,['topic-pets','topic-art']);assert.deepEqual(M.allowedIds(s,f),wall.photo_ids);
  s=apply(s,{type:'THEME',id:'topic-pets'},{type:'THEME',id:'foreign'});
  assert.deepEqual(s.themeIds,['topic-art']);
  s=apply(s,{type:'CONFIRM_SETTINGS'},{type:'FAILED'},{type:'RETRY'},{type:'READY'});
  assert.deepEqual(s.themeIds,['topic-art']);assert.deepEqual(s.personIds,['a']);
  assert.equal(M.validWall(s,f,wall),false);
  assert.equal(M.validWall(s,f,{...wall,theme_ids:['topic-art']}),true);
});
test('Changing themes invalidates the wall consent, and foreign theme state fails closed',()=>{
  let s=apply(prepare(),{type:'EDIT'},{type:'THEME',id:'topic-pets'});
  assert.equal(s.wall,null);assert.equal(s.scopeConfirmed,false);
  s=apply({...s,themeIds:['foreign']},{type:'CONFIRM_SETTINGS'});assert.equal(s.step,'settings');
});
test('Bubbles use 1.1 scale, themes are in settings, and the device card has no photo',()=>{
  const fs=require('node:fs');
  const source=fs.readFileSync(require.resolve('../demos/onboarding/v2.js'),'utf8');
  const css=fs.readFileSync(require.resolve('../demos/onboarding/v2.css'),'utf8');
  assert.match(css,/\.avatar-bubble\[aria-pressed="true"\]\{transform:scale\(1\.1\)/);
  assert.match(source,/peopleSection\(\).*themeSection\(\)/);
  assert.match(source,/data-theme=/);
  assert.doesNotMatch(source.match(/<div class="device-card">(.*?)<div class="network-summary">/s)[1],/<img/);
  assert.doesNotMatch(source,/class="person-check"|class="people-grid"/);
});
test('Auto-update requires opting in and the same settings confirmation',()=>{
  let s=apply(connect(),{type:'SCHEDULE',value:'daily'},{type:'TIME',value:'08:30'});
  assert.equal(s.scheduleConfirmed,false);s=apply(s,{type:'CONFIRM_SETTINGS'});assert.equal(s.schedule,'daily');assert.equal(s.time,'08:30');assert.equal(s.scheduleConfirmed,true);
});
test('Blank/invalid daily times block confirmation; disabling updates is safe',()=>{
  for(const value of ['','29:80','12:99']){
    let s=apply(connect(),{type:'SCHEDULE',value:'daily'},{type:'TIME',value},{type:'CONFIRM_SETTINGS'});
    assert.equal(s.step,'settings');assert.equal(s.scheduleConfirmed,false);
    s=apply(s,{type:'SCHEDULE',value:'off'},{type:'CONFIRM_SETTINGS'});assert.equal(s.step,'preview');
  }
});
test('Connection failure is retryable on the same page',()=>{
  let s=apply(M.initial(),{type:'START'},{type:'GRANT'},{type:'DEVICE_FOUND'},{type:'CONNECT'},{type:'CONNECTION_FAILED'});
  assert.equal(s.step,'device');assert.equal(s.processing,'idle');s=apply(s,{type:'CONNECT'},{type:'CONNECTED'});assert.equal(s.step,'settings');
});
test('Failed processing keeps preferences and uses no additional required page',()=>{
  let s=apply(connect(),{type:'CONFIRM_SETTINGS'},{type:'FAILED'},{type:'RETRY'},{type:'READY'},{type:'WALL',wall});
  assert.equal(s.step,'preview');assert.equal(s.mode,'all');assert.equal(s.schedule,'off');assert.equal(s.current,null);
});
test('Ready and wall events never publish automatically',()=>{
  let s=prepare();s=apply(s,{type:'PUBLISHED',wallId:wall.id});assert.equal(s.current,null);assert.equal(s.actionCount,4);
});
test('Stale, out-of-scope, duplicate or incomplete previews fail closed',()=>{
  const s=apply(connect(),{type:'PHASE',phase:2},{type:'MODE',mode:'include'},{type:'PERSON',id:'a'},{type:'CONFIRM_SETTINGS'},{type:'READY'});
  for(const w of [{...wall,scope:'old'},{...wall,photo_ids:['p15',...wall.photo_ids.slice(1)]},{...wall,photo_ids:Array(8).fill('p0')},{...wall,photo_ids:['p0']}])assert.equal(apply(s,{type:'WALL',wall:w},{type:'CONFIRM_WALL'}).publishing,false);
});
test('Publication requires a current confirmation and matching wall receipt',()=>{
  let s=apply(prepare(),{type:'CONFIRM_WALL'},{type:'PUBLISHED',wallId:'other'});assert.equal(s.current,null);
  s=apply(s,{type:'PUBLISHED',wallId:wall.id});assert.equal(s.current.id,wall.id);
});
test('Editing cancels an in-flight simulated publication',()=>{
  const s=apply(prepare(),{type:'CONFIRM_WALL'},{type:'EDIT'},{type:'PUBLISHED',wallId:wall.id});
  assert.equal(s.current,null);assert.equal(s.wall,null);assert.equal(s.scopeConfirmed,false);
});
test('Double confirmation is not counted twice or double published',()=>{
  const s=apply(prepare(),{type:'CONFIRM_WALL'},{type:'CONFIRM_WALL'});assert.equal(s.actionCount,5);
});
test('Any preview error blocks confirmation',()=>{
  const s=apply(prepare(),{type:'ERROR',message:'stale'},{type:'CONFIRM_WALL'});assert.equal(s.publishing,false);assert.equal(s.current,null);
});
test('Next wall preserves the current wall; hold has no person side effects',()=>{
  const s=apply(prepare(),{type:'CONFIRM_WALL'},{type:'PUBLISHED',wallId:wall.id},{type:'HOLD'},{type:'NEXT'});
  assert.equal(s.current.id,wall.id);assert.equal(s.held,true);assert.equal(s.wall,null);assert.equal(s.step,'preview');assert.deepEqual(s.personIds,[]);
});

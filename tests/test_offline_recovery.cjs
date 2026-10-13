const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const network=require('../photo-wall-app/src/networkRecovery.cjs');
const status=require('../photo-wall-app/src/deviceStatus.cjs');
const {runFirstWall}=require('../photo-wall-app/src/firstWall.cjs');
const app=path.resolve(__dirname,'../photo-wall-app');
const deps=process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve=name=>require.resolve(name,{paths:[deps]});
const babel=require(resolve('@babel/core'));
const source=fs.readFileSync(path.join(app,'App.js'),'utf8');
const ast=babel.parseSync(source,{configFile:false,babelrc:false,parserOpts:{plugins:['jsx']}});
const visit=(node,callback)=>{if(!node||typeof node!=='object')return;callback(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(x=>visit(x,callback));else if(value&&typeof value==='object')visit(value,callback)};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const scope=()=>({deviceId:'screen',bindingKey:'owner/screen',bindingEpoch:2,sequence:0});
const session=()=>({accountToken:'synthetic-owner',device:{device_id:'screen'},firstWall:{state:'publishing',wallId:'wall'},publishedWall:{revision:'old'}});
function value(name,context) {
  let target;visit(ast,node=>{if(node.type==='VariableDeclarator'&&node.id.name===name)target=node.init});
  assert.ok(target,name);return vm.compileFunction('return ('+source.slice(target.start,target.end)+')',Object.keys(context))(...Object.values(context));
}
function effect(fragment,context) {
  let target;visit(ast,node=>{if(node.type==='CallExpression'&&node.callee.name==='useEffect'&&source.slice(node.arguments[0].start,node.arguments[0].end).includes(fragment))target=node.arguments[0]});
  assert.ok(target,fragment);return vm.compileFunction('return ('+source.slice(target.start,target.end)+')',Object.keys(context))(...Object.values(context))();
}
function moduleAt(file,mocks={},globals={}) {
  const filename=path.join(app,file),module={exports:{}};
  const code=babel.transformFileSync(filename,{configFile:false,babelrc:false,plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;
  vm.compileFunction(code,['module','exports','require',...Object.keys(globals)],{filename})(module,module.exports,name=>mocks[name]||{},...Object.values(globals));
  return module.exports;
}
function api(fetch,timeouts=[]) {
  const mocks={'react-native':{Platform:{OS:'ios'}},
    './unifiedSelection':{UNIFIED_SELECTION:true,SELECTION_CONTRACT:'unified-recollections-v1'},
    './selectionReadiness.cjs':require('../photo-wall-app/src/selectionReadiness.cjs'),
    './networkRecovery.cjs':{withRequestTimeout:(read,options)=>{timeouts.push(options.timeoutMs);return network.withRequestTimeout(read,{...options,timeoutMs:5})}},
    './deviceStatus.cjs':{withDeviceStatusTimeout:(read,options)=>status.withDeviceStatusTimeout(read,{...options,timeoutMs:5})},
    './deviceApi':{DEFAULT_API_BASE:'https://fixture.invalid'}};
  const globals={fetch,process:{env:{}},__DEV__:false};
  return {...moduleAt('src/deviceApi.js',mocks,globals),...moduleAt('src/accountApi.js',mocks,globals)};
}
const options={apiBase:'https://fixture.invalid',deviceId:'screen',accountToken:'synthetic-owner',accessToken:'synthetic-user'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)});

test('whole request deadlines cover ignored abort in fetch and body, and external cancellation never starts an already cancelled request',async()=>{
  for(const body of [false,true]) {
    let signal;
    const client=api(async(_,options)=>{signal=options.signal;return body?{ok:true,text:()=>new Promise(()=>{})}:new Promise(()=>{})});
    await assert.rejects(client.readDeviceDisplayHistory(options),{code:'SERVICE_TIMEOUT'});
    assert.equal(signal.aborted,true);
  }
  const controller=new AbortController();let propagated;
  const client=api(async(_,options)=>{propagated=options.signal;return new Promise(()=>{})});
  const pending=client.readDeviceDisplayHistory({...options,signal:controller.signal});
  await Promise.resolve();controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(propagated.aborted,true);
  await assert.rejects(network.withRequestTimeout(()=>assert.fail('must not start'),{signal:controller.signal}),{name:'AbortError'});
});

test('calendar, preferences, account initialization, mutation and wall APIs have appropriate finite deadlines',async()=>{
  const deadlines=[],client=api(async()=>({ok:true,text:()=>new Promise(()=>{})}),deadlines);
  for(const [name,ms] of [['readDeviceDisplayHistory',8000],['readDevicePreferenceProfile',8000],['readRecognizedContent',8000],
    ['readSelectionModel',8000],['readAccount',8000],['registerAccount',8000],['adoptDevice',8000],
    ['removeDisplay',10000],['reprovisionDisplay',10000],['createDevicePreferenceRevision',10000],
    ['activateDevicePreferenceRevision',10000],['generateWall',120000],['publishGeneratedWall',15000]]) {
    await assert.rejects(client[name](options),{code:'SERVICE_TIMEOUT'});assert.equal(deadlines.at(-1),ms,name);
  }
});

test('malformed success cannot erase history/preferences or imply missing device/deletion/reprovision',async()=>{
  for(const [name,bodies] of [['readDeviceDisplayHistory',[{},null,{records:null}]],['readDevicePreferenceProfile',[{},null,{revisions:null}]],
    ['listDisplays',[{},null,{devices:[null]},{devices:[{}]}]],['removeDisplay',[{},null,{device_id:'other',removed:true},{device_id:'screen',removed:'true'}]],
    ['reprovisionDisplay',[{},null,{device:{device_id:'other'},reprovision_required:true}]]]) {
    for(const body of bodies) await assert.rejects(api(async()=>response(body))[name](options),{code:'INVALID_SERVICE_RESPONSE'});
  }
  assert.deepEqual(await api(async()=>response({records:[]})).readDeviceDisplayHistory(options),{records:[]});
  await assert.rejects(api(async()=>response({devices:[]})).readDisplayStatus(options),{code:'DEVICE_NOT_FOUND'});
  assert.equal((await api(async()=>response({device_id:'screen',removed:true},202)).removeDisplay(options)).removed,true);
});

test('publish timeout preserves uncertain dispatch and later matching receipt does not regenerate or republish',async()=>{
  let saved={},published=0,generated=0,prepared=0;
  const client=api(async()=>{published++;return {ok:true,text:()=>new Promise(()=>{})}});
  const deps={load:async()=>saved,save:async value=>{saved=structuredClone(value)},readDevice:async()=>({device_id:'screen'}),
    prepare:async()=>{prepared++},generate:async()=>{generated++;return{wall_id:'wall',image_url:'/wall.png'}},publish:()=>client.publishGeneratedWall(options),stage:()=>{},sleep:async()=>{},polls:1};
  await assert.rejects(runFirstWall(deps),{code:'SERVICE_TIMEOUT'});assert.equal(saved.state,'publishing');
  deps.readDevice=async()=>({device_id:'screen',revision:'revision',displayed_revision:'revision',state:'displayed'});
  await runFirstWall(deps);assert.equal(saved.state,'done');assert.deepEqual([prepared,generated,published],[1,1,1]);
});

test('service read failure overrides recent cached online until a successful read; heartbeat expiry remains distinct',()=>{
  const binding=scope(),now=1_000_000,device={device_id:'screen',last_seen:1000};
  let observation={...binding,device,receivedAt:now,readFailed:true};
  for(const clock of [now,now+10000]) assert.deepEqual(status.deviceConnectionStatus({connected:true,device,observation,scope:binding,now:clock}),{deviceOnline:false,connectionLabel:'连接确认失败'});
  observation={...observation,readFailed:false};
  assert.equal(status.deviceConnectionStatus({connected:true,device,observation,scope:binding,now}).connectionLabel,'已连接');
  observation={...observation,device:{...device,last_seen:900}};
  assert.equal(status.deviceConnectionStatus({connected:true,device:observation.device,observation,scope:binding,now}).connectionLabel,'暂时离线');
  assert.match(network.serviceFailureMessage({status:401}),/权限/);assert.doesNotMatch(network.serviceFailureMessage({status:401}),/离线/);
});

function historyFixture(read) {
  const binding={current:scope()},state={records:[{revision:'confirmed'}],historyBinding:'key',error:'',loading:false};
  const context={historyVisible:false,activeTab:'calendar',needsOnboarding:false,IS_WEB_PREVIEW:false,
    wallRequestScopeRef:binding,sameDeviceBinding:status.sameDeviceBinding,historyScopeRef:{current:'key'},historyScopeKey:'key',
    effectiveSession:session(),session:session(),DEFAULT_API_BASE:options.apiBase,readDeviceDisplayHistory:read,
    setDisplayHistory:v=>state.records=v,setHistoryBinding:v=>state.historyBinding=v,setHistoryError:v=>state.error=v,setHistoryLoading:v=>state.loading=v,
    serviceFailureMessage:network.serviceFailureMessage};
  return{state,context,binding,start:()=>effect('if (!historyVisible',context)};
}
test('real calendar effect keeps confirmed records through failure and retries; only a valid successful read replaces them',async()=>{
  let read=async()=>{throw Object.assign(Error('503'),{status:503})};
  const f=historyFixture((...args)=>read(...args));
  let cleanup=f.start();await flush();assert.equal(f.state.loading,false);assert.match(f.state.error,/连接不到服务/);assert.equal(f.state.records[0].revision,'confirmed');cleanup();
  const gate=deferred();read=()=>gate.promise;cleanup=f.start();assert.equal(f.state.records[0].revision,'confirmed');
  gate.resolve({records:[{revision:'new'}]});await flush();assert.equal(f.state.records[0].revision,'new');assert.equal(f.state.error,'');cleanup();
});

test('real calendar effect clears cross-binding history and rejects late response even for same device ID',async()=>{
  const gate=deferred(),f=historyFixture(()=>gate.promise);f.context.historyScopeKey='new-owner';
  const cleanup=f.start();assert.deepEqual(f.state.records,[]);
  f.binding.current={...f.binding.current,bindingEpoch:3};gate.resolve({records:[{revision:'wrong-owner'}]});await flush();assert.deepEqual(f.state.records,[]);cleanup();
});

function storeFixture() {
  const values=new Map(), hooks={get:null},SecureStore={WHEN_UNLOCKED_THIS_DEVICE_ONLY:'test',
    getItemAsync:async key=>{const raw=values.get(key);return hooks.get?hooks.get(key,raw):raw},
    setItemAsync:async(key,value)=>values.set(key,value),deleteItemAsync:async key=>values.delete(key)};
  return{values,hooks,store:moduleAt('src/sessionStore.js',{'react-native':{Platform:{OS:'ios'}},'expo-secure-store':SecureStore})};
}
test('a delayed read never writes a removed device back into secure storage',async()=>{
  const f=storeFixture(),s=session();await f.store.saveDeviceSession(s);
  const gate=deferred();let first=true;
  f.hooks.get=(key,raw)=>key==='photowall-device-sessions-v2'&&first?(first=false,gate.promise.then(()=>raw)):raw;
  const stale=f.store.loadDeviceSessions();await f.store.removeDeviceSession('screen');gate.resolve();await stale;
  assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('queued old status/first-wall writes are rejected at storage commit and cannot resurrect a removed binding',async()=>{
  const f=storeFixture();await f.store.saveDeviceSession(session());let active=true;
  const removal=f.store.removeDeviceSession('screen');const late=f.store.updateDeviceSession(session(),{current:()=>active,expectedAccountToken:'synthetic-owner'});active=false;
  await removal;await assert.rejects(late,{code:'DEVICE_BINDING_CHANGED'});assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('same ID and same account rebind survives an old delete acknowledgement, while explicit new discovery remains supported',async()=>{
  const f=storeFixture();await f.store.saveDeviceSession(session());let epoch=1;
  const current=()=>epoch===1;await f.store.removeDeviceSession('screen');epoch++;
  await f.store.saveDeviceSession({...session(),firstWall:{state:'new-binding'}});
  await assert.rejects(f.store.removeDeviceSession('screen',{current,expectedAccountToken:'synthetic-owner'}),{code:'DEVICE_BINDING_CHANGED'});
  assert.equal((await f.store.loadDeviceSession()).firstWall.state,'new-binding');
  await f.store.updateDeviceSession({accountToken:'second',device:{device_id:'discovered'}},{current:()=>true});
  assert.equal((await f.store.loadDeviceSessions()).sessions.length,2);
});

test('real App delete never removes local binding for timeout, authorization, missing device or malformed acknowledgement',async()=>{
  const original=session();
  for(const error of [Object.assign(Error('timeout'),{code:'SERVICE_TIMEOUT'}),Object.assign(Error('auth'),{status:401}),Object.assign(Error('missing'),{status:404}),Object.assign(Error('bad'),{code:'INVALID_SERVICE_RESPONSE'})]) {
    let removed=0;const remove=value('removeManagedDevice',{runManagedDeviceAction:(_,action)=>action(()=>true),IS_WEB_PREVIEW:false,
      isScreen19Device:()=>false,removeDisplay:async()=>{throw error},DEFAULT_API_BASE:options.apiBase,
      removeDeviceSession:async()=>removed++,serviceFailureMessage:network.serviceFailureMessage});
    await assert.rejects(remove(original),/尚未确认删除/);assert.equal(removed,0);assert.equal(original.firstWall.state,'publishing');
  }
});

test('real App rejects late delete after binding changes, before local storage mutation',async()=>{
  const gate=deferred();let current=true,removed=0;
  const remove=value('removeManagedDevice',{runManagedDeviceAction:(_,action)=>action(()=>current),IS_WEB_PREVIEW:false,
    isScreen19Device:()=>false,removeDisplay:()=>gate.promise,DEFAULT_API_BASE:options.apiBase,
    removeDeviceSession:async()=>removed++,serviceFailureMessage:network.serviceFailureMessage});
  const pending=remove(session());current=false;gate.resolve({device_id:'screen',removed:true});
  await assert.rejects(pending,/绑定已变化/);assert.equal(removed,0);
});

test('real App management lock spans closed views, aborts old work without changing saved intent, and releases after failure',async()=>{
  const bound=session(),controller=new AbortController(),refs={deviceManagementRef:{current:null},deviceManagementEpochRef:{current:0},
    wallRequestScopeRef:{current:scope()},latestDeviceSessionsRef:{current:[bound]},firstWallAbortRef:{current:{controller,resume:true}},
    firstWallAttemptRef:{current:''},wallOperationRef:{current:{old:true}},deviceStatusPollRef:{current:null}};
  const run=value('runManagedDeviceAction',{...refs,IS_WEB_PREVIEW:false,sameManagedDevice:network.sameManagedDevice,
    sameDeviceBinding:status.sameDeviceBinding,wallBindingKey:'owner/screen',setFirstWall:()=>{},firstWallFailure:(error,binding)=>({binding,message:error.message})});
  const gate=deferred(),pending=run(bound,()=>gate.promise);assert.equal(controller.signal.aborted,true);
  await assert.rejects(run(bound,()=>assert.fail()),/上一项/);assert.equal(bound.firstWall.state,'publishing');assert.equal(bound.publishedWall.revision,'old');
  gate.reject(Error('offline'));await assert.rejects(pending,/offline/);assert.equal(refs.deviceManagementRef.current,null);
  await run(bound,async()=>{});
});

function connectedContext(store,overrides={}) {
  const refs={deviceManagementRef:{current:null},deviceManagementEpochRef:{current:4},wallRequestScopeRef:{current:scope()}};
  const changes={},noop=()=>{};
  const context={...refs,renderedManagementEpoch:4,reconfigurationSession:null,IS_WEB_PREVIEW:false,addingDevice:false,
    normalizeDeviceSession:x=>x,prepareAccountSession:async()=>({accessToken:'synthetic-owner'}),upgradeDeviceToFamily:async value=>value,
    saveDeviceSession:store.saveDeviceSession,updateDeviceSession:store.updateDeviceSession,
    setSession:value=>changes.session=value,setDeviceSessions:value=>changes.sessions=value,clearPendingDeviceSetup:async()=>{},
    setReconfigurationSession:noop,setAddingDevice:noop,setInitialSetupDevice:noop,setDeviceModal:noop,setDeviceManagerVisible:noop,
    needsOnboarding:false,setOnboardingStep:noop,setOnboardingDeviceConnectedNow:noop,setActiveTab:noop,setNotice:noop,...overrides};
  return{context,refs,changes};
}

test('real onConnected cannot resurrect a deleted binding when account adoption returns late',async()=>{
  const f=storeFixture();await f.store.saveDeviceSession(session());const gate=deferred();
  const {context,refs,changes}=connectedContext(f.store,{prepareAccountSession:()=>gate.promise});
  const pending=value('onConnected',context)(session());refs.deviceManagementEpochRef.current++;
  await f.store.removeDeviceSession('screen');gate.resolve({accessToken:'synthetic-owner'});
  await assert.rejects(pending,/未恢复旧绑定/);assert.equal(changes.session,undefined);assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('real same-ID connection completion advances binding epoch and polling effect restarts for that epoch',async()=>{
  const f=storeFixture();await f.store.saveDeviceSession(session());const {context,refs}=connectedContext(f.store);
  const oldEpoch=refs.wallRequestScopeRef.current.bindingEpoch,oldManagement=refs.deviceManagementEpochRef.current;
  await value('onConnected',context)(session());
  assert.equal(refs.wallRequestScopeRef.current.bindingEpoch,oldEpoch+1);
  assert.equal(refs.deviceManagementEpochRef.current,oldManagement+1);
  await assert.rejects(f.store.removeDeviceSession('screen',{current:()=>refs.wallRequestScopeRef.current.bindingEpoch===oldEpoch,
    expectedAccountToken:'synthetic-owner'}),{code:'DEVICE_BINDING_CHANGED'});
  assert.equal((await f.store.loadDeviceSessions()).sessions.length,1);
  let dependencies;visit(ast,node=>{if(node.type==='CallExpression'&&node.callee.name==='useEffect'&&source.slice(node.arguments[0].start,node.arguments[0].end).includes('const poll = createDeviceStatusPoll'))dependencies=source.slice(node.arguments[1].start,node.arguments[1].end)});
  assert.match(dependencies,/historyScopeKey/);
});

test('real reconfiguration retains first-wall intent and publication while refreshing its binding',async()=>{
  const f=storeFixture(),old=session();await f.store.saveDeviceSession(old);
  const {context}=connectedContext(f.store,{reconfigurationSession:old});
  await value('onConnected',context)({accountToken:old.accountToken,device:{device_id:'screen',state:'online'}});
  const saved=await f.store.loadDeviceSession();assert.deepEqual(saved.firstWall,old.firstWall);assert.deepEqual(saved.publishedWall,old.publishedWall);
});

test('real first-wall escape cancels waiting, exposes calendar and preserves saved publication intent',()=>{
  const bound=session(),controller=new AbortController(),binding={current:scope()};let dismissed,firstWall={binding:'owner/screen',state:'waiting'},tab;
  const context={firstWallAttemptRef:{current:''},wallBindingKey:'owner/screen',firstWallAbortRef:{current:{controller,resume:true}},
    wallRequestScopeRef:binding,wallOperationRef:{current:{old:true}},setFirstWall:update=>firstWall=update(firstWall),
    setDismissedFirstWall:value=>dismissed=value,setActiveTab:value=>tab=value};
  value('leaveFirstWall',context)();assert.equal(controller.signal.aborted,true);assert.equal(tab,'calendar');assert.equal(firstWall.state,'failed');
  assert.equal(value('firstWallVisible',{firstWall,wallBindingKey:'owner/screen',recoveringPreferences:false,
    dismissedFirstWall:dismissed,sameDeviceBinding:status.sameDeviceBinding,wallRequestScopeRef:binding}),false);
  assert.equal(bound.firstWall.state,'publishing');assert.equal(bound.publishedWall.revision,'old');
});

test('real preference hydration timeout unlocks cached editing without overwriting its profile and late replies cannot cross binding',async()=>{
  const client=api(async()=>new Promise(()=>{})),binding={current:scope()},state={};
  const context={IS_WEB_PREVIEW:false,session:session(),preferenceProfileLoaded:true,preferenceRequestEpochRef:{current:0},
    wallRequestScopeRef:binding,sameDeviceBinding:status.sameDeviceBinding,DEFAULT_API_BASE:options.apiBase,
    setHydratedPreferenceDeviceId:value=>state.device=value,setHydratedPreferenceBinding:value=>state.binding=value,wallBindingKey:'owner/screen',
    readDevicePreferenceProfile:client.readDevicePreferenceProfile,cachePreferenceProfile:()=>assert.fail('failed read must not cache'),
    setPreferenceProfile:()=>assert.fail('failed read must not replace'),getActivePreferenceRevision:()=>null,hydratePreferenceSnapshot:()=>assert.fail(),
    setPreferenceReadError:value=>state.error=value,serviceFailureMessage:network.serviceFailureMessage};
  let cleanup=effect('readDevicePreferenceProfile({',context);await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(state.binding,'owner/screen');assert.equal(state.device,'screen');assert.match(state.error,/连接不到服务/);cleanup();
  const gate=deferred();context.readDevicePreferenceProfile=()=>gate.promise;cleanup=effect('readDevicePreferenceProfile({',context);
  binding.current={...binding.current,bindingEpoch:3};gate.resolve({revisions:[]});await flush();assert.equal(state.binding,'');cleanup();
});

test('real status poll errors never clear a binding, and a later successful read clears only reachability failure',async()=>{
  const bound=session(),binding={current:scope()},state={observation:null};let failure=true;
  const context={IS_WEB_PREVIEW:false,addingDevice:false,reconfigurationSession:null,session:bound,wallRequestScopeRef:binding,
    wallOperationRef:{current:{busy:true}},deviceManagementRef:{current:null},deviceStatusPollRef:{current:null},
    createDeviceStatusPoll:status.createDeviceStatusPoll,readDisplayStatus:async()=>{if(failure)throw Object.assign(Error('missing'),{code:'DEVICE_NOT_FOUND'});return{device_id:'screen',last_seen:Date.now()/1000}},
    DEFAULT_API_BASE:options.apiBase,setDeviceObservation:update=>state.observation=typeof update==='function'?update(state.observation):update,
    setStatusClock:()=>{},sameDeviceBinding:status.sameDeviceBinding,serviceFailureMessage:network.serviceFailureMessage,
    updateDeviceSession:()=>assert.fail('busy must not save'),removeDeviceSession:()=>assert.fail('read failure must not delete'),
    setInterval:()=>1,clearInterval:()=>{}};
  const cleanup=effect('const poll = createDeviceStatusPoll',context);await flush();assert.equal(state.observation.readFailed,true);
  assert.match(state.observation.message,/权限/);failure=false;await context.deviceStatusPollRef.current.refresh();
  assert.equal(state.observation.readFailed,false);assert.equal(bound.firstWall.state,'publishing');cleanup();
});

test('late family adoption callback uses its origin epoch and cannot upsert after a removal',async()=>{
  const f=storeFixture();await f.store.saveDeviceSession(session());const refs={deviceManagementRef:{current:null},deviceManagementEpochRef:{current:4}};
  const upgrade=value('handleFamilyDeviceUpgrade',{...refs,renderedManagementEpoch:4,normalizeDeviceSession:x=>x,
    deviceSessions:[session()],updateDeviceSession:f.store.updateDeviceSession,setDeviceSessions:()=>assert.fail('stale UI'),setSession:()=>assert.fail(),session:session()});
  refs.deviceManagementEpochRef.current++;await f.store.removeDeviceSession('screen');
  await upgrade({...session(),accountToken:'new-family-owner'});assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('leaving a household invalidates earlier account sync before its first queued deletion completes',async()=>{
  const refs={deviceManagementRef:{current:null},deviceManagementEpochRef:{current:4},wallRequestScopeRef:{current:scope()}},gate=deferred();
  const context={...refs,renderedManagementEpoch:4,deviceSessions:[session()],sameDeviceBinding:status.sameDeviceBinding,
    firstWallAbortRef:{current:null},removeDeviceSession:()=>gate.promise,loadDeviceSessions:async()=>({sessions:[],activeDeviceId:null}),
    normalizeDeviceSession:x=>x,setDeviceSessions:()=>{},setSession:()=>{},clearDeviceRuntimeState:()=>{}};
  const pending=value('handleHouseholdLeft',context)({devices:[{device_id:'screen'}]});
  assert.equal(refs.deviceManagementEpochRef.current,5);assert.ok(refs.deviceManagementRef.current);
  gate.resolve();await pending;assert.equal(refs.deviceManagementRef.current,null);
});

test('account read timeout releases shared initialization and keeps credentials without silently registering another account',async()=>{
  const client=api(async()=>new Promise(()=>{})),saved={accessToken:'existing',account:{name:'saved'}};
  const refs={accountPreparationRef:{current:null}},context={...refs,accountSession:saved,loadAccountSession:async()=>saved,
    readAccount:client.readAccount,setAccountSession:()=>{},persistAccountSession:()=>assert.fail('no persistence on unreachable service'),
    registerAccount:()=>assert.fail('network failure is not missing account')};
  await assert.rejects(value('prepareAccountSession',context)(),{code:'SERVICE_TIMEOUT'});assert.equal(refs.accountPreparationRef.current,null);
  assert.equal(saved.accessToken,'existing');
});

test('503 preference fallback reports local-only revision rather than cloud-saved success',async()=>{
  const recovery=require('../photo-wall-app/src/preferenceRecovery.cjs'),state={},binding={current:scope()};
  const profile={revisions:[{id:'old',snapshot:{rules:{}}}],activeRevisionId:'old'};
  const context={preferenceSaveInFlightRef:{current:false},preferenceDeviceKey:'screen',preferenceDeviceKeyRef:{current:'screen'},
    wallRequestScopeRef:binding,preferenceRequestEpochRef:{current:0},setSavingPreferenceRevision:value=>state.saving=value,setError:value=>state.error=value,
    savePreferenceWithFallback:recovery.savePreferenceWithFallback,IS_WEB_PREVIEW:false,effectiveSession:session(),session:session(),DEFAULT_API_BASE:options.apiBase,
    createDevicePreferenceRevision:async()=>{throw Object.assign(Error('unavailable'),{status:503})},preferenceProfile:profile,
    cachePreferenceProfile:()=>assert.fail('no remote cache'),savePreferenceRevision:async()=>({...profile,activeRevisionId:'local',revisions:[...profile.revisions,{id:'local'}]}),
    setPreferenceProfile:value=>state.profile=value,setNotice:value=>state.notice=value};
  await value('savePreferenceAsRevision',context)('preferences',{rules:{}});
  assert.match(state.notice,/本机新版本/);assert.equal(state.profile.activeRevisionId,'local');assert.equal(state.saving,false);
});

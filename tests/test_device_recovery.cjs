const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=path.resolve(__dirname,'../photo-wall-app');
const deps=process.env.PHOTO_WALL_TEST_DEPENDENCIES||app;
const resolve=name=>require.resolve(name,{paths:[deps]});
const babel=require(resolve('@babel/core'));
const source=fs.readFileSync(path.join(app,'App.js'),'utf8');
const ast=babel.parseSync(source,{configFile:false,babelrc:false,parserOpts:{plugins:['jsx']}});
const status=require('../photo-wall-app/src/deviceStatus.cjs');
const network=require('../photo-wall-app/src/networkRecovery.cjs');
const visit=(n,fn)=>{if(!n||typeof n!=='object')return;fn(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(x=>visit(x,fn));else if(v&&typeof v==='object')visit(v,fn)};
function value(name,context){let n;visit(ast,x=>{if(x.type==='VariableDeclarator'&&x.id.name===name)n=x.init});assert.ok(n,name);return vm.compileFunction('return ('+source.slice(n.start,n.end)+')',Object.keys(context))(...Object.values(context))}
function effect(fragment,context){let n;visit(ast,x=>{if(x.type==='CallExpression'&&x.callee.name==='useEffect'&&source.slice(x.arguments[0].start,x.arguments[0].end).includes(fragment))n=x.arguments[0]});assert.ok(n,fragment);return vm.compileFunction('return ('+source.slice(n.start,n.end)+')',Object.keys(context))(...Object.values(context))()}
function moduleAt(file,mocks={},globals={}){const filename=path.join(app,file),module={exports:{}};const code=babel.transformFileSync(filename,{configFile:false,babelrc:false,plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;vm.compileFunction(code,['module','exports','require',...Object.keys(globals)],{filename})(module,module.exports,name=>mocks[name]||{},...Object.values(globals));return module.exports}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const s=()=>({accountToken:'fixture-owner',device:{device_id:'screen',binding_id:'binding-a'},firstWall:{state:'publishing',wallId:'wall'},publishedWall:{revision:'previous'}});
const scope=()=>({deviceId:'screen',bindingKey:'fixture-owner/screen',bindingEpoch:1,sequence:0});
function storage(){const values=new Map(),events=[],hooks={set:null};const secure={WHEN_UNLOCKED_THIS_DEVICE_ONLY:'test',getItemAsync:async k=>values.get(k),setItemAsync:async(k,v)=>{events.push(k);if(hooks.set)await hooks.set(k,v);values.set(k,v)},deleteItemAsync:async k=>values.delete(k)};return{values,events,hooks,store:moduleAt('src/sessionStore.js',{'react-native':{Platform:{OS:'ios'}},'expo-secure-store':secure})}}
const response=(body,code=202)=>({ok:code>=200&&code<300,status:code,text:async()=>JSON.stringify(body)});
function api(fetch){return moduleAt('src/deviceApi.js',{'react-native':{Platform:{OS:'ios'}},'./unifiedSelection':{UNIFIED_SELECTION:true},'./networkRecovery.cjs':network,'./deviceStatus.cjs':status},{fetch,process:{env:{}},__DEV__:false})}
const options={apiBase:'https://fixture.invalid',deviceId:'screen',accountToken:'fixture-owner',bindingId:'binding-a',requestId:'request-a'};

test('manual check joins pending poll and visibly completes with one actual status read',async()=>{
  const gate=deferred(),binding={current:scope()},seen=[];let calls=0;
  const poll=status.createDeviceStatusPoll({getScope:()=>binding.current,isBusy:()=>true,readDevice:()=>{calls++;return gate.promise},onObserved:()=>{},onIdle:()=>assert.fail(),onError:()=>{}});
  const automatic=poll.refresh();
  const context={wallRequestScopeRef:binding,connectionCheckRef:{current:null},sameDeviceBinding:status.sameDeviceBinding,
    setConnectionCheck:x=>seen.push(x),setHistoryRefresh:()=>{},setConnectionRefresh:()=>{},deviceStatusPollRef:{current:poll},
    withDeviceStatusTimeout:status.withDeviceStatusTimeout,connectionCheckResult:status.connectionCheckResult,serviceFailureMessage:network.serviceFailureMessage};
  const check=value('checkConnection',context),first=check(),second=check();assert.equal(first,second);assert.equal(seen[0].state,'checking');assert.equal(calls,1);
  gate.resolve({device_id:'screen',last_seen:Date.now()/1000});await automatic;const result=await first;
  assert.equal(result.state,'connected');assert.equal(seen.at(-1).state,'connected');assert.equal(context.connectionCheckRef.current,null);
});

test('manual check times out visibly, can retry, and ignores late different binding results',async()=>{
  const binding={current:scope()},seen=[],gate=deferred();let pending=()=>new Promise(()=>{});
  const context={wallRequestScopeRef:binding,connectionCheckRef:{current:null},sameDeviceBinding:status.sameDeviceBinding,setConnectionCheck:x=>seen.push(x),setHistoryRefresh:()=>{},setConnectionRefresh:()=>{},deviceStatusPollRef:{current:{refresh:()=>pending()}},withDeviceStatusTimeout:read=>status.withDeviceStatusTimeout(read,{timeoutMs:5}),connectionCheckResult:status.connectionCheckResult,serviceFailureMessage:network.serviceFailureMessage};
  const check=value('checkConnection',context);await check();assert.equal(seen.at(-1).state,'failed');assert.match(seen.at(-1).message,/连接不到服务/);
  pending=()=>gate.promise;const late=check();binding.current={...binding.current,bindingEpoch:2};gate.resolve({ok:true,device:{last_seen:Date.now()/1000}});await late;
  assert.equal(seen.at(-1).state,'checking');assert.equal(context.connectionCheckRef.current,null);
});

test('connection check separates actual expired heartbeat from unreachable service and device fault',()=>{
  assert.equal(status.connectionCheckResult({ok:true,device:{last_seen:100}},200000).state,'offline');
  assert.equal(status.connectionCheckResult({ok:true,device:{last_seen:200,error:'failed'}},200000).state,'device-error');
  assert.equal(status.connectionCheckResult({ok:false,error:Error('network')}).state,'failed');
});

test('cloud DELETE sends both binding and persisted attempt headers; every mismatched receipt is rejected',async()=>{
  const good={device_id:'screen',removed:true,binding_id:'binding-a',request_id:'request-a',reprovision_required:true};let request;
  const client=api(async(_,init)=>{request=init;return response(good)});await client.removeDisplay(options);
  assert.equal(request.headers['X-Device-Binding'],'binding-a');assert.equal(request.headers['X-Delete-Request-Id'],'request-a');
  for(const body of [{...good,binding_id:'new-binding'},{...good,request_id:'other'},{...good,device_id:'other'},{...good,removed:false},{device_id:'screen',removed:true}])await assert.rejects(api(async()=>response(body)).removeDisplay(options),{code:'INVALID_SERVICE_RESPONSE'});
  for(const code of [401,404,409])await assert.rejects(api(async()=>response({error:'not removed'},code)).removeDisplay(options),{status:code});
});

test('delete retry reuses durable ID even after lost response; a new binding allocates another attempt',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());const first=await f.store.prepareDeviceRemoval(s());assert.match(first.requestId,/^[\da-f-]{36}$/);
  assert.deepEqual(await f.store.prepareDeviceRemoval(s()),first);
  assert.deepEqual(await f.store.prepareDeviceRemoval({...s(),device:{device_id:'screen'}}),first);
  await f.store.saveDeviceSession({...s(),device:{device_id:'screen',binding_id:'binding-b'}});
  const next=await f.store.prepareDeviceRemoval({...s(),device:{device_id:'screen',binding_id:'binding-b'}});
  assert.notEqual(next.requestId,first.requestId);assert.equal(next.bindingId,'binding-b');
});

test('missing binding never creates an unprotected delete attempt and stale owner cannot prepare a removal',async()=>{
  const f=storage(),old={...s(),device:{device_id:'screen'}};await f.store.saveDeviceSession(old);
  await assert.rejects(f.store.prepareDeviceRemoval(old),{code:'DEVICE_BINDING_REQUIRED'});
  await assert.rejects(f.store.prepareDeviceRemoval({...old,accountToken:'other'}),{code:'DEVICE_BINDING_CHANGED'});
});

test('local-only removal first protects credentials and preferences, blocks passive rediscovery, and explicit restore clears it',async()=>{
  const f=storage(),old=s(),profile={activeRevisionId:'saved',revisions:[{id:'saved',snapshot:{rules:{more:['person-old']}}}]};await f.store.saveDeviceSession(old);f.events.length=0;
  const removed=await f.store.forgetDeviceSession({...old,recoveryPreferenceProfile:profile});assert.equal(removed.sessions.length,0);
  assert.equal(f.events[0],'photowall-device-recovery-v1');const record=await f.store.loadDeviceRecovery('screen');
  assert.equal(record.session.accountToken,old.accountToken);assert.deepEqual(record.session.firstWall,old.firstWall);assert.deepEqual(record.session.recoveryPreferenceProfile,profile);
  assert.deepEqual(await f.store.loadLocallyRemovedDeviceIds(),['screen']);await assert.rejects(f.store.updateDeviceSession(old),{code:'DEVICE_LOCALLY_REMOVED'});
  await f.store.saveDeviceSession(record.session);assert.equal(await f.store.loadDeviceRecovery('screen'),null);assert.equal((await f.store.loadDeviceSessions()).sessions.length,1);
});

test('failed recovery-key write cannot remove the visible binding or overwrite the original owner',async()=>{
  const f=storage(),old=s();await f.store.saveDeviceSession(old);
  f.hooks.set=async key=>{if(key==='photowall-device-recovery-v1')throw Error('keychain unavailable')};
  await assert.rejects(f.store.forgetDeviceSession(old),/keychain/);assert.equal((await f.store.loadDeviceSession()).accountToken,old.accountToken);assert.equal((await f.store.loadDeviceSessions()).sessions.length,1);
  await assert.rejects(f.store.forgetDeviceSession({...old,accountToken:'other'}),{code:'DEVICE_BINDING_CHANGED'});
});

test('cloud removal total deadline does not dispatch a late DELETE after the preliminary binding lookup',async()=>{
  const gate=deferred();let deletes=0,removes=0;
  const context={runManagedDeviceAction:(_,action)=>action(()=>true),IS_WEB_PREVIEW:false,isScreen19Device:()=>false,
    prepareDeviceRemoval:async()=>{throw Object.assign(Error('missing'),{code:'DEVICE_BINDING_REQUIRED'})},readDisplayStatus:()=>gate.promise,
    withDeviceStatusTimeout:read=>status.withDeviceStatusTimeout(read,{timeoutMs:5}),removeDisplay:()=>{deletes++},removeDeviceSession:()=>{removes++},DEFAULT_API_BASE:'https://fixture.invalid',serviceFailureMessage:network.serviceFailureMessage};
  await assert.rejects(value('removeManagedDevice',context)(s()),/尚未确认删除/);gate.resolve(s().device);await flush();assert.equal(deletes,0);assert.equal(removes,0);
});

function surfaces(from){const state={manage:from==='manage',add:from==='add',setup:from==='setup',mounted:from==='setup',nearby:from==='nearby'?{deviceId:'screen'}:null};const context={deviceModal:state.setup,deviceManagerVisible:state.manage,addDisplayVisible:state.add,nearbyDevicePrompt:state.nearby,pendingDeviceSurfaceRef:{current:null},Platform:{OS:'ios'},setDeviceManagerVisible:v=>state.manage=v,setAddDisplayVisible:v=>state.add=v,setDeviceModal:v=>state.setup=v,setDeviceSetupMounted:v=>state.mounted=v,setNearbyDevicePrompt:v=>state.nearby=v};context.presentDeviceSurface=value('presentDeviceSurface',context);context.finishDeviceSurfaceTransition=value('finishDeviceSurfaceTransition',context);return{state,context,open:value('openDeviceSurface',context)}}
test('actual modal coordinator waits for matching iOS onDismiss across manage/add/setup/nearby',()=>{
  for(const [from,to] of [['manage','setup'],['manage','add'],['add','setup'],['setup','manage'],['nearby','setup']]){
    const f=surfaces(from);f.open(to);assert.equal(f.state.manage||f.state.add||f.state.setup,false);
    f.context.finishDeviceSurfaceTransition('wrong');assert.equal(f.state.manage||f.state.add||f.state.setup,false);
    f.context.finishDeviceSurfaceTransition(from);assert.equal(f.state[to],true);assert.equal(f.context.pendingDeviceSurfaceRef.current,null);
  }
});

function adapter(extra={}){const events=[];const context={startBleDeviceDiscovery:()=>{},stopBleDeviceDiscovery:()=>{},connectBleProvisioningDevice:async()=>({deviceId:'screen',setupToken:'physical-proof'}),loadDeviceRecovery:async()=>({session:s()}),scanBleWifiNetworks:()=>{},subscribeBleProvisionStatus:()=>{},cancelBleProvisioning:()=>{},createProvisionStatusWaiter:()=>({promise:Promise.resolve({deviceId:'screen',localUrl:'http://fixture.invalid'}),cancel:()=>events.push('cancel')}),reprovisionDisplay:async options=>{events.push(['authorize',options]);return{device:s().device}},provisionBleWifi:async()=>events.push('wifi'),claimProvisionedDevice:async()=>{events.push('claim');return{accountToken:'new-owner',device:{device_id:'screen',binding_id:'new-binding'}}},localUrlForDevice:()=>'',DEFAULT_API_BASE:'https://fixture.invalid',...extra};return{events,api:value('REAL_DEVICE_SETUP_ADAPTER',context)}}
test('physical same-device recovery uses retained owner plus fresh setup proof and preserves publication',async()=>{
  const f=adapter(),device=await f.api.connectProvisioningDevice('screen'),result=await f.api.provisionWifi({ssid:'synthetic',password:'',device});
  assert.equal(f.events[0][0],'authorize');assert.equal(f.events[0][1].setupToken,'physical-proof');assert.equal(f.events[0][1].accountToken,'fixture-owner');assert.equal(f.events[1],'wifi');
  assert.equal(result.firstWall.state,'publishing');assert.equal(result.publishedWall.revision,'previous');assert.ok(!f.events.includes('claim'));
});

test('401 recovery uses normal physical claim authorization, preserves preference but never inherits old wall publication',async()=>{
  const profile={revisions:[{id:'local',snapshot:{rules:{more:['person-old']}}}],activeRevisionId:'local'};
  const f=adapter({loadDeviceRecovery:async()=>({session:{...s(),recoveryPreferenceProfile:profile}}),reprovisionDisplay:async()=>{throw Object.assign(Error('missing'),{status:401})}});
  const device=await f.api.connectProvisioningDevice('screen'),result=await f.api.provisionWifi({device});
  assert.equal(result.accountToken,'new-owner');assert.deepEqual(result.recoveryPreferenceProfile,profile);assert.equal(result.publishedWall,undefined);assert.equal(result.firstWall,undefined);assert.ok(f.events.includes('claim'));
});

test('wrong physical device, network failure, or server ownership rejection cannot restore a recovery session',async()=>{
  let f=adapter();await assert.rejects(f.api.provisionWifi({device:{deviceId:'other',recoverySession:s()}}),/不是原/);
  f=adapter({reprovisionDisplay:async()=>{throw Error('unreachable')}});let device=await f.api.connectProvisioningDevice('screen');await assert.rejects(f.api.provisionWifi({device}),/unreachable/);assert.ok(!f.events.includes('wifi'));
  f=adapter({reprovisionDisplay:async()=>{throw Object.assign(Error('missing'),{status:401})},claimProvisionedDevice:async()=>{throw Object.assign(Error('still owned'),{status:403})}});device=await f.api.connectProvisioningDevice('screen');await assert.rejects(f.api.provisionWifi({device}),/still owned/);assert.ok(f.events.includes('cancel'));
});

test('explicit reprovision opens BLE with no racing cloud preflight',async()=>{
  const opened=[],bound=s();let requests=0;
  const context={session:bound,deviceSessions:[bound],canManageCurrentDevice:true,IS_WEB_PREVIEW:false,isScreen19Device:()=>false,
    runManagedDeviceAction:(_,action)=>action(()=>true),savePendingDeviceSetup:async()=>{},setReconfigurationSession:x=>opened.push(x),setAddingDevice:()=>{},setInitialSetupDevice:()=>{},openDeviceSurface:x=>opened.push(x),setNotice:()=>{},reprovisionDisplay:()=>{requests++;return new Promise(()=>{})},DEFAULT_API_BASE:'https://fixture.invalid'};
  await value('reconfigureManagedDevice',context)(bound);assert.ok(opened.includes('setup'));assert.equal(requests,0);
});

test('empty cloud profile cannot erase recovered preferences after a same-device claim uses a new account',async()=>{
  const binding={current:scope()},saved={...s(),accountToken:'new-owner',recoveryPreferenceProfile:{revisions:[{id:'local'}]}},state={};
  const cleanup=effect('readDevicePreferenceProfile({',{IS_WEB_PREVIEW:false,session:saved,preferenceProfileLoaded:true,
    preferenceRequestEpochRef:{current:0},wallRequestScopeRef:binding,sameDeviceBinding:status.sameDeviceBinding,
    setHydratedPreferenceDeviceId:x=>state.id=x,setHydratedPreferenceBinding:x=>state.binding=x,
    readDevicePreferenceProfile:async()=>({revisions:[]}),cachePreferenceProfile:()=>assert.fail('must preserve'),setPreferenceProfile:()=>assert.fail('must preserve'),setPreferenceReadError:x=>state.message=x,DEFAULT_API_BASE:'https://fixture.invalid',wallBindingKey:'new',serviceFailureMessage:network.serviceFailureMessage});
  await flush();assert.match(state.message,/保留.*偏好/);assert.equal(state.binding,'new');cleanup();
});

test('same-owner recovery with a new public binding never inherits the old binding wall intent',async()=>{
  const f=adapter({reprovisionDisplay:async()=>({device:{device_id:'screen',binding_id:'binding-new'}})});
  const device=await f.api.connectProvisioningDevice('screen'),result=await f.api.provisionWifi({device});
  assert.equal(result.device.binding_id,'binding-new');assert.equal(result.firstWall,null);assert.equal(result.publishedWall,null);
});

test('actual successful onConnected restores recovered preference snapshot before enabling a new-account binding',async()=>{
  const f=storage(),old=s(),profile={revisions:[{id:'local',snapshot:{rules:{person_old:'more'},schedule:{time:'21:15'}}}],activeRevisionId:'local'};
  await f.store.saveDeviceSession(old);await f.store.forgetDeviceSession({...old,recoveryPreferenceProfile:profile});
  const state={},noop=()=>{},binding={current:scope()},management={current:0};
  const context={renderedManagementEpoch:0,deviceManagementRef:{current:null},deviceManagementEpochRef:management,wallRequestScopeRef:binding,
    reconfigurationSession:null,IS_WEB_PREVIEW:false,addingDevice:true,normalizeDeviceSession:x=>x,
    prepareAccountSession:async()=>{throw Error('cloud unavailable')},saveDeviceSession:f.store.saveDeviceSession,
    cachePreferenceProfile:async x=>state.cached=x,setPreferenceProfile:x=>state.profile=x,
    getActivePreferenceRevision:p=>p.revisions.find(r=>r.id===p.activeRevisionId),hydratePreferenceSnapshot:x=>state.snapshot=x,
    setSession:x=>state.session=x,setDeviceSessions:noop,clearPendingDeviceSetup:async()=>{},setReconfigurationSession:noop,setAddingDevice:noop,
    setInitialSetupDevice:noop,setDeviceModal:noop,openDeviceSurface:x=>state.surface=x,needsOnboarding:false,setActiveTab:noop,setNotice:noop};
  await value('onConnected',context)({accountToken:'new-owner',device:{device_id:'screen',binding_id:'new-binding'},recoveryPreferenceProfile:profile});
  assert.deepEqual(state.cached,profile);assert.deepEqual(state.profile,profile);assert.equal(state.snapshot.schedule.time,'21:15');
  assert.equal(state.session.accountToken,'new-owner');assert.equal(state.session.publishedWall,undefined);assert.equal(state.surface,'manage');assert.equal(await f.store.loadDeviceRecovery('screen'),null);
});

test('local-only removal preserves photo-sync runtime while invalidating wall and device views',()=>{
  let syncCleared=false,sessionCleared=false;let n;visit(ast,x=>{if(x.type==='VariableDeclarator'&&x.id.name==='clearDeviceRuntimeState')n=x.init});
  const names=new Set();visit(n,x=>{if(x.type==='CallExpression'&&x.callee.type==='Identifier')names.add(x.callee.name)});
  const context=Object.fromEntries([...names].map(name=>[name,()=>{}]));Object.assign(context,{EMPTY_RECOGNITION_SNAPSHOT:{},EMPTY_OPERATION:{},setPhotoSync:()=>syncCleared=true,setSession:()=>sessionCleared=true});
  value('clearDeviceRuntimeState',context)({preservePhotoSync:true});assert.equal(syncCleared,false);assert.equal(sessionCleared,true);
});

test('same-account new binding rejects old deletion receipt at queue commit, including a non-current device',async()=>{
  const f=storage(),old=s();await f.store.saveDeviceSession(old);const attempt=await f.store.prepareDeviceRemoval(old);
  await f.store.saveDeviceSession({...old,device:{...old.device,binding_id:'binding-b'}});
  await assert.rejects(f.store.removeDeviceSession('screen',{expectedAccountToken:old.accountToken,expectedBindingId:'binding-a',returnSnapshot:true}),{code:'DEVICE_BINDING_CHANGED'});
  await assert.rejects(f.store.forgetDeviceSession(old),{code:'DEVICE_BINDING_CHANGED'});
  await assert.rejects(f.store.prepareDeviceRemoval({...old,device:{device_id:'screen'}}),{code:'DEVICE_BINDING_CHANGED'});
  assert.equal((await f.store.loadDeviceSession()).device.binding_id,'binding-b');assert.equal(attempt.bindingId,'binding-a');
});

test('actual managed action rejects a late non-current target binding while active wall scope remains unchanged',async()=>{
  const old=s(),refs={latestDeviceSessionsRef:{current:[old]},deviceManagementRef:{current:null},deviceManagementEpochRef:{current:0},wallRequestScopeRef:{current:{...scope(),deviceId:'other-active'}},firstWallAbortRef:{current:null},wallOperationRef:{current:null},deviceStatusPollRef:{current:null}};
  const gate=deferred(),run=value('runManagedDeviceAction',{...refs,IS_WEB_PREVIEW:false,sameManagedDevice:network.sameManagedDevice,sameDeviceBinding:status.sameDeviceBinding});
  const pending=run(old,async current=>{await gate.promise;return current()});
  refs.latestDeviceSessionsRef.current=[{...old,device:{...old.device,binding_id:'binding-b'}}];gate.resolve();assert.equal(await pending,false);
});

test('forgetting another-account non-current device never copies the active device preference profile',async()=>{
  const target={...s(),accountToken:'other-owner'},active={...s(),device:{device_id:'active',binding_id:'active-binding'}},profile={revisions:[{id:'active-only'}]};let saved;
  const context={runManagedDeviceAction:(_,action)=>action(()=>true),sameManagedDevice:network.sameManagedDevice,latestWallSessionRef:{current:active},preferenceProfile:profile,
    IS_WEB_PREVIEW:false,forgetDeviceSession:async x=>{saved=x;return{sessions:[active],activeDeviceId:'active'}},applyDeviceRemoval:()=>{},setNotice:()=>{},setAddingDevice:()=>{},setInitialSetupDevice:()=>{},openDeviceSurface:()=>{}};
  await value('forgetManagedDevice',context)(target);assert.equal(saved.recoveryPreferenceProfile,undefined);
});

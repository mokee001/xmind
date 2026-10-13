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
function value(name,context){context={recoverySetupRef:{current:null},setRecoverySetupSession:()=>{},...context};let n;visit(ast,x=>{if(x.type==='VariableDeclarator'&&x.id.name===name)n=x.init});assert.ok(n,name);return vm.compileFunction('return ('+source.slice(n.start,n.end)+')',Object.keys(context))(...Object.values(context))}
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

function adapter(extra={}){const events=[];const context={startBleDeviceDiscovery:()=>{},stopBleDeviceDiscovery:()=>{},connectBleProvisioningDevice:async()=>({deviceId:'screen',setupToken:'physical-proof'}),loadDeviceRecovery:async()=>({session:s()}),scanBleWifiNetworks:()=>{},subscribeBleProvisionStatus:()=>{},cancelBleProvisioning:()=>{},createProvisionStatusWaiter:()=>({promise:Promise.resolve({deviceId:'screen',localUrl:'http://fixture.invalid'}),cancel:()=>events.push('cancel')}),reprovisionDisplay:async options=>{events.push(['authorize',options]);return{device:s().device}},provisionBleWifi:async()=>events.push('wifi'),claimProvisionedDevice:async()=>{events.push('claim');return{accountToken:'new-owner',device:{device_id:'screen',binding_id:'new-binding'}}},localUrlForDevice:()=>'',DEFAULT_API_BASE:'https://fixture.invalid',...extra};context.sendReprovisionOperation=({session,setupToken})=>context.reprovisionDisplay({accountToken:session.accountToken,setupToken});return{events,api:value('REAL_DEVICE_SETUP_ADAPTER',context)}}
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

test('explicit reprovision opens BLE before waiting for its guarded cloud wake operation',async()=>{
  const opened=[],bound=s();let requests=0;
  const context={session:bound,deviceSessions:[bound],canManageCurrentDevice:true,IS_WEB_PREVIEW:false,isScreen19Device:()=>false,
    runManagedDeviceAction:(_,action)=>action(()=>true),savePendingDeviceSetup:async()=>{},setReconfigurationSession:x=>opened.push(x),setAddingDevice:()=>{},setInitialSetupDevice:()=>{},openDeviceSurface:x=>opened.push(x),setNotice:()=>{},wakeReconfiguration:()=>{requests++;return new Promise(()=>{})},DEFAULT_API_BASE:'https://fixture.invalid'};
  await value('reconfigureManagedDevice',context)(bound);assert.ok(opened.includes('setup'));assert.equal(requests,1);
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

function operationRunner(f,{read,post,timeoutMs=10000}={}) {
  return value('sendReprovisionOperation',{withDeviceStatusTimeout:(fn,opts)=>status.withDeviceStatusTimeout(fn,{...opts,timeoutMs}),
    loadDeviceReprovision:f.store.loadDeviceReprovision,prepareDeviceReprovision:f.store.prepareDeviceReprovision,
    readDisplayStatus:read||(async()=>({...s().device,recovery_generation:'gen-0'})),
    reprovisionDisplay:post||(async ({operation,phase})=>({device:{...s().device,recovery_generation:'gen-1'},
      operation:{id:operation.operationId,binding_id:operation.bindingId,from_generation:operation.expectedGeneration,generation:'gen-1',stage:phase==='authorize'?'authorized':'entered'}})),DEFAULT_API_BASE:'https://fixture.invalid'});
}

test('legacy session obtains binding and generation read-only, persists the shared intent before either phase',async()=>{
  const f=storage(),legacy={...s(),device:{device_id:'screen'}};await f.store.saveDeviceSession(legacy);
  const events=[],messages=[];
  const send=operationRunner(f,{read:async()=>{events.push('read');return{device_id:'screen',binding_id:'binding-a',recovery_generation:'gen-0'}},post:async body=>{assert.ok(f.values.has('photowall-device-reprovision-v1'));events.push(body.phase);messages.push(body);return{device:{device_id:'screen'}}}});
  await send({session:legacy,phase:'enter_setup'});await send({session:legacy,phase:'authorize',setupToken:'fresh-physical-proof'});
  assert.deepEqual(events,['read','enter_setup','authorize']);assert.deepEqual(messages[0].operation,messages[1].operation);
  assert.equal(messages[1].operation.bindingId,'binding-a');assert.equal(messages[1].operation.expectedGeneration,'gen-0');
  assert.equal((await f.store.loadDeviceSession()).device.binding_id,undefined,'metadata lookup must not switch the active binding or invalidate its UI');
});

test('a lost enter response and reopening reuse durable operation ID and original generation without rebasing',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());let first=true,reads=0;const attempts=[];
  const options={read:async()=>{reads++;return{...s().device,recovery_generation:'gen-0'}},post:async body=>{attempts.push(body.operation);if(first){first=false;throw Object.assign(Error('lost response'),{code:'SERVICE_TIMEOUT'})}return{device:s().device}}};
  await assert.rejects(operationRunner(f,options)({session:s(),phase:'enter_setup'}),{code:'SERVICE_TIMEOUT'});
  // Recreate the orchestration function: no in-memory operation reference is reused.
  await operationRunner(f,options)({session:s(),phase:'enter_setup'});
  assert.equal(reads,1);assert.deepEqual(attempts[0],attempts[1]);assert.ok(await f.store.loadDeviceReprovision(s()));
});

test('persistent operation write failure never dispatches either cloud phase',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());let posted=0;
  f.hooks.set=async key=>{if(key==='photowall-device-reprovision-v1')throw Error('keychain unavailable')};
  const send=operationRunner(f,{post:async()=>posted++});
  for(const phase of ['enter_setup','authorize'])await assert.rejects(send({session:s(),phase}),/keychain/);
  assert.equal(posted,0);assert.equal((await f.store.loadDeviceSession()).accountToken,s().accountToken);
});

test('concurrent wake and physical authorization share the serialized durable intent, including proof arriving first',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());const gate=deferred(),calls=[];
  const send=operationRunner(f,{read:()=>gate.promise,post:async body=>{calls.push(body);return{device:s().device}}});
  const proof=send({session:s(),phase:'authorize',setupToken:'fresh-proof'}),enter=send({session:s(),phase:'enter_setup'});
  gate.resolve({...s().device,recovery_generation:'gen-0'});await Promise.all([proof,enter]);
  assert.equal(calls.length,2);assert.equal(calls[0].operation.operationId,calls[1].operation.operationId);assert.equal(calls[0].operation.expectedGeneration,calls[1].operation.expectedGeneration);
});

test('cancelled or changed binding cannot persist a late lookup or send a cloud command; an already sent intent remains recoverable',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());let active=true,posted=0;const gate=deferred();
  const pending=operationRunner(f,{read:()=>gate.promise,post:async()=>posted++})({session:s(),phase:'enter_setup',isCurrent:()=>active});
  active=false;gate.resolve({...s().device,recovery_generation:'gen-0'});await assert.rejects(pending,{name:'AbortError'});assert.equal(posted,0);assert.equal(await f.store.loadDeviceReprovision(s()),null);
  active=true;const reply=deferred();const sent=operationRunner(f,{post:()=>{posted++;return reply.promise}})({session:s(),phase:'enter_setup',isCurrent:()=>active});await flush();active=false;reply.resolve({device:s().device});await assert.rejects(sent,{name:'AbortError'});assert.ok(await f.store.loadDeviceReprovision(s()));
});

test('409 is not automatically rebased, and only explicit new operation reads fresh generation and changes ID',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());let reads=0;const seen=[];
  const send=operationRunner(f,{read:async()=>({...s().device,recovery_generation:`gen-${reads++}`}),post:async body=>{seen.push(body.operation);throw Object.assign(Error('conflict'),{status:409})}});
  await assert.rejects(send({session:s(),phase:'enter_setup'}),{status:409});
  await assert.rejects(send({session:s(),phase:'authorize',setupToken:'proof'}),{status:409});assert.equal(reads,1);assert.deepEqual(seen[0],seen[1]);
  await assert.rejects(send({session:s(),phase:'enter_setup',newOperation:true}),{status:409});assert.equal(reads,2);assert.notEqual(seen[1].operationId,seen[2].operationId);assert.equal(seen[2].expectedGeneration,'gen-1');
});

test('real API carries and validates the full two-phase recovery contract and rejects stale response identities',async()=>{
  const operation={operationId:'op-a',bindingId:'binding-a',expectedGeneration:'gen-0'},sent=[];
  const good={device:{device_id:'screen',binding_id:'binding-a',recovery_generation:'gen-1'},reprovision_required:true,
    operation:{id:'op-a',binding_id:'binding-a',from_generation:'gen-0',generation:'gen-1',stage:'authorized'}};
  const client=api(async(_,init)=>{sent.push(init);return response(good)});
  await client.reprovisionDisplay({...options,operation,phase:'authorize',setupToken:'fresh-proof'});
  assert.equal(sent[0].headers['X-Device-Binding'],'binding-a');assert.deepEqual(JSON.parse(sent[0].body),{setup_token:'fresh-proof',operation_id:'op-a',expected_generation:'gen-0',phase:'authorize'});
  for(const changes of [{id:'other'},{binding_id:'other'},{from_generation:'other'},{generation:'other'},{stage:'entered'},{stage:'unknown'}])await assert.rejects(api(async()=>response({...good,operation:{...good.operation,...changes}})).reprovisionDisplay({...options,operation,phase:'authorize'}),{code:'INVALID_SERVICE_RESPONSE'});
  await client.reprovisionDisplay({...options,operation,phase:'enter_setup'}); // authorized replay is safe and valid for a late enter.
});

test('successful real connection storage clears only its exact recovery operation; failed storage keeps the intent',async()=>{
  const f=storage(),old={...s(),device:{...s().device,recovery_generation:'gen-0'}};await f.store.saveDeviceSession(old);const op=await f.store.prepareDeviceReprovision(old);
  let fail=true,cleared=0;const noop=()=>{},context={renderedManagementEpoch:0,deviceManagementRef:{current:null},deviceManagementEpochRef:{current:0},wallRequestScopeRef:{current:scope()},reconfigurationSession:old,IS_WEB_PREVIEW:false,addingDevice:false,normalizeDeviceSession:x=>x,
    prepareAccountSession:async()=>{throw Error('unavailable')},updateDeviceSession:async(...args)=>{if(fail)throw Error('session write failed');return f.store.updateDeviceSession(...args)},clearDeviceReprovision:async(...args)=>{cleared++;return f.store.clearDeviceReprovision(...args)},setSession:noop,setDeviceSessions:noop,clearPendingDeviceSetup:async()=>{},setReconfigurationSession:noop,setAddingDevice:noop,setInitialSetupDevice:noop,setDeviceModal:noop,openDeviceSurface:noop,needsOnboarding:false,setActiveTab:noop,setNotice:noop};
  const result={...old,reprovisionOperation:op};await assert.rejects(value('onConnected',context)(result),/session write failed/);assert.equal(cleared,0);assert.ok(await f.store.loadDeviceReprovision(old));
  fail=false;await value('onConnected',context)(result);assert.equal(cleared,1);assert.equal(await f.store.loadDeviceReprovision(old),null);assert.equal((await f.store.loadDeviceSession()).firstWall.state,'publishing');
});

test('wake UI immediately shows progress, distinguishes uncertain result, and never waits before presentation',async()=>{
  const old=s(),gate=deferred(),states=[],context={reprovisionWakeRef:{current:null},deviceManagementEpochRef:{current:3},latestDeviceSessionsRef:{current:[old]},sameManagedDevice:network.sameManagedDevice,
    setReprovisionWake:x=>states.push(x),sendReprovisionOperation:()=>gate.promise,serviceFailureMessage:network.serviceFailureMessage};
  const wake=value('wakeReconfiguration',context),pending=wake(old);assert.equal(states[0].state,'waking');
  gate.reject(Object.assign(Error('timeout'),{code:'SERVICE_TIMEOUT'}));await pending;assert.equal(states.at(-1).state,'failed');assert.match(states.at(-1).message,/尚未确认/);assert.equal(context.reprovisionWakeRef.current,null);
});

test('App restart restores a paused pending setup with a visible safe retry rather than silently creating a fresh operation',async()=>{
  const old=s(),state={},noop=()=>{};
  const cleanup=effect('Promise.all([loadDeviceSessions(), loadPendingDeviceSetup()])',{
    IS_WEB_PREVIEW:false,deviceManagementEpochRef:{current:4},deviceManagementRef:{current:null},loadDeviceSessions:async()=>({sessions:[old],activeDeviceId:'screen'}),
    loadPendingDeviceSetup:async()=>({kind:'reconfigure',session:old}),normalizeDeviceSession:x=>x,sameManagedDevice:network.sameManagedDevice,
    setDeviceSessions:noop,setSession:noop,setReconfigurationSession:x=>state.session=x,setReprovisionWake:x=>state.wake=x,openDeviceSurface:x=>state.surface=x,
    setActiveTab:noop,setError:assert.fail,loadPhotoSyncPreference:async()=>null,setPhotoSync:noop,refreshPermission:async()=>{}});
  await flush();assert.equal(state.wake.state,'paused');assert.equal(state.surface,'setup');assert.equal(state.session.device.device_id,'screen');cleanup();
});

test('explicit new-operation permission is consumed once even if authorization fails, so ordinary retry cannot silently rebase',async()=>{
  const content=fs.readFileSync(path.join(app,'src/DeviceSetupFlow.js'),'utf8');const parsed=babel.parseSync(content,{configFile:false,babelrc:false,parserOpts:{plugins:['jsx']}});let n;
  visit(parsed,x=>{if(x.type==='VariableDeclarator'&&x.id.name==='connectWifi')n=x.init});const flags=[],noop=()=>{},ref={current:true};
  const context={provisionRequestRef:{current:false},selectedNetwork:{ssid:'synthetic',secure:false},password:'',flowGenerationRef:{current:0},
    setBusy:noop,setError:noop,setProgress:noop,setStatusText:noop,transition:noop,previewMode:false,newRecoveryOperationRef:ref,selectedDevice:{deviceId:'screen'},
    existingSession:s(),recoverySession:null,isSessionCurrent:()=>true,setRecoveryConflict:noop,adapter:{provisionWifi:async options=>{flags.push(options.newOperation);throw Object.assign(Error('lost response'),{code:'SERVICE_TIMEOUT'})}}};
  const connect=vm.compileFunction('return ('+content.slice(n.start,n.end)+')',Object.keys(context))(...Object.values(context));
  await connect();await connect();assert.deepEqual(flags,[true,false]);assert.equal(ref.current,false);
});

function removedFlow(f, overrides={}) {
  const state={surfaces:[],wakes:[]},noop=()=>{};
  const context={recoverySetupRef:{current:null},reprovisionWakeRef:{current:null},deviceManagementRef:{current:null},deviceManagementEpochRef:{current:0},latestDeviceSessionsRef:{current:[]},
    sameManagedDevice:network.sameManagedDevice,loadDeviceRecoverySessions:f.store.loadDeviceRecoverySessions,savePendingDeviceSetup:f.store.savePendingDeviceSetup,clearPendingDeviceSetup:f.store.clearPendingDeviceSetup,
    setRecoverySetupSession:x=>state.target=x,setReconfigurationSession:noop,setAddingDevice:noop,setInitialSetupDevice:noop,
    openDeviceSurface:x=>state.surfaces.push(x),setReprovisionWake:x=>state.wakes.push(x),serviceFailureMessage:network.serviceFailureMessage,
    IS_WEB_PREVIEW:false,reconfigurationSession:null,pendingDeviceSurfaceRef:{current:null},setDeviceModal:noop,setError:assert.fail,...overrides};
  context.wakeReconfiguration=value('wakeReconfiguration',context);
  return {state,context,reconnect:value('reconnectRemovedDevice',context),close:value('closeDeviceSetup',context)};
}

test('removed device picker is local read-only and excludes active bindings without restoring or waking any device',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());
  const writes=f.events.length;const sessions=await f.store.loadDeviceRecoverySessions();assert.equal(sessions.length,1);assert.equal(sessions[0].accountToken,s().accountToken);
  assert.equal(f.events.length,writes);assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
  // An orphaned recovery entry from an interrupted save must not become a second restoration choice.
  f.values.set('photowall-device-sessions-v2',JSON.stringify({sessions:[{...s(),device:{...s().device,binding_id:'new'}}],activeDeviceId:'screen'}));
  assert.deepEqual(await f.store.loadDeviceRecoverySessions(),[]);
});

test('explicit removed-device click opens setup before cloud completion and shares the durable operation with physical proof',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());const gate=deferred(),posts=[];
  const send=operationRunner(f,{post:async args=>{posts.push(args);if(args.phase==='enter_setup')await gate.promise;return{device:s().device,operation:{stage:args.phase==='authorize'?'authorized':'entered'}}}});
  const flow=removedFlow(f,{sendReprovisionOperation:send});assert.equal(posts.length,0);
  await flow.reconnect(s());assert.equal(flow.state.surfaces.at(-1),'setup');await flush();assert.equal(posts.length,1);assert.equal(flow.state.wakes[0].state,'waking');
  assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);assert.equal((await f.store.loadPendingDeviceSetup()).kind,'local-recovery');
  const device={deviceId:'screen',setupToken:'fresh-proof',recoverySession:(await f.store.loadDeviceRecovery('screen')).session};
  // Real coordinator authorize call uses the same secure operation even while enter is still pending.
  const authorized=await send({session:device.recoverySession,phase:'authorize',setupToken:device.setupToken});
  assert.equal(posts[0].operation.operationId,posts[1].operation.operationId);assert.equal(authorized.operation.stage,'authorized');
  gate.resolve();await flush();assert.equal(flow.state.wakes.at(-1).state,'requested');
});

test('closing explicit recovery preserves credentials and operation, clears only pending UI, and returns to the target picker',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());const flow=removedFlow(f,{sendReprovisionOperation:operationRunner(f)});
  await flow.reconnect(s());await flush();const before=await f.store.loadDeviceReprovision(s());assert.ok(before);
  await flow.close();assert.equal(flow.state.surfaces.at(-1),'add');assert.equal(flow.context.recoverySetupRef.current,null);
  assert.equal(await f.store.loadPendingDeviceSetup(),null);assert.ok(await f.store.loadDeviceRecovery('screen'));assert.deepEqual(await f.store.loadDeviceReprovision(s()),before);
  await flow.reconnect(s());await flush();assert.deepEqual(await f.store.loadDeviceReprovision(s()),before);assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('pending removed-device recovery after App restart opens only the explicit picker and never activates or wakes its target',async()=>{
  const f=storage(),state={},noop=()=>{};await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());await f.store.savePendingDeviceSetup({kind:'local-recovery',session:s()});
  const cleanup=effect('Promise.all([loadDeviceSessions(), loadPendingDeviceSetup()])',{IS_WEB_PREVIEW:false,deviceManagementEpochRef:{current:0},deviceManagementRef:{current:null},
    loadDeviceSessions:f.store.loadDeviceSessions,loadPendingDeviceSetup:f.store.loadPendingDeviceSetup,normalizeDeviceSession:x=>x,sameManagedDevice:network.sameManagedDevice,
    setDeviceSessions:x=>state.sessions=x,setSession:assert.fail,setReconfigurationSession:assert.fail,setReprovisionWake:assert.fail,openDeviceSurface:x=>state.surface=x,
    setActiveTab:noop,setError:assert.fail,loadPhotoSyncPreference:async()=>null,setPhotoSync:noop,refreshPermission:async()=>{}});
  await flush();assert.equal(state.surface,'add');assert.deepEqual(state.sessions,[]);assert.equal(await f.store.loadDeviceReprovision(s()),null);cleanup();
});

test('cancelled local target selection and failed pending persistence cannot dispatch cloud wake or reinsert a session',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());const gate=deferred();let sent=0;
  let flow=removedFlow(f,{loadDeviceRecoverySessions:()=>gate.promise,sendReprovisionOperation:async()=>sent++});
  const selecting=flow.reconnect(s());flow.context.deviceManagementEpochRef.current++;gate.resolve([s()]);await selecting;
  assert.equal(sent,0);assert.deepEqual(flow.state.surfaces,[]);assert.equal(await f.store.loadPendingDeviceSetup(),null);
  flow=removedFlow(f,{savePendingDeviceSetup:async()=>{throw Error('keychain unavailable')},sendReprovisionOperation:async()=>sent++});
  await assert.rejects(flow.reconnect(s()),/keychain/);assert.equal(sent,0);assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('removed-target wake failure remains explicit without restoring a device, and stale target binding cannot be selected',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());const flow=removedFlow(f,{sendReprovisionOperation:async()=>{throw Object.assign(Error('offline'),{code:'SERVICE_TIMEOUT'})}});
  await flow.reconnect(s());await flush();assert.equal(flow.state.surfaces.at(-1),'setup');assert.equal(flow.state.wakes.at(-1).state,'failed');assert.ok(await f.store.loadDeviceRecovery('screen'));
  await assert.rejects(flow.reconnect({...s(),device:{...s().device,binding_id:'other'}}),/恢复信息已变化/);
  assert.equal((await f.store.loadDeviceSessions()).sessions.length,0);
});

test('explicit recovery target cannot authorize another owner or binding, while 401 with physical proof still uses normal claim',async()=>{
  let f=adapter(),device=await f.api.connectProvisioningDevice('screen');
  for(const wrong of [{...s(),accountToken:'other'},{...s(),device:{...s().device,binding_id:'other'}}])await assert.rejects(f.api.provisionWifi({device,recoverySession:wrong}),/恢复信息已变化/);
  assert.equal(f.events.length,0);
  f=adapter({reprovisionDisplay:async()=>{throw Object.assign(Error('deleted'),{status:401})}});device=await f.api.connectProvisioningDevice('screen');
  const result=await f.api.provisionWifi({device,recoverySession:s()});assert.equal(result.accountToken,'new-owner');assert.equal(result.publishedWall,undefined);assert.ok(f.events.includes('claim'));
});

test('recovery save queue rejects a newer active binding and a newer retained authority; matching explicit restore clears only that target',async()=>{
  const f=storage();await f.store.saveDeviceSession(s());await f.store.forgetDeviceSession(s());const captured=await f.store.loadDeviceRecovery('screen');
  await f.store.saveDeviceSession({...s(),device:{...s().device,binding_id:'new'}});
  await assert.rejects(f.store.saveDeviceSession(s(),{recoveryTarget:captured.session}),{code:'DEVICE_BINDING_CHANGED'});
  assert.equal((await f.store.loadDeviceSession()).device.binding_id,'new');
  const fresh=await f.store.loadDeviceSession();await f.store.forgetDeviceSession(fresh);
  await assert.rejects(f.store.saveDeviceSession(s(),{recoveryTarget:captured.session}),{code:'DEVICE_BINDING_CHANGED'});
  await f.store.saveDeviceSession(fresh,{recoveryTarget:fresh});assert.equal(await f.store.loadDeviceRecovery('screen'),null);
});

test('adding a different ESP32 clears the selected recovery target without waking it or deleting its credentials',()=>{
  const state={},ref={current:{session:s()}},context={recoverySetupRef:ref,setRecoverySetupSession:x=>state.target=x,setReconfigurationSession:x=>state.existing=x,setReprovisionWake:x=>state.wake=x,
    setAddDisplayVisible:()=>{},setAddingDevice:x=>state.adding=x,setInitialSetupDevice:()=>{},openDeviceSurface:x=>state.surface=x};
  value('addEsp32Device',context)();assert.equal(ref.current,null);assert.equal(state.target,null);assert.equal(state.existing,null);assert.equal(state.surface,'setup');assert.equal(state.adding,true);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const recovery=require('../photo-wall-app/src/preferenceRecovery.cjs');
const {sameDeviceBinding}=require('../photo-wall-app/src/deviceStatus.cjs');
const {createReadinessProbe,SELECTION_CONTRACT}=require('../photo-wall-app/src/selectionReadiness.cjs');
const {runFirstWall}=require('../photo-wall-app/src/firstWall.cjs');
const {isCurrentWallRequest}=require('../photo-wall-app/src/wallExperienceState.cjs');
const app=path.resolve(__dirname,'../photo-wall-app');
const dependencies=process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve=name=>require.resolve(name,{paths:[dependencies]});
const babel=require(resolve('@babel/core'));
const appSource=fs.readFileSync(path.join(app,'App.js'),'utf8');
const ast=babel.parseSync(appSource,{configFile:false,babelrc:false,parserOpts:{plugins:['jsx']}});
const initial={schedule:{time:'20:00',frequency:'每天'},rules:{'person-person_old':'more','person-person_hidden':'hide'},photoRange:{mode:'all',since:''},temporalPreference:'balanced'};
const initialProfile=()=>({onboardingCompleted:true,activeRevisionId:'original',revisions:[{id:'original',snapshot:structuredClone(initial)}]});
const scope=()=>({deviceId:'synthetic-screen',bindingKey:'synthetic-binding',bindingEpoch:3,sequence:2});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};

function appValue(name, context) {
  let target;
  function visit(node) {
    if(!node || typeof node!=='object')return;
    if(node.type==='VariableDeclarator' && node.id.name===name) target=node.init;
    for(const value of Object.values(node)) if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  }
  visit(ast);assert.ok(target,name+' exists in real App');
  return vm.compileFunction('return ('+appSource.slice(target.start,target.end)+')',Object.keys(context))(...Object.values(context));
}
function loadModule(relative,mocks,globals={}) {
  const filename=path.join(app,relative),module={exports:{}};
  const code=babel.transformFileSync(filename,{configFile:false,babelrc:false,plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;
  vm.compileFunction(code,['module','exports','require',...Object.keys(globals)],{filename})(module,module.exports,name=>mocks[name]||{},...Object.values(globals));
  return module.exports;
}
function nativeApis(fetch) {
  const saved=new Map();
  const store=loadModule('src/preferenceStore.js',{
    'react-native':{Platform:{OS:'ios'}},
    'expo-secure-store':{WHEN_UNLOCKED_THIS_DEVICE_ONLY:'test',getItemAsync:async key=>saved.get(key),setItemAsync:async(key,value)=>saved.set(key,value)},
  });
  const api=loadModule('src/deviceApi.js',{
    'react-native':{Platform:{OS:'ios'}},
    './unifiedSelection':{UNIFIED_SELECTION:true,SELECTION_CONTRACT},
    './selectionReadiness.cjs':require('../photo-wall-app/src/selectionReadiness.cjs'),
    './networkRecovery.cjs':require('../photo-wall-app/src/networkRecovery.cjs'),
  },{fetch,process:{env:{}},__DEV__:false});
  return{store,api};
}
function managedContext(overrides={}) {
  const profile=initialProfile(), draft={...scope(),rules:{'person-person_old':'normal','person-person_hidden':'normal'},photoRange:initial.photoRange,temporalPreference:'balanced'};
  const changes={};
  const context={...recovery,sameDeviceBinding,editingPreferences:true,canEditModelPreferences:true,
    preferenceSaveInFlightRef:{current:false},wallRequestScopeRef:{current:scope()},recoveringPreferences:true,
    managedPreferenceDraft:draft,preferenceProfile:profile,activePreferenceRevision:profile.revisions[0],preferenceSnapshot:initial,
    recognizedContent:{people:[],topics:[],albums:[]},
    savePreferenceAsRevision:async()=>{throw Error('provide persistence')},hydrateContentPreferenceSnapshot:value=>changes.applied=value,
    setManagedPreferenceDraft:value=>changes.draft=value,setPreferenceDetails:value=>changes.details=value,
    setError:value=>changes.error=value,setPreferenceResume:value=>changes.resume=value,
    setActiveTab:value=>changes.tab=value,setNotice:value=>changes.notice=value,...overrides};
  return{context,changes,draft};
}

test('terminal readiness retains the person code and false retryable through the actual failure adapter',async()=>{
  const probe=createReadinessProbe({check:async()=>({contract:SELECTION_CONTRACT,ready:false,retryable:false,code:'people_selection_changed',reason:'synthetic person rejection'})});
  await assert.rejects(probe.refresh(),error=>{
    const failure=recovery.firstWallFailure(error,'binding');
    assert.equal(failure.code,'people_selection_changed');assert.equal(failure.retryable,false);
    assert.equal(recovery.isPeoplePreferenceError(failure),true);return true;
  });
  assert.equal(recovery.isPeoplePreferenceError(recovery.firstWallFailure(Object.assign(Error('network'),{data:{code:'network',retryable:true}}),'binding')),false);
});

test('old more/hide remain visible and effective until explicit cancellation; unknown identities are not remapped',()=>{
  const current={people:[{id:'person-person_new',filters:['person_new']}],topics:[],albums:[]};
  assert.deepEqual(recovery.unresolvedPersonRules(initial.rules,current),Object.entries(initial.rules));
  assert.deepEqual(recovery.preferenceFilters(current,initial.rules),{prefer:['person_old'],exclude:['person_hidden']});
  const draft={...initial.rules,'person-person_old':'normal'};
  assert.deepEqual(recovery.preferenceFilters(current,draft),{prefer:[],exclude:['person_hidden']});
  assert.equal(initial.rules['person-person_old'],'more');
});

test('real App recovery route bypasses first-wall overlay only for the current failed binding',()=>{
  const current=scope();
  const firstWall={binding:current.bindingKey,state:'failed'};
  const recovering=appValue('recoveringPreferences',{activeTab:'preferences',firstWall,preferenceRecovery:current,wallRequestScopeRef:{current},sameDeviceBinding});
  assert.equal(recovering,true);
  assert.equal(appValue('firstWallVisible',{firstWall,wallBindingKey:current.bindingKey,dismissedFirstWall:null,wallRequestScopeRef:{current},sameDeviceBinding,recoveringPreferences:recovering}),false);
  assert.equal(appValue('firstWallVisible',{firstWall,wallBindingKey:current.bindingKey,dismissedFirstWall:null,wallRequestScopeRef:{current},sameDeviceBinding,recoveringPreferences:false}),true);
  assert.equal(appValue('recoveringPreferences',{activeTab:'preferences',firstWall,preferenceRecovery:{...current,bindingEpoch:2},wallRequestScopeRef:{current},sameDeviceBinding}),false);
});

test('real App return preserves failure, binding and draft without saving or restarting',()=>{
  const attempt={current:''},tabs=[];
  appValue('returnFromRecoveryPreferences',{firstWallAttemptRef:attempt,wallBindingKey:'binding',setActiveTab:value=>tabs.push(value)})();
  assert.equal(attempt.current,'binding');assert.deepEqual(tabs,['calendar']);
});

test('real App readonly refresh distinguishes failed reads from successful empty canonical people',async()=>{
  let response=Error('offline'),states=[],snapshot;
  const current=scope(),context={wallRequestScopeRef:{current},preferenceRecoveryReadRef:{current:0},sameDeviceBinding,
    readRecoveryContent:read=>read(new AbortController().signal),readRecognizedContent:async()=>{if(response instanceof Error)throw response;return response},
    DEFAULT_API_BASE:'https://fixture.invalid',session:{accountToken:'synthetic'},selectionSources:()=>['all'],photoSync:null,
    setPreferenceRecovery:value=>states.push(value),setRecognitionSnapshot:value=>snapshot=value};
  const refresh=appValue('readRecoveryPreferences',context);
  await refresh();assert.deepEqual(states.map(x=>x.status),['loading','failed']);assert.equal(snapshot,undefined);
  states=[];response={peopleAvailable:true,people:[],albums:[]};await refresh();
  assert.deepEqual(states.map(x=>x.status),['loading','ready']);assert.equal(snapshot,response);
  states=[];response={peopleAvailable:false,people:[],albums:[]};await refresh();
  assert.deepEqual(states.map(x=>x.status),['loading','failed']);
});

test('real App ignores a late recognition response after switching binding',async()=>{
  const gate=deferred(),current={current:scope()},states=[];
  const refresh=appValue('readRecoveryPreferences',{wallRequestScopeRef:current,preferenceRecoveryReadRef:{current:0},sameDeviceBinding,
    readRecoveryContent:()=>gate.promise,readRecognizedContent:()=>assert.fail(),DEFAULT_API_BASE:'fixture',session:{},selectionSources:()=>[],photoSync:null,
    setPreferenceRecovery:x=>states.push(x),setRecognitionSnapshot:()=>assert.fail('late result applied')});
  const work=refresh();current.current={...scope(),bindingEpoch:4};gate.resolve({peopleAvailable:true,people:[]});await work;
  assert.deepEqual(states.map(x=>x.status),['loading']);
});

test('real unified content API rejects malformed success instead of converting it into empty people',async()=>{
  let body,seenSignal;
  const{api}=nativeApis(async(url,options)=>{
    assert.ok(url.endsWith('/api/selection/content'));seenSignal=options.signal;
    return {ok:true,status:200,text:async()=>JSON.stringify(body)};
  });
  const signal=new AbortController().signal;
  const read=()=>api.readRecognizedContent({apiBase:'https://fixture.invalid',accountToken:'synthetic',signal});
  for(body of [{},null,{peopleAvailable:true,people:null},{peopleAvailable:true},{people:[]},{people:[],peopleAvailable:'true'}]) {
    await assert.rejects(read(),/完整的人物结果/);
  }
  for(const available of [false,true]) {
    body={peopleAvailable:available,people:[],albums:[]};
    const result=await read();assert.equal(result.peopleAvailable,available);assert.deepEqual(result.people,[]);
  }
  assert.notEqual(seenSignal,signal);assert.equal(seenSignal.aborted,false);
});

test('404 cloud preferences persist a real local revision and real App resumes generation with newly saved filters',async()=>{
  const requests=[];
  const{store,api}=nativeApis(async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    return url.endsWith('/api/preferences/revisions') ? {ok:false,status:404,text:async()=>JSON.stringify({detail:'not found'})}
      : {ok:true,status:200,text:async()=>JSON.stringify({wall_id:'synthetic-wall',image_url:'/output/synthetic.png'})};
  });
  const f=managedContext();
  f.context.savePreferenceAsRevision=async(source,snapshot)=>{
    const saved=await recovery.savePreferenceWithFallback({current:()=>true,
      remote:()=>api.createDevicePreferenceRevision({apiBase:'https://fixture.invalid',deviceId:scope().deviceId,accountToken:'synthetic',source,snapshot}),
      cache:store.cachePreferenceProfile,local:()=>store.savePreferenceRevision({profile:f.context.preferenceProfile,snapshot,source})});
    assert.equal(saved.localOnly,true);return saved.profile;
  };
  await appValue('saveManagedPreferences',f.context)();
  assert.equal(f.changes.tab,'calendar');assert.equal(f.changes.draft,null);
  assert.deepEqual(f.changes.applied.rules,{'person-person_old':'normal','person-person_hidden':'normal'});
  const persisted=await store.loadPreferenceProfile();assert.equal(persisted.revisions.length,2);
  assert.deepEqual(persisted.revisions[0].snapshot.rules,initial.rules);
  let saved={},device={revision:''},published=0,resuming;
  assert.equal(recovery.resumePreferenceRecovery(f.changes.resume,scope(),(uncertain,applied)=>{
    assert.equal(uncertain,false);assert.equal(applied.revisionId,persisted.activeRevisionId);
    const filters=recovery.preferenceFilters(applied.content,applied.snapshot.rules);
    resuming=runFirstWall({load:async()=>saved,save:async x=>saved=x,readDevice:async()=>device,prepare:async()=>{},
      generate:()=>api.generateWall({apiBase:'https://fixture.invalid',accountToken:'synthetic',deviceId:scope().deviceId,filters:filters.prefer,excludeFilters:filters.exclude,preferenceRevisionId:applied.revisionId}),
      publish:async()=>{published++;device={revision:'revision',displayed_revision:'revision'};return{device,revision:'revision'}},stage:()=>{},sleep:async()=>{}});
  }),true);
  await resuming;
  assert.equal(published,1);assert.equal(saved.state,'done');
  assert.deepEqual(requests.at(-1).body.filters,[]);assert.deepEqual(requests.at(-1).body.exclude_filters,[]);
  assert.equal(requests.at(-1).body.preference_revision_id,persisted.activeRevisionId);
});

test('explicit same-value save still resumes and does not duplicate a published revision',async()=>{
  const f=managedContext();f.context.managedPreferenceDraft={...scope(),...structuredClone(initial)};
  f.context.recognizedContent={people:[{id:'person-person_old',filters:['person_old']},{id:'person-person_hidden',filters:['person_hidden']}],topics:[],albums:[]};
  f.context.savePreferenceAsRevision=()=>assert.fail('unchanged snapshot must not create a revision');
  await appValue('saveManagedPreferences',f.context)();
  assert.equal(f.changes.resume.revisionId,'original');
  let saved={state:'waiting',revision:'already-sent',wallId:'existing'},pending;
  recovery.resumePreferenceRecovery(f.changes.resume,scope(),(uncertain)=>{
    assert.equal(uncertain,false);
    pending=runFirstWall({load:async()=>saved,save:async x=>saved=x,
      readDevice:async()=>({revision:'already-sent',displayed_revision:'already-sent'}),
      prepare:()=>assert.fail(),generate:()=>assert.fail(),publish:()=>assert.fail('duplicate publish'),stage:()=>{}});
  });
  await pending;assert.equal(saved.state,'done');assert.equal(saved.wallId,'existing');
});

test('real App startFirstWall uses the explicitly saved snapshot and fresh content rather than stale render rules',async()=>{
  const binding=scope(),session={accountToken:'synthetic',device:{device_id:binding.deviceId,revision:''}},requests=[],states=[];
  const latest={current:session};
  const start=appValue('startFirstWall',{
    wallOperationRef:{current:null},deviceManagementRef:{current:null},session,canPublish:true,AppState:{currentState:'active'},
    wallRequestScopeRef:{current:binding},firstWallAbortRef:{current:null},photoWorkEpochRef:{current:0},photoWorkMountedRef:{current:true},
    isCurrentWallRequest,preferenceFilters:recovery.preferenceFilters,recognizedContent:{people:[],topics:[]},preferenceRules:initial.rules,
    UNIFIED_SELECTION:true,preferenceProfile:initialProfile(),selectionSources:()=>['all'],photoSync:null,wallBindingKey:binding.bindingKey,
    setFirstWall:value=>states.push(value),setDismissedFirstWall:()=>{},latestWallSessionRef:latest,
    updateDeviceSession:async value=>({sessions:[value]}),setSession:()=>{},setDeviceSessions:()=>{},normalizeDeviceSession:x=>x,
    runFirstWall,readDisplayStatus:async()=>session.device,DEFAULT_API_BASE:'https://fixture.invalid',
    createFirstWallReadiness:()=>({read:async()=>({ready:true,action:'generate'}),close:()=>{}}),syncSelectionInBackground:()=>assert.fail(),prewarmOwner:'synthetic',
    generateWall:async options=>{requests.push(options);return{wall_id:'wall',image_url:'/output/wall.png'}},
    publishGeneratedWall:async()=>({device:{device_id:binding.deviceId,revision:'revision',displayed_revision:'revision'}}),
    publicationFromResponse:()=>({revision:'revision',wallId:'wall'}),setHistoryRefresh:()=>{},firstWallFailure:recovery.firstWallFailure,
    setPhotoWorkRevision:()=>{},
  });
  await start(false,{snapshot:{rules:{'person-person_old':'normal','person-person_hidden':'normal','person-person_new':'more'}},
    revisionId:'saved-revision',content:{people:[{id:'person-person_new',filters:['person_new']}],topics:[]}});
  assert.equal(requests.length,1);assert.deepEqual(requests[0].filters,['person_new']);assert.deepEqual(requests[0].excludeFilters,[]);
  assert.equal(requests[0].preferenceRevisionId,'saved-revision');assert.equal(states.at(-1).state,'done');
});

test('unmodified or partially cancelled unresolved selections stay in the real App draft without creating a revision or restarting',async()=>{
  for(const rules of [initial.rules,{...initial.rules,'person-person_old':'normal'}]) {
    const f=managedContext();f.context.managedPreferenceDraft={...scope(),...structuredClone(initial),rules:{...rules}};
    f.context.savePreferenceAsRevision=()=>assert.fail('unresolved choice cannot be saved from recovery');
    await appValue('saveManagedPreferences',f.context)();
    assert.match(f.changes.error,/还有待确认的旧人物选择/);
    assert.equal(f.changes.draft,undefined);assert.equal(f.changes.resume,undefined);assert.equal(f.changes.applied,undefined);
    assert.deepEqual(f.context.managedPreferenceDraft.rules,rules);
  }
});

test('failed persistence preserves the App draft and does not schedule recovery',async()=>{
  const f=managedContext({savePreferenceAsRevision:async()=>null});
  await appValue('saveManagedPreferences',f.context)();
  assert.equal(f.changes.draft,undefined);assert.equal(f.changes.resume,undefined);assert.equal(f.changes.applied,undefined);
  assert.deepEqual(f.context.managedPreferenceDraft,f.draft);
  await assert.rejects(recovery.savePreferenceWithFallback({current:()=>true,remote:async()=>initialProfile(),cache:async()=>{throw Error('storage failed')},local:()=>assert.fail()}),/storage failed/);
});

test('late saves and pending recovery cannot cross a binding epoch even for the same screen',async()=>{
  const gate=deferred(),f=managedContext({savePreferenceAsRevision:()=>gate.promise});
  const work=appValue('saveManagedPreferences',f.context)();f.context.wallRequestScopeRef.current={...scope(),bindingEpoch:4};
  gate.resolve(initialProfile());await work;
  assert.equal(f.changes.applied,undefined);assert.equal(f.changes.resume,undefined);
  assert.equal(recovery.resumePreferenceRecovery({...scope(),snapshot:initial,revisionId:'original'},f.context.wallRequestScopeRef.current,()=>assert.fail()),false);
});

test('authorization and conflict failures never silently fall back to local rules',async()=>{
  for(const status of [401,403,409]) await assert.rejects(recovery.savePreferenceWithFallback({current:()=>true,
    remote:async()=>{throw Object.assign(Error('blocked'),{status})},cache:()=>assert.fail(),local:()=>assert.fail()}),{status});
});

test('bounded recognition read aborts a hung request and the next attempt can succeed',async()=>{
  let signal;
  await assert.rejects(recovery.readRecoveryContent(value=>{signal=value;return new Promise(()=>{})},5),/超时/);
  assert.equal(signal.aborted,true);
  assert.deepEqual(await recovery.readRecoveryContent(async()=>({peopleAvailable:true,people:[]}),5),{peopleAvailable:true,people:[]});
});

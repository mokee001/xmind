const test=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');const vm=require('node:vm');
const app=path.resolve(__dirname,'../photo-wall-app');
const dependencies=process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve=name=>require.resolve(name,{paths:[dependencies]});
const babel=require(resolve('@babel/core'));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};

function fixture(overrides={}) {
  const assets=[{id:'a',filename:'a.heic',modificationTime:1},{id:'b',filename:'b.heic',modificationTime:2}];
  const calls={curate:[],observe:[],network:[],pages:[],files:[],uploaded:[]};
  const library={permission:{status:'granted',accessPrivileges:'all'}};
  const state={currentState:'active'};
  const files=new Map();
  class File {
    constructor(...parts){this.key=parts.join('/');calls.files.push(this.key)}
    get exists(){return files.has(this.key)}
    async text(){return files.get(this.key)}
    write(value){files.set(this.key,value)}
  }
  class FormData {constructor(){this.values={}}append(key,value){this.values[key]=value}}
  const media={MediaType:{photo:'photo'},SortBy:{creationTime:'creationTime'},
    getPermissionsAsync:async()=>({...library.permission}),
    getAssetsAsync:async options=>{calls.pages.push(options);return {assets,endCursor:'end',hasNextPage:false}},
    getAssetInfoAsync:async asset=>({...asset,localUri:`file:///synthetic/${asset.id}.heic`}),
    ...overrides.media};
  const native={curateLocalPhotos:async(ids,options)=>{calls.curate.push({ids,options});return {candidates:[{id:'b'},{id:'a'}],reviewedIds:ids}},
    observeLocalPhotoFile:async uri=>{calls.observe.push(uri);return {fixture:uri}},...overrides.native};
  const fetch=async(url,options)=>{
    calls.network.push({url,options});
    if(overrides.fetch){const response=await overrides.fetch(url,options);if(response)return response;}
    if(url.endsWith('/session'))return {ok:true,json:async()=>({contract:'unified-recollections-v1',scope:'test'})};
    if(url.endsWith('/upload')){calls.uploaded.push(options.body.values);return {ok:true,json:async()=>({contract:'unified-recollections-v1',saved:1})};}
    throw Error('unexpected endpoint');
  };
  const mocks={'react-native':{Platform:{OS:'ios'},AppState:state},'expo-media-library/legacy':media,
    'expo-file-system':{File,Paths:{document:'memory'}},'expo/fetch':{fetch},
    './fetchUpload':{appendLocalFetchFile:(form,name,value)=>form.append(name,value)},
    '../modules/local-photo-curation':native};
  const filename=path.join(app,'src/unifiedSelection.js');
  const code=babel.transformFileSync(filename,{configFile:false,babelrc:false,
    plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;
  const module={exports:{}};
  vm.compileFunction(code,['module','exports','require','process','FormData'],{filename})(module,module.exports,
    name=>name in mocks?mocks[name]:require(path.resolve(app,'src',name)),
    {env:{EXPO_PUBLIC_UNIFIED_SELECTION:'1'}},FormData);
  const options={apiBase:'https://fixture.invalid',accountToken:'account',album:null,firstWall:true,prewarmOwner:'local',active:()=>true};
  return {...module.exports,calls,library,state,files,assets,options};
}

test('authorization prewarm has no upload/persistence, then same first page reuses original native results',async()=>{
  const f=fixture();await f.prewarmPhotoSelection({owner:'local',album:null});
  assert.equal(f.calls.network.length,0);assert.equal(f.calls.files.length,0);
  assert.equal(f.calls.curate.length,1);assert.equal(f.calls.observe.length,2);
  assert.deepEqual(f.calls.curate[0],{ids:['a','b'],options:{maximumCandidates:300}});
  await f.syncSelectionInBackground(f.options);
  assert.equal(f.calls.curate.length,1);assert.equal(f.calls.observe.length,2);
  assert.deepEqual(f.calls.pages.map(p=>p.first),[60,60]);
  assert.deepEqual(f.calls.uploaded.map(x=>x.files.uri),['file:///synthetic/b.heic','file:///synthetic/a.heic']);
  assert.equal(JSON.parse(f.calls.uploaded[0].metadata)[0].vision.fixture,'file:///synthetic/b.heic');
});

test('no authorization means no native processing or requests',async()=>{
  const f=fixture();f.library.permission={status:'denied',accessPrivileges:'none'};
  await f.prewarmPhotoSelection({owner:'local'});assert.equal(f.calls.curate.length,0);assert.equal(f.calls.network.length,0);
  await assert.rejects(f.syncSelectionInBackground(f.options),/允许访问照片/);
});

test('permission scope change and asset edit force fresh native observation',async()=>{
  const f=fixture();await f.prewarmPhotoSelection({owner:'local'});
  f.library.permission.accessPrivileges='limited';f.assets[0].modificationTime=3;
  await f.syncSelectionInBackground(f.options);
  assert.equal(f.calls.curate.length,2);assert.equal(f.calls.observe.length,4);
});

test('prewarm native failure falls through to genuine foreground processing',async()=>{
  let first=true;const f=fixture({native:{curateLocalPhotos:async ids=>{if(first){first=false;throw Error('native unavailable')}return {candidates:ids.map(id=>({id})),reviewedIds:ids}}}});
  await assert.rejects(f.prewarmPhotoSelection({owner:'local'}),/native unavailable/);
  await f.syncSelectionInBackground(f.options);assert.equal(f.calls.uploaded.length,2);
});

test('changed library during prewarm drops old result and schedules no observation/upload',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({native:{curateLocalPhotos:async ids=>{started.resolve();await gate.promise;return {candidates:ids.map(id=>({id})),reviewedIds:ids}}}});
  const warming=f.prewarmPhotoSelection({owner:'local'});await started.promise;
  const rejected=assert.rejects(warming,{code:'PREWARM_INVALIDATED'});f.invalidatePhotoPrewarm();gate.resolve();await rejected;
  assert.equal(f.calls.observe.length,0);assert.equal(f.calls.network.length,0);
});

test('ready arriving during native observation leaves current asset pending for receipt-gated later sync',async()=>{
  let ready=false;
  const f=fixture({native:{observeLocalPhotoFile:async()=>{ready=true;return {original:true}}}});
  await f.syncSelectionInBackground({...f.options,shouldStop:()=>ready});assert.equal(f.calls.uploaded.length,0);
  const saved=JSON.parse(f.files.get('memory/selection-test-0.json'));assert.equal(saved.pending.index,0);
  await f.syncSelectionInBackground({...f.options,firstWall:false});assert.equal(f.calls.uploaded.length,2);
});

test('readiness preserves HTTP authorization and supports non-JSON legacy 404',async()=>{
  let status=404;
  const f=fixture({fetch:async url=>url.endsWith('/readiness')?{ok:false,status,json:async()=>{throw Error('HTML')}}:null});
  const old=f.createFirstWallReadiness({...f.options,options:{deviceId:'screen'},active:()=>true});
  assert.equal(await old.refresh(),false);await old.refresh();assert.equal(f.calls.network.length,1);
  status=403;const forbidden=f.createFirstWallReadiness({...f.options,options:{deviceId:'screen'},active:()=>true});
  await assert.rejects(forbidden.refresh(),{status:403});
});

test('abort propagates to a current upload and never marks it confirmed',async()=>{
  const started=deferred();const controller=new AbortController();
  const f=fixture({fetch:async(url,options)=>{
    if(!url.endsWith('/upload'))return null;started.resolve();
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
  }});
  const syncing=f.syncSelectionInBackground({...f.options,signal:controller.signal});await started.promise;
  const rejected=assert.rejects(syncing,{name:'AbortError'});controller.abort();await rejected;
  assert.equal(JSON.parse(f.files.get('memory/selection-test-0.json')).pending.index,0);
});

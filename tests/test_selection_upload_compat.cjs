const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const app = path.resolve(__dirname, '../photo-wall-app');
const dependencies = process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve = name => require.resolve(name, {paths:[dependencies]});
const babel = require(resolve('@babel/core'));
function load(filename, mocks = {}, globals = {}) {
  const module = {exports:{}};
  const code = babel.transformFileSync(filename, {configFile:false, babelrc:false, plugins:[
    resolve(filename.endsWith('.ts') ? '@babel/plugin-transform-typescript' : '@babel/plugin-transform-flow-strip-types'),
    resolve('@babel/plugin-transform-modules-commonjs'),
  ]}).code;
  vm.compileFunction(code, ['module','exports','require',...Object.keys(globals)], {filename})(
    module, module.exports, name => name in mocks ? mocks[name] : require(name), ...Object.values(globals));
  return module.exports;
}
const expo = path.dirname(resolve('expo/package.json'));
const rn = path.dirname(resolve('react-native/package.json'));
const RNFormData = load(path.join(rn,'Libraries/Network/FormData.js')).default;
const {installFormDataPatch} = load(path.join(expo,'src/winter/FormData.ts'));
const FormData = installFormDataPatch(RNFormData);
const {convertFormDataAsync} = load(path.join(expo,'src/winter/fetch/convertFormData.ts'), {
  '../../utils/blobUtils':{blobToArrayBufferAsync:blob=>blob.arrayBuffer()},
});
const contract = 'unified-recollections-v1';
const vision = {version:1,labels:[{identifier:'nature',confidence:0.9}],faces:0};

function fixture(replies, assets = [
  {id:'unsupported',filename:'first.gif',modificationTime:1},
  {id:'supported',filename:'second.HEIC',modificationTime:2},
]) {
  const files = new Map(), originals = new Map(), sent = [];
  const copy = assets.map(asset=>({...asset}));
  for (const asset of copy) originals.set(`file:///photos/${asset.id}`, Buffer.from(`synthetic-original-${asset.id}`));
  class LocalFile {
    constructor(...parts) { this.uri=parts.join('/'); this.name=this.uri.split('/').pop(); }
    get exists() {return files.has(this.uri);}
    get type() {return '';}
    async text() {return files.get(this.uri);}
    write(value) {files.set(this.uri,value);}
    async bytes() {return originals.get(this.uri);}
  }
  const filesystem = {File:LocalFile,Paths:{document:'file:///checkpoints'}};
  const fetchUpload = load(path.join(app,'src/fetchUpload.js'), {'expo-file-system':filesystem});
  const native = {
    curateLocalPhotos:async ids=>({reviewedIds:ids,candidates:ids.map(id=>({id}))}),
    observeLocalPhotoFile:async()=>structuredClone(vision),
  };
  const response = (value,status=200,headers={})=>new Response(JSON.stringify(value), {status,headers});
  const fetch = async (url,options) => {
    if (url.endsWith('/session')) return response({contract,scope:'synthetic-owner-library'});
    assert.ok(url.endsWith('/upload'));
    assert.equal(options.headers['X-Account-Token'],'synthetic-owner');
    const {body,boundary} = await convertFormDataAsync(options.body);
    const form = await new Response(body,{headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`}}).formData();
    const photo=form.get('files');
    sent.push({name:photo.name,type:photo.type,bytes:Buffer.from(await photo.arrayBuffer()),
      metadata:JSON.parse(form.get('metadata')),sources:JSON.parse(form.get('sources'))});
    const reply=replies.shift();
    if (reply instanceof Error) throw reply;
    return response(reply?.body || {saved:1,contract},reply?.status || 200,reply?.headers);
  };
  const old=process.env.EXPO_PUBLIC_UNIFIED_SELECTION;
  process.env.EXPO_PUBLIC_UNIFIED_SELECTION='1';
  let selection;
  try {
    selection=load(path.join(app,'src/unifiedSelection.js'), {
      'react-native':{Platform:{OS:'ios'},AppState:{currentState:'active'}},
      'expo-media-library/legacy':{
        getPermissionsAsync:async()=>({status:'granted',accessPrivileges:'all'}),
        getAssetsAsync:async()=>({assets:copy,endCursor:'end',hasNextPage:false}),
        getAssetInfoAsync:async asset=>({...asset,localUri:`file:///photos/${asset.id}`}),
        MediaType:{photo:'photo'},SortBy:{creationTime:'creationTime'},
      },
      'expo-file-system':filesystem,'expo/fetch':{fetch},'./fetchUpload':fetchUpload,
      '../modules/local-photo-curation':native,
      './selectionSync.cjs':require('../photo-wall-app/src/selectionSync.cjs'),
      './photoPrewarm.cjs':require('../photo-wall-app/src/photoPrewarm.cjs'),
      './selectionReadiness.cjs':require('../photo-wall-app/src/selectionReadiness.cjs'),
    }, {FormData});
  } finally {
    if (old===undefined) delete process.env.EXPO_PUBLIC_UNIFIED_SELECTION;
    else process.env.EXPO_PUBLIC_UNIFIED_SELECTION=old;
  }
  return {sent,originals,assets:copy,
    run:()=>selection.syncSelectionInBackground({apiBase:'https://synthetic.invalid',accountToken:'synthetic-owner',firstWall:true}),
    state:()=>JSON.parse(files.get('file:///checkpoints/selection-synthetic-owner-library-0.json')),
  };
}

for (const rejected of [
  {detail:'不支持的照片格式'},
  {detail:'照片文件损坏或无法读取'},
  {detail:'Unsupported image',code:'unsupported_photo_format'},
  {detail:'Unreadable image',code:'unreadable_photo'},
]) {
  test(`upload ${rejected.code || rejected.detail} skips only that asset without confirming it`,async()=>{
    const f=fixture([{status:422,body:{detail:rejected.detail},headers:rejected.code ? {'X-Photo-Error-Code':rejected.code} : {}}]);
    await f.run();
    assert.deepEqual(f.sent.map(p=>p.name),['first.gif','second.HEIC']);
    assert.equal(f.state().seen.unsupported,undefined);
    assert.equal(f.state().seen.supported,2);
    assert.equal(f.state().completed,true);
    assert.deepEqual(f.sent[1].metadata,[{local_engine:'apple-vision-local-v1',vision}]);
    assert.deepEqual(f.sent[1].sources,['all']);
    assert.deepEqual(f.sent[1].bytes,f.originals.get('file:///photos/supported'));
    assert.equal(f.sent[1].type,'image/heic');
    // A later pass may retry the unavailable asset; it was never marked uploaded.
    await f.run();
    assert.deepEqual(f.sent.map(p=>p.name),['first.gif','second.HEIC','first.gif']);
  });
}

for (const rejected of [
  {status:422,detail:'Invalid observation region'},
  {status:422,detail:'不支持的照片格式',code:'invalid_vision'},
  {status:422,detail:'不支持的照片格式（其他错误）'},
  ...[401,403,503].map(status=>({status,detail:'不支持的照片格式',code:'unsupported_photo_format'})),
]) {
  test(`non-photo rejection ${rejected.status}/${rejected.code || rejected.detail} retains pending checkpoint`,async()=>{
    const f=fixture([{status:rejected.status,body:{detail:rejected.detail},headers:rejected.code ? {'X-Photo-Error-Code':rejected.code} : {}}]);
    await assert.rejects(f.run(),{status:rejected.status});
    assert.equal(f.state().pending.index,0);
    assert.equal(f.state().seen.unsupported,undefined);
    assert.deepEqual(f.sent.map(p=>p.name),['first.gif']);
    await f.run();
    assert.deepEqual(f.sent.map(p=>p.name),['first.gif','first.gif','second.HEIC']);
  });
}

test('transport cancellation retains the failed asset for the next real upload',async()=>{
  const timeout=Object.assign(new Error('timed out'),{name:'AbortError'});
  const f=fixture([timeout]);
  await assert.rejects(f.run(),error=>error===timeout);
  assert.equal(f.state().pending.index,0);
  assert.equal(f.state().seen.unsupported,undefined);
  assert.equal(f.sent.length,1);
  await f.run();
  assert.deepEqual(f.sent.map(p=>p.name),['first.gif','first.gif','second.HEIC']);
});

test('interruption after a skipped photo resumes the next pending asset',async()=>{
  const f=fixture([{status:422,body:{detail:'不支持的照片格式'}},Object.assign(new Error('offline'),{name:'TypeError'})]);
  await assert.rejects(f.run(),/offline/);
  assert.equal(f.state().pending.index,1);
  assert.equal(f.state().seen.unsupported,undefined);
  await f.run();
  assert.deepEqual(f.sent.map(p=>p.name),['first.gif','second.HEIC','second.HEIC']);
  assert.equal(f.state().seen.supported,2);
});

test('unconfirmed success response remains an error and does not advance the checkpoint',async()=>{
  const f=fixture([{body:{contract,saved:0}}]);
  await assert.rejects(f.run(),/照片上传未确认/);
  assert.equal(f.state().pending.index,0);
  assert.equal(f.state().seen.unsupported,undefined);
});

test('missing asset filename uses local filename without fabricating a JPEG suffix',async()=>{
  const f=fixture([],[{id:'original.PNG',modificationTime:1}]);
  await f.run();
  assert.equal(f.sent[0].name,'original.PNG');
  assert.equal(f.sent[0].type,'image/png');
  assert.deepEqual(f.sent[0].bytes,f.originals.get('file:///photos/original.PNG'));
  assert.deepEqual(f.assets,[{id:'original.PNG',modificationTime:1}]);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const app = path.resolve(__dirname,'../photo-wall-app');
const dependencies = process.env.PHOTO_WALL_TEST_DEPENDENCIES || app;
const resolve = name => require.resolve(name,{paths:[dependencies]});
const babel = require(resolve('@babel/core'));
const status = require('../photo-wall-app/src/deviceStatus.cjs');
const filename = path.join(app,'src/deviceApi.js');
const code = babel.transformFileSync(filename,{configFile:false,babelrc:false,
  plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;

function api(fetch) {
  const mocks = {'react-native':{Platform:{OS:'ios'}},
    './unifiedSelection':{UNIFIED_SELECTION:true,SELECTION_CONTRACT:'unified-recollections-v1'},
    './selectionReadiness.cjs':require('../photo-wall-app/src/selectionReadiness.cjs'),
    './networkRecovery.cjs':require('../photo-wall-app/src/networkRecovery.cjs'),
    './deviceStatus.cjs':{withDeviceStatusTimeout:(read, options) =>
      status.withDeviceStatusTimeout(read,{...options,timeoutMs:10})}};
  const module = {exports:{}};
  vm.compileFunction(code,['module','exports','require','fetch','process','__DEV__'],{filename})(
    module,module.exports,name => mocks[name] || {},fetch,{env:{}},false);
  return module.exports;
}

test('real listDisplays bounds a hung body read and later readDisplayStatus succeeds', async () => {
  let calls = 0, firstSignal;
  const client = api(async (url, options) => {
    assert.equal(url,'https://fixture.invalid/api/devices');
    assert.equal(options.headers['X-Account-Token'],'synthetic-owner');
    if (++calls === 1) {
      firstSignal = options.signal;
      return {ok:true,text:() => new Promise(() => {})};
    }
    return {ok:true,text:async () => JSON.stringify({devices:[{device_id:'screen',last_seen:1000}]})};
  });
  const options = {apiBase:'https://fixture.invalid/',accountToken:'synthetic-owner',deviceId:'screen'};
  await assert.rejects(client.listDisplays(options),{code:'DEVICE_STATUS_TIMEOUT'});
  assert.equal(firstSignal.aborted,true);
  assert.equal((await client.readDisplayStatus(options)).last_seen,1000);
});

test('real status API propagates external cancellation and preserves an HTTP authorization error', async () => {
  let sentSignal;
  const client = api(async (_, options) => {
    sentSignal = options.signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = client.readDisplayStatus({apiBase:'https://fixture.invalid',accountToken:'owner',
    deviceId:'screen',signal:controller.signal});
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(sentSignal.aborted,true);
  const forbidden = api(async () => ({ok:false,status:403,text:async () => JSON.stringify({detail:'not authorized'})}));
  await assert.rejects(forbidden.readDisplayStatus({apiBase:'https://fixture.invalid',accountToken:'owner',deviceId:'screen'}),
    {status:403,message:'not authorized'});
});

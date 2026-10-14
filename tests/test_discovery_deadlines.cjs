const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=path.resolve(__dirname,'../photo-wall-app');
const deps=process.env.PHOTO_WALL_TEST_DEPENDENCIES||app;
const resolve=name=>require.resolve(name,{paths:[deps]});
const babel=require(resolve('@babel/core'));
const status=require('../photo-wall-app/src/deviceStatus.cjs');
const network=require('../photo-wall-app/src/networkRecovery.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function value(file,name,context){const source=fs.readFileSync(path.join(app,file),'utf8');const ast=babel.parseSync(source,{configFile:false,babelrc:false,parserOpts:{plugins:['jsx']}});let result;
  function walk(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id.name===name)result=node.init;for(const item of Object.values(node)){if(Array.isArray(item))item.forEach(walk);else if(item&&typeof item==='object')walk(item)}}walk(ast);assert.ok(result,name);
  return vm.compileFunction('return ('+source.slice(result.start,result.end)+')',Object.keys(context))(...Object.values(context));
}
const target={accountToken:'synthetic-owner',device:{device_id:'synthetic-screen',binding_id:'synthetic-binding'}};
function wake(extra={}){const states=[],budgets=[];const context={reprovisionWakeRef:{current:null},deviceManagementEpochRef:{current:1},latestDeviceSessionsRef:{current:[]},recoverySetupRef:{current:{epoch:1,session:target}},sameManagedDevice:network.sameManagedDevice,
  setReprovisionWake:x=>states.push(x),loadDeviceRecoverySessions:async()=>[target],sendReprovisionOperation:async()=>({operation:{stage:'entered'}}),serviceFailureMessage:network.serviceFailureMessage,
  withDeviceStatusTimeout:(read,options)=>{budgets.push(options.timeoutMs);return status.withDeviceStatusTimeout(read,{...options,timeoutMs:8})},...extra};
  return{states,budgets,context,run:value('App.js','wakeReconfiguration',context)};
}
function scan(extra={}){const state={busy:false,error:'',devices:[],budgets:[]};let now=0,sequence=0;const timers=new Map();
  state.advance=ms=>{now+=ms;for(const [id,timer] of timers)if(timer.at<=now){timers.delete(id);timer.fn()}};
  const context={setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,at:now+ms});return id},clearTimeout:id=>timers.delete(id),discoveryAttemptRef:{current:null},discoveryStopRef:{current:null},flowGenerationRef:{current:1},previewMode:false,
  setBusy:x=>state.busy=x,setError:x=>state.error=x,setStatusText:x=>state.message=x,setDevices:x=>state.devices=typeof x==='function'?x(state.devices):x,
  withDeviceStatusTimeout:(read,options)=>{state.budgets.push(options.timeoutMs);return status.withDeviceStatusTimeout(read,{...options,timeoutMs:8})},...extra};
  return{state,context,run:value('src/DeviceSetupFlow.js','discoverDevices',context)};
}

test('wake deadline covers stalled SecureStore preflight and a late read can never start HTTP',async()=>{
  const gate=deferred();let sends=0;const f=wake({loadDeviceRecoverySessions:()=>gate.promise,sendReprovisionOperation:async()=>{sends++;return{operation:{stage:'entered'}}}});
  await f.run(target);assert.deepEqual(f.budgets,[10000]);assert.equal(f.states.at(-1).state,'failed');assert.equal(f.context.reprovisionWakeRef.current,null);
  gate.resolve([target]);await flush();assert.equal(sends,0);assert.equal(f.states.at(-1).state,'failed');
});

test('wake cancellation during local read cannot issue a cloud operation or replace feedback in another view',async()=>{
  const gate=deferred();let sends=0;const f=wake({loadDeviceRecoverySessions:()=>gate.promise,sendReprovisionOperation:async()=>sends++});
  const pending=f.run(target);f.context.reprovisionWakeRef.current.controller.abort();await pending;gate.resolve([target]);await flush();
  assert.equal(sends,0);assert.equal(f.states.length,1);assert.equal(f.context.reprovisionWakeRef.current,null);
});

test('wake success and bounded cloud failure still produce explicit outcomes for a stable selected target',async()=>{
  let f=wake();await f.run(target);assert.equal(f.states.at(-1).state,'requested');
  f=wake({sendReprovisionOperation:()=>new Promise(()=>{})});await f.run(target);assert.equal(f.states.at(-1).state,'failed');assert.match(f.states.at(-1).message,/尚未确认/);
});

test('scan entry deadline covers both previous stop and native startup, without a permanent busy state',async()=>{
  for(const previous of [true,false]){let starts=0;const gate=deferred();const f=scan({discoveryStopRef:{current:previous?()=>gate.promise:null},adapter:{startDeviceDiscovery:()=>{starts++;return gate.promise}}});
    await f.run();assert.deepEqual(f.state.budgets,[20000]);assert.equal(f.state.busy,false);assert.match(f.state.error,/准备超时/);assert.equal(starts,previous?0:1);
    gate.resolve(()=>{});await flush();assert.equal(starts,previous?0:1);
  }
});

test('late native scan callbacks cannot populate an expired attempt and the next search can finish normally',async()=>{
  const gate=deferred();let callback,lateStops=0;const f=scan({adapter:{startDeviceDiscovery:onDevice=>{callback=onDevice;return gate.promise}}});
  await f.run();callback({deviceId:'stale',signalStrength:-30});assert.deepEqual(f.state.devices,[]);
  gate.resolve(()=>lateStops++);await flush();assert.equal(lateStops,1);
  const fresh=scan({adapter:{startDeviceDiscovery:async onDevice=>{onDevice({deviceId:'fresh',signalStrength:-40});return()=>{}}}});
  await fresh.run();assert.equal(fresh.state.busy,false);assert.equal(fresh.state.error,'');assert.equal(fresh.state.devices[0].deviceId,'fresh');
});

test('replaced scan attempt cannot clear the new attempt busy indicator or overwrite its results',async()=>{
  const gates=[deferred(),deferred()],callbacks=[];let i=0;const f=scan({adapter:{startDeviceDiscovery:cb=>{callbacks.push(cb);return gates[i++].promise}}});
  const old=f.run();await flush();const next=f.run();await flush();await old;assert.equal(f.state.busy,true);
  callbacks[0]({deviceId:'old'});assert.deepEqual(f.state.devices,[]);callbacks[1]({deviceId:'new',signalStrength:-20});gates[1].resolve(()=>{});await next;
  assert.equal(f.state.devices[0].deviceId,'new');assert.equal(f.state.error,'');gates.forEach(g=>g.resolve(()=>{}));await flush();
});

function ble(extra={}){const events={scans:[],stops:0,callbacks:[]};const manager={state:async()=> 'PoweredOn',stopDeviceScan:async()=>events.stops++,connectedDevices:async()=>[],
  startDeviceScan:async(_,options,cb)=>{events.scans.push(options);events.callbacks.push(cb)},...extra};const module={exports:{}};
  const code=babel.transformFileSync(path.join(app,'src/bleProvisioning.js'),{configFile:false,babelrc:false,plugins:[resolve('@babel/plugin-transform-modules-commonjs')]}).code;
  vm.compileFunction(code,['module','exports','require','console'])(module,module.exports,name=>({'react-native':{Platform:{OS:'ios'}},'base64-js':{},'react-native-ble-plx':{BleManager:function(){return manager}}}[name]||{}),{info:()=>{}});
  return{api:module.exports,events,manager};
}

test('native BLE startup checks cancellation after pending state and never starts a late scan',async()=>{
  const gate=deferred(),f=ble({state:()=>gate.promise}),controller=new AbortController();
  const pending=f.api.startDeviceDiscovery(()=>assert.fail(),{signal:controller.signal});controller.abort();gate.resolve('PoweredOn');
  await assert.rejects(pending,{name:'AbortError'});assert.equal(f.events.scans.length,0);
});

test('old BLE stop handles, aborts and advertisements cannot stop or report into a newer scan',async()=>{
  const f=ble(),a=[],b=[],controller=new AbortController();const stopA=await f.api.startDeviceDiscovery(x=>a.push(x),{signal:controller.signal,includeCached:false});
  const stopB=await f.api.startDeviceDiscovery(x=>b.push(x),{includeCached:false});const before=f.events.stops;
  await stopA();controller.abort();await flush();assert.equal(f.events.stops,before);
  f.events.callbacks[0](null,{id:'old',name:'PHOTOWALL-OLD',rssi:-20});f.events.callbacks[1](null,{id:'new',name:'PHOTOWALL-NEW',rssi:-30});
  assert.deepEqual(a,[]);assert.equal(b[0].deviceId,'new');await stopB();assert.equal(f.events.stops,before+1);
});

test('a started scan survives the 20-second UI wait and receives 30- and 60-second delayed advertisements',async()=>{
  for(const delay of [30000,60000]){let callback,stops=0,scanSignal;
    const f=scan({adapter:{startDeviceDiscovery:async(cb,options)=>{callback=cb;scanSignal=options.signal;return()=>stops++}}});
    await f.run();assert.equal(f.state.busy,true);f.state.advance(20000);
    assert.equal(f.state.busy,false);assert.match(f.state.error,/会继续查找/);assert.equal(stops,0);assert.equal(scanSignal.aborted,false);
    f.state.advance(delay-20000);callback({deviceId:'late-real-advertisement',signalStrength:-40});
    assert.equal(f.state.devices[0].deviceId,'late-real-advertisement');assert.equal(f.state.error,'');assert.equal(stops,0);
    f.context.discoveryAttemptRef.current.controller.abort();callback({deviceId:'after-close'});assert.equal(f.state.devices.length,1);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceStatusPoll, deviceConnectionStatus, withDeviceStatusTimeout } = require('../photo-wall-app/src/deviceStatus.cjs');

const scope = () => ({deviceId:'screen-a', bindingKey:'account-a/screen-a', bindingEpoch:1, sequence:0});
const device = last_seen => ({device_id:'screen-a', last_seen, state:'online', error:''});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};

test('preparation longer than 90 seconds observes live heartbeats without changing the wall session', async () => {
  const binding = scope();
  let clock = 1_000_000, observation, persisted = 0;
  const session = {device:device(clock / 1000), firstWall:{state:'preparing'},
    publishedWall:{revision:'previous-revision', wallId:'previous-wall'}};
  const original = JSON.stringify(session);
  const poll = createDeviceStatusPoll({getScope:() => binding, isBusy:() => true,
    readDevice:async () => device(clock / 1000), now:() => clock,
    onObserved:value => { observation = value; },
    onIdle:() => { persisted++; session.firstWall = null; session.publishedWall = null; },
    onError:error => { throw error; }});
  for (let elapsed = 0; elapsed <= 180_000; elapsed += 10_000) {
    clock = 1_000_000 + elapsed;
    await poll.refresh();
    assert.deepEqual(deviceConnectionStatus({connected:true, device:session.device,
      observation, scope:binding, now:clock}), {deviceOnline:true, connectionLabel:'已连接'});
  }
  assert.equal(persisted,0);
  assert.equal(JSON.stringify(session),original);
  poll.cancel();
});

test('a fresh server read of an expired heartbeat still reports offline using the 90 second rule', () => {
  const binding = scope();
  for (const age of [90,91]) {
    const now = 1_000_000, status = device(now / 1000 - age);
    const result = deviceConnectionStatus({connected:true, device:status, scope:binding, now,
      observation:{...binding, device:status, receivedAt:now, readFailed:false}});
    assert.equal(result.deviceOnline,age === 90);
    assert.equal(result.connectionLabel,age === 90 ? '已连接' : '暂时离线');
  }
});

test('a failed or stale status request is not evidence that the device went offline', () => {
  const binding = scope(), now = 1_000_000, status = device(900);
  for (const observation of [null,
    {...binding, device:status, receivedAt:now, readFailed:true},
    {...binding, device:status, receivedAt:now-21_000, readFailed:false}]) {
    assert.deepEqual(deviceConnectionStatus({connected:true, device:status, scope:binding, now, observation}),
      {deviceOnline:false, connectionLabel:'确认连接中'});
  }
});

test('switching binding ignores the previous observation even for the same device ID', () => {
  const previous = scope(), current = {...previous,bindingKey:'account-b/screen-a',bindingEpoch:2};
  const now = 1_000_000;
  const result = deviceConnectionStatus({connected:true, device:device(800), scope:current, now,
    observation:{...previous,device:device(1000),receivedAt:now,readFailed:false}});
  assert.equal(result.connectionLabel,'确认连接中');
  assert.equal(result.deviceOnline,false);
});

test('device faults stay faults and the preview remains an explicit simulation', () => {
  const status = {...device(1000),error:'display failure'};
  assert.equal(deviceConnectionStatus({connected:true,device:status,now:1_000_000}).connectionLabel,'设备异常');
  assert.equal(deviceConnectionStatus({connected:true,preview:true}).connectionLabel,'演示连接');
  assert.equal(deviceConnectionStatus({connected:false}).connectionLabel,'连接照片墙');
});

test('timed out body reads release the poll so the next refresh can succeed', async () => {
  let calls = 0, observation, requestSignal;
  const errors = [];
  const poll = createDeviceStatusPoll({getScope:scope,isBusy:() => true,
    readDevice:(_,signal) => withDeviceStatusTimeout(async bounded => {
      calls++;
      requestSignal = bounded;
      // Models headers arriving but response.text() never settling or honoring abort.
      if (calls === 1) return new Promise(() => {});
      return device(1000);
    }, {signal,timeoutMs:10}),
    onObserved:value => { observation = value; }, onIdle:() => assert.fail('busy write'),
    onError:error => errors.push(error)});
  await poll.refresh();
  assert.equal(errors[0].code,'DEVICE_STATUS_TIMEOUT');
  assert.equal(requestSignal.aborted,true);
  await poll.refresh();
  assert.equal(calls,2);
  assert.equal(observation.device.last_seen,1000);
  poll.cancel();
});

test('external abort cancels a hung status read and an already aborted caller never starts one', async () => {
  const controller = new AbortController();
  let propagated;
  const pending = withDeviceStatusTimeout(signal => {
    propagated = signal;
    return new Promise(() => {});
  }, {signal:controller.signal,timeoutMs:1000});
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(propagated.aborted,true);
  await assert.rejects(withDeviceStatusTimeout(() => assert.fail('read after cancel'),
    {signal:controller.signal}),{name:'AbortError'});
});

test('binding switches and disposal discard delayed successful status responses', async () => {
  for (const cancel of [false,true]) {
    let binding = scope(), observed = 0, saved = 0, calls = 0;
    const waiting = deferred();
    const poll = createDeviceStatusPoll({getScope:() => binding,isBusy:() => false,
      readDevice:() => { calls++; return waiting.promise; },
      onObserved:() => { observed++; },onIdle:() => { saved++; },onError:assert.fail});
    const pending = poll.refresh();
    if (cancel) poll.cancel();
    else binding = {...binding,bindingKey:'account-b/screen-a',bindingEpoch:2};
    waiting.resolve(device(1000));
    await pending;
    await poll.refresh();
    assert.equal(observed,0);
    assert.equal(saved,0);
    assert.equal(calls,1);
    poll.cancel();
  }
});

test('a poll overlapping the start or end of a wall operation never persists its stale session', async () => {
  for (const initiallyBusy of [false,true]) {
    let busy = initiallyBusy, observed = 0, saved = 0;
    const binding = scope(), waiting = deferred();
    const poll = createDeviceStatusPoll({getScope:() => binding,isBusy:() => busy,
      readDevice:() => waiting.promise,onObserved:() => { observed++; },
      onIdle:() => { saved++; },onError:assert.fail});
    const pending = poll.refresh();
    busy = !initiallyBusy;
    binding.sequence++;
    waiting.resolve(device(1000));
    await pending;
    assert.equal(observed,1);
    assert.equal(saved,0);
    poll.cancel();
  }
});

test('idle refresh keeps the existing persistence path and concurrent refreshes do not overlap', async () => {
  let observed = 0, saved = 0, calls = 0;
  const waiting = deferred(), binding = scope();
  const poll = createDeviceStatusPoll({getScope:() => binding,isBusy:() => false,
    readDevice:() => { calls++; return waiting.promise; },onObserved:() => { observed++; },
    onIdle:status => { assert.equal(status.last_seen,1000); saved++; },onError:assert.fail});
  const pending = poll.refresh();
  await poll.refresh();
  assert.equal(calls,1);
  waiting.resolve(device(1000));
  await pending;
  assert.equal(observed,1);
  assert.equal(saved,1);
  poll.cancel();
});

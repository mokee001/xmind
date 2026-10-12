import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const { mountFirstWall, createFirstWallJourney, DEMO_STALE_PERSON_ID } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/first-wall.js')).toString('base64')}`);
const { createOnboarding } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/onboarding.js')).toString('base64')}`);
const { mountPanel, resetPreferenceDraft } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/panels.js')).toString('base64')}`);

function harness(scenario = 'success', delays) {
  const tasks = new Map(), actions = {}; let id = 0, now = 0, done = 0;
  const schedule = (fn, delay) => { const key = ++id; tasks.set(key, { fn, at: now + delay }); return key; };
  const cancel = key => tasks.delete(key);
  const journey = createFirstWallJourney({ scenario, delays,
    schedule, cancel,
  });
  const advance = milliseconds => {
    const until = now + milliseconds;
    for (let n = 0; n < 100; n++) {
      const next = [...tasks].sort((a,b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      now = next[1].at; tasks.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  const host = { innerHTML: '', querySelector: selector => host.innerHTML.includes(selector.slice(1,-1)) ? { addEventListener: (_, fn) => actions[selector] = fn } : null };
  return { journey, tasks, actions, host, advance, schedule, cancel,
    mount: (extra = {}) => mountFirstWall({ host, header: {}, journey, onDone: () => done++, ...extra }),
    events: (type, stage) => journey.snapshot().events.filter(event => event.type === type && (!stage || event.stage === stage)),
    done: () => done,
  };
}

test('authorization prepares locally during connection and reuses the finished result', () => {
  const h = harness(); h.journey.authorize('limited'); h.advance(1800);
  assert.equal(h.journey.snapshot().work.local, 'ready');
  assert.equal(h.events('started', 'upload').length, 0, 'no simulated upload before connection');
  h.journey.connect(); const stop = h.mount();
  assert.equal(h.events('started', 'local').length, 1);
  assert.equal(h.events('started', 'upload').length, 1);
  h.advance(9000); assert.match(h.host.innerHTML, /第一幅回忆，已在照片墙/);
  h.actions['[data-first-done]'](); assert.equal(h.done(), 1); stop(); h.journey.destroy();
});

function preferenceHarness(journey, preferences = { people: [], topics: [], memoryMix: '均衡' }, availablePeople) {
  let state = { preferences: structuredClone(preferences), settings: { connected: true, deviceName: '示例照片墙', updateFrequency: '每周', updateTime: '18:30' } };
  let allowSave = true, saves = 0, resumed = 0, cleanup;
  const toasts = [];
  const host = { innerHTML: '', contains: () => true, querySelector: () => ({ focus() {} }),
    addEventListener(_, callback, { signal }) { this.click = callback; signal.addEventListener('abort', () => { this.click = null; }); } };
  const recovery = journey ? { key: journey, stalePeople: [DEMO_STALE_PERSON_ID], availablePeople } : null;
  const mount = () => {
    cleanup = mountPanel(host, 'preferences', { icon: () => '', getState: () => structuredClone(state),
      preferenceRecovery: recovery, toast: message => toasts.push(message),
      updateState(patch) {
        saves++;
        if (!allowSave) return false;
        state = { ...state, preferences: { ...state.preferences, ...patch.preferences } };
        return true;
      },
      onPreferencesSaved() {
        assert.equal(journey.confirmPeoplePreferences(state.preferences.people), true);
        resumed++;
      },
    });
  };
  return { host, mount, close: () => cleanup(), state: () => structuredClone(state),
    saves: () => saves, resumed: () => resumed, failSave: value => { allowSave = !value; }, toasts,
    click(action, value) { host.click({ target: { closest: () => ({ dataset: { panelAction: action, value } }) } }); },
  };
}

test('people recovery provides a preference entry; rechecking does not discard the original failure or connection', () => {
  const h = harness('people'); let opened = 0;
  h.journey.authorize('all'); h.journey.connect();
  const stop = h.mount({ onAdjustPeople: () => opened++ }); h.advance(30000);
  assert.match(h.host.innerHTML, /需要重新确认人物偏好/);
  assert.match(h.host.innerHTML, /暂时不在当前可选结果中/);
  assert.match(h.host.innerHTML, /调整人物偏好/);
  assert.match(h.host.innerHTML, /重新检查/);
  assert.match(h.host.innerHTML, /设备回执均为模拟/);
  const before = h.journey.snapshot();
  h.actions['[data-first-retry]'](); h.advance(30000);
  assert.equal(h.journey.snapshot().failure, 'people');
  assert.equal(h.journey.snapshot().connected, true);
  assert.deepEqual(h.journey.snapshot().work, before.work);
  assert.equal(h.events('started', 'publish').length, 0);
  h.actions['[data-first-people]'](); assert.equal(opened, 1);
  stop(); h.journey.destroy();
});

test('people recovery keeps old choices on back and retains edits across a failed save; only a successful save resumes', () => {
  resetPreferenceDraft();
  const h = harness('people'); h.journey.authorize('limited'); h.journey.connect();
  const stop = h.mount(); h.advance(30000); stop();
  const p = preferenceHarness(h.journey, { people: ['person-1'], topics: ['food'], memoryMix: '多些旧回忆' });
  const original = p.state(); p.mount();
  assert.match(p.host.innerHTML, /data-panel-action="manage">保存并继续<\/button>/);
  assert.match(p.host.innerHTML, /待确认的旧选择 1/);
  p.click('manage'); assert.equal(p.saves(), 0);
  assert.match(p.host.innerHTML, /请先移除待确认的旧选择/);
  p.close();
  const returnToFailure = h.mount();
  assert.match(h.host.innerHTML, /需要重新确认人物偏好/);
  assert.deepEqual(p.state(), original);
  assert.equal(h.journey.snapshot().connected, true);
  returnToFailure(); p.mount();
  assert.match(p.host.innerHTML, /待确认的旧选择 1/);
  p.click('remove-unresolved', DEMO_STALE_PERSON_ID);
  p.click('person', 'person-2'); p.failSave(true); p.click('manage');
  assert.equal(p.saves(), 1); assert.equal(p.resumed(), 0);
  assert.deepEqual(p.state(), original);
  assert.equal(h.journey.snapshot().failure, 'people');
  assert.match(p.host.innerHTML, /你的修改还在这里/);
  p.close(); p.mount();
  assert.doesNotMatch(p.host.innerHTML, /待确认的旧选择 1/);
  assert.match(p.host.innerHTML, /data-value="person-2"[^>]*aria-pressed="true"/);
  p.failSave(false); p.click('manage');
  assert.equal(p.resumed(), 1);
  assert.deepEqual(p.state().preferences.people, ['person-1', 'person-2']);
  assert.deepEqual(p.state().settings, original.settings);
  assert.deepEqual(p.state().preferences.topics, original.preferences.topics);
  assert.equal(h.journey.snapshot().work.generation, 'idle', 'preferences route stays paused until return');
  p.close(); const resumed = h.mount(); h.advance(30000);
  assert.equal(h.journey.snapshot().work.receipt, 'ready');
  assert.equal(h.events('started', 'local').length, 1);
  assert.equal(h.events('started', 'upload').length, 1);
  assert.equal(h.events('started', 'publish').length, 1);
  assert.match(h.host.innerHTML, /设备回执均为模拟/);
  resumed(); h.journey.destroy(); resetPreferenceDraft();
});

test('zero current people preserves every old selection and states natural arrangement before explicit save', () => {
  resetPreferenceDraft();
  const h = harness('people'); h.journey.authorize('all'); h.journey.connect(); h.advance(30000); h.journey.pause();
  const p = preferenceHarness(h.journey, { people: ['person-1'], topics: [], memoryMix: '均衡' }, []); p.mount();
  assert.match(p.host.innerHTML, /这次精选里暂时没有可选人物/);
  assert.match(p.host.innerHTML, /也可以返回保留原选择/);
  assert.doesNotMatch(p.host.innerHTML, /data-panel-action="person"/);
  p.click('remove-unresolved', DEMO_STALE_PERSON_ID);
  p.click('manage'); assert.equal(p.saves(), 0, 'the earlier normal selection is also preserved until explicitly removed');
  assert.deepEqual(p.state().preferences.people, ['person-1']);
  p.click('remove-unresolved', 'person-1');
  assert.match(p.host.innerHTML, /未选择人物，保存后按自然安排继续/);
  assert.equal(p.saves(), 0); assert.equal(h.journey.snapshot().failure, 'people');
  p.click('manage'); assert.equal(p.saves(), 1); assert.equal(p.resumed(), 1);
  assert.deepEqual(p.state().preferences.people, []);
  p.close(); h.journey.destroy(); resetPreferenceDraft();
});

test('ordinary preferences still require manage before editing and remain on the page after saving', () => {
  resetPreferenceDraft();
  const p = preferenceHarness(null, { people: ['person-1'], topics: [], memoryMix: '均衡' }); p.mount();
  assert.match(p.host.innerHTML, /管理偏好/);
  assert.doesNotMatch(p.host.innerHTML, /待确认的旧选择/);
  p.click('manage');
  assert.match(p.host.innerHTML, /data-panel-action="manage">保存<\/button>/);
  p.click('person', 'person-2'); p.click('manage');
  assert.equal(p.saves(), 1); assert.equal(p.resumed(), 0);
  assert.deepEqual(p.state().preferences.people, ['person-1', 'person-2']);
  assert.match(p.host.innerHTML, /管理偏好/);
  p.close(); resetPreferenceDraft();
});

test('onboarding authorization bridges into warmup before real demo connection completion', t => {
  const h = harness(); const savedGlobals = {};
  for (const name of ['setTimeout', 'clearTimeout', 'location', 'sessionStorage']) savedGlobals[name] = globalThis[name];
  t.after(() => { Object.assign(globalThis, savedGlobals); h.journey.destroy(); });
  const values = new Map(); let sheet, completion;
  globalThis.setTimeout = h.schedule; globalThis.clearTimeout = h.cancel;
  globalThis.location = { hash: '#welcome', search: '', replace(value) { this.hash = value; } };
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
  const element = () => ({ innerHTML: '', scrollTop: 0, addEventListener(_, callback, { signal }) { this.click = callback; signal.addEventListener('abort', () => { this.click = null; }); } });
  const host = element(), header = element();
  const state = { settings: { deviceName: '书房照片墙', updateFrequency: '每周', updateTime: '18:30' }, preferences: { people: ['saved-person'] }, onboarding: { completed: true } };
  const original = JSON.parse(JSON.stringify(state));
  const flow = createOnboarding({ host, header, icon: () => '', toast: () => {}, getState: () => state,
    onPhotoAccess: access => h.journey.authorize(access),
    onComplete(patch) { completion = patch; h.journey.connect(); return true; },
    openSheet(config) { sheet = config; return { close() {}, dialog: { querySelector: () => ({ value: 'Home_2.4G' }) } }; },
  });
  t.after(() => flow.destroy());
  const click = action => host.click({ target: { closest: () => ({ disabled: false, dataset: { flowAction: action } }) } });
  flow.show('welcome'); assert.equal(h.events('started', 'local').length, 0);
  click('start'); sheet.actions[1].onClick();
  assert.equal(h.events('started', 'local').length, 1, 'partial permission starts warmup before any connection permission');
  assert.equal(h.journey.snapshot().connected, false);
  flow.destroy(); flow.show('device'); h.advance(100); sheet.actions[0].onClick();
  h.advance(100); sheet.actions[0].onClick(); h.advance(550);
  click('connect-device'); sheet.actions[0].onClick(); h.advance(2000);
  assert.equal(h.journey.snapshot().connected, true);
  assert.equal(h.events('started', 'local').length, 1);
  assert.equal(h.journey.snapshot().work.local, 'ready');
  assert.deepEqual(completion, { settings: { connected: true, photoAccess: 'limited' }, onboarding: { completed: true } });
  assert.deepEqual(state, original, 'warmup must not change preferences, schedule or device name');
});

test('candidate readiness starts the first wall; remaining uploads wait for its receipt', () => {
  const h = harness(); h.journey.authorize('all'); h.advance(1800); h.journey.connect();
  h.advance(3000);
  assert.equal(h.journey.snapshot().work.candidates, 'ready');
  assert.equal(h.journey.snapshot().work.remaining, 'idle');
  assert.equal(h.events('started', 'remaining').length, 0);
  assert.equal(h.journey.snapshot().work.generation, 'pending');
  h.advance(6000); assert.equal(h.journey.snapshot().work.receipt, 'ready');
  assert.equal(h.journey.snapshot().work.remaining, 'pending', 'remaining upload begins only after the first receipt');
  const events = h.journey.snapshot().events;
  assert.ok(events.findIndex(event => event.type === 'ready' && event.stage === 'receipt')
    < events.findIndex(event => event.type === 'started' && event.stage === 'remaining'));
  h.journey.destroy();
});

test('unfinished local work continues waiting after connection without fake completion', () => {
  const h = harness('preparation-slow'); h.journey.authorize('all'); h.journey.connect(); const stop = h.mount();
  h.advance(13999); assert.match(h.host.innerHTML, /正在准备第一幅回忆/);
  assert.equal(h.events('started', 'upload').length, 0);
  assert.doesNotMatch(h.host.innerHTML, /data-first-done/);
  h.advance(1); assert.equal(h.events('started', 'upload').length, 1);
  assert.equal(h.events('started', 'local').length, 1, 'connection must not restart warmup');
  stop(); h.journey.destroy();
});

test('entering calendar after the first receipt allows remaining background work to finish', () => {
  const h = harness(); h.journey.authorize('all'); h.advance(1800); h.journey.connect(); const stop = h.mount();
  h.advance(9000); assert.equal(h.journey.snapshot().work.receipt, 'ready');
  assert.equal(h.journey.snapshot().work.remaining, 'pending');
  h.actions['[data-first-done]'](); stop();
  h.advance(12000); assert.equal(h.journey.snapshot().work.remaining, 'ready');
  assert.equal(h.done(), 1); h.journey.destroy();
});

for (const [scenario, failedStage] of [['empty', 'local'], ['upload', 'upload'], ['receipt', 'receipt']]) {
  test(`${scenario} recovery preserves every already completed step`, () => {
    const h = harness(scenario); h.journey.authorize('all'); h.journey.connect(); const stop = h.mount();
    h.advance(30000); assert.match(h.host.innerHTML, /data-first-retry/);
    assert.doesNotMatch(h.host.innerHTML, /第一幅回忆，已在照片墙/);
    assert.equal(h.events('started', 'remaining').length, 0, 'failed first wall must not release remaining uploads');
    const completedBefore = Object.entries(h.journey.snapshot().work).filter(([,state]) => state === 'ready').map(([name]) => name);
    const startsBefore = Object.fromEntries(completedBefore.map(name => [name, h.events('started', name).length]));
    h.actions['[data-first-retry]'](); h.advance(30000);
    assert.match(h.host.innerHTML, /第一幅回忆，已在照片墙/);
    assert.equal(h.events('started', failedStage).length, 2);
    completedBefore.forEach(name => assert.equal(h.events('started', name).length, startsBefore[name], `${name} must be reused`));
    h.actions['[data-first-done]'](); assert.equal(h.done(), 1);
    stop(); h.journey.destroy();
  });
}

test('leaving cancels stale callbacks, returning keeps completed warmup', () => {
  const h = harness(); h.journey.authorize('all'); h.advance(1800); h.journey.connect(); const stop = h.mount();
  const lateCallback = [...h.tasks.values()][0].fn;
  stop(); const oldHtml = h.host.innerHTML; lateCallback(); h.advance(30000);
  assert.equal(h.host.innerHTML, oldHtml); assert.equal(h.events('ready', 'upload').length, 0);
  assert.equal(h.tasks.size, 0); assert.equal(h.done(), 0);
  const stopAgain = h.mount(); h.advance(30000);
  assert.equal(h.events('started', 'local').length, 1); assert.equal(h.journey.snapshot().work.receipt, 'ready');
  stopAgain(); h.journey.destroy();
});

test('authorization revocation or scope change invalidates old work and callbacks', () => {
  const h = harness(); h.journey.authorize('all'); h.advance(1800); h.journey.connect();
  const oldUpload = [...h.tasks.values()][0].fn;
  h.journey.authorize('none'); oldUpload(); h.advance(30000);
  assert.equal(h.tasks.size, 0); assert.equal(h.journey.snapshot().work.local, 'idle');
  assert.equal(h.events('ready', 'upload').length, 0);
  h.journey.authorize('limited'); h.advance(1800);
  assert.equal(h.events('started', 'local').length, 2);
  h.journey.destroy(); const before = h.journey.snapshot(); h.advance(30000);
  assert.deepEqual(h.journey.snapshot(), before);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const { mountFirstWall, createFirstWallJourney, DEMO_STALE_PERSON_ID } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/first-wall.js')).toString('base64')}`);
const { createOnboarding } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/onboarding.js')).toString('base64')}`);
const { mountPanel, resetPreferenceDraft } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/panels.js')).toString('base64')}`);
const { createNetworkDemo, networkNotice } = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync('demos/calendar-app/network.js')).toString('base64')}`);

function harness(scenario = 'success', delays, networkOptions) {
  const tasks = new Map(), actions = {}; let id = 0, now = 0, done = 0;
  const schedule = (fn, delay) => { const key = ++id; tasks.set(key, { fn, at: now + delay }); return key; };
  const cancel = key => tasks.delete(key);
  const network = networkOptions ? createNetworkDemo({ ...networkOptions, schedule, cancel }) : null;
  const journey = createFirstWallJourney({ scenario, delays,
    schedule, cancel, network,
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
  const header = { innerHTML: '', querySelector: selector => header.innerHTML.includes(selector.slice(1,-1)) ? { addEventListener: (_, fn) => actions[selector] = fn } : null };
  return { journey, network, tasks, actions, host, header, advance, schedule, cancel,
    mount: (extra = {}) => mountFirstWall({ host, header, journey, onDone: () => done++, ...extra }),
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

test('service-unreachable history reads end at eight seconds and repeated checks never invent screen offline or success', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  const reading = h.network.readHistory();
  h.advance(7999); assert.equal(h.network.snapshot().history, 'loading');
  assert.equal(networkNotice(h.network.snapshot()).label, '确认连接中');
  h.advance(1); assert.equal((await reading).ok, false);
  assert.equal(h.network.snapshot().history, 'error');
  assert.equal(h.network.snapshot().device, null);
  assert.match(networkNotice(h.network.snapshot()).title, /无法读取展示记录/);
  assert.match(networkNotice(h.network.snapshot()).copy, /已有记录会保留/);
  for (let i = 0; i < 3; i++) {
    const checking = h.network.check(); h.advance(8000);
    assert.equal((await checking).ok, false);
    assert.equal(h.network.snapshot().checking, false);
    assert.equal(h.network.snapshot().history, 'error');
    assert.equal(h.network.snapshot().removed, false);
  }
  h.network.destroy(); h.journey.destroy();
});

test('screen offline does not prevent a successful history read or count as a display receipt', async () => {
  const h = harness('success', undefined, { scenario: 'device-offline' });
  const reading = h.network.readHistory(); h.advance(650);
  assert.equal((await reading).ok, true);
  assert.equal(h.network.snapshot().history, 'ready');
  assert.equal(networkNotice(h.network.snapshot()).label, '照片墙离线');
  assert.equal(h.journey.snapshot().work.receipt, 'idle');
  h.network.destroy(); h.journey.destroy();
});

test('removal needs explicit confirmation; ten-second service failure retains the binding', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  assert.equal((await h.network.remove()).confirmationRequired, true);
  assert.equal(h.tasks.size, 0);
  const removing = h.network.remove({ confirmed: true });
  h.advance(9999); assert.equal(h.network.snapshot().removing, true);
  assert.equal(h.network.snapshot().removed, false);
  h.advance(1); assert.deepEqual(await removing, { ok: false, reason: 'timeout', simulated: true });
  assert.equal(h.network.snapshot().removed, false);
  assert.equal(h.network.snapshot().removing, false);
  h.network.destroy(); h.journey.destroy();
});

test('service acceptance removes an offline device while explicitly retaining pending device synchronization', async () => {
  const h = harness('success', undefined, { scenario: 'device-offline' });
  const removing = h.network.remove({ confirmed: true }); h.advance(650);
  assert.deepEqual(await removing, { ok: true, removed: true, pendingDevice: true, simulated: true });
  assert.equal(h.network.snapshot().removed, true);
  assert.match(networkNotice(h.network.snapshot()).copy, /屏幕恢复联网后同步清除连接设置/);
  assert.equal(h.journey.snapshot().work.receipt, 'idle');
  h.network.destroy(); h.journey.destroy();
});

test('mismatched or unconfirmed removal responses preserve the binding', async () => {
  for (const response of [null, {}, { device_id: 'another-demo-frame', removed: true }, { device_id: 'demo-frame', removed: false }]) {
    const h = harness('success', undefined, { scenario: 'device-offline', removalResponse: () => response });
    const removing = h.network.remove({ confirmed: true }); h.advance(650);
    assert.equal((await removing).reason, 'unconfirmed');
    assert.equal(h.network.snapshot().removed, false);
    h.network.destroy(); h.journey.destroy();
  }
});

function actualSheetHarness(network) {
  const source = fs.readFileSync('demos/calendar-app/app.js', 'utf8');
  const openSource = source.slice(source.indexOf('function openSheet('), source.indexOf('function manageDevice('));
  const networkSource = source.slice(source.indexOf('async function checkNetwork('), source.indexOf('function removeNetworkDevice('));
  const removeSource = source.slice(source.indexOf('function removeNetworkDevice('), source.indexOf('function connectionSheet('));
  const listeners = [], queued = [];
  const dialog = {
    open: false, closeCalls: 0, showCalls: 0, buttons: [], fields: {},
    set innerHTML(value) {
      this.html = value;
      this.buttons = [...value.matchAll(/<button[^>]*?( hidden)? data-sheet-action="(\d+)">([^<]*)<\/button>/g)]
        .map(match => ({ dataset: { sheetAction: match[2] }, textContent: match[3], hidden: !!match[1], disabled: false }));
      this.fields = Object.fromEntries(['data-remove-result', 'data-network-result', 'data-network-label', 'data-network-copy']
        .map(name => [`[${name}]`, { textContent: '' }]));
    },
    querySelector(selector) {
      const index = /\[data-sheet-action="(\d+)"\]/.exec(selector);
      return index ? this.buttons[Number(index[1])] : this.fields[selector];
    },
    addEventListener(type, callback, options = {}) {
      const listener = { type, callback, active: true };
      listeners.push(listener);
      options.signal?.addEventListener('abort', () => { listener.active = false; });
    },
    dispatch(type, event) {
      const current = listeners.filter(listener => listener.type === type && listener.active);
      current.forEach(listener => { if (listener.active) listener.callback(event); });
    },
    showModal() { this.open = true; this.showCalls++; },
    close() { this.open = false; this.closeCalls++; queued.push(() => this.dispatch('close', {})); },
    click(index) {
      const button = this.buttons[index];
      this.dispatch('click', { target: { closest: selector => selector === '[data-sheet-action]' ? button : null } });
    },
    flushClose() { while (queued.length) queued.shift()(); },
  };
  let reconnects = 0; const routes = [];
  const factory = new Function('dialog', 'document', 'escapeHtml', 'icon', 'network', 'navigate', 'networkNotice', 'onboarding',
    `let sheetController; const route = 'calendar'; const manageDevice = () => {}; ${openSource}\n${networkSource}\n${removeSource}\nreturn {openSheet, networkHelp, removeNetworkDevice};`);
  return { dialog, routes, reconnects: () => reconnects,
    ...factory(dialog, { activeElement: null }, String, () => '', network, route => routes.push(route), networkNotice, { beginReconnect() { reconnects++; } }) };
}

test('actual nested sheets keep new buttons active and ignore an old queued close event', () => {
  const h = actualSheetHarness(); let confirmed = 0, child;
  const parent = h.openSheet({ title: '设备', body: '', actions: [{ label: '移除设备', onClick: () => {
    child = h.openSheet({ title: '确认移除', body: '', actions: [{ label: '确认移除', onClick: () => confirmed++ }] });
  } }] });
  h.dialog.click(0);
  assert.equal(h.dialog.closeCalls, 0, 'replacement must not enqueue a close event');
  assert.equal(h.dialog.showCalls, 1);
  assert.equal(parent.signal.aborted, true);
  parent.close(); assert.equal(h.dialog.open, true, 'a stale view cannot close its replacement');
  h.dialog.click(0); assert.equal(confirmed, 1);
  child.close();
  const next = h.openSheet({ title: '下一张', body: '', actions: [{ label: '继续', onClick: () => confirmed++ }] });
  h.dialog.flushClose();
  assert.equal(next.signal.aborted, false);
  h.dialog.click(0); assert.equal(confirmed, 2);
  next.close(); h.dialog.flushClose(); assert.equal(next.signal.aborted, true);
});

test('actual removal sheet disables only its request button and restores retry after the bounded failure', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  const ui = actualSheetHarness(h.network); ui.removeNetworkDevice();
  ui.dialog.click(0);
  assert.equal(ui.dialog.buttons[0].textContent, '正在确认移除…');
  assert.equal(ui.dialog.buttons[0].disabled, true);
  assert.equal(ui.dialog.buttons[2].disabled, false);
  assert.equal(ui.dialog.buttons[1].hidden, true);
  ui.dialog.click(0); assert.equal(h.tasks.size, 1, 'repeated confirmation cannot queue another request');
  h.advance(10000); await Promise.resolve();
  assert.equal(ui.dialog.buttons[0].disabled, false);
  assert.equal(ui.dialog.buttons[0].textContent, '重新确认移除');
  assert.match(ui.dialog.fields['[data-remove-result]'].textContent, /设备绑定和偏好已保留/);
  assert.equal(ui.dialog.buttons[1].hidden, false);
  assert.equal(h.network.snapshot().removed, false);
  ui.dialog.click(2); ui.dialog.flushClose(); assert.equal(ui.dialog.open, false);
  h.network.destroy(); h.journey.destroy();
});

test('actual network sheet updates its status after recovery and stops listening after replacement', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  const ui = actualSheetHarness(h.network); ui.networkHelp();
  assert.equal(ui.dialog.fields['[data-network-label]'].textContent, '正在检查连接…');
  assert.equal(ui.dialog.buttons[0].disabled, true);
  assert.equal(h.tasks.size, 1, 'opening check must immediately start one bounded request');
  ui.dialog.click(0); assert.equal(h.tasks.size, 1);
  h.advance(8000); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.dialog.fields['[data-network-label]'].textContent, '暂时连不上服务');
  ui.dialog.click(2);
  assert.equal(ui.dialog.fields['[data-network-label]'].textContent, '已连接');
  assert.match(ui.dialog.fields['[data-network-copy]'].textContent, /模拟服务已恢复访问/);
  assert.equal(h.journey.snapshot().work.receipt, 'idle');
  ui.dialog.click(0); h.advance(650); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.dialog.fields['[data-network-label]'].textContent, '已连接');
  assert.match(ui.dialog.fields['[data-network-result]'].textContent, /连接正常 · 模拟结果/);
  const oldLabel = ui.dialog.fields['[data-network-label]'];
  ui.openSheet({ title: '另一张', body: '' });
  ui.dialog.fields = {};
  h.network.recover(); h.advance(650);
  assert.equal(oldLabel.textContent, '已连接', 'the replaced sheet subscription must have been removed');
  h.network.destroy(); h.journey.destroy();
});

test('failed cloud removal requires a separate local-only confirmation before opening reconnect', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  const ui = actualSheetHarness(h.network); ui.removeNetworkDevice();
  ui.dialog.click(1); assert.equal(ui.reconnects(), 0, 'hidden fallback cannot run before a failed request');
  ui.dialog.click(0); h.advance(10000); await Promise.resolve();
  ui.dialog.click(1);
  assert.match(ui.dialog.html, /云端绑定尚未解除/);
  assert.match(ui.dialog.html, /不会清除照片墙上的连接设置/);
  assert.equal(h.network.snapshot().removed, false);
  ui.dialog.click(1); ui.dialog.flushClose();
  assert.equal(ui.reconnects(), 0); assert.equal(h.network.snapshot().removed, false);
  ui.removeNetworkDevice(); ui.dialog.click(0); h.advance(10000); await Promise.resolve();
  ui.dialog.click(1); ui.dialog.click(0);
  assert.equal(h.network.snapshot().removed, true);
  assert.equal(h.network.snapshot().removalKind, 'local');
  assert.equal(h.network.snapshot().service, false);
  assert.equal(h.network.snapshot().removalPendingDevice, false);
  assert.match(networkNotice(h.network.snapshot()).copy, /云端绑定尚未解除/);
  assert.equal(ui.reconnects(), 1); assert.deepEqual(ui.routes, ['setup-device']);
  assert.equal(h.tasks.size, 0, 'local removal does not enqueue a cloud request');
  h.network.destroy(); h.journey.destroy();
});

test('local removal does not pretend the cloud binding is removed or restore it merely on network recovery', () => {
  const h = harness('success', undefined, { scenario: 'device-offline' });
  assert.equal(h.network.removeLocal().confirmationRequired, true);
  assert.equal(h.network.snapshot().removed, false);
  assert.deepEqual(h.network.removeLocal({ confirmed: true }), { ok: true, localOnly: true, cloudBindingRemoved: false, simulated: true });
  h.network.restoreService(); assert.equal(h.network.snapshot().device, false);
  assert.equal(h.network.completeReconnect(), false);
  assert.equal(h.network.snapshot().removed, true);
  assert.equal(h.network.completeReconnect({ confirmed: true }), true);
  assert.equal(h.network.snapshot().removed, false);
  assert.equal(h.network.snapshot().removalKind, null);
  h.network.destroy(); h.journey.destroy();
});

test('actual reconnect completion needs service confirmation and keeps the scenario out of stored settings', () => {
  const source = fs.readFileSync('demos/calendar-app/app.js', 'utf8');
  const completeSource = source.slice(source.indexOf('function completeOnboarding('), source.indexOf("header.addEventListener('click'"));
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  h.network.removeLocal({ confirmed: true });
  const original = { settings: { deviceName: '书房照片墙', connected: false, photoAccess: 'limited', updateFrequency: '每周', updateTime: '18:30' },
    preferences: { people: ['saved-person'], topics: ['food'] }, onboarding: { completed: true, completedAt: 'earlier' } };
  let stored = 0, connected = 0; const routes = [];
  const factory = new Function('initialState', 'network', 'updateState', 'firstJourney', 'navigate',
    `let state = initialState, previewHistory = true, calendarPosition = 20;
     const onboarding = { isRecovery: () => true }, toast = () => {}, resetPreferenceDraft = () => {};
     ${completeSource}
     return { completeOnboarding, state: () => state };`);
  const app = factory(structuredClone(original), h.network, () => { stored++; return true; },
    () => ({ connect: () => connected++ }), route => routes.push(route));
  const result = { settings: { connected: true, photoAccess: 'limited' }, onboarding: { completed: true } };
  assert.equal(app.completeOnboarding(result), false);
  assert.deepEqual(app.state(), original);
  assert.equal(h.network.snapshot().removalKind, 'local');
  h.network.restoreService();
  assert.equal(app.completeOnboarding(result), true);
  assert.equal(stored, 0, 'a network Demo recovery must never commit its simulated connection to normal saved settings');
  assert.equal(connected, 1); assert.deepEqual(routes, ['first-wall']);
  assert.equal(h.network.snapshot().history, 'loading', 'confirmed reconnect starts a fresh history read');
  assert.equal(app.state().settings.deviceName, original.settings.deviceName);
  assert.equal(app.state().settings.updateTime, '18:30');
  assert.equal(app.state().settings.updateFrequency, '每周');
  assert.deepEqual(app.state().preferences, original.preferences);
  assert.equal(h.network.snapshot().removed, false);
  h.network.destroy(); h.journey.destroy();
});

test('canceling a dialog releases its request and a stale callback cannot settle its replacement', async () => {
  for (const operation of ['check', 'remove']) {
    const h = harness('success', undefined, { scenario: 'device-offline' });
    const controller = new AbortController();
    const first = h.network[operation]({ confirmed: true, signal: controller.signal });
    const late = [...h.tasks.values()][0].fn;
    controller.abort(); assert.equal((await first).canceled, true);
    const replacement = h.network[operation]({ confirmed: true });
    late();
    assert.equal(h.network.snapshot().removed, false);
    assert.equal(h.network.snapshot()[operation === 'check' ? 'checking' : 'removing'], true);
    h.advance(650); assert.equal((await replacement).ok, true);
    h.network.destroy(); h.journey.destroy();
  }
});

test('explicit simulated recovery reloads history without silently completing a first wall', async () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  const initial = h.network.readHistory(); h.advance(8000); await initial;
  h.network.recover();
  assert.equal(h.network.snapshot().history, 'error', 'recovery alone does not pretend history was fetched');
  const checking = h.network.check(); h.advance(650); assert.equal((await checking).ok, true);
  const reading = h.network.readHistory(); h.advance(650); assert.equal((await reading).ok, true);
  assert.equal(h.journey.snapshot().work.receipt, 'idle');
  h.network.destroy(); h.journey.destroy();
});

test('first-wall navigation stays available while waiting and in a network failure', () => {
  const h = harness('success', undefined, { scenario: 'service-unreachable' });
  let calendar = 0, settings = 0, checks = 0;
  h.journey.authorize('all'); h.journey.connect();
  const stop = h.mount({ onCalendar: () => calendar++, onManageDevice: () => settings++, onCheckNetwork: () => checks++ });
  h.actions['[data-first-calendar]'](); h.actions['[data-first-manage]']();
  assert.equal(calendar, 1); assert.equal(settings, 1);
  h.advance(30000); assert.match(h.host.innerHTML, /暂时连不上服务/);
  h.actions['[data-first-calendar]'](); h.actions['[data-first-manage]'](); h.actions['[data-first-network]']();
  assert.equal(calendar, 2); assert.equal(settings, 2); assert.equal(checks, 1);
  assert.equal(h.journey.snapshot().work.receipt, 'idle');
  stop(); h.network.destroy(); h.journey.destroy();
});

test('network recovery preserves completed stages and a sent wall only resumes its receipt', async () => {
  for (const scenario of ['service-unreachable', 'device-offline']) {
    const h = harness('success', undefined, { scenario });
    h.journey.authorize('all'); h.journey.connect(); const stop = h.mount(); h.advance(30000);
    assert.equal(h.journey.snapshot().failure, scenario);
    const completed = Object.entries(h.journey.snapshot().work).filter(([,state]) => state === 'ready').map(([name]) => name);
    const starts = Object.fromEntries(completed.map(stage => [stage, h.events('started', stage).length]));
    h.journey.retry(); h.advance(30000);
    assert.equal(h.journey.snapshot().failure, scenario, 'a retry cannot cure the network');
    h.network.recover(); const checking = h.network.check(); h.advance(650); await checking;
    h.journey.retry(); h.advance(30000);
    assert.equal(h.journey.snapshot().work.receipt, 'ready');
    completed.forEach(stage => assert.equal(h.events('started', stage).length, starts[stage]));
    assert.equal(h.events('started', 'publish').length, 1);
    stop(); h.network.destroy(); h.journey.destroy();
  }
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

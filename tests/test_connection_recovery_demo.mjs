import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('demos/calendar-app/onboarding.js', 'utf8');
const { createOnboarding } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const key = 'echooo-calendar-onboarding-draft-v2';

function harness(scenario, saved = {}) {
  const tasks = new Map(); let timer = 0; let sheet; const completions = [];
  const store = new Map([[key, JSON.stringify({ version: 2, photoAccess: 'all', bluetooth: true, localNetwork: true, connected: false, network: 'Home_2.4G', ...saved })]]);
  globalThis.location = { hash: '#setup-device', search: `?connection=${scenario}` };
  globalThis.sessionStorage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  globalThis.setTimeout = callback => { tasks.set(++timer, callback); return timer; };
  globalThis.clearTimeout = id => tasks.delete(id);
  const element = () => ({ innerHTML: '', scrollTop: 0, addEventListener(_, fn, { signal }) { this.click = fn; signal.addEventListener('abort', () => { this.click = null; }); } });
  const host = element(); const header = element();
  const state = { settings: { deviceName: '书房照片墙', frequency: 'weekly', updateTime: '18:30' }, preferences: { people: ['saved-person'] }, onboarding: { completed: true } };
  let saveSucceeds = true;
  const make = () => createOnboarding({ host, header, icon: () => '', toast: () => {}, getState: () => state,
    openSheet(config) { sheet = config; return { close() {}, dialog: { querySelector: () => ({ value: 'Home_2.4G' }) } }; },
    onComplete(patch) { completions.push(patch); return saveSucceeds; },
  });
  let flow = make();
  const click = action => host.click({ target: { closest: () => ({ disabled: false, dataset: { flowAction: action } }) } });
  const tick = () => { const next = tasks.entries().next().value; if (!next) return false; tasks.delete(next[0]); next[1](); return true; };
  const flush = () => { for (let n = 0; n < 30 && tick(); n++); assert.equal(tasks.size, 0, 'flow must reach a bounded state'); };
  return { host, tasks, state, completions, click, tick, flush,
    draft: () => JSON.parse(store.get(key)),
    start() { flow.show('device'); flush(); click('connect-device'); sheet.actions[0].onClick(); },
    connectAgain() { sheet.actions[0].onClick(); },
    destroy() { flow.destroy(); },
    reload() { flow.destroy(); flow = make(); flow.show('device'); },
    failSave() { saveSucceeds = false; },
    allowSave() { saveSucceeds = true; },
  };
}

test('cloud outage retains Wi-Fi, bounded retries never claim success, manual retry needs recovery', () => {
  const h = harness('cloud-offline'); h.start(); h.flush();
  assert.match(h.host.innerHTML, /暂时连不上服务/);
  assert.match(h.host.innerHTML, /data-flow-action="retry-cloud"/);
  assert.doesNotMatch(h.host.innerHTML, />重新输入密码</);
  assert.equal(h.draft().wifiConnected, true); assert.equal(h.draft().connected, false);
  assert.equal(h.completions.length, 0);
  h.click('retry-cloud'); assert.doesNotMatch(h.host.innerHTML, /正在连接家庭网络/); h.flush();
  assert.equal(h.completions.length, 0);
  h.reload(); assert.match(h.host.innerHTML, /暂时连不上服务/); assert.equal(h.tasks.size, 0);
  h.click('demo-service-restored'); h.click('retry-cloud'); h.flush();
  assert.equal(h.completions.length, 1);
  assert.deepEqual(h.completions[0], { settings: { connected: true, photoAccess: 'all' }, onboarding: { completed: true } });
  assert.equal(h.state.settings.frequency, 'weekly'); assert.deepEqual(h.state.preferences.people, ['saved-person']); h.destroy();
});

test('temporary outage recovers automatically after Wi-Fi association', () => {
  const h = harness('cloud-temporary'); h.start(); h.tick(); h.tick();
  assert.match(h.host.innerHTML, /正在重新连接服务/); assert.equal(h.draft().wifiConnected, true);
  h.flush(); assert.equal(h.completions.length, 1); h.destroy();
});

test('wrong password stays at Wi-Fi recovery until example credential is corrected', () => {
  const h = harness('wrong-password'); h.start(); h.flush();
  assert.match(h.host.innerHTML, /Wi-Fi 密码不正确/); assert.equal(h.draft().wifiConnected, false);
  assert.equal(h.completions.length, 0);
  h.click('demo-password-corrected'); h.click('choose-network'); h.connectAgain(); h.flush();
  assert.equal(h.completions.length, 1); h.destroy();
});

test('leaving while retry is pending cancels late completion', () => {
  const h = harness('cloud-temporary'); h.start(); h.tick(); h.tick();
  assert.match(h.host.innerHTML, /正在重新连接服务/);
  h.destroy(); h.flush(); assert.equal(h.completions.length, 0);
});

test('Wi-Fi loss cancels scheduled service retry and clears only connection progress', () => {
  const h = harness('cloud-temporary'); h.start(); h.tick(); h.tick();
  h.click('demo-failed'); h.flush();
  assert.match(h.host.innerHTML, /Wi-Fi 没有连接成功/);
  assert.equal(h.draft().wifiConnected, false); assert.equal(h.completions.length, 0);
  assert.equal(h.draft().photoAccess, 'all'); assert.equal(h.state.settings.updateTime, '18:30'); h.destroy();
});

test('save failure retries save without redoing connection', () => {
  const h = harness('success'); h.failSave(); h.start(); h.flush();
  assert.match(h.host.innerHTML, /已连接，设置还未保存/);
  assert.equal(h.draft().connected, true); assert.equal(h.completions.length, 1);
  h.allowSave(); h.click('finish'); h.flush(); assert.equal(h.completions.length, 2); h.destroy();
});

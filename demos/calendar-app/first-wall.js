// Every completion below is a local demo event, never a hardware acknowledgement.
const WORK = ['local', 'upload', 'candidates', 'remaining', 'generation', 'publish', 'receipt'];
const DEFAULT_DELAYS = { local: 1800, upload: 1400, candidates: 1600, remaining: 12000, generation: 1800, publish: 1800, receipt: 2400 };
export const FIRST_WALL_SCENARIOS = ['success', 'preparation-slow', 'empty', 'upload', 'receipt', 'people'];
export const DEMO_STALE_PERSON_ID = 'demo-unresolved-person';

export function createFirstWallJourney({ scenario = 'success', schedule = setTimeout, cancel = clearTimeout, delays = {} } = {}) {
  scenario = FIRST_WALL_SCENARIOS.includes(scenario) ? scenario : 'success';
  const duration = { ...DEFAULT_DELAYS, ...(scenario === 'preparation-slow' ? { local: 14000 } : {}), ...delays };
  let access = 'none', connected = false, active = true, destroyed = false, epoch = 0, failure = null;
  let peopleConfirmed = false;
  let work = Object.fromEntries(WORK.map(name => [name, 'idle']));
  const timers = new Map(), listeners = new Set(), failedOnce = new Set(), events = [];
  function snapshot() { return { access, connected, active, destroyed, failure, work: { ...work }, events: events.map(event => ({ ...event })) }; }
  function emit(type, stage = '') {
    events.push({ sequence: events.length + 1, type, stage });
    const value = snapshot(); listeners.forEach(listener => listener(value));
  }
  function clearPending() {
    epoch++; timers.forEach(cancel); timers.clear();
    WORK.forEach(name => { if (work[name] === 'pending') work[name] = 'idle'; });
  }
  function shouldFail(name) {
    if (scenario === 'people' && name === 'generation') return !peopleConfirmed;
    return !failedOnce.has(name) && ((scenario === 'empty' && name === 'local') || (scenario === 'upload' && name === 'upload') || (scenario === 'receipt' && name === 'receipt'));
  }
  function start(name) {
    if (!active || destroyed || work[name] !== 'idle') return;
    work[name] = 'pending'; const ownEpoch = epoch;
    const timer = schedule(() => {
      if (!active || destroyed || epoch !== ownEpoch || work[name] !== 'pending') return;
      timers.delete(name);
      if (shouldFail(name)) { failedOnce.add(name); work[name] = 'failed'; failure = scenario === 'people' ? 'people' : name; emit('failed', failure); return; }
      work[name] = 'ready'; emit('ready', name); advance();
    }, duration[name]);
    timers.set(name, timer); emit('started', name);
  }
  function advance() {
    if (!active || destroyed || access === 'none' || failure) return;
    if (work.local !== 'ready') { start('local'); return; }
    if (!connected) return;
    if (work.upload !== 'ready') { start('upload'); return; }
    // Candidate readiness releases the first wall; remaining uploads stay idle
    // until its display receipt, so they cannot compete with first-wall work.
    if (work.candidates !== 'ready') { start('candidates'); return; }
    if (work.generation !== 'ready') { start('generation'); return; }
    if (work.publish !== 'ready') { start('publish'); return; }
    if (work.receipt !== 'ready') { start('receipt'); return; }
    start('remaining');
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    authorize(value) {
      if (destroyed) return;
      const next = ['all', 'limited'].includes(value) ? value : 'none';
      if (next !== access) {
        clearPending(); work = Object.fromEntries(WORK.map(name => [name, 'idle'])); failure = null;
        access = next; emit('authorization', next);
      }
      advance();
    },
    connect() {
      if (destroyed) return;
      if (!connected) { connected = true; emit('connected'); }
      advance();
    },
    retry() {
      if (!failure || destroyed || !active) return;
      if (failure === 'people') { emit('rechecked', 'people'); return; }
      const stage = failure; failure = null; work[stage] = 'idle'; emit('retry', stage); advance();
    },
    confirmPeoplePreferences(people) {
      if (destroyed || failure !== 'people' || !Array.isArray(people) || people.includes(DEMO_STALE_PERSON_ID)) return false;
      peopleConfirmed = true; failure = null; work.generation = 'idle';
      emit('preferences-saved', 'people'); advance();
      return true;
    },
    pause() {
      if (!active || destroyed) return;
      active = false; clearPending(); emit('paused');
    },
    resume() {
      if (destroyed) return;
      if (!active) { active = true; emit('resumed'); }
      advance();
    },
    destroy() { destroyed = true; active = false; clearPending(); listeners.clear(); },
  };
}

export function mountFirstWall({ host, header, onDone, onAdjustPeople, journey }) {
  if (!journey) throw new Error('First-wall demo requires the authorization/connection journey');
  let stopped = false, rendered = '';
  header.innerHTML = '<span class="flow-brand">echooo<span>®</span></span>';
  function render(title, copy, mode = 'waiting') {
    const key = `${title}|${copy}|${mode}`;
    if (stopped || key === rendered) return;
    rendered = key;
    host.innerHTML = `<div class="flow-shell first-wall"><div class="flow-scroll"><div class="first-wall-art ${mode === 'people' ? 'failed' : mode}" aria-hidden="true"><i></i><i></i><i></i><i></i><span>${mode === 'done' ? '✓' : ''}</span></div><div role="status" aria-live="polite"><h1>${title}</h1><p class="flow-lead">${copy}</p></div></div><footer class="flow-footer">${mode === 'people' ? '<button class="flow-primary" data-first-people>调整人物偏好</button><button class="flow-secondary" data-first-retry>重新检查</button>' : mode === 'failed' ? '<button class="flow-primary" data-first-retry>再试一次</button>' : mode === 'done' ? '<button class="flow-primary" data-first-done>进入日历</button>' : '<p>首次准备中，请暂时保持 App 打开。</p>'}<p>Demo · 选片、生成、投送与设备回执均为模拟</p></footer></div>`;
    host.querySelector('[data-first-people]')?.addEventListener('click', () => { if (!stopped) onAdjustPeople?.(); });
    host.querySelector('[data-first-retry]')?.addEventListener('click', () => { if (!stopped) journey.retry(); });
    host.querySelector('[data-first-done]')?.addEventListener('click', () => { if (!stopped) onDone(); });
  }
  function update({ failure, work }) {
    if (failure === 'people') render('需要重新确认人物偏好', '之前选择的人物暂时不在当前可选结果中。请重新确认后继续准备。', 'people');
    else if (failure === 'local') render('还需要几张照片', '当前授权范围内没有足够的可用照片。<br>正式 App 可在这里补充照片授权后继续。', 'failed');
    else if (failure === 'upload') render('这次准备暂时中断了', '请检查网络后重试。<br>照片墙已连接，无需重新设置。', 'failed');
    else if (failure === 'receipt') render('还未收到屏幕的回应', '照片已送出，但暂未确认显示。<br>请检查照片墙的电源与网络。', 'failed');
    else if (work.receipt === 'ready') render('第一幅回忆，已在照片墙。', '以后的日子，也会有新的相遇。', 'done');
    else if (work.publish === 'ready') render('回忆即将抵达', '正在等待照片墙完成刷新。');
    else if (work.generation === 'ready') render('回忆即将抵达', '照片墙正在接收这次的画面。');
    else render('正在准备第一幅回忆', '从手机里已有的照片开始。<br>不必等整个相册。');
  }
  const unsubscribe = journey.subscribe(update);
  journey.resume();
  return () => {
    stopped = true; unsubscribe();
    if (journey.snapshot().work.receipt !== 'ready') journey.pause();
  };
}

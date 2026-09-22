const DRAFT_KEY = 'echooo-calendar-onboarding-draft-v2';
const ROUTES = { welcome: '#welcome', device: '#setup-device' };
const NETWORKS = ['Home_2.4G', 'Echooo_Demo'];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function freshDraft(state) {
  return { version: 2, photoAccess: 'none', bluetooth: false, localNetwork: false, connected: false, permissionDenied: '', deviceName: state.settings?.deviceName?.trim()?.slice(0, 24) || '客厅照片墙', network: NETWORKS[0] };
}
function loadDraft(state) {
  const draft = freshDraft(state);
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (saved?.version !== 2) return draft;
    draft.photoAccess = ['all', 'limited'].includes(saved.photoAccess) ? saved.photoAccess : 'none';
    draft.bluetooth = saved.bluetooth === true;
    draft.localNetwork = saved.localNetwork === true;
    draft.connected = saved.connected === true && draft.photoAccess !== 'none' && draft.bluetooth && draft.localNetwork;
    draft.permissionDenied = ['photo', 'bluetooth', 'network'].includes(saved.permissionDenied) ? saved.permissionDenied : '';
    draft.network = NETWORKS.includes(saved.network) ? saved.network : draft.network;
  } catch { /* Invalid or unavailable storage starts a neutral walkthrough. */ }
  return draft;
}
function calendarArt() {
  return `<svg viewBox="0 0 310 220" fill="none" aria-hidden="true">
    <ellipse cx="156" cy="194" rx="97" ry="10" fill="#c4c4b3" opacity=".18"/>
    <g transform="translate(64 37) rotate(-9 85 70)"><rect width="164" height="146" rx="5" fill="#e5e3d8"/><path d="M15 27h134M15 37h90M15 47h109" stroke="#d2d0c3"/></g>
    <g transform="translate(75 24) rotate(4 80 75)"><rect x="2" y="6" width="166" height="151" rx="5" fill="#deddd0" opacity=".55"/><rect width="166" height="151" rx="5" fill="#fffefb" stroke="#d8d7cb"/><path d="M0 33h166" stroke="#e4e3d9"/><path d="M31-5v15m104-15v15" stroke="#898f77" stroke-width="3" stroke-linecap="round"/><text x="83" y="23" text-anchor="middle" fill="#8b8f7b" font-size="9" letter-spacing="4">EVERY DAY</text><text x="84" y="107" text-anchor="middle" fill="#697357" font-size="62" font-family="Georgia,serif">15</text><path d="M52 128h63" stroke="#dcded1"/><circle cx="83" cy="137" r="2" fill="#a4ad91"/></g>
    <path d="M234 187c-1-18 4-36 17-57m-16 39c-17-4-21-14-17-26 11 4 18 13 17 26Zm7-22c-1-15 7-24 19-26 1 13-5 22-19 26Z" stroke="#8d977d" stroke-width="1.4" fill="#e2e7d7"/>
    <path d="m52 63-7-4m13-8-2-8m-14 32-8 1" stroke="#a5ab94" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

export function createOnboarding(api) {
  const { host, header, icon } = api;
  let draft = loadDraft(api.getState());
  let stage = 'welcome';
  let phase = 'permissions';
  let active = false;
  let listenerController;
  let currentSheet;
  let epoch = 0;
  let submitting = false;
  let storageWarningShown = false;
  const timers = new Set();

  function persistDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
    catch {
      if (!storageWarningShown) api.toast('暂时无法保存体验进度，留在本页仍可继续。');
      storageWarningShown = true;
    }
  }
  function clearAsync() { epoch++; timers.forEach(clearTimeout); timers.clear(); }
  function later(callback, delay) {
    const ownEpoch = epoch, ownStage = stage;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!active || epoch !== ownEpoch || stage !== ownStage || location.hash !== ROUTES[ownStage]) return;
      callback();
    }, delay);
    timers.add(timer);
  }
  function closeSheet() { currentSheet?.close(); currentSheet = null; }
  function openSheet(config) { closeSheet(); currentSheet = api.openSheet(config); return currentSheet; }
  function go(next) {
    if (!ROUTES[next]) return;
    clearAsync(); closeSheet();
    if (location.hash === ROUTES[next]) show(next);
    else location.hash = ROUTES[next];
  }
  function nextConnectionPermission() { return !draft.bluetooth ? 'bluetooth' : !draft.localNetwork ? 'network' : null; }
  function ready() { return draft.photoAccess !== 'none' && !nextConnectionPermission(); }
  function progress() {
    const step = stage === 'welcome' ? 0 : 1;
    return `<ol class="flow-steps" aria-label="开始使用，第 ${step + 1} 步，共 2 步">${['授权照片', '连接照片墙'].map((name, i) => `<li class="${i === step ? 'is-current' : i < step ? 'is-done' : ''}"${i === step ? ' aria-current="step"' : ''}><span class="flow-step-number">${i + 1}</span><span>${name}</span></li>`).join('')}</ol>`;
  }
  function primary(label, action, disabled = false) { return `<button type="button" class="flow-primary" data-flow-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`; }
  function footer(button) { return `<footer class="flow-footer">${button}<p>Demo · 照片授权与设备连接均为模拟</p></footer>`; }
  function arrangementNote() {
    return api.getState().onboarding.completed ? '已保存的偏好和更新安排会继续保留。' : '先由我们自然安排，每天 20:00 更新。<br>偏好与更新时间，之后随时可以调整。';
  }
  function renderHeader() {
    header.innerHTML = stage === 'welcome'
      ? '<span class="flow-brand">echooo<span>®</span></span><button type="button" class="flow-demo-button" data-flow-action="info">演示说明</button>'
      : `<button type="button" class="header-action back" data-flow-action="back">${icon('chevron-left', 17)}<span>上一步</span></button><button type="button" class="flow-demo-button" data-flow-action="info">演示说明</button>`;
  }
  function renderWelcome() {
    const granted = draft.photoAccess !== 'none';
    host.innerHTML = `<div class="flow-shell flow-welcome"><div class="flow-scroll">${progress()}<div class="flow-welcome-art">${calendarArt()}</div><h1>让平常的日子，<br>有值得期待的回忆。</h1><p class="flow-lead">授权照片，连接照片墙。<br>不必一张张挑选，剩下的交给我们。</p><p class="flow-inline-note">${arrangementNote()}</p>${draft.permissionDenied === 'photo' ? '<p class="flow-inline-note flow-warning" role="status">还没有获得照片访问权限。你可以重新允许全部或部分照片。</p>' : ''}${granted ? `<button type="button" class="flow-access-link" data-flow-action="photo">${draft.photoAccess === 'limited' ? '已允许部分照片' : '已允许全部照片'} · 调整</button>` : ''}<details class="flow-preparation"><summary>连接前，需要准备什么${icon('chevron-right', 15)}</summary><ul><li>${icon('device', 17)}<span>一台已通电的照片墙</span></li><li>${icon('wifi', 17)}<span>家中的 2.4 GHz Wi-Fi</span></li></ul></details></div>${footer(primary(granted ? '继续连接照片墙' : '授权照片，开始使用', 'start'))}</div>`;
  }
  function askPermission(key) {
    if (!active || (key === 'photo' ? stage !== 'welcome' : stage !== 'device')) return;
    const config = {
      photo: { title: '允许访问照片？', body: '<p>从你允许的照片中整理回忆。你可以允许全部照片，也可以只允许部分照片。</p><p class="flow-sheet-note">模拟权限弹窗，不会读取真实相册。</p>', values: [{ label: '允许全部照片', value: 'all', primary: true }, { label: '仅允许部分照片', value: 'limited' }, { label: '暂不允许', value: 'none' }] },
      bluetooth: { title: '允许使用蓝牙？', body: '<p>用于发现你身边已通电的照片墙。</p><p class="flow-sheet-note">模拟权限弹窗，不会调用真实蓝牙。</p>', values: [{ label: '允许蓝牙', value: true, primary: true }, { label: '暂不允许', value: false }] },
      network: { title: '允许访问本地网络？', body: '<p>用于让 App 和照片墙在家中连接。</p><p class="flow-sheet-note">模拟权限弹窗，不会扫描真实网络。</p>', values: [{ label: '允许本地网络', value: true, primary: true }, { label: '暂不允许', value: false }] },
    }[key];
    if (!config) return;
    const ownEpoch = epoch, ownStage = stage;
    openSheet({ title: config.title, body: config.body, actions: config.values.map(choice => ({ label: choice.label, primary: choice.primary, onClick: () => {
      if (!active || ownEpoch !== epoch || stage !== ownStage) return;
      const field = { photo: 'photoAccess', bluetooth: 'bluetooth', network: 'localNetwork' }[key];
      draft[field] = choice.value;
      const denied = choice.value === false || choice.value === 'none';
      draft.permissionDenied = denied ? key : '';
      if (denied) draft.connected = false;
      closeSheet(); persistDraft();
      if (key === 'photo') { if (denied) renderWelcome(); else go('device'); }
      else if (denied) { phase = 'permissions'; renderDevice(); }
      else advanceDevice();
    } })) });
  }
  function renderDevice() {
    const permission = nextConnectionPermission();
    const permissionName = permission === 'bluetooth' ? '蓝牙' : '本地网络';
    const states = {
      permissions: { title: `允许${permissionName}，${permission === 'bluetooth' ? '发现照片墙' : '完成连接'}`, copy: permission === 'bluetooth' ? '让手机靠近已通电的照片墙。' : 'App 与照片墙需要在家中保持联系。', graphic: 'wifi', label: `允许${permissionName}`, action: 'permission' },
      searching: { title: '正在寻找照片墙', copy: '请让手机靠近设备，稍等一下。', graphic: 'wifi', label: '正在查找…', action: 'search', disabled: true },
      found: { title: '发现附近的照片墙', copy: 'Echooo · 示例设备 01<br>选择这台设备，为它连接家庭网络。', graphic: 'device', label: '连接这台照片墙', action: 'connect-device' },
      network: { title: '为照片墙连接 Wi-Fi', copy: '选择家中的 2.4 GHz 网络。', graphic: 'wifi', label: '选择家庭 Wi-Fi', action: 'choose-network' },
      connecting: { title: '正在连接家庭网络', copy: `${escapeHtml(draft.network)} · 示例网络<br>连接成功后，直接进入回忆日历。`, graphic: 'wifi', label: '正在连接…', action: 'choose-network', disabled: true },
      connected: { title: '连接成功', copy: `${escapeHtml(draft.deviceName)}已准备好。`, graphic: 'check', label: submitting ? '正在保存…' : '进入回忆日历', action: 'finish', disabled: submitting },
      'save-failed': { title: '已连接，设置还未保存', copy: '请重试保存，无需重新连接照片墙。', graphic: 'check', label: '重试保存', action: 'finish' },
      'not-found': { title: '暂时没有发现设备', copy: '确认照片墙已通电，让手机靠近后重试。', graphic: 'device', label: '重新查找', action: 'search' },
      failed: { title: '这次连接没有成功', copy: '检查家庭网络，再试一次。', graphic: 'wifi', label: '重新连接', action: 'choose-network' },
    };
    const current = states[phase];
    host.innerHTML = `<div class="flow-shell"><div class="flow-scroll">${progress()}<h1>连接你的<br>照片墙。</h1><p class="flow-lead">让手机靠近已通电的照片墙。<br>连好后，就可以开始了。</p><div class="flow-device-card" role="status"><span class="flow-device-symbol${['searching', 'connecting'].includes(phase) ? ' is-searching' : ''}${draft.connected ? ' is-connected' : ''}">${icon(current.graphic, 34)}</span><strong>${current.title}</strong><p>${current.copy}</p><span class="flow-simulation-pill">模拟设备状态</span></div>${draft.permissionDenied && phase === 'permissions' ? `<p class="flow-inline-note flow-warning" role="status">尚未允许${permissionName}，准备好后可再次允许。</p>` : ''}<p class="flow-inline-note">${arrangementNote()}</p><details class="flow-device-help"><summary>连接帮助${icon('chevron-right', 15)}</summary><p>确认照片墙已通电，手机靠近设备，家中网络可用。</p><div class="flow-help-actions"><button type="button" data-flow-action="demo-not-found">演示找不到设备</button><button type="button" data-flow-action="demo-failed">演示连接失败</button></div><p class="flow-sheet-note">只切换本地模拟状态。</p></details></div>${footer(primary(current.label, current.action, current.disabled))}</div>`;
  }
  function advanceDevice() {
    clearAsync();
    if (!active || stage !== 'device') return;
    if (draft.photoAccess === 'none') { go('welcome'); return; }
    const permission = nextConnectionPermission();
    if (permission) { phase = 'permissions'; renderDevice(); later(() => askPermission(permission), 100); }
    else if (draft.connected) { phase = 'connected'; renderDevice(); later(submit, 300); }
    else search();
  }
  function search() {
    if (!active || stage !== 'device' || ['searching', 'connecting'].includes(phase)) return;
    if (!ready()) { advanceDevice(); return; }
    clearAsync(); draft.connected = false; phase = 'searching'; persistDraft(); renderDevice();
    later(() => { phase = 'found'; renderDevice(); }, 550);
  }
  function connectDevice() {
    if (stage !== 'device' || phase !== 'found') return;
    phase = 'network'; renderDevice(); chooseNetwork();
  }
  function chooseNetwork() {
    if (stage !== 'device' || !['network', 'failed'].includes(phase)) return;
    if (!ready()) { advanceDevice(); return; }
    const ownEpoch = epoch;
    const sheet = openSheet({ title: '连接家庭 Wi-Fi', body: `<p>为照片墙选择一个 2.4 GHz 网络。</p><fieldset class="flow-network-list"><legend class="flow-sr-only">示例家庭网络</legend>${NETWORKS.map(network => `<label><span>${icon('wifi', 20)}<span>${network}<small>示例网络 · 2.4 GHz</small></span></span><input type="radio" name="flow-network" value="${network}"${draft.network === network ? ' checked' : ''}></label>`).join('')}</fieldset><p class="flow-sheet-note">使用已准备的示例凭证，无需填写真实 Wi-Fi 密码。</p>`, actions: [{ label: '连接并开始使用', primary: true, onClick: () => {
      if (!active || stage !== 'device' || epoch !== ownEpoch || !['network', 'failed'].includes(phase)) return;
      const network = sheet.dialog.querySelector('[name="flow-network"]:checked')?.value;
      if (!NETWORKS.includes(network)) { api.toast('请选择一个示例网络'); return; }
      draft.network = network; closeSheet(); connect();
    } }] });
  }
  function connect() {
    if (!active || stage !== 'device' || !ready() || !['network', 'failed'].includes(phase)) return;
    clearAsync(); phase = 'connecting'; draft.connected = false; persistDraft(); renderDevice();
    later(() => { draft.connected = true; phase = 'connected'; persistDraft(); renderDevice(); later(submit, 400); }, 900);
  }
  function submit() {
    if (!active || stage !== 'device' || submitting) return;
    if (!ready()) { advanceDevice(); return; }
    if (!draft.connected) { phase = 'permissions'; advanceDevice(); return; }
    clearAsync();
    submitting = true; phase = 'connected'; renderDevice();
    // Existing preferences and schedule remain owned by the app; onboarding only changes connection fields.
    const completed = api.onComplete({ settings: { connected: true, photoAccess: draft.photoAccess }, onboarding: { completed: true } });
    if (!completed) { submitting = false; phase = 'save-failed'; renderDevice(); return; }
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Main state was saved successfully. */ }
    clearAsync(); closeSheet();
  }
  function demoInfo() {
    openSheet({ title: '关于这次体验', body: '<p>只需授权照片、连接照片墙。偏好和更新时间可以之后再调整。</p><p>权限、设备发现与 Wi-Fi 均为本地模拟，不读取照片或操作真实设备。</p><p>完成后进入日历，已保存的偏好与更新时间保持不变。</p>' });
  }
  function back() { if (active && stage === 'device') go('welcome'); }
  function bind() {
    listenerController = new AbortController();
    const click = event => {
      if (!active) return;
      const target = event.target.closest('button');
      if (!target || target.disabled) return;
      const action = target.dataset.flowAction;
      if (action === 'start') { if (draft.photoAccess === 'none') askPermission('photo'); else go('device'); }
      else if (action === 'photo') askPermission('photo');
      else if (action === 'back') back();
      else if (action === 'info') demoInfo();
      else if (action === 'permission') askPermission(nextConnectionPermission());
      else if (action === 'search') search();
      else if (action === 'connect-device') connectDevice();
      else if (action === 'choose-network') chooseNetwork();
      else if (action === 'finish') submit();
      else if (['demo-not-found', 'demo-failed'].includes(action) && stage === 'device') {
        clearAsync(); closeSheet(); draft.connected = false;
        phase = action === 'demo-not-found' ? 'not-found' : 'failed'; persistDraft(); renderDevice();
      }
    };
    host.addEventListener('click', click, { signal: listenerController.signal });
    header.addEventListener('click', click, { signal: listenerController.signal });
  }
  function show(requested) {
    clearAsync(); closeSheet(); listenerController?.abort();
    active = true; submitting = false;
    draft.deviceName = freshDraft(api.getState()).deviceName;
    stage = requested === 'device' && draft.photoAccess !== 'none' ? 'device' : 'welcome';
    if (requested !== stage) { location.replace(ROUTES[stage]); return; }
    bind(); renderHeader(); host.scrollTop = 0;
    if (stage === 'welcome') renderWelcome();
    else { phase = 'permissions'; advanceDevice(); }
  }
  function reset() {
    clearAsync(); closeSheet(); draft = freshDraft(api.getState()); phase = 'permissions'; submitting = false; storageWarningShown = false;
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Fresh draft remains in memory. */ }
  }
  function destroy() { active = false; clearAsync(); closeSheet(); listenerController?.abort(); }
  return { show, back, reset, destroy };
}

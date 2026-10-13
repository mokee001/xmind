import { mountFirstWall, createFirstWallJourney, FIRST_WALL_SCENARIOS, DEMO_STALE_PERSON_ID } from './first-wall.js?v=0.3.10';
import { mountPanel, resetPreferenceDraft } from './panels.js?v=0.3.10';
import { createNetworkDemo, NETWORK_SCENARIOS, networkNotice } from './network.js?v=0.3.10';
import { createOnboarding } from './onboarding.js?v=0.3.10';

const STORAGE_KEY = 'echooo-calendar-demo-v1';
const DEFAULT = {
  preferences: { people: [], topics: [], timeRange: '全部已授权照片', memoryMix: '均衡' },
  settings: { deviceName: '客厅照片墙', connected: false, autoUpdate: true, updateFrequency: '每天', updateTime: '20:00', notifications: false, photoAccess: 'none' },
  onboarding: { completed: false, completedAt: null },
};
const screen = document.querySelector('#screen');
const header = document.querySelector('#app-header');
const dialog = document.querySelector('#sheet');
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const YEAR = TODAY.getFullYear();
const MONTH = TODAY.getMonth();
const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const clone = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = clone(DEFAULT);
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    state = { preferences: { ...DEFAULT.preferences, ...saved.preferences }, settings: { ...DEFAULT.settings, ...saved.settings }, onboarding: { ...DEFAULT.onboarding, ...saved.onboarding } };
    if (!saved.settings?.updateFrequency) state.settings.updateFrequency = state.settings.autoUpdate ? '每天' : '关闭';
  }
} catch { /* A corrupt or unavailable demo store starts with neutral defaults. */ }
let route = '';
let cleanupPanel = null;
let calendarPosition = null;
let calendarReady = false;
let firstMonth = -3;
let lastMonth = 3;
let onboarding;
let firstWallJourney;
let preferenceRecovery = null;
let previewSettingsBeforeOverlay = null;
let openDeviceOnMount = false;
let previewHistory = false;
const FLOW_STAGES = { welcome: 'welcome', 'setup-device': 'device' };
const LEGACY_FLOW_ROUTES = { setup: 'welcome', 'setup-permissions': 'welcome', 'setup-preferences': 'setup-device', 'setup-schedule': 'setup-device' };
let toastTimer;
let sheetController;
const requestedFirstWallScenario = new URLSearchParams(location.search).get('firstWall');
const networkScenario = new URLSearchParams(location.search).get('network');
const network = NETWORK_SCENARIOS.includes(networkScenario) ? createNetworkDemo({ scenario: networkScenario }) : null;
if (FIRST_WALL_SCENARIOS.includes(requestedFirstWallScenario)) document.querySelector('#first-wall-scenario').value = requestedFirstWallScenario;
// A direct recovery preview overlays connection/authorization in memory only.
if ((requestedFirstWallScenario === 'people' && location.hash === '#first-wall')
  || (network && ['#calendar', '#first-wall', '#settings'].includes(location.hash))) {
  previewSettingsBeforeOverlay = { ...state.settings };
  state = { ...state, settings: { ...state.settings, connected: true,
    photoAccess: ['all', 'limited'].includes(state.settings.photoAccess) ? state.settings.photoAccess : 'all' } };
}

function showFirstWallEvents(snapshot) {
  const element = document.querySelector('#first-wall-events');
  if (!element) return;
  const names = { local: '本地准备', upload: '首批上传', candidates: '服务候选', remaining: '其余上传', generation: '生成', publish: '投送', receipt: '回执', people: '人物偏好' };
  const labels = { started: '开始', ready: '就绪', failed: '模拟失败', retry: '仅重试本步', authorization: '照片授权', connected: '保存连接完成', paused: '离开后暂停', resumed: '继续已有任务', rechecked: '仍需重新确认', 'preferences-saved': '已保存，继续准备' };
  element.textContent = snapshot.events.slice(-7).map(event => `${names[event.stage] || ''}${labels[event.type]}${event.type === 'authorization' ? ` · ${event.stage}` : ''}`).join('\n') || '等待照片授权。';
  const summary = document.querySelector('#first-wall-coordination');
  const generated = snapshot.events.findIndex(event => event.type === 'started' && event.stage === 'generation');
  const remainder = snapshot.events.findIndex(event => event.type === 'ready' && event.stage === 'remaining');
  if (summary) summary.textContent = snapshot.work.receipt === 'ready'
    ? '这轮模拟：照片墙回执已到达，才继续其余上传。'
    : generated >= 0 && (remainder < 0 || generated < remainder)
    ? '这轮模拟：先生成首幅，其余上传在照片墙回执后继续。'
    : snapshot.work.local === 'ready' && !snapshot.connected
      ? '本地准备已在连接期间完成，稍后直接复用。'
      : '授权后即开始本地准备，与设备连接并行。尚未完成时会继续等待。';
}
function firstJourney() {
  if (!firstWallJourney) {
    firstWallJourney = createFirstWallJourney({ scenario: document.querySelector('#first-wall-scenario')?.value, network });
    firstWallJourney.subscribe(showFirstWallEvents);
  }
  return firstWallJourney;
}

const paths = {
  'chevron-left': '<path d="m14 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  sliders: '<path d="M4 7h9m5 0h2M4 17h2m5 0h9"/><circle cx="15" cy="7" r="2.5"/><circle cx="8.5" cy="17" r="2.5"/>',
  settings: '<path d="m10 3-.5 2.2-2 .9-2-.7-2 3.4L5 10.4v2.2l-1.5 1.6 2 3.4 2-.7 2 .9L10 20h4l.5-2.2 2-.9 2 .7 2-3.4-1.5-1.6v-2.2l1.5-1.6-2-3.4-2 .7-2-.9L14 3Z"/><circle cx="12" cy="11.5" r="3"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 4h.01M13 15h.01M9 18h.01"/>',
  wifi: '<path d="M3 8c5-5 13-5 18 0M6 12c3-3 9-3 12 0m-9 4c2-1.5 4-1.5 6 0M12 20h.01"/>',
  device: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 6h8v12H8Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 5v2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
  leaf: '<path d="M20 3C9 2 2 8 5 15c4 7 15 1 15-12ZM4 21 15 9"/>',
  paw: '<path d="M7 14c2-5 8-5 10 0 5 6 0 8-5 6-5 2-10 0-5-6Z"/><ellipse cx="5" cy="9" rx="2" ry="2.5"/><ellipse cx="10" cy="5" rx="2" ry="2.5"/><ellipse cx="16" cy="5.5" rx="2" ry="2.5"/><ellipse cx="20" cy="10" rx="2" ry="2.5"/>',
  mountain: '<path d="m2 20 7-14 5 9 3-6 5 11ZM6 12l3 2 3-2"/><circle cx="17" cy="4" r="1.5"/>',
  coffee: '<path d="M4 8h13v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Zm13 1h2a3 3 0 0 1 0 6h-2M8 3v2m5-2v2"/>',
  music: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="18" cy="16" rx="3" ry="2.5"/>',
  frame: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M7 7h10v10H7Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
};
function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
}
function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}
function updateState(patch) {
  const next = { preferences: { ...state.preferences, ...patch.preferences }, settings: { ...state.settings, ...patch.settings }, onboarding: { ...state.onboarding, ...patch.onboarding } };
  const stored = previewSettingsBeforeOverlay
    ? { ...next, settings: { ...previewSettingsBeforeOverlay, ...patch.settings } } : next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); }
  catch { return false; }
  if (previewSettingsBeforeOverlay) previewSettingsBeforeOverlay = stored.settings;
  state = next;
  renderHeader();
  return true;
}
function openSheet({ title, body, actions = [] }) {
  sheetController?.abort();
  sheetController = new AbortController();
  const controller = sheetController;
  const restoreFocus = document.activeElement;
  const close = () => { if (dialog.open && sheetController === controller) dialog.close(); };
  dialog.innerHTML = `<div class="sheet-top"><h2 id="sheet-title">${escapeHtml(title)}</h2><button class="sheet-close" aria-label="关闭">${icon('close', 18)}</button></div><div class="sheet-body">${body}</div>${actions.length ? `<div class="sheet-actions">${actions.map((action, i) => `<button class="${action.primary ? 'primary-button' : 'secondary-button'}"${action.hidden ? ' hidden' : ''} data-sheet-action="${i}">${escapeHtml(action.label)}</button>`).join('')}</div>` : ''}`;
  dialog.addEventListener('click', event => {
    if (event.target.closest('.sheet-close')) close();
    const button = event.target.closest('[data-sheet-action]');
    if (button && !button.disabled && !button.hidden) actions[Number(button.dataset.sheetAction)]?.onClick?.();
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    }
  }, { signal: controller.signal });
  dialog.addEventListener('close', () => {
    if (dialog.open || sheetController !== controller) return;
    controller.abort();
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }, { signal: controller.signal });
  if (!dialog.open) dialog.showModal();
  return { dialog, close, signal: controller.signal, isCurrent: () => dialog.open && sheetController === controller };
}
function manageDevice() {
  openDeviceOnMount = true;
  if (route === 'settings') renderRoute();
  else navigate('settings');
}
async function checkNetwork(signal) {
  const result = await network.check({ signal });
  if (result.canceled) return result;
  if (result.ok) {
    network.readHistory();
    if (result.deviceOnline && route === 'first-wall'
      && ['service-unreachable', 'device-offline'].includes(firstWallJourney?.snapshot().failure)) firstWallJourney.retry();
  }
  return result;
}
function networkHelp() {
  if (!network) { connectionSheet(); return; }
  const current = network.snapshot(), notice = networkNotice(current);
  async function runCheck() {
    const button = view.dialog.querySelector('[data-sheet-action="0"]');
    if (!view.isCurrent() || button.disabled) return;
    button.disabled = true; button.textContent = '正在检查…';
    view.dialog.querySelector('[data-network-result]').textContent = '正在检查，请稍候。';
    const result = await checkNetwork(view.signal);
    if (!view.isCurrent() || result.canceled) return;
    button.disabled = false; button.textContent = '重新检查';
    view.dialog.querySelector('[data-network-result]').textContent = result.ok
      ? result.deviceOnline ? '连接正常 · 模拟结果。正在重新读取记录。' : '手机可以访问服务，但照片墙离线。请检查屏幕电源和 Wi-Fi，或在设备管理中重新连接。'
      : '暂时无法访问服务。请检查手机网络；也可以进入设备管理重新连接。';
  }
  const view = openSheet({ title: '检查连接',
    body: `<p><strong data-network-label>${escapeHtml(notice.label)}</strong> · 本地模拟</p><p data-network-copy>${escapeHtml(notice.copy)}</p><p data-network-result role="status">正在检查，请稍候。</p>`,
    actions: [{ label: '重新检查', primary: true, onClick: runCheck }, { label: '管理设备', onClick: () => { view.close(); manageDevice(); } },
    { label: 'Demo：模拟恢复连接', onClick: () => {
      network.recover();
      view.dialog.querySelector('[data-network-result]').textContent = '已切换为模拟网络恢复。请点“重新检查”，这不会伪造屏幕回执。';
    } }],
  });
  const unsubscribe = network.subscribe(value => {
    if (!view.isCurrent()) return;
    const next = networkNotice(value);
    view.dialog.querySelector('[data-network-label]').textContent = next.label;
    view.dialog.querySelector('[data-network-copy]').textContent = next.copy;
  });
  view.signal.addEventListener('abort', unsubscribe, { once: true });
  runCheck();
}
function reconnectNetworkDevice() {
  if (!network) return;
  onboarding.beginReconnect();
  if (route === 'setup-device') renderRoute();
  else navigate('setup-device');
}
function confirmLocalRemoval() {
  if (!network || network.snapshot().removed) return;
  const view = openSheet({ title: '仅从此手机移除？',
    body: '<p>云端绑定尚未解除，此操作不会清除照片墙上的连接设置。只从当前手机移除设备，然后重新查找并连接。</p><p>偏好和照片保留。接下来需要让照片墙进入蓝牙配网模式。</p><p class="flow-sheet-note">本地 Demo 模拟，不操作真实手机绑定或硬件。</p>',
    actions: [{ label: '仅从此手机移除并重新连接', primary: true, onClick: () => {
      const result = network.removeLocal({ confirmed: true });
      if (result.ok) { view.close(); reconnectNetworkDevice(); }
    } }, { label: '取消', onClick: () => view.close() }],
  });
}
function removeNetworkDevice() {
  if (!network || network.snapshot().removed) return;
  const view = openSheet({ title: '移除这台照片墙？',
    body: '<p>由服务确认移除绑定后，才会从设备列表中移除。屏幕清除连接设置需要下一次联网同步。</p><p data-remove-result role="status">这是本地模拟，不会删除真实设备或照片；偏好会保留。</p>',
    actions: [{ label: '确认移除', primary: true, onClick: async () => {
      const button = view.dialog.querySelector('[data-sheet-action="0"]');
      button.disabled = true; button.textContent = '正在确认移除…';
      const result = await network.remove({ confirmed: true, signal: view.signal });
      if (!view.isCurrent() || result.canceled) return;
      if (!result.ok) {
        button.disabled = false; button.textContent = '重新确认移除';
        view.dialog.querySelector('[data-remove-result]').textContent = '云端尚未确认移除，设备绑定和偏好已保留。可以重试，或仅从此手机移除后重新连接。';
        view.dialog.querySelector('[data-sheet-action="1"]').hidden = false;
        return;
      }
      openSheet({ title: '设备已移除', body: '<p>模拟服务已确认移除。屏幕恢复联网后同步清除连接设置。</p><p>原有偏好与展示记录保留。本次没有操作真实设备。</p>',
        actions: [{ label: '返回日历', primary: true, onClick: () => { dialog.close(); navigate('calendar'); } }],
      });
    } }, { label: '仅从此手机移除并重新连接', hidden: true, onClick: confirmLocalRemoval },
    { label: '取消', onClick: () => view.close() }],
  });
}
function connectionSheet() {
  if (network) { networkHelp(); return; }
  const s = state.settings;
  openSheet({ title: s.deviceName || '客厅照片墙', body: `<p><span class="connection-dot"></span> <strong>${s.connected ? '已连接' : '未连接'} · 模拟状态</strong></p><p>${s.connected ? '这版 Demo 用来体验日历与页面导航。' : '连接恢复后，照片墙会继续按偏好更新。'}</p><p>设备、账户与更新时间，都在日历右上角的「设置」里。</p><p style="font-size:10px;margin-top:16px;color:#a0a292">此状态来自本地示例，未连接真实设备。</p>` });
}
function renderHeader() {
  if (FLOW_STAGES[route]) return;
  if (route === 'calendar') {
    const networkState = network?.snapshot();
    const label = networkState ? networkNotice(networkState).label : state.settings.connected ? '已连接' : '未连接';
    const online = networkState ? networkState.service && networkState.device && !networkState.removed : state.settings.connected;
    header.innerHTML = `<button class="header-action status-pill${online ? '' : ' offline'}" data-action="connection" aria-label="连接状态：${label}，示例"><i></i>${label}<small>示例</small></button><div class="header-entries"><button class="header-action preference-entry" data-route="preferences" aria-label="偏好">${icon('sliders', 19)}<span>偏好</span></button><button class="header-action icon-button" data-route="settings" aria-label="设置" title="设置">${icon('settings', 19)}</button></div>`;
  } else if (route === 'preferences') {
    header.innerHTML = `<button class="header-action back" data-route="${preferenceRecovery ? 'first-wall' : 'calendar'}" aria-label="${preferenceRecovery ? '返回首次准备' : '返回日历'}">${icon('chevron-left', 18)}<span>${preferenceRecovery ? '返回' : '日历'}</span></button>`;
  } else if (route === 'settings') {
    header.innerHTML = `<button class="header-action back" data-route="calendar" aria-label="返回日历">${icon('chevron-left', 18)}<span>日历</span></button><span class="header-title">ECHOoo</span><span class="header-side"></span>`;
  }
}

// Date tiles are illustrations for a UI demo, never inferred photo metadata.
function illustration(kind) {
  const art = [
    '<rect width="120" height="100" fill="#e9e8da"/><circle cx="82" cy="25" r="10" fill="#c0ab73"/><path d="m0 76 42-42 35 27 18-15 25 30v24H0Z" fill="#9dada0"/><path d="m0 89 35-28 28 20 31-14 26 23v10H0Z" fill="#667d72"/><path d="m42 34 10 10-13-2-11 6Z" fill="#ecebe0"/>',
    '<rect width="120" height="100" fill="#eddfcf"/><ellipse cx="61" cy="80" rx="36" ry="5" fill="#d0bba2"/><path d="M36 36h45v26c0 24-45 24-45 0Z" fill="#af795d"/><path d="M81 42h8c18 0 18 22-8 22" fill="none" stroke="#af795d" stroke-width="7"/><path d="M48 13c-8 7 8 11 0 17m18-19c-8 7 8 11 0 17" fill="none" stroke="#c5b49e" stroke-width="2" stroke-linecap="round"/>',
    '<rect width="120" height="100" fill="#dbe4e0"/><circle cx="87" cy="27" r="12" fill="#d7c898"/><path d="M0 58q25-11 50 0t70 0v42H0" fill="#99b0aa"/><path d="M0 73q25-11 50 0t70 0" fill="none" stroke="#ecede0" stroke-width="2"/><path d="M0 88q25-11 50 0t70 0" fill="none" stroke="#7a9891" stroke-width="3"/>',
    '<rect width="120" height="100" fill="#e8e6d8"/><path d="M60 87 65 23" stroke="#859372" stroke-width="2"/><path d="M64 53C24 44 25 13 64 53Z" fill="#a0ad89"/><path d="M62 67C26 68 28 38 62 67Z" fill="#87966f"/><path d="M64 46C98 51 102 19 64 46Z" fill="#798d73"/><path d="M65 31C45 14 50 2 65 31Z" fill="#b0b58d"/><path d="M44 74h33l-3 25H48Z" fill="#c4b99f"/>',
    '<rect width="120" height="100" fill="#e6e2dc"/><path d="m38 33-8-20 22 10m19 1 21-11-7 22" fill="#b3a89b"/><ellipse cx="61" cy="51" rx="30" ry="30" fill="#c7bcad"/><path d="m49 44 1 1m23-1 1 1" stroke="#645d56" stroke-width="4" stroke-linecap="round"/><path d="m58 55 4 3 4-3m-4 3v5m-7 0q7 7 14 0M34 54l-17-3m17 11-17 4m72-12 17-3m-17 11 17 4" fill="none" stroke="#84796d" stroke-width="1.5"/><ellipse cx="60" cy="92" rx="37" ry="10" fill="#d5ccbc"/>',
  ][kind % 5];
  return `<svg viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${art}</svg>`;
}
const monthDate = offset => new Date(YEAR, MONTH + offset, 1);
function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function exampleFor(date) {
  if (state.onboarding.completed && !previewHistory) return null;
  if (date >= TODAY) return null;
  const ageMonths = (YEAR - date.getFullYear()) * 12 + MONTH - date.getMonth();
  if (ageMonths > 3 || ageMonths < 0) return null;
  if (![2, 5, 8, 11, 13, 17, 21, 24, 28].includes(date.getDate())) return null;
  const kind = (date.getDate() + date.getMonth()) % 5;
  return { kind, title: ['有山的日子', '一杯暖暖的日常', '去看一看海', '一点绿色的陪伴', '毛孩子的慢时光'][kind] };
}
function monthHtml(offset) {
  const month = monthDate(offset);
  const year = month.getFullYear();
  const m = month.getMonth();
  const total = new Date(year, m + 1, 0).getDate();
  const blank = (month.getDay() + 6) % 7;
  let count = 0;
  let cells = '<span aria-hidden="true"></span>'.repeat(blank);
  for (let day = 1; day <= total; day++) {
    const date = new Date(year, m, day);
    const example = exampleFor(date);
    const today = date.getTime() === TODAY.getTime();
    const future = date > TODAY;
    if (example) count++;
    cells += `<button class="day${today ? ' today' : ''}${future ? ' future' : ''}${example ? ' historical' : ''}" data-date="${dateKey(date)}" aria-label="${year}年${m + 1}月${day}日${today ? '，今天' : ''}${example ? '，查看示例记录' : future ? '，尚未到来' : '，暂无记录'}"${today ? ' aria-current="date"' : ''}><span class="day-number">${day}</span>${example ? `<span class="day-art">${illustration(example.kind)}</span>` : !today && !future ? '<span class="day-empty-marker" aria-hidden="true"></span>' : ''}</button>`;
  }
  const fresh = state.onboarding.completed && !previewHistory;
  return `<section class="month-section" data-month-offset="${offset}" aria-label="${year}年${m + 1}月"><div class="month-header"><div class="month-name"><h2>${MONTHS[m]}</h2><span>${year}</span></div><span class="month-meta">${offset > 0 ? '留一点期待' : fresh ? '' : `${count} 天 · 示例记录`}</span></div>${fresh && offset === 0 && (!network || network.snapshot().history === 'ready') ? `<div class="calendar-first-use">${icon('leaf', 20)}<div><strong>回忆，会从今天开始。</strong><p>照片墙展示过的内容，会留在对应的日子里。<br>第一次相遇，留给生活中的惊喜。</p></div></div>` : ''}<div class="month-grid">${cells}</div>${offset > 0 ? '<div class="month-empty">下一段日常，会慢慢来到。</div>' : ''}</section>`;
}
function scrollToCurrent(behavior = 'auto') {
  const section = screen.querySelector('[data-month-offset="0"]');
  if (!section) return;
  const heroHeight = screen.querySelector('.calendar-hero').offsetHeight;
  const weekdaysHeight = screen.querySelector('.calendar-weekdays').offsetHeight;
  screen.style.setProperty('--calendar-heading-height', `${heroHeight}px`);
  screen.scrollTo({ top: section.getBoundingClientRect().top - screen.getBoundingClientRect().top + screen.scrollTop - heroHeight - weekdaysHeight, behavior });
}
function renderCalendar() {
  screen.innerHTML = `<div class="calendar-hero"><div><span class="eyebrow">THE DAYS WE KEEP</span><h1>回忆日历</h1><p>回看已经展示的日子，留住不经意的美好。</p></div><button class="today-button" data-action="today" aria-label="回到本月今天">${icon('calendar', 13)}今天</button></div><div class="calendar-weekdays" aria-label="星期"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-months"><button class="calendar-edge top" data-action="earlier">${icon('arrow-up', 12)}更早的日子</button><div id="months">${Array.from({ length: lastMonth - firstMonth + 1 }, (_, i) => monthHtml(firstMonth + i)).join('')}</div><button class="calendar-edge" data-action="later">再往后看看 ${icon('chevron-right', 12)}</button></div><div class="calendar-hint"><span class="hint-line"></span>只回看已展示内容，未来保持留白<span class="hint-line"></span></div><p class="calendar-bottom-note">${state.onboarding.completed && !previewHistory ? '连接、选片与展示记录均为本地模拟；当前还没有真实展示回执。' : '日期标记与插画均为示例，不是设备展示回执。'}</p>`;
  const networkState = network?.snapshot();
  const unfinished = firstWallJourney && !firstWallJourney.snapshot().destroyed
    && firstWallJourney.snapshot().work.receipt !== 'ready' && !networkState?.removed;
  if (networkState || unfinished) {
    const notice = networkState ? networkNotice(networkState) : { title: '首次准备尚未完成', copy: '已完成的准备会保留。可以继续查看日历、偏好或设备设置。' };
    screen.querySelector('.calendar-hero').insertAdjacentHTML('beforeend', `<section class="calendar-recovery" aria-live="polite"><strong>${escapeHtml(notice.title)}</strong><p>${escapeHtml(notice.copy)}</p>${networkState ? `<small>${networkState.history === 'loading' ? '正在读取记录，仍可使用偏好与设置' : networkState.history === 'error' ? '读取未完成，不代表没有展示记录' : networkState.history === 'ready' ? '示例记录已读取 · 不代表新的上屏回执' : '本地网络情境模拟'}</small>` : ''}<div>${networkState && !networkState.removed ? '<button data-action="check-network">检查连接</button>' : ''}<button data-action="manage-device">设备设置</button>${unfinished ? '<button data-action="resume-first-wall">继续首次准备</button>' : ''}</div></section>`);
  }
  requestAnimationFrame(() => {
    if (route !== 'calendar') return;
    screen.style.setProperty('--calendar-heading-height', `${screen.querySelector('.calendar-hero').offsetHeight}px`);
    if (calendarPosition === null) scrollToCurrent();
    else screen.scrollTo({ top: calendarPosition, behavior: 'instant' });
    calendarReady = true;
  });
}
function showDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const example = exampleFor(date);
  const today = date.getTime() === TODAY.getTime();
  const future = date > TODAY;
  openSheet({ title: `${month}月${day}日`, body: example
    ? `<div class="memory-art">${illustration(example.kind)}</div><p class="memory-caption"><strong>${example.title}</strong>示例展示记录 · 插画示意</p><p style="font-size:10px;text-align:center;margin-top:18px">这里只回看已经发生的展示，不提前揭晓未来内容。</p>`
    : `<div class="detail-empty">${icon(future ? 'sun' : 'calendar', 30)}<strong>${future ? '这一天，留一点期待。' : today ? '今天的回忆，慢慢来。' : '这天还没有展示记录。'}</strong><p>${future ? '未来的内容，会在展示后记在这里。' : today ? '照片墙展示完成后，会在日历留下记录。' : '不需要补上每一天，美好的日常自有节奏。'}</p></div>` });
}

function navigate(name) {
  if (!['calendar', 'preferences', 'settings', 'first-wall', ...Object.keys(FLOW_STAGES)].includes(name)) name = 'welcome';
  if (name === route) return;
  location.hash = name;
}
function renderRoute() {
  const requested = location.hash.slice(1);
  const next = LEGACY_FLOW_ROUTES[requested] || requested;
  if (next !== requested) history.replaceState(null, '', `#${next}`);
  const target = ['calendar', 'preferences', 'settings', 'first-wall', ...Object.keys(FLOW_STAGES)].includes(next) ? next : state.onboarding.completed ? 'calendar' : 'welcome';
  if (target === 'first-wall' && network?.snapshot().removed) { location.replace('#calendar'); return; }
  if (target === 'first-wall' && (!state.settings.connected || !['all', 'limited'].includes(state.settings.photoAccess))) {
    location.replace('#welcome'); return;
  }
  if (route === 'calendar') calendarPosition = screen.scrollTop;
  cleanupPanel?.();
  cleanupPanel = null;
  onboarding?.destroy();
  if (target === 'first-wall' || FLOW_STAGES[target] || firstWallJourney?.snapshot().work.receipt === 'ready') firstWallJourney?.resume();
  else firstWallJourney?.pause();
  if (dialog.open) dialog.close();
  route = target;
  renderHeader();
  screen.style.scrollBehavior = 'auto';
  screen.scrollTop = 0;
  screen.classList.remove('screen-arrive');
  if (route === 'calendar') {
    calendarReady = false;
    renderCalendar();
    if (network?.snapshot().history === 'idle') network.readHistory();
  }
  else if (route === 'first-wall') {
    const journey = firstJourney();
    journey.authorize(state.settings.photoAccess); journey.connect();
    if (network?.snapshot().service && network?.snapshot().device
      && ['service-unreachable', 'device-offline'].includes(journey.snapshot().failure)) journey.retry();
    cleanupPanel = mountFirstWall({ host: screen, header, journey, onDone: () => navigate('calendar'),
      onCalendar: () => navigate('calendar'), onManageDevice: manageDevice, onCheckNetwork: networkHelp,
      onAdjustPeople: () => {
        if (journey.snapshot().failure !== 'people') return;
        if (preferenceRecovery?.key !== journey) preferenceRecovery = { key: journey, stalePeople: [DEMO_STALE_PERSON_ID], availablePeople: [] };
        navigate('preferences');
      },
    });
  }
  else if (FLOW_STAGES[route]) onboarding.show(FLOW_STAGES[route]);
  else cleanupPanel = mountPanel(screen, route, {
    icon,
    navigate,
    getState: () => clone(state),
    updateState,
    toast,
    openSheet,
    restartOnboarding,
    network,
    networkHelp,
    removeNetworkDevice,
    reconnectNetworkDevice,
    openDeviceOnMount,
    preferenceRecovery,
    onPreferencesSaved: () => {
      if (preferenceRecovery?.key !== firstWallJourney) return;
      if (!firstWallJourney.confirmPeoplePreferences(state.preferences.people)) return;
      preferenceRecovery = null;
      navigate('first-wall');
    },
  });
  openDeviceOnMount = false;
  document.querySelectorAll('[data-level]').forEach(el => el.classList.toggle('active', el.dataset.level === route));
  document.title = `${route === 'calendar' ? '日历' : route === 'preferences' ? '偏好' : route === 'settings' ? '设置' : route === 'welcome' ? '欢迎' : '首次设置'} · Echooo`;
  requestAnimationFrame(() => screen.classList.add('screen-arrive'));
}
function restartOnboarding() {
  firstWallJourney?.destroy(); firstWallJourney = null;
  preferenceRecovery = null;
  if (previewSettingsBeforeOverlay) { state = { ...state, settings: previewSettingsBeforeOverlay }; previewSettingsBeforeOverlay = null; }
  onboarding.reset();
  if (route === 'welcome') renderRoute();
  else navigate('welcome');
}
function completeOnboarding(result) {
  const settings = { ...state.settings, ...result.settings };
  if (!settings.connected || !['all', 'limited'].includes(settings.photoAccess)) {
    toast('请先完成照片授权与设备连接');
    return false;
  }
  if (!['每天', '每周', '关闭'].includes(settings.updateFrequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.updateTime)) {
    toast('请确认更新频次与时间');
    return false;
  }
  if (network && onboarding.isRecovery()) {
    if (!network.completeReconnect({ confirmed: true })) return false;
    network.readHistory();
    state = { ...state, settings, onboarding: { ...state.onboarding, completed: true } };
  } else if (!updateState({ ...result, onboarding: { completed: true, completedAt: new Date().toISOString() } })) {
    toast('暂时无法保存，请保留此页面后重试');
    return false;
  }
  resetPreferenceDraft();
  firstJourney().connect();
  previewHistory = false;
  calendarPosition = null;
  navigate('first-wall');
  return true;
}
header.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || FLOW_STAGES[route]) return;
  if (target.dataset.route) navigate(target.dataset.route);
  else if (target.dataset.action === 'connection') connectionSheet();
});
screen.addEventListener('click', event => {
  if (route !== 'calendar') return;
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.date) showDay(button.dataset.date);
  if (button.dataset.action === 'check-network') networkHelp();
  if (button.dataset.action === 'manage-device') manageDevice();
  if (button.dataset.action === 'resume-first-wall') navigate('first-wall');
  if (button.dataset.action === 'today') scrollToCurrent(matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');
  if (button.dataset.action === 'earlier') {
    const start = screen.scrollHeight;
    const position = screen.scrollTop;
    screen.querySelector('#months').insertAdjacentHTML('afterbegin', monthHtml(--firstMonth));
    screen.scrollTop = position + screen.scrollHeight - start;
    toast('向上滑动，查看更多月份');
  }
  if (button.dataset.action === 'later') screen.querySelector('#months').insertAdjacentHTML('beforeend', monthHtml(++lastMonth));
});
onboarding = createOnboarding({ host: screen, header, icon, openSheet, toast, getState: () => clone(state), onComplete: completeOnboarding,
  onPhotoAccess: access => firstJourney().authorize(access),
  getRecoveryNetwork: () => network?.snapshot(),
  onRecoveryServiceRestored: () => network?.restoreService(),
  onRecoveryExit: () => navigate('settings'),
});
document.querySelector('#experience-setup').addEventListener('click', restartOnboarding);
document.querySelector('#experience-calendar').addEventListener('click', () => {
  previewHistory = true;
  calendarPosition = null;
  if (route === 'calendar') renderCalendar();
  else navigate('calendar');
});
window.addEventListener('hashchange', renderRoute);
window.addEventListener('resize', () => {
  if (route === 'calendar') screen.style.setProperty('--calendar-heading-height', `${screen.querySelector('.calendar-hero').offsetHeight}px`);
});
if (network) {
  const journey = firstJourney(); journey.authorize(state.settings.photoAccess); journey.connect(); journey.pause();
  network.subscribe(value => {
    if (value.removed && firstWallJourney) { firstWallJourney.destroy(); firstWallJourney = null; }
    renderHeader();
    if (route === 'calendar') { if (calendarReady) calendarPosition = screen.scrollTop; renderCalendar(); }
    const bound = screen.querySelector('[data-bound-device]');
    const removed = screen.querySelector('[data-device-removed]');
    if (bound) bound.hidden = value.removed;
    if (removed) removed.hidden = !value.removed;
  });
}
renderRoute();

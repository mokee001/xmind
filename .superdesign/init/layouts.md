# Layouts and shared shell

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

## AppPreviewShell
`demos/calendar-app/index.html` provides the desktop-only presentation wrapper, central phone, status bar, app header, scroll host, home indicator, toast and native dialog. The target is the mobile app viewport; desktop explanatory columns are not part of the homepage design alternatives.
No image/font/logo files are imported. Desktop wordmark is live text; do not add new logo placement on the mobile calendar header.

### `demos/calendar-app/index.html`

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#faf9f6">
  <title>Echooo · 日历版 Demo</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="panels.css">
  <link rel="stylesheet" href="onboarding.css">
</head>
<body>
  <div class="preview-layout">
    <aside class="preview-guide">
      <a class="wordmark" href="#calendar" aria-label="Echooo 日历主页">echooo<span>®</span></a>
      <div class="guide-story"><span class="eyebrow">ANOTHER WAY TO REMEMBER</span><h1>日子向前，<br>回忆留在这里。</h1><p>从日历开始。<br>让偏好与设置，各归其位。</p></div>
      <div class="structure" aria-label="日历首页直接进入同级的偏好和设置"><span data-level="calendar" class="active">日历</span><span class="structure-line"></span><span><span data-level="preferences">偏好</span> / <span data-level="settings">设置</span></span></div>
      <div class="demo-info"><span class="demo-label">完整体验 DEMO · B v0.2</span><p>从第一次打开，到日历里的每一天。<br>授权、连接与人物均为本地模拟。</p><button id="experience-setup" class="text-link">从新用户流程体验 <span aria-hidden="true">↗</span></button><button id="experience-calendar" class="text-link">查看示例日历 <span aria-hidden="true">↗</span></button><a class="old-preview" href="http://127.0.0.1:8094/" target="_blank" rel="noopener">打开原版对照 ↗</a></div>
    </aside>
    <section class="phone" aria-label="日历版 App 预览">
      <div class="phone-status" aria-hidden="true"><span id="status-time">9:41</span><span class="dynamic-island"></span><span class="status-symbols">▮▮▮ <svg width="15" height="12" viewBox="0 0 20 16"><path d="M2 5q8-7 16 0M5 9q5-4 10 0M8 13q2-2 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><i></i></span></div>
      <header id="app-header" class="app-header"></header>
      <main id="screen" tabindex="-1"></main>
      <div class="home-indicator" aria-hidden="true"></div>
      <div id="toast" role="status" aria-live="polite"></div>
    </section>
    <aside class="preview-note"><span class="small-rule"></span><span class="eyebrow">A LITTLE SETUP.<br>A LOT TO REMEMBER.</span><p>授权准备 → 连接设备<br>选择偏好 → 设置更新<br>完成后，日历从这里开始</p><div class="note-detail">首页左上 · 连接状态常驻<br>首页右上 · 偏好 / 设置<br>偏好与设置 · 都返回日历</div></aside>
  </div>
  <dialog id="sheet" aria-labelledby="sheet-title"></dialog>
  <script type="module" src="app.js"></script>
</body>
</html>

```

## AppController / AppHeader / CalendarHome
`demos/calendar-app/app.js` is the full shared controller, including route-based header, dialog helpers and homepage calendar. It imports two leaf modules (`panels.js`, `onboarding.js`) and injects helpers into them. This full file is included once here because there is no separate layout/router file. The routes inventory points here instead of duplicating it.
Homepage invariant: always-visible top-left connection indicator; peer top-right preferences and gear settings; vertical month calendar; no tabs; only past displayed memories; future dates blank. SVG tiles and connected state are explicitly local examples.

### `demos/calendar-app/app.js`

```javascript
import { mountPanel, preferenceChoices, resetPreferenceDraft } from './panels.js';
import { createOnboarding } from './onboarding.js';

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
let firstMonth = -3;
let lastMonth = 3;
let onboarding;
let previewHistory = false;
const FLOW_STAGES = { welcome: 'welcome', 'setup-permissions': 'permissions', 'setup-device': 'device', 'setup-preferences': 'preferences', 'setup-schedule': 'schedule' };
let toastTimer;
let sheetController;

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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch { return false; }
  state = next;
  renderHeader();
  return true;
}
function openSheet({ title, body, actions = [] }) {
  if (dialog.open) dialog.close();
  sheetController?.abort();
  sheetController = new AbortController();
  const controller = sheetController;
  const restoreFocus = document.activeElement;
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.innerHTML = `<div class="sheet-top"><h2 id="sheet-title">${escapeHtml(title)}</h2><button class="sheet-close" aria-label="关闭">${icon('close', 18)}</button></div><div class="sheet-body">${body}</div>${actions.length ? `<div class="sheet-actions">${actions.map((action, i) => `<button class="${action.primary ? 'primary-button' : 'secondary-button'}" data-sheet-action="${i}">${escapeHtml(action.label)}</button>`).join('')}</div>` : ''}`;
  dialog.addEventListener('click', event => {
    if (event.target.closest('.sheet-close')) close();
    const button = event.target.closest('[data-sheet-action]');
    if (button) actions[Number(button.dataset.sheetAction)]?.onClick?.();
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    }
  }, { signal: controller.signal });
  dialog.addEventListener('close', () => {
    controller.abort();
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }, { once: true, signal: controller.signal });
  dialog.showModal();
  return { dialog, close };
}
function connectionSheet() {
  const s = state.settings;
  openSheet({ title: s.deviceName || '客厅照片墙', body: `<p><span class="connection-dot"></span> <strong>${s.connected ? '已连接' : '未连接'} · 模拟状态</strong></p><p>${s.connected ? '这版 Demo 用来体验日历与页面导航。' : '连接恢复后，照片墙会继续按偏好更新。'}</p><p>设备、账户与更新时间，都在日历右上角的「设置」里。</p><p style="font-size:10px;margin-top:16px;color:#a0a292">此状态来自本地示例，未连接真实设备。</p>` });
}
function renderHeader() {
  if (FLOW_STAGES[route]) return;
  if (route === 'calendar') {
    header.innerHTML = `<button class="header-action status-pill${state.settings.connected ? '' : ' offline'}" data-action="connection" aria-label="连接状态：${state.settings.connected ? '已连接' : '未连接'}，示例"><i></i>${state.settings.connected ? '已连接' : '未连接'}<small>示例</small></button><div class="header-entries"><button class="header-action preference-entry" data-route="preferences" aria-label="偏好">${icon('sliders', 19)}<span>偏好</span></button><button class="header-action icon-button" data-route="settings" aria-label="设置" title="设置">${icon('settings', 19)}</button></div>`;
  } else if (route === 'preferences') {
    header.innerHTML = `<button class="header-action back" data-route="calendar" aria-label="返回日历">${icon('chevron-left', 18)}<span>日历</span></button>`;
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
  return `<section class="month-section" data-month-offset="${offset}" aria-label="${year}年${m + 1}月"><div class="month-header"><div class="month-name"><h2>${MONTHS[m]}</h2><span>${year}</span></div><span class="month-meta">${offset > 0 ? '留一点期待' : fresh ? '' : `${count} 天 · 示例记录`}</span></div>${fresh && offset === 0 ? `<div class="calendar-first-use">${icon('leaf', 20)}<div><strong>回忆，会从今天开始。</strong><p>照片墙展示过的内容，会留在对应的日子里。<br>第一次相遇，留给生活中的惊喜。</p></div></div>` : ''}<div class="month-grid">${cells}</div>${offset > 0 ? '<div class="month-empty">下一段日常，会慢慢来到。</div>' : ''}</section>`;
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
  screen.innerHTML = `<div class="calendar-hero"><div><span class="eyebrow">THE DAYS WE KEEP</span><h1>回忆日历</h1><p>回看已经展示的日子，留住不经意的美好。</p></div><button class="today-button" data-action="today" aria-label="回到本月今天">${icon('calendar', 13)}今天</button></div><div class="calendar-weekdays" aria-label="星期"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-months"><button class="calendar-edge top" data-action="earlier">${icon('arrow-up', 12)}更早的日子</button><div id="months">${Array.from({ length: lastMonth - firstMonth + 1 }, (_, i) => monthHtml(firstMonth + i)).join('')}</div><button class="calendar-edge" data-action="later">再往后看看 ${icon('chevron-right', 12)}</button></div><div class="calendar-hint"><span class="hint-line"></span>只回看已展示内容，未来保持留白<span class="hint-line"></span></div><p class="calendar-bottom-note">${state.onboarding.completed && !previewHistory ? '连接状态为本地模拟；当前还没有真实展示记录。' : '日期标记与插画均为示例，不是设备展示回执。'}</p>`;
  requestAnimationFrame(() => {
    if (route !== 'calendar') return;
    screen.style.setProperty('--calendar-heading-height', `${screen.querySelector('.calendar-hero').offsetHeight}px`);
    if (calendarPosition === null) scrollToCurrent();
    else screen.scrollTo({ top: calendarPosition, behavior: 'instant' });
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
  if (!['calendar', 'preferences', 'settings', ...Object.keys(FLOW_STAGES)].includes(name)) name = 'welcome';
  if (name === route) return;
  location.hash = name;
}
function renderRoute() {
  const next = location.hash.slice(1);
  const target = next === 'setup' ? 'welcome' : ['calendar', 'preferences', 'settings', ...Object.keys(FLOW_STAGES)].includes(next) ? next : state.onboarding.completed ? 'calendar' : 'welcome';
  if (route === 'calendar') calendarPosition = screen.scrollTop;
  cleanupPanel?.();
  cleanupPanel = null;
  onboarding?.destroy();
  if (dialog.open) dialog.close();
  route = target;
  renderHeader();
  screen.style.scrollBehavior = 'auto';
  screen.scrollTop = 0;
  screen.classList.remove('screen-arrive');
  if (route === 'calendar') renderCalendar();
  else if (FLOW_STAGES[route]) onboarding.show(FLOW_STAGES[route]);
  else cleanupPanel = mountPanel(screen, route, { icon, navigate, getState: () => clone(state), updateState, toast, openSheet, restartOnboarding });
  document.querySelectorAll('[data-level]').forEach(el => el.classList.toggle('active', el.dataset.level === route));
  document.title = `${route === 'calendar' ? '日历' : route === 'preferences' ? '偏好' : route === 'settings' ? '设置' : route === 'welcome' ? '欢迎' : '首次设置'} · Echooo`;
  requestAnimationFrame(() => screen.classList.add('screen-arrive'));
}
function restartOnboarding() {
  onboarding.reset();
  if (route === 'welcome') renderRoute();
  else navigate('welcome');
}
function completeOnboarding(result) {
  const settings = result.settings || {};
  if (!settings.connected || !['all', 'limited'].includes(settings.photoAccess)) {
    toast('请先完成照片授权与设备连接');
    return false;
  }
  if (!['每天', '每周', '关闭'].includes(settings.updateFrequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.updateTime)) {
    toast('请确认更新频次与时间');
    return false;
  }
  if (!updateState({ ...result, onboarding: { completed: true, completedAt: new Date().toISOString() } })) {
    toast('暂时无法保存，请保留此页面后重试');
    return false;
  }
  resetPreferenceDraft();
  previewHistory = false;
  calendarPosition = null;
  navigate('calendar');
  toast('设置已保存，欢迎来到回忆日历');
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
onboarding = createOnboarding({ host: screen, header, icon, openSheet, toast, getState: () => clone(state), onComplete: completeOnboarding, preferenceChoices, goCalendar: () => {
  previewHistory = true;
  calendarPosition = null;
  navigate('calendar');
} });
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
renderRoute();

```


const PEOPLE = [
  { id: 'person-1', name: '人物 1', style: 0 },
  { id: 'person-2', name: '人物 2', style: 1 },
  { id: 'person-3', name: '人物 3', style: 2 },
  { id: 'person-4', name: '人物 4', style: 3 },
  { id: 'person-5', name: '人物 5', style: 4 },
  { id: 'person-6', name: '人物 6', style: 5 },
];

const TOPICS = [
  { id: 'pets', label: '毛孩子', icon: 'paw' },
  { id: 'trips', label: '出去玩的照片', icon: 'sun' },
  { id: 'food', label: '吃到的好东西', icon: 'coffee' },
  { id: 'nature', label: '山海与风景', icon: 'mountain' },
  { id: 'shows', label: '看过的演出', icon: 'music' },
  { id: 'exhibitions', label: '逛过的展览', icon: 'frame' },
];

const MIXES = ['多些新照片', '均衡', '多些旧回忆'];
const RANGES = ['全部已授权照片', '最近一年', '最近三年'];
// Keep an unsaved edit session across in-app navigation, never across reloads.
let pendingPreferences = null;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function portrait(style) {
  const hair = [
    'M23 35c-2-22 35-24 35 0M24 28c9 2 17-3 20-8 2 6 7 9 13 10',
    'M22 53V32c0-22 37-22 37 0v22M23 29c8-1 15-5 18-11 3 6 9 10 17 11',
    'M23 35c-8-5-4-16 3-16 2-8 11-10 17-5 8-4 16 3 15 10 5 4 4 10 0 13',
    'M23 36c-4-17 3-26 17-26s22 8 18 26M24 28c10-1 18-7 22-13 2 8 6 12 11 14',
    'M23 35c-3-21 38-24 35 0M23 25c12 3 19-6 23-9l8 12',
    'M23 38c-6-19 2-27 17-27 16 0 23 10 18 28M24 25c6 1 13-2 19-8 3 5 9 8 14 9',
  ][style];
  return `<svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M13 79c1-16 9-22 21-24m12 0c12 2 20 9 21 24" fill="currentColor" fill-opacity=".07"/><g stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M24 32v7c0 12 7 19 16 19s17-8 17-19v-7M34 57v7m12-7v7M13 79c1-15 9-20 21-22m12 0c12 2 20 7 21 22"/><path d="${hair}"/><path d="M32 37h1m14 0h1M40 38l-1 7h3m-7 5c3 2 7 2 10-1"/>${style === 2 || style === 4 ? '<rect x="27" y="33" width="11" height="9" rx="3"/><rect x="43" y="33" width="11" height="9" rx="3"/><path d="M38 36h5"/>' : ''}</g></svg>`;
}

export const preferenceChoices = { people: PEOPLE, topics: TOPICS, portrait };
export function resetPreferenceDraft() { pendingPreferences = null; }

function normalPreferences(state) {
  const current = state.preferences || {};
  return {
    ...current,
    people: Array.isArray(current.people) ? [...current.people] : [],
    topics: Array.isArray(current.topics) ? [...current.topics] : [],
    timeRange: current.timeRange || RANGES[0],
    memoryMix: current.memoryMix || '均衡',
  };
}

function scheduleFrequency(settings) {
  return ['每天', '每周', '关闭'].includes(settings.updateFrequency)
    ? settings.updateFrequency
    : settings.autoUpdate ? '每天' : '关闭';
}

function scheduleSummary(settings) {
  const frequency = scheduleFrequency(settings);
  if (frequency === '关闭') return '已关闭';
  return `${frequency === '每周' ? '每周日' : '每天'} ${settings.updateTime || '20:00'}`;
}

export function mountPanel(host, name, api) {
  let editing = name === 'preferences' && !!pendingPreferences;
  let draft = normalPreferences(pendingPreferences ? { preferences: pendingPreferences } : api.getState());
  const controller = new AbortController();
  let activeSheet = null;

  const sheet = (config) => {
    activeSheet?.close();
    activeSheet = api.openSheet(config);
    return activeSheet;
  };
  const closeSheet = () => { activeSheet?.close(); activeSheet = null; };
  const save = (patch, message) => {
    if (!api.updateState(patch)) {
      api.toast('暂时无法保存，请保留此页面后重试。');
      return false;
    }
    if (message) api.toast(message);
    return true;
  };
  const check = (selected) => `<span class="panel-choice-mark${selected ? ' panel-choice-mark-selected' : ''}" aria-hidden="true">${selected ? api.icon('check', 12) : ''}</span>`;
  function preferences() {
    const prefs = editing ? draft : normalPreferences(api.getState());
    host.innerHTML = `<div class="panel panel-preferences${editing ? ' panel-is-editing' : ''}">
      <header class="panel-title-row"><h1>偏好</h1><button type="button" class="panel-manage${editing ? ' panel-manage-save' : ''}" data-panel-action="manage">${editing ? '保存' : '管理偏好'}</button></header>
      <p class="panel-intro">让日常里，多一些你在意的。</p>
      <section class="panel-section" aria-labelledby="panel-people-title">
        <div class="panel-section-title"><h2 id="panel-people-title">想多看到谁</h2><span class="panel-example">示例人物</span></div>
        <p class="panel-description">默认所有人都可出现，也可以选出想多看到的人。</p>
        <div class="panel-people">${PEOPLE.map((person) => {
          const selected = prefs.people.includes(person.id);
          const content = `<span class="panel-avatar panel-avatar-${person.style}${selected ? ' panel-avatar-selected' : ''}">${portrait(person.style)}${editing ? check(selected) : ''}</span><span class="panel-person-name">${person.name}</span>${!editing && selected ? '<span class="panel-person-note">多些出现</span>' : ''}`;
          return editing
            ? `<button class="panel-person" type="button" data-panel-action="person" data-value="${person.id}" aria-label="多展示${person.name}" aria-pressed="${selected}">${content}</button>`
            : `<div class="panel-person">${content}</div>`;
        }).join('')}</div>
      </section>
      <section class="panel-section" aria-labelledby="panel-topics-title">
        <h2 id="panel-topics-title">想多看到什么</h2>
        <p class="panel-description">喜欢的内容，多留一些位置。</p>
        <div class="panel-topics">${TOPICS.map((topic) => {
          const selected = prefs.topics.includes(topic.id);
          const content = `<span class="panel-topic-icon">${api.icon(topic.icon, 21)}</span><span>${topic.label}</span>${editing ? check(selected) : ''}`;
          const attributes = `class="panel-topic${selected ? ' panel-topic-selected' : ''}"`;
          return editing
            ? `<button type="button" ${attributes} data-panel-action="topic" data-value="${topic.id}" aria-pressed="${selected}">${content}</button>`
            : `<div ${attributes}>${content}</div>`;
        }).join('')}</div>
      </section>
      <section class="panel-section panel-last-section" aria-labelledby="panel-mix-title">
        <h2 id="panel-mix-title">新照片与旧回忆</h2>
        <p class="panel-description">在最近的生活和过去的时光之间。</p>
        ${editing ? `<div class="panel-mix" role="group" aria-label="新照片与旧回忆的比例">${MIXES.map((mix) => `<button type="button" data-panel-action="mix" data-value="${mix}" class="panel-mix-option${prefs.memoryMix === mix ? ' panel-mix-selected' : ''}" aria-pressed="${prefs.memoryMix === mix}">${mix}</button>`).join('')}</div>` : `<div class="panel-read-value">${escapeHtml(prefs.memoryMix)}<span>当前偏好</span></div>`}
      </section>
      <p class="panel-footnote">此 Demo 使用示例人物，偏好仅保存在本机。</p>
    </div>`;
  }

  function row({ action, icon, title, value = '', detail = '', trailing = '' }) {
    return `<button type="button" class="panel-setting-row" data-panel-action="${action}"><span class="panel-row-icon">${api.icon(icon, 21)}</span><span class="panel-row-copy"><span class="panel-row-title">${title}</span>${detail ? `<span class="panel-row-detail">${detail}</span>` : ''}</span>${trailing || `<span class="panel-row-value">${escapeHtml(value)}</span>${api.icon('chevron-right', 16)}`}</button>`;
  }

  function settings() {
    const state = api.getState();
    const device = state.settings || {};
    const prefs = normalPreferences(state);
    host.innerHTML = `<div class="panel panel-settings">
      <header class="panel-title-row"><h1>设置</h1></header>
      <p class="panel-intro">照顾好连接，剩下的交给时光。</p>
      <section class="panel-setting-section" aria-labelledby="panel-device-heading"><h2 id="panel-device-heading">我的设备</h2><div class="panel-settings-group">
        ${row({ action: 'device', icon: 'device', title: escapeHtml(device.deviceName || '客厅照片墙'), detail: `<span class="panel-status-dot${device.connected ? ' panel-status-online' : ''}"></span>${device.connected ? '已连接' : '未连接'} · 模拟状态` })}
        ${row({ action: 'schedule', icon: 'clock', title: '更新时间', value: scheduleSummary(device) })}
      </div></section>
      <section class="panel-setting-section" aria-labelledby="panel-account-heading"><h2 id="panel-account-heading">账户与照片</h2><div class="panel-settings-group">
        ${row({ action: 'account', icon: 'user', title: '我的账户', value: device.accountName || '体验账户' })}
        ${row({ action: 'sharing', icon: 'users', title: '共同使用', value: '仅自己' })}
        ${row({ action: 'range', icon: 'image', title: '照片访问范围', detail: escapeHtml(prefs.timeRange) })}
      </div></section>
      <section class="panel-setting-section" aria-labelledby="panel-other-heading"><h2 id="panel-other-heading">其他</h2><div class="panel-settings-group">
        <button type="button" class="panel-setting-row" data-panel-action="notifications" role="switch" aria-checked="${!!device.notifications}" aria-label="更新提醒"><span class="panel-row-icon">${api.icon('bell', 21)}</span><span class="panel-row-copy"><span class="panel-row-title">更新提醒</span></span><span class="panel-switch${device.notifications ? ' panel-switch-on' : ''}" aria-hidden="true"></span></button>
      </div></section>
      <div class="panel-demo-note">${api.icon('leaf', 17)}<p>独立体验 Demo<br><span>这里的设置仅影响本地预览，不连接真实设备。</span></p></div>
      <button type="button" class="panel-manage" data-panel-action="restart-onboarding">重新体验新用户流程</button>
      <p class="panel-footnote">只重新打开本地引导，不删除已保存的偏好。</p>
    </div>`;
  }

  function openDevice() {
    const current = api.getState().settings || {};
    const photoAccess = {
      all: '已模拟允许访问全部照片',
      limited: '已模拟允许访问部分照片，仅使用授权范围',
      none: '尚未模拟允许照片访问',
    }[current.photoAccess] || '尚未模拟允许照片访问';
    const view = sheet({
      title: '我的设备',
      body: `<div class="panel-sheet-form"><label class="panel-field">设备名称<input name="deviceName" type="text" maxlength="24" autocomplete="off" value="${escapeHtml(current.deviceName || '客厅照片墙')}"></label><label class="panel-field-inline"><span>模拟设备已连接</span><input name="connected" type="checkbox" ${current.connected ? 'checked' : ''}></label><p class="panel-description">切换后，日历左上角的连接状态会同步变化。</p><div class="panel-field"><span>照片授权</span><p class="panel-description">${photoAccess}。此处仅显示 Demo 状态，不读取照片或更改系统权限。</p></div></div>`,
      actions: [{ label: '保存', primary: true, onClick: () => {
        const name = view.dialog.querySelector('[name="deviceName"]').value.trim();
        if (!name) { api.toast('请填写设备名称。'); return; }
        const connected = view.dialog.querySelector('[name="connected"]').checked;
        if (save({ settings: { ...api.getState().settings, deviceName: name, connected } }, '设备设置已保存')) { closeSheet(); settings(); }
      } }],
    });
  }

  function openSchedule() {
    const current = api.getState().settings || {};
    const frequency = scheduleFrequency(current);
    const view = sheet({
      title: '更新时间',
      body: `<div class="panel-sheet-form"><fieldset class="panel-radio-list"><legend class="panel-visually-hidden">更新频次</legend>${['每天', '每周', '关闭'].map((option) => `<label class="panel-radio-row"><span>${option === '每周' ? '每周日' : option}</span><input name="updateFrequency" type="radio" value="${option}" ${frequency === option ? 'checked' : ''}></label>`).join('')}</fieldset><label class="panel-field"><span data-schedule-time-label>${frequency === '每周' ? '每周日更新时间' : '更新时间'}</span><input name="updateTime" type="time" value="${escapeHtml(current.updateTime || '20:00')}" ${frequency === '关闭' ? 'disabled' : ''}></label><p class="panel-description">每周更新固定在周日；关闭后保留已设置的时间。此设置仅保存为体验偏好，不会调度真实设备。</p></div>`,
      actions: [{ label: '保存', primary: true, onClick: () => {
        const updateFrequency = view.dialog.querySelector('[name="updateFrequency"]:checked')?.value;
        if (!['每天', '每周', '关闭'].includes(updateFrequency)) { api.toast('请选择更新频次。'); return; }
        const value = view.dialog.querySelector('[name="updateTime"]').value;
        const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
        if (updateFrequency !== '关闭' && !validTime) { api.toast('请选择有效的更新时间。'); return; }
        const updateTime = validTime ? value : current.updateTime || '20:00';
        if (save({ settings: { ...api.getState().settings, updateFrequency, updateTime, autoUpdate: updateFrequency !== '关闭' } }, '更新时间已保存')) { closeSheet(); settings(); }
      } }],
    });
    view.dialog.addEventListener('change', (event) => {
      if (event.target.name !== 'updateFrequency') return;
      const selected = event.target.value;
      view.dialog.querySelector('[name="updateTime"]').disabled = selected === '关闭';
      view.dialog.querySelector('[data-schedule-time-label]').textContent = selected === '每周' ? '每周日更新时间' : '更新时间';
    }, { signal: controller.signal });
  }

  function openRange() {
    const current = normalPreferences(api.getState());
    const view = sheet({
      title: '照片访问范围',
      body: `<div class="panel-sheet-form"><p class="panel-description">用时间划定范围，无需逐个挑选相簿。</p><fieldset class="panel-radio-list"><legend class="panel-visually-hidden">照片时间范围</legend>${RANGES.map((range) => `<label class="panel-radio-row"><span>${range}</span><input type="radio" name="timeRange" value="${range}" ${current.timeRange === range ? 'checked' : ''}></label>`).join('')}</fieldset><p class="panel-description">仅保存此 Demo 的范围选择，不会读取照片或修改系统授权。</p></div>`,
      actions: [{ label: '保存', primary: true, onClick: () => {
        const timeRange = view.dialog.querySelector('[name="timeRange"]:checked')?.value;
        if (!RANGES.includes(timeRange)) { api.toast('请选择照片范围。'); return; }
        if (save({ preferences: { ...normalPreferences(api.getState()), timeRange } }, '照片范围已保存')) { closeSheet(); settings(); }
      } }],
    });
  }

  function openAccount() {
    const current = api.getState().settings || {};
    const view = sheet({
      title: '我的账户',
      body: `<div class="panel-sheet-form"><label class="panel-field">称呼<input name="accountName" type="text" maxlength="20" autocomplete="nickname" value="${escapeHtml(current.accountName || '体验账户')}"></label><p class="panel-description">此处为体验账户，未登录真实账号。</p></div>`,
      actions: [{ label: '保存', primary: true, onClick: () => {
        const accountName = view.dialog.querySelector('[name="accountName"]').value.trim();
        if (!accountName) { api.toast('请填写称呼。'); return; }
        if (save({ settings: { ...api.getState().settings, accountName } }, '称呼已保存')) { closeSheet(); settings(); }
      } }],
    });
  }

  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-panel-action]');
    if (!button || !host.contains(button)) return;
    const action = button.dataset.panelAction;
    if (action === 'manage') {
      if (!editing) { draft = normalPreferences(api.getState()); editing = true; pendingPreferences = draft; }
      else {
        const current = normalPreferences(api.getState());
        if (!save({ preferences: { ...current, people: draft.people, topics: draft.topics, memoryMix: draft.memoryMix } }, '偏好已保存')) return;
        editing = false;
        pendingPreferences = null;
      }
      preferences();
      host.querySelector('[data-panel-action="manage"]')?.focus({ preventScroll: true });
    } else if (editing && (action === 'person' || action === 'topic')) {
      const key = action === 'person' ? 'people' : 'topics';
      const value = button.dataset.value;
      draft[key] = draft[key].includes(value) ? draft[key].filter((item) => item !== value) : [...draft[key], value];
      pendingPreferences = draft;
      preferences();
      host.querySelector(`[data-panel-action="${action}"][data-value="${value}"]`)?.focus({ preventScroll: true });
    } else if (editing && action === 'mix') {
      draft.memoryMix = button.dataset.value;
      pendingPreferences = draft;
      preferences();
      host.querySelector(`[data-panel-action="mix"][data-value="${draft.memoryMix}"]`)?.focus({ preventScroll: true });
    } else if (action === 'device') openDevice();
    else if (action === 'restart-onboarding') { closeSheet(); api.restartOnboarding?.(); }
    else if (action === 'schedule') openSchedule();
    else if (action === 'range') openRange();
    else if (action === 'account') openAccount();
    else if (action === 'sharing') sheet({ title: '共同使用', body: '<div class="panel-sheet-form"><p class="panel-sheet-empty-title">此刻，由你一人管理</p><p class="panel-description">正式版本可在这里邀请家人共同使用。这次 Demo 仅展示入口，不会发出邀请。</p></div>', actions: [{ label: '知道了', primary: true, onClick: closeSheet }] });
    else if (action === 'notifications') {
      const current = api.getState().settings || {};
      if (save({ settings: { ...current, notifications: !current.notifications } }, current.notifications ? '已关闭体验提醒' : '已保存提醒偏好（本地模拟）')) settings();
    }
  }, { signal: controller.signal });

  if (name === 'preferences') preferences();
  else settings();
  return () => { controller.abort(); closeSheet(); };
}

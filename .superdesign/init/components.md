# Shared UI primitives

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

## Framework and boundaries
- Framework: none; browser ES modules and template-string DOM rendering.
- Meta-framework/component library: none. No target-local package.json, build config, third-party imports or aliases.
- Styling: vanilla CSS; three linked stylesheets. SVG icons and sample art are code-native.
- Shared primitives are functions within modules, not independently importable React components. The full shell/host source is in `layouts.md`; full CSS is in `theme.md`.
- Do not supply the whole discovery set to generation. Homepage is `renderCalendar`, `renderHeader`, `monthHtml`, and calendar styles; panels/onboarding are unrelated redesign targets.

## Icon
Source: `demos/calendar-app/app.js` — fixed line-icon dictionary and SVG renderer shared through the injected API.
Key arguments: `name`, `size = 20`; dictionary keys and SVG paths are hardcoded.

```javascript
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

```

## Toast
Source: `demos/calendar-app/app.js` — accessible status toast in the persistent shell.
Key argument: `message`; uses the shell #toast element and a module timer.

```javascript
function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}

```

## ModalSheet
Source: `demos/calendar-app/app.js` — native dialog with heading, close, action list, backdrop close and focus restoration.
Key arguments: title, body, actions (label/primary/onClick). Depends on `dialog`, `sheetController`, `escapeHtml`, `icon` in the module; full context is in layouts.md.

```javascript
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

```

## Portrait
Source: `demos/calendar-app/panels.js` — inline illustrative portrait used in preferences and onboarding; no real person data.
Key argument: style (0–5). Out of homepage visual scope.

```javascript
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


```

## SettingsRow
Source: `demos/calendar-app/panels.js` — reusable setting row inside mountPanel.
Arguments: action, icon, title, value, detail, trailing; depends on injected api.icon and escapeHtml. Out of homepage visual scope.

```javascript
  function row({ action, icon, title, value = '', detail = '', trailing = '' }) {
    return `<button type="button" class="panel-setting-row" data-panel-action="${action}"><span class="panel-row-icon">${api.icon(icon, 21)}</span><span class="panel-row-copy"><span class="panel-row-title">${title}</span>${detail ? `<span class="panel-row-detail">${detail}</span>` : ''}</span>${trailing || `<span class="panel-row-value">${escapeHtml(value)}</span>${api.icon('chevron-right', 16)}`}</button>`;
  }


```

## CSS primitives
`.primary-button`, `.secondary-button`, `.header-action`, `.icon-button`, `.status-pill`, `.sheet-close` live in style.css, fully copied in theme.md. No duplicate source dump here.

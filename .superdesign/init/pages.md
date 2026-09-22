# Page dependency trees

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

## Shared complete runtime dependency graph

Entry: `demos/calendar-app/index.html`
Dependencies (all local imports/linked CSS traced recursively; module imports are eager):
```text
demos/calendar-app/index.html
├── demos/calendar-app/style.css              (leaf; globals, shell, home, dialog)
├── demos/calendar-app/panels.css             (leaf; preferences/settings)
├── demos/calendar-app/onboarding.css         (leaf; landing + four-step flow)
└── demos/calendar-app/app.js                 (shared controller and homepage)
    ├── demos/calendar-app/panels.js          (leaf; no imports)
    └── demos/calendar-app/onboarding.js      (leaf; no imports)
```
No CSS @imports, URL-based assets, alias imports or node_modules dependencies. Inline SVG art lives in JS. README and archival outputs are not runtime imports.

## /#calendar
Renderer: `app.js renderCalendar → monthHtml / illustration / showDay`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: app.js home/header/helpers; style.css homepage, shell and shared dialog rules; index.html phone host.

## /#preferences
Renderer: `panels.js mountPanel → preferences`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: panels.js preferences/portrait; panels.css; app.js injected helpers; style.css globals/shell.

## /#settings
Renderer: `panels.js mountPanel → settings`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: panels.js settings/row/dialog forms; panels.css; app.js injected helpers; style.css globals/shell.

## /#welcome
Renderer: `onboarding.js renderWelcome`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: onboarding.js welcome/calendarArt; onboarding.css; app.js injected helpers; style.css globals/shell.

## /#setup-permissions
Renderer: `onboarding.js renderPermissions`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: onboarding.js permission cards and permission sheet; onboarding.css; app.js shared dialog.

## /#setup-device
Renderer: `onboarding.js renderDevice`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: onboarding.js simulated phases and network sheet; onboarding.css; app.js shared dialog.

## /#setup-preferences
Renderer: `onboarding.js renderPreferences`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: onboarding.js choices; panels.js preferenceChoices/portrait via app.js; onboarding.css.

## /#setup-schedule
Renderer: `onboarding.js renderSchedule`.
All routes share the complete eager dependency graph above; no lazy route import. Target-specific visual subset: onboarding.js schedule; onboarding.css; app.js saved-state completion callback.

## Payload recommendation for current task
Use only the homepage source slice (renderHeader, illustration, monthHtml, renderCalendar), the compact theme summary and current screenshot as context. The full app.js source is already in layouts.md, but sending its unrelated state/onboarding logic is unnecessary for static visual proposals. Do not send preferences/settings/onboarding modules or all raw CSS simply because they are eagerly imported.

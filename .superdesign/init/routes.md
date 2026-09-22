# Route map

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

Routing is inline hash routing in `demos/calendar-app/app.js`, not a separate config file. The complete router source (including FLOW_STAGES, navigate, renderRoute, listeners) is copied in layouts.md, in the full app.js block.

| URL | Renderer/source | Layout | Description |
| --- | --- | --- | --- |
| `/` | app.js renderRoute | index.html shared phone shell | First run → welcome; completed onboarding → calendar |
| `/#calendar` | app.js renderCalendar / monthHtml | shared app header + #screen | Current month anchored, vertically continuous months, today action, past example details |
| `/#preferences` | panels.js mountPanel → preferences | same shell; calendar back link | Read-only saved choices, manage/save editing mode |
| `/#settings` | panels.js mountPanel → settings | same shell; calendar back link | Device/account/range/update settings and onboarding replay |
| `/#welcome` | onboarding.js createOnboarding → renderWelcome | same shell, welcome header | Existing new-user landing, out of this proposal scope |
| `/#setup-permissions` | onboarding.js renderPermissions | same shell + four-step progress | Simulated photos/Bluetooth/local network permissions |
| `/#setup-device` | onboarding.js renderDevice | same shell + four-step progress | Simulated find/confirm/Wi-Fi/connect flow with retry |
| `/#setup-preferences` | onboarding.js renderPreferences | same shell + four-step progress | Optional people/topic preferences |
| `/#setup-schedule` | onboarding.js renderSchedule | same shell + four-step progress | Daily/weekly/off frequency and update time |
| `/#setup` | app.js renderRoute alias | welcome shell | Legacy alias to #welcome |

Target preview origin: `http://127.0.0.1:8095/`. No backend calls. Module state is localStorage/sessionStorage, kept outside any generated proposal. All non-calendar routes are discovery context only and must not be restyled by this task.

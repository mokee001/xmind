# Theme

## Part 1 — Compact actual-token summary

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

- Current direction (reference baseline, not required to preserve for alternatives): restrained paper/olive diary with Chinese serif hierarchy and small inline illustration tiles.
- Color roles: `--ink #262725`; `--muted #85857e`; `--line #e8e6df`; `--paper #faf9f6`; `--accent #7a8068`; `--white #fff`; desktop background `#eeede9`; focus outline `#8b936e`; online dot `#879270`; offline `#aaa59b`. No dark theme/provider exists.
- Body: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", sans-serif`. Heading token `--serif: "Songti SC", "STSong", serif`. No imported webfonts.
- Mobile heading scale: main calendar h1 31px / 1.4, 500; month 26px / normal, 500; day 12px; body 11–13px; eyebrow/meta 9–10px. Normal app header 12–13px. Panel heading 31px, onboarding 29–31px (out of scope).
- Layout: phone width 414px; desktop height min(852px, 100dvh - 60px). Mobile ≤780px full viewport, max-width 480px. App header 64px; fake status 45px desktop/42px mobile + safe inset. Calendar side padding 20px (grid), 27px (hero); header 24px.
- Calendar grid: 7 equal columns; Monday first; 2px column and 7px row gap; day cell min-height68px; numeric disk 26px; art35×31px. Section spacing: month header27px top/21px bottom; month bottom26px. Today filled ink disk, future muted. Weekdays and hero sticky.
- Spacing clusters: 4/7/8/9/12/15/18/20/24/26/27/32px. No formal spacing token scale exists.
- Radius roles: art6px; date cell11px; buttons13px; cards14–17px; native sheet25px; today24px/pill; icon button50%; phone43px. No uniform card wrapping for each day.
- Shadows: phone `0 28px 75px #25231810, 0 0 0 6px #fff8`; native sheet `0 20px 90px #20251835`; miniature art `0 1px 2px #34332009`.
- Responsive: desktop aside reduced at1170px; phone-only at780px; short desktop at720px viewport height; panels/onboarding reduce at360px. Reduced motion disables animation, transition, smooth scroll.
- Assets: no photos, external image requests, fonts or logo files. Five inline SVG illustrations (mountains/coffee/sea/plant/cat) are sample calendar markers. Line SVG icon helper has 1.5px strokes. No production device receipts or personal identities represented.
- Scope guard: vary only homepage tokens/typography/calendar visual treatment. Keep same content and calendar semantics across alternatives. Preferences/settings remain peers; no tab bar, no future-content previews.

## Part 2 — Complete raw CSS sources
The CSS is copied verbatim for discovery. For generation, pass the compact summary above and the necessary homepage selectors rather than all three stylesheets. No Tailwind config, theme provider or token JS file exists for this isolated Demo.

### `demos/calendar-app/style.css`

```css
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;color:#262725;background:#eeede9;font-synthesis:none;--ink:#262725;--muted:#85857e;--line:#e8e6df;--paper:#faf9f6;--accent:#7a8068;--white:#fff;--serif:"Songti SC","STSong",serif}*{box-sizing:border-box}body{margin:0}button,a,input,select{font:inherit}button{color:inherit;cursor:pointer}button:disabled{cursor:default}a{color:inherit;text-decoration:none}button{border:0;background:none}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #8b936e;outline-offset:4px}button,a{-webkit-tap-highlight-color:transparent}svg{display:inline-block;flex-shrink:0;vertical-align:middle}h1,h2,h3,p{margin:0}button,input,select{touch-action:manipulation}input,select{accent-color:var(--ink)}.preview-layout{max-width:1320px;min-height:100dvh;margin:auto;display:grid;grid-template-columns:270px 414px 200px;align-items:center;justify-content:center;gap:55px;padding:30px}.preview-guide{align-self:center}.wordmark{font-size:35px;letter-spacing:-2px;font-weight:600}.wordmark span{display:inline-block;font-size:10px;vertical-align:top;padding-top:7px;letter-spacing:0;margin-left:5px}.guide-story{margin-top:68px}.eyebrow{font-size:9px;letter-spacing:1.8px;line-height:1.8;color:#93958b}.guide-story h1{font-family:var(--serif);font-size:34px;font-weight:500;line-height:1.7;margin:18px 0 19px;letter-spacing:1px}.guide-story p{font-size:13px;line-height:1.95;color:var(--muted)}.structure{display:flex;align-items:center;gap:11px;font-size:12px;color:#aaa99f;margin-top:38px}.structure span[data-level]{transition:color .2s}.structure span.active{color:#363a2d}.structure-line{width:22px;height:1px;background:#d7d6cb}.demo-info{margin-top:64px;border-top:1px solid #dcdad1;padding-top:22px}.demo-label{font-size:9px;letter-spacing:1.7px;color:#74776a}.demo-info p{font-size:10px;line-height:1.9;color:#8c8c81;margin:11px 0 17px}.text-link,.old-preview{display:block;padding:9px 0;font-size:11px;line-height:1.5;color:#606454}.old-preview{color:#8a8c80}.text-link span{margin-left:5px}.phone{width:414px;height:min(852px,calc(100dvh - 60px));min-height:650px;display:flex;flex-direction:column;background:var(--paper);border-radius:43px;border:1px solid #d7d5cc;box-shadow:0 28px 75px #25231810,0 0 0 6px #fff8;overflow:hidden;position:relative}.phone-status{height:45px;min-height:45px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;position:relative}.dynamic-island{width:87px;height:24px;border-radius:20px;background:#282923;position:absolute;top:9px;left:calc(50% - 43.5px)}.status-symbols{display:flex;align-items:center;gap:5px;font-size:8px;letter-spacing:-1px}.status-symbols i{display:block;width:20px;height:10px;border:1px solid #777b71;border-radius:3px;position:relative}.status-symbols i:before{content:"";position:absolute;inset:1.5px;background:#33372e;border-radius:1px}.status-symbols i:after{content:"";position:absolute;right:-3px;top:2px;width:1px;height:4px;background:#777b71}.app-header{height:64px;min-height:64px;padding:8px 24px 11px;display:flex;justify-content:space-between;align-items:center;gap:12px;z-index:4;background:var(--paper)}.header-action{min-height:42px;display:flex;align-items:center;gap:7px;padding:0 2px;font-size:13px;white-space:nowrap}.header-action.back{font-size:12px;color:#6e7166}.header-action.icon-button{width:42px;justify-content:center;border:1px solid var(--line);border-radius:50%;padding:0}.header-action.preference-entry{gap:7px}.status-pill{font-size:12px;display:flex;align-items:center;gap:7px}.status-pill i,.connection-dot{width:6px;height:6px;border-radius:50%;background:#879270;display:inline-block}.status-pill.offline i{background:#aaa59b}.status-pill small{font-size:9px;color:#aaa89d;font-weight:400;margin-left:1px}.header-title{font-size:13px;font-weight:500;color:#929285}.header-side{width:42px}#screen{overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;scrollbar-width:none;overscroll-behavior:contain;outline:0;scroll-behavior:smooth}#screen::-webkit-scrollbar{display:none}.home-indicator{height:4px;min-height:4px;width:110px;border-radius:8px;background:#32332d;margin:9px auto 10px}.calendar-hero{padding:12px 27px 22px;display:flex;align-items:flex-end;justify-content:space-between}.calendar-hero .eyebrow{font-size:9px;letter-spacing:1.25px}.calendar-hero h1{font-family:var(--serif);font-size:31px;line-height:1.4;font-weight:500;margin-top:7px;letter-spacing:1px}.calendar-hero p{font-size:11px;line-height:1.7;color:var(--muted);margin-top:8px}.today-button{height:35px;display:flex;align-items:center;gap:5px;border:1px solid #deded4;border-radius:24px;padding:0 12px;font-size:11px;background:var(--paper);margin-bottom:3px}.calendar-weekdays{display:grid;grid-template-columns:repeat(7,1fr);margin:0 20px;padding:15px 0 12px;font-size:10px;color:#aaa89e;text-align:center;border-bottom:1px solid var(--line);background:var(--paper);position:sticky;top:0;z-index:3}.calendar-weekdays span:nth-last-child(-n+2){color:#bebbb1}.calendar-months{padding:0 20px}.month-section{padding:0 0 26px;border-bottom:1px solid var(--line);scroll-margin-top:42px}.month-header{display:flex;justify-content:space-between;align-items:center;padding:27px 6px 21px}.month-name{display:flex;align-items:baseline;gap:9px}.month-name h2{font-family:var(--serif);font-size:26px;font-weight:500;letter-spacing:.6px}.month-name span{font-size:10px;color:#a5a397;letter-spacing:.5px}.month-meta{font-size:9px;color:#a29f93;letter-spacing:.5px}.month-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));column-gap:2px;row-gap:7px}.day{position:relative;min-height:68px;padding:4px 2px 5px;display:flex;align-items:center;flex-direction:column;gap:5px;border-radius:11px;font-size:13px;transition:background .15s}.day:hover{background:#eeeee6}.day-number{height:26px;min-height:26px;width:26px;display:grid;place-items:center;font-size:12px;line-height:1;position:relative;z-index:1}.day.future{color:#c4c0b5}.day.today .day-number{border-radius:50%;background:var(--ink);color:#fff}.day.today:after{content:"今天";font-size:8px;color:#787e67;letter-spacing:.8px;position:absolute;bottom:6px}.day-art{width:35px;height:31px;overflow:hidden;border-radius:6px;display:grid;place-items:center;opacity:.9;transform:rotate(-4deg);box-shadow:0 1px 2px #34332009}.day:nth-child(2n) .day-art{transform:rotate(3deg)}.day-art svg{width:35px;height:31px;display:block}.day.historical:hover .day-art{transform:rotate(0deg);transition:transform .2s}.day-empty-marker{height:4px;width:4px;border-radius:50%;background:#d7d3c8;margin-top:9px}.month-empty{text-align:center;padding:14px 0 1px;font-size:10px;color:#b3afa2;letter-spacing:1px}.calendar-edge{width:100%;padding:19px 5px;color:#939586;font-size:10px;display:flex;justify-content:center;align-items:center;gap:7px}.calendar-edge.top{padding-top:6px;padding-bottom:11px}.calendar-hint{padding:21px 24px 0;display:flex;align-items:center;gap:8px;font-size:9px;color:#a6a395;line-height:1.7}.calendar-hint .hint-line{height:1px;flex:1;background:var(--line)}.calendar-bottom-note{padding:18px 26px 28px;font-size:9px;color:#aaa89e;text-align:center;line-height:1.9}.preview-note{align-self:center;padding-top:80px}.small-rule{display:block;width:22px;height:1px;background:#999d88;margin-bottom:20px}.preview-note .eyebrow{line-height:2}.preview-note p{font-size:12px;line-height:2;color:#838979;margin-top:25px}.note-detail{font-size:10px;line-height:2.3;color:#9b9e91;margin-top:36px}.panel{padding:12px 26px 32px}.panel h1{font-family:var(--serif);font-weight:500}.panel button{transition:background .15s}.primary-button,.secondary-button{min-height:47px;border-radius:13px;padding:13px 18px;background:var(--ink);color:#fff;width:100%;font-size:13px}.secondary-button{background:transparent;color:var(--ink);border:1px solid var(--line)}#toast{position:absolute;bottom:32px;left:50%;transform:translate(-50%,8px);opacity:0;pointer-events:none;max-width:85%;width:max-content;background:#272b24;color:#fff;padding:11px 16px;border-radius:11px;font-size:11px;line-height:1.6;z-index:20;transition:.2s}#toast.visible{opacity:1;transform:translate(-50%,0)}#sheet{padding:26px 25px 23px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:25px;width:min(366px,calc(100vw - 32px));max-height:85dvh;overflow:auto;box-shadow:0 20px 90px #20251835}#sheet::backdrop{background:#252a2359;backdrop-filter:blur(3px)}.sheet-top{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:19px}.sheet-top h2{font-family:var(--serif);font-size:24px;font-weight:500}.sheet-close{width:35px;height:35px;display:grid;place-items:center;border-radius:50%;background:#edede5}.sheet-body{font-size:13px;line-height:1.9;color:#7d8074}.sheet-body strong{color:#42493a;font-weight:500}.sheet-body p+p{margin-top:10px}.sheet-actions{display:grid;gap:9px;margin-top:25px}.memory-art{width:100%;aspect-ratio:1.2;border-radius:15px;display:grid;place-items:center;background:#f0ede3;margin-bottom:18px;overflow:hidden}.memory-art svg{width:100%;height:100%}.memory-caption{font-size:11px;text-align:center}.memory-caption strong{display:block;font-size:15px;margin-bottom:4px}.detail-empty{min-height:110px;display:grid;place-content:center;text-align:center;padding:15px}.detail-empty svg{margin:auto auto 18px;color:#a1a68f}.onboarding{padding:15px 28px 33px;min-height:100%;display:flex;flex-direction:column}.setup-steps{display:flex;gap:7px;margin:0 0 32px}.setup-steps i{flex:1;height:3px;background:#e2e3d7;border-radius:3px}.setup-steps i.active{background:#747e61}.onboarding .eyebrow{font-size:9px}.onboarding h1{font-family:var(--serif);font-size:31px;font-weight:500;line-height:1.5;margin:14px 0}.onboarding>p{font-size:12px;color:var(--muted);line-height:1.9}.setup-card{border:1px solid var(--line);border-radius:17px;padding:27px 21px;margin:26px 0;text-align:center}.setup-card>svg{width:38px;height:38px;color:#727c62;margin-bottom:17px}.setup-card strong{display:block;font-weight:500;font-size:15px;margin-bottom:9px}.setup-card p{font-size:11px;line-height:1.8;color:var(--muted)}.setup-bottom{margin-top:auto;padding-top:28px}.setup-bottom small{display:block;font-size:9px;line-height:1.8;color:#9b9e91;text-align:center;margin-top:12px}.setup-time{padding:13px;border:1px solid var(--line);border-radius:10px;background:transparent;font-size:24px;display:block;margin:20px auto 0;color:var(--ink)}.setup-row{display:flex;gap:12px;align-items:center;justify-content:center;font-size:12px;padding-top:18px}.setup-row input{width:18px;height:18px}.screen-arrive{animation:arrive .22s ease-out}@keyframes arrive{from{opacity:.4;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@media(max-width:1170px){.preview-layout{grid-template-columns:235px 414px;gap:45px}.preview-note{display:none}.guide-story h1{font-size:30px}}@media(max-width:780px){body{background:var(--paper)}.preview-layout{display:block;padding:0;min-height:100dvh}.preview-guide,.preview-note{display:none}.phone{width:100%;height:100dvh;min-height:0;max-width:480px;margin:auto;border:0;border-radius:0;box-shadow:none}.phone-status{padding-top:env(safe-area-inset-top);height:calc(42px + env(safe-area-inset-top));min-height:calc(42px + env(safe-area-inset-top))}.dynamic-island{display:none}.home-indicator{margin-bottom:max(10px,env(safe-area-inset-bottom))}.app-header{padding-left:24px;padding-right:24px}.calendar-hero{padding-top:8px}}@media(max-height:720px) and (min-width:781px){.preview-layout{padding:15px}.phone{height:calc(100dvh - 30px);min-height:550px}.guide-story{margin-top:30px}.demo-info{margin-top:30px}.phone-status{height:36px;min-height:36px}.dynamic-island{height:20px;top:7px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}[hidden]{display:none!important}

.calendar-hero{position:sticky;top:0;z-index:4;background:var(--paper)}.calendar-weekdays{top:var(--calendar-heading-height,118px)}
.header-entries{display:flex;align-items:center;gap:15px;flex-shrink:0}
.calendar-first-use{display:flex;align-items:flex-start;gap:12px;margin:0 6px 22px;padding:17px 15px;border:1px solid var(--line);border-radius:14px;color:var(--accent)}.calendar-first-use strong{display:block;font-family:var(--serif);font-size:17px;font-weight:500;color:var(--ink)}.calendar-first-use p{font-size:11px;color:var(--muted);line-height:1.9;margin-top:6px}

```

### `demos/calendar-app/panels.css`

```css
.panel { padding: 10px 24px 40px; color: var(--ink, #222); }
.panel button, .panel-sheet-form input { font: inherit; }
.panel button { -webkit-tap-highlight-color: transparent; }
.panel-title-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 47px; }
.panel-preferences .panel-title-row { position: sticky; top: 0; z-index: 3; background: var(--paper, #faf9f6); padding-block: 8px; margin-top: -8px; }
.panel-title-row h1 { margin: 0; font-size: 31px; line-height: 1.3; font-weight: 650; letter-spacing: -.9px; }
.panel-manage { border: 1px solid var(--line, #e7e5df); border-radius: 24px; background: transparent; padding: 9px 14px; min-height: 40px; font-size: 12px !important; color: var(--ink, #222); cursor: pointer; font-weight: 600 !important; }
.panel-manage-save { background: var(--ink, #222); color: #fff; border-color: var(--ink, #222); min-width: 68px; }
.panel-intro { margin: 9px 0 31px; color: var(--muted, #85837f); font-size: 13px; line-height: 1.8; }
.panel-section { padding: 0 0 28px; margin: 0 0 25px; border-bottom: 1px solid var(--line, #e7e5df); }
.panel-section h2, .panel-setting-section h2 { margin: 0; font-size: 16px; line-height: 1.5; font-weight: 600; letter-spacing: -.2px; }
.panel-section-title { display: flex; align-items: center; gap: 9px; }
.panel-example { font-size: 10px; font-weight: 500; color: var(--muted, #85837f); padding: 3px 7px; background: #efeee9; border-radius: 5px; }
.panel-description { font-size: 12px; color: var(--muted, #85837f); line-height: 1.8; margin: 7px 0 18px; }
.panel-people { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 21px 16px; padding-top: 6px; }
.panel-person { padding: 0; border: 0; background: transparent; color: var(--ink, #222); display: flex; align-items: center; flex-direction: column; position: relative; min-height: 103px; }
button.panel-person { cursor: pointer; border-radius: 10px; }
.panel-avatar { position: relative; display: block; width: 72px; height: 72px; background: #eeece6; border-radius: 50%; border: 1px solid transparent; transition: transform .18s ease, border-color .18s ease; }
.panel-avatar svg { display: block; width: 100%; height: 100%; overflow: hidden; border-radius: 50%; }
.panel-avatar-1, .panel-avatar-4 { background: #ebeae7; }
.panel-avatar-2, .panel-avatar-5 { background: #e9eae4; }
.panel-is-editing .panel-avatar-selected { transform: scale(1.1); border-color: var(--ink, #222); }
.panel-person-name { margin-top: 11px; font-size: 12px; }
.panel-person-note { color: #7d8071; font-size: 10px; margin-top: 4px; }
.panel-choice-mark { display: grid; place-items: center; height: 17px; width: 17px; border: 1px solid #c9c7bf; border-radius: 50%; background: var(--paper, #faf9f6); flex: 0 0 17px; box-sizing: border-box; }
.panel-avatar > .panel-choice-mark { position: absolute; top: 0; right: -1px; width: 20px; height: 20px; z-index: 1; }
.panel-avatar > .panel-choice-mark svg { width: 12px; height: 12px; }
.panel-choice-mark-selected { background: var(--ink, #222); border-color: var(--ink, #222); color: #fff; }
.panel-topics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.panel-topic { position: relative; border: 1px solid var(--line, #e7e5df); background: rgba(255, 255, 255, .43); border-radius: 13px; display: flex; align-items: center; gap: 9px; min-height: 62px; padding: 14px 12px; box-sizing: border-box; font-size: 12px !important; color: var(--ink, #222); text-align: left; }
button.panel-topic { cursor: pointer; padding-right: 29px; }
.panel-topic-icon { flex: 0 0 21px; display: flex; color: #686b5d; }
.panel-topic > .panel-choice-mark { position: absolute; top: 7px; right: 7px; height: 14px; width: 14px; }
.panel-topic-selected { background: #eeeee5; border-color: #c5c8b8; }
.panel-is-editing .panel-topic-selected { border-color: var(--ink, #222); }
.panel-mix { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); background: #eeede8; padding: 4px; border-radius: 10px; }
.panel-mix-option { font-size: 11px !important; border: 0; min-height: 40px; background: transparent; border-radius: 7px; color: var(--muted, #85837f); cursor: pointer; }
.panel-mix-selected { background: #fff; color: var(--ink, #222); box-shadow: 0 1px 4px #00000008; }
.panel-read-value { display: flex; justify-content: space-between; padding: 15px 16px; border-radius: 12px; background: #f0efe9; font-size: 13px; }
.panel-read-value span { color: var(--muted, #85837f); font-size: 11px; }
.panel-last-section { border-bottom: 0; margin-bottom: 0; padding-bottom: 22px; }
.panel-footnote { margin: 0; text-align: center; font-size: 10px; color: #99978f; line-height: 1.8; }
.panel-setting-section { margin-bottom: 29px; }
.panel-setting-section h2 { font-size: 12px; color: var(--muted, #85837f); font-weight: 500; margin: 0 0 11px 2px; }
.panel-settings-group { border: 1px solid var(--line, #e7e5df); background: rgba(255,255,255,.55); border-radius: 15px; overflow: hidden; }
.panel-setting-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 69px; border: 0; border-bottom: 1px solid var(--line, #e7e5df); padding: 16px 15px; text-align: left; background: transparent; color: var(--ink, #222); cursor: pointer; }
.panel-setting-row:last-child { border-bottom: 0; }
.panel-row-icon { flex: 0 0 23px; display: flex; color: #55594e; }
.panel-row-copy { display: flex; flex-direction: column; flex: 1; gap: 5px; min-width: 0; }
.panel-row-title { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.panel-row-detail { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--muted, #85837f); }
.panel-row-value { color: var(--muted, #85837f); font-size: 11px; line-height: 1.5; max-width: 112px; overflow-wrap: anywhere; text-align: right; }
.panel-setting-row > svg { flex: 0 0 16px; color: #aaa99f; }
.panel-status-dot { width: 5px; height: 5px; border-radius: 50%; background: #a7a59d; }
.panel-status-online { background: #6a775d; }
.panel-switch { display: block; position: relative; width: 36px; height: 21px; border-radius: 13px; background: #dcdad3; flex: 0 0 36px; }
.panel-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #00000012; transition: transform .2s ease; }
.panel-switch-on { background: var(--ink, #222); }
.panel-switch-on::after { transform: translateX(15px); }
.panel-demo-note { display: flex; justify-content: center; align-items: flex-start; gap: 8px; color: #8a8d7b; margin: 43px 0 18px; }
.panel-demo-note p { margin: 0; font-size: 11px; line-height: 1.9; }
.panel-demo-note span { font-size: 10px; color: #a09e96; }
.panel-demo-note svg { margin-top: 2px; }
.panel-sheet-form { padding: 7px 0 4px; color: var(--ink, #222); }
.panel-field { display: flex; flex-direction: column; gap: 9px; margin-bottom: 20px; font-size: 12px; }
.panel-field input { border: 1px solid var(--line, #e7e5df); background: #fff; color: var(--ink, #222); border-radius: 10px; padding: 13px; min-height: 46px; width: 100%; box-sizing: border-box; font-size: 16px; }
.panel-field-inline { display: flex; justify-content: space-between; align-items: center; gap: 20px; font-size: 14px; min-height: 48px; margin-bottom: 15px; }
.panel-field-inline input, .panel-radio-row input { accent-color: #222; width: 20px; height: 20px; flex: 0 0 20px; }
.panel-radio-list { border: 0; padding: 0; margin: 0 0 20px; }
.panel-radio-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--line, #e7e5df); min-height: 59px; font-size: 14px; }
.panel-sheet-empty-title { margin: 5px 0 9px; font-size: 17px; }
.panel-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.panel button:focus-visible, .panel-sheet-form input:focus-visible { outline: 2px solid #697256; outline-offset: 4px; }
@media (max-width: 360px) { .panel { padding-left: 18px; padding-right: 18px; } .panel-topic { gap: 7px; font-size: 11px !important; padding-left: 10px; } .panel-avatar { width: 65px; height: 65px; } .panel-row-value { max-width: 90px; } }
@media (prefers-reduced-motion: reduce) { .panel-avatar, .panel-switch::after { transition: none; } }

```

### `demos/calendar-app/onboarding.css`

```css
.flow-shell { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--ink); }
.flow-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: none; padding: 11px 27px 24px; }
.flow-scroll::-webkit-scrollbar { display: none; }
.flow-shell h1 { font-family: var(--serif, "Songti SC", serif); font-size: 31px; font-weight: 500; line-height: 1.52; letter-spacing: .7px; margin: 10px 0 12px; }
.flow-eyebrow { display: block; font-size: 9px; line-height: 1.8; letter-spacing: 1.35px; color: #949887; }
.flow-lead { font-size: 12px; color: var(--muted); line-height: 1.95; margin: 0; }
.flow-brand { font-size: 26px; letter-spacing: -1.6px; font-weight: 600; }
.flow-brand > span { font-size: 8px; display: inline-block; vertical-align: top; margin-top: 5px; margin-left: 3px; letter-spacing: 0; }
.flow-demo-button { padding: 11px 0 11px 11px; min-height: 42px; font-size: 11px; color: #96998c; }
.flow-footer { flex-shrink: 0; padding: 15px 27px 5px; background: var(--paper); border-top: 1px solid #e8e6df99; }
.flow-primary { width: 100%; border: 0; border-radius: 13px; min-height: 47px; padding: 13px 14px; background: var(--ink); color: #fff; font-size: 13px; line-height: 1.55; cursor: pointer; }
.flow-primary:disabled { background: #d8d9cf; color: #7c8071; cursor: progress; }
.flow-footer > p { margin: 10px 0 0; text-align: center; font-size: 9px; color: #a0a292; line-height: 1.7; }
.flow-steps { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); padding: 0; margin: 0 0 27px; list-style: none; }
.flow-steps li { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 10px; color: #b4b5a9; }
.flow-steps li::before { content: ''; position: absolute; top: 12px; right: calc(50% + 17px); width: calc(100% - 34px); height: 1px; background: #e0e2d5; }
.flow-steps li:first-child::before { display: none; }
.flow-step-number { position: relative; display: grid; place-items: center; height: 26px; width: 26px; border: 1px solid #dddfd2; border-radius: 50%; font-size: 10px; color: #9fa48e; background: var(--paper); }
.flow-steps .is-current { color: var(--ink); }
.flow-steps .is-current .flow-step-number { background: var(--ink); color: #fff; border-color: var(--ink); }
.flow-steps .is-done { color: #878f73; }
.flow-steps .is-done .flow-step-number { border-color: #a6ad95; background: #edf0e4; color: #788263; }
.flow-welcome .flow-scroll { padding-top: 0; text-align: center; display: flex; flex-direction: column; align-items: center; }
.flow-welcome-art { flex-shrink: 0; width: 285px; height: 199px; max-width: 100%; margin: 0 0 14px; }
.flow-welcome-art > svg { width: 100%; height: 100%; }
.flow-welcome h1 { font-size: 29px; margin: 13px 0 15px; line-height: 1.6; letter-spacing: .4px; }
.flow-welcome .flow-lead { font-size: 12px; }
.flow-preparation { width: 100%; margin-top: 23px; text-align: left; border-top: 1px solid var(--line); }
.flow-preparation summary, .flow-device-help summary { display: flex; justify-content: space-between; gap: 12px; align-items: center; min-height: 44px; font-size: 11px; color: #777e68; cursor: pointer; list-style: none; }
.flow-preparation summary::-webkit-details-marker, .flow-device-help summary::-webkit-details-marker { display: none; }
.flow-preparation[open] summary > svg, .flow-device-help[open] summary > svg { transform: rotate(90deg); }
.flow-preparation ul { margin: 5px 0 0; padding: 0; list-style: none; }
.flow-preparation li { display: flex; align-items: center; gap: 10px; font-size: 11px; color: #737966; line-height: 1.8; padding: 7px 0; }
.flow-preparation > p { font-size: 10px; color: #a1a48f; line-height: 1.8; margin-top: 8px; }
.flow-permission-list { margin-top: 24px; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #ffffff60; }
.flow-permission-row { width: 100%; display: flex; align-items: center; gap: 13px; border: 0; border-bottom: 1px solid var(--line); padding: 16px 14px; min-height: 76px; text-align: left; background: transparent; }
.flow-permission-row:last-child { border-bottom: 0; }
.flow-permission-icon { display: grid; place-items: center; color: #747d63; }
.flow-permission-copy { display: flex; flex-direction: column; gap: 5px; flex: 1; }
.flow-permission-copy strong { font-size: 13px; font-weight: 500; }
.flow-permission-copy > span { font-size: 10px; line-height: 1.6; color: var(--muted); }
.flow-permission-status { font-size: 10px; color: #959b85; flex: 0 0 auto; }
.flow-permission-status.granted { color: #6b7657; }
.flow-inline-note { font-size: 10px; line-height: 1.9; color: #9a9f8b; margin: 17px 0 0; }
.flow-inline-note.flow-warning { color: #9a7555; background: #f4ece1; border-radius: 8px; padding: 10px 12px; }
.flow-device-card { display: flex; flex-direction: column; align-items: center; text-align: center; margin-top: 23px; border: 1px solid var(--line); border-radius: 17px; background: #ffffff65; padding: 27px 16px 19px; }
.flow-device-symbol { position: relative; width: 67px; height: 67px; border-radius: 22px; display: grid; place-items: center; background: #eaece2; color: #747e62; margin-bottom: 19px; }
.flow-device-symbol.is-searching::before { position: absolute; content: ''; inset: -7px; border: 1px solid #a3ad8e66; border-radius: 28px; animation: flow-pulse 1.6s ease-in-out infinite; }
.flow-device-symbol.is-connected { border-radius: 50%; background: #e9eede; color: #6f7d56; }
.flow-device-card > strong { font-size: 17px; line-height: 1.55; font-weight: 500; }
.flow-device-card > p { margin-top: 10px; font-size: 11px; line-height: 1.9; color: var(--muted); }
.flow-simulation-pill { margin-top: 17px; color: #a5a895; font-size: 9px; border-radius: 20px; padding: 4px 9px; background: #efefe9; }
.flow-device-help { margin-top: 12px; }
.flow-device-help > p { font-size: 11px; line-height: 1.9; color: var(--muted); }
.flow-help-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.flow-help-actions > button { font-size: 10px; padding: 9px 10px; border-radius: 7px; border: 1px solid #ddded2; color: #92987f; }
.flow-device-help > .flow-sheet-note { margin-top: 11px; }
.flow-sheet-note { font-size: 10px !important; line-height: 1.8; color: #979d86; margin-top: 12px; }
.flow-sheet-device { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 7px 0 20px; }
.flow-sheet-device > svg { color: #7b8668; }
.flow-sheet-device > strong { font-size: 15px; }
.flow-sheet-device > span { font-size: 11px; }
.flow-network-list { padding: 0; margin: 17px 0; border: 1px solid var(--line); border-radius: 12px; }
.flow-network-list label { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 15px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.flow-network-list label:last-child { border-bottom: 0; }
.flow-network-list label > span { display: flex; align-items: center; gap: 10px; }
.flow-network-list small { display: block; margin-top: 3px; font-size: 9px; color: #a0a591; }
.flow-network-list input { flex-shrink: 0; width: 18px; height: 18px; accent-color: var(--ink); }
.flow-preference-section { border-top: 1px solid var(--line); margin-top: 23px; padding-top: 19px; }
.flow-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.flow-section-heading h2 { font-size: 14px; font-weight: 500; line-height: 1.6; }
.flow-section-heading > span { color: #a0a48f; font-size: 9px; }
.flow-preference-section > p { font-size: 10px; line-height: 1.8; color: #8b927b; margin-top: 6px; }
.flow-people { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 19px 14px; padding: 21px 0 0; }
.flow-person { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 9px; border: 0; background: transparent; padding: 0; }
.flow-person > span:last-child { font-size: 11px; color: #818776; }
.flow-avatar { position: relative; display: block; width: 65px; height: 65px; border: 1px solid #dddfd2; border-radius: 50%; background: #eeeee5; transition: transform .18s ease; }
.flow-avatar > svg { display: block; border-radius: 50%; overflow: hidden; width: 100%; height: 100%; color: #777e69; }
.flow-person.is-selected .flow-avatar { transform: scale(1.1); border-color: var(--ink); }
.flow-choice-check { border: 1px solid #cbcfc0; background: var(--paper); border-radius: 50%; height: 16px; width: 16px; display: grid; place-items: center; }
.flow-avatar .flow-choice-check { position: absolute; right: -3px; top: 0; width: 17px; height: 17px; }
.is-selected > .flow-choice-check, .is-selected .flow-avatar .flow-choice-check { background: var(--ink); color: #fff; border-color: var(--ink); }
.flow-topics { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; margin-top: 14px; }
.flow-topic { min-width: 0; border: 1px solid var(--line); border-radius: 11px; background: #ffffff55; min-height: 59px; display: flex; align-items: center; gap: 8px; padding: 15px 9px; text-align: left; position: relative; }
.flow-topic > svg { color: #7a836a; }
.flow-topic > span:nth-child(2) { font-size: 10px; line-height: 1.6; }
.flow-topic > .flow-choice-check { position: absolute; right: 5px; top: 5px; width: 13px; height: 13px; }
.flow-topic.is-selected { background: #eeeee3; border-color: #979e85; }
.flow-schedule-card { margin-top: 25px; padding: 25px 20px 24px; border: 1px solid var(--line); border-radius: 17px; background: #ffffff55; text-align: center; }
.flow-schedule-icon { display: block; color: #899473; margin-bottom: 13px; }
.flow-schedule-card h2 { font-size: 14px; line-height: 1.6; font-weight: 500; }
.flow-frequency { padding: 4px; border-radius: 10px; background: #eeeee5; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 3px; margin-top: 19px; }
.flow-frequency button { font-size: 12px; color: #949b82; padding: 9px 5px; border-radius: 7px; min-height: 36px; }
.flow-frequency button.is-selected { background: #fffefb; box-shadow: 0 1px 4px #30382008; color: var(--ink); }
.flow-time-label { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 27px; }
.flow-time-label > span { font-size: 10px; color: #939a82; }
.flow-time-label input { width: 180px; max-width: 100%; min-height: 59px; color: #454d38; border: 1px solid #e2e4d6; border-radius: 11px; padding: 10px 12px; font-size: 30px; background: #fafaf5; text-align: center; font-variant-numeric: tabular-nums; }
.flow-schedule-note { font-size: 10px; line-height: 1.9; color: #9ca48c; margin-top: 17px; }
.flow-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.flow-shell button:focus-visible, .flow-shell summary:focus-visible, .flow-shell input:focus-visible { outline: 2px solid #87936e; outline-offset: 4px; }
@keyframes flow-pulse { 0%,100% { transform: scale(.98); opacity: .4; } 50% { transform: scale(1.06); opacity: 1; } }
@media (max-width: 360px) { .flow-scroll { padding-left: 22px; padding-right: 22px; } .flow-footer { padding-left: 22px; padding-right: 22px; } .flow-shell h1 { font-size: 28px; } .flow-steps li { font-size: 9px; } .flow-avatar { width: 59px; height: 59px; } .flow-topic { gap: 6px; padding-inline: 8px; } .flow-topic > svg { width: 18px; height: 18px; } }
@media (max-height: 760px) { .flow-welcome-art { height: 165px; margin-bottom: 7px; } .flow-welcome h1 { font-size: 27px; } .flow-steps { margin-bottom: 20px; } .flow-device-card { padding-top: 22px; } }
@media (prefers-reduced-motion: reduce) { .flow-avatar { transition: none; } .flow-device-symbol.is-searching::before { animation: none; } }

```


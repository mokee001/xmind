# Extractable component menu

> Discovery scope: the isolated `demos/calendar-app` B v0.2 Demo, specifically `#calendar` homepage. This is not the production Expo App, native App, backend or selection engine. User requested several homepage-only visual proposals; preserve all behavior and other screens.

No remote DraftComponents are created by init. These are extraction candidates only. Most target widgets are template-string functions embedded in app.js; there is no preexisting framework component tree to sync. For different homepage visual directions, extracting/fixing the entire styled calendar header/grid before branching would overconstrain the requested exploration. Prefer use the screenshot and concise structural context; extract only if needed for invariants.

## AppPreviewShell
- Source: `demos/calendar-app/index.html`
- Category: layout
- Description: Phone app host with fake status, header, scroller, home indicator, toast/dialog portals.
- Extractable props: none required for homepage proposals; optional showPresentationAside (boolean, false).
- Hardcoded: status icons, desktop explanatory copy, DOM IDs, phone CSS. Desktop presentation aside is not product UI.

## CalendarTopBar
- Source: `demos/calendar-app/app.js` → renderHeader calendar branch
- Category: layout
- Description: Persistent left connection status plus right peer preference/settings navigation.
- Extractable props: connected (boolean), preferencesHref (string, #preferences), settingsHref (string, #settings).
- Hardcoded: labels 已连接/未连接/偏好/示例, line icons, placement, no tab navigation. Style must remain variant-specific.

## BackHeader
- Source: `demos/calendar-app/app.js` → renderHeader non-home branches
- Category: layout
- Description: Secondary-page calendar back navigation; out of homepage proposal scope.
- Extractable props: homeHref (string, #calendar), showCenteredTitle (boolean).
- Hardcoded: 日历 label, left arrow, ECHOoo title, CSS.

## ActionButton
- Source: `demos/calendar-app/style.css` → primary-button/secondary-button, `app.js` → openSheet
- Category: basic
- Description: Shared native button treatments in sheets.
- Extractable props: isPrimary (boolean), isDisabled (boolean).
- Hardcoded: target-specific labels/icon choices/classes stay in their usage.

## ModalSheet
- Source: `demos/calendar-app/app.js` → openSheet
- Category: layout
- Description: Native dialog shell with close/backdrop and action area.
- Extractable props: isOpen (boolean), showActions (boolean).
- Hardcoded: close SVG, typography, classes, portal structure; content/labels are fixed per proposed screen.

## ConnectionIndicator
- Source: `demos/calendar-app/app.js` → renderHeader and connectionSheet
- Category: basic
- Description: Dot, online/offline text and example annotation; permanently discoverable on home.
- Extractable props: isConnected (boolean).
- Hardcoded: dot placement, labels, example status annotation. Never label a local simulation as real device receipt.

## CalendarMonth
- Source: `demos/calendar-app/app.js` → monthHtml
- Category: basic
- Description: Month/year heading plus Monday-first 7-column dates and past-only markers.
- Extractable props: isCurrentMonth (boolean), isFreshAccount (boolean), exampleCount (number).
- Hardcoded: selected comparable month/date text, illustration sources, day grid semantics, calendar labels. Keep rendering style variant-specific.

## CalendarDay
- Source: `demos/calendar-app/app.js` → monthHtml/illustration
- Category: basic
- Description: Accessible date target with today/current flag, historic sample artwork or future blank.
- Extractable props: isToday (boolean), isFuture (boolean), hasMemory (boolean).
- Hardcoded: fixed date numbers in proposal, sample illustration sources, aria text; no scheduling or selection controls.

## PersonAvatar
- Source: `demos/calendar-app/panels.js` → portrait / preferences
- Category: basic
- Description: Example avatar with edit-only check and selected scaling; shared with onboarding but out of homepage scope.
- Extractable props: isSelected (boolean), isEditing (boolean).
- Hardcoded: example portrait SVG, person names, positive preference copy.

## SettingsRow
- Source: `demos/calendar-app/panels.js` → row
- Category: basic
- Description: Icon/copy/value/chevron row, out of homepage scope.
- Extractable props: destinationHref (string), showValue (boolean).
- Hardcoded: icon names, row labels, CSS and sample value text.

# UX audit: the browser chrome

Scope: tab strip (tabs, groups, Organize, pinned, sleeping, audio), toolbar (Back / Forward / Reload, address bar, site
chip, star, reader, AI shield, extension and download icons, the AI button, the ⋯ menu), omnibox suggestions, context
menus, find bar, shortcuts. Walked in a hidden window with a throwaway profile and local fixture pages (12 to 17 tabs, a
group, pinned, sleeping and muted tabs), light and dark, at 1280, 1100, 900 and 700 px wide. Native menus can't be
screenshotted, so their templates were dumped and read. Screenshots are in `docs/ux-audit/chrome/`.

Overall the chrome is in good shape: the find bar, the omnibox keyboard handling (arrows, Esc, drafts), the tab hover
card, group menus, the audio button, focus rings and accessible names are all solid. Findings below are ranked by how
much they get in a user's way. **Fixed** items are in this PR (test: `test/chrome-ux.js`, `test/chrome-ux-units.js`).

## Fixed in this PR

### 1. The tab in front disappears when the window gets narrower (bug)
Where: tab strip (`app.js`, strip `ResizeObserver`). With many tabs, shrinking the window left the active tab scrolled
off the right edge, with nothing showing where the page you are looking at had gone. The strip only scrolled to the
active tab when the active tab *changed*. Screenshots: `before-700-14tabs.png` (no tab is highlighted),
`after-700-14tabs.png` (the active tab sits at the end of the strip, in view). Fix: when the strip gets narrower and the
tab in front was in view, it is scrolled back into view. A strip the user scrolled away on purpose stays put.

### 2. "Not secure" on your own computer
Where: address bar chip. `http://localhost:3000` and `http://127.0.0.1` were labelled with an orange warning and "Not
secure", like a site that really crosses the network. Chrome and Edge don't do that for loopback addresses; for a
browser people develop in, it is a false alarm on every page they build. Screenshots: `before-dark-1280.png` (warning),
`after-security-dark.png` / `after-security-light.png` (neutral "i" chip, tooltip "This page is on your own computer. Click
for site information."). Fix: `chrome-helpers.js` `isLoopbackUrl` (localhost, `*.localhost`, 127/8, `[::1]`).

### 3. Back and Forward had no history list
Where: toolbar. Right-clicking Back or Forward did nothing; Chrome, Edge and Arc show the pages behind or ahead (up to 15,
nearest first, then "Show full history"), so a long way back is one pick. Fix: right-click on either button opens that list
(`browser/nav-history.js`, `nav:history-menu`). Disabled buttons stay quiet.

### 4. Context menus hid their keyboard shortcuts
Where: the tab menu and the page menu. Reload, Close Tab, Reopen Closed Tab, Bookmark Tab, Bookmark All Tabs, and on the page
Back, Forward, Reload, Save Page As, Print, View Page Source, Take Screenshot all have shortcuts that the ⋯ menu shows and
these menus didn't, so a user never learned them from the place they right-click. Fix: the shortcuts are shown beside
the items (display only, so no key is registered twice).

### 5. Copy Link and bookmarking gave no confirmation from menus
Where: tab menu and page link menu "Copy Link"; tab menu "Bookmark Tab" / "Remove Bookmark", Ctrl+D. Clicking Copy Link
did nothing visible (did it copy?), and bookmarking a background tab, where the star isn't showing, left no trace. Fix:
a two-and-a-half-second toast in the strip's existing note ("Link copied", "Bookmark added", "Bookmark removed").
Screenshot: `after-toast-light.png`.

### 6. The two AI switches were far apart in the tab menu
Where: tab right-click. "Keep the AI From Acting on This Tab" sat among the tab's own commands (after Mute Site) and
"Turn Off AI on <site>" sat alone near Close, two similar, easily confused items about one question (what may the AI
touch). Fix: both now form one section, with separators, above Close.

### 7. "Ask Claude About Selection" in a multi-model browser
Where: page menu with selected text. The sidebar can run Claude, GPT, Gemini, Grok, Codex and others, but the item named
one of them. Now "Ask AI About Selection" (README updated).

## Left for later (ranked)

1. **The AI shield in the address bar looks like a security or tracker-blocking shield** and is on every page
   (`before-dark-1280.png`, right of the address). Its job is "keep the AI from acting on this tab"; a security-minded
   user reads it as site protection. Suggest a sparkle-with-slash icon (matching the Organize and AI-opened marks), or
   showing it only when the AI is in use or the tab is already kept off.
2. **Many tabs read as a row of identical globes** (`before-states-light.png`): below about 70 px a tab shows only its icon,
   and pages without a favicon all show the same globe. The hover card names them, but keyboard users get nothing until they
   focus one. Consider a letter-avatar fallback (first letter of the site) instead of the globe. A muted or playing tab shrinks
   its title to one letter ("P") because the speaker button reserves room even when the tab is too narrow for it.
3. **Tab state isn't in the accessible name** of pinned, sleeping, muted and playing tabs (only the AI states are), and the speaker
   button is a Tab stop between the toolbar and the strip rather than inside the strip's roving focus.
4. **The tab menu shows "Merge All Windows (only one window open)" and a dead "Merge Window Into"** when there is one window.
   A deliberate choice (a missing item looks like a missing feature), but in the right-click menu they are two dead rows; the ⋯
   menu is the better place to keep the explanation.
5. **Menu labels are Title Case; tooltips, buttons and settings are sentence case** ("New Tab" vs "New tab"). Consistent within
   each kind, so it is a house-style decision (Windows Chrome and Edge use sentence case); it touches about 150 strings and the
   tests that match them, so it deserves its own change.
6. **The omnibox's first suggestion isn't pre-selected** (`before-suggest.png`): typing `alp` and Enter searches the web for
   "alp" even though "Page alpha" is the first row; Chrome treats the top row as the default match. Arrow Down then Enter works.
7. **Private windows have their own address-bar chip**, which still says "Not secure" for localhost (`private.js`).
8. **The AI button shows the selected model's vendor mark**, and a plain circle when no model is connected; with nothing set up
   the toolbar's rightmost icon says nothing about what it does until you hover. Its tooltip is the model's name, not "AI".
9. **The toast sits in the tab strip's row** and pushes Organize and tab search along while it is up (the existing organize
   note behaves the same).
10. **The ⋯ menu is long** (about 40 entries at full height, folded into submenus on short windows). The sections are sensible
    and destructive items are separated, but "Tabs and Files", "AI Chat and Tasks" and "More Tools" are only named when it folds.

## Checked and fine

- Find bar: opens with the selection, "n of m", "No matches", Enter / Shift+Enter, Esc closes and returns focus.
- Omnibox: arrows move through suggestions and write them into the field, first Esc closes the list, second reverts; per-tab drafts.
- Toolbar: every button has a name and a tooltip with its shortcut (shortcuts shown as ⌘ on macOS); Reload turns into Stop while
  loading and its name follows; Back and Forward disable when there is nowhere to go; keyboard focus ring on every control.
- Tabs: active tab is raised and bold in both themes (subtle in dark, but clear), hover card shows title and host, sleeping
  tabs are dimmed and wake on hover, groups have a name chip, a color underline, collapse and a menu with Ungroup and Close
  Group set apart from the rest.
- Menus: grouped sensibly, destructive entries (Close …, Clear History…) separated, "…" used for items that ask for more.

## Screenshots

| Name | What it shows |
|---|---|
| `before-dark-1280.png` | dark, 12 tabs, group, "Not secure" chip on localhost, AI shield |
| `after-security-dark.png`, `after-security-light.png` | the neutral local-page chip |
| `before-700-14tabs.png`, `after-700-14tabs.png` | the tab in front after the window narrows |
| `before-states-light.png`, `before-states-dark.png` | pinned, group, muted, sleeping, active tabs, hover card |
| `after-states-light.png`, `after-states-dark.png` | the same after |
| `after-toast-light.png` | "Link copied" toast |
| `before-suggest.png` | omnibox suggestions |
| `before-light-find.png` | find bar |

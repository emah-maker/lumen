# UX audit: the browser chrome

Scope: tab strip (tabs, groups, Organize, pinned, sleeping, audio), toolbar (Back / Forward / Reload, address bar, site
chip, star, reader, the AI read-only button, extension and download icons, the AI button, the ⋯ menu), omnibox suggestions, context
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

## Round 2: the "left for later" list (items 1 to 8 fixed, 9 and 10 left)

Tests: `test/chrome-ux-units.js` (default match, address check, sentence-case guard, wiring), `test/chrome-ux.js`, `test/aitaboff.js`,
`test/tabmenu.js`, `test/tabui.js`, `test/private.js`, `test/security-ui.js`, `test/a11y.js`.

1. **The AI shield looked like a security shield and was on every page. FIXED.** The button is now a sparkle (the mark Lumen
   uses for AI everywhere: Organize, the AI-opened tab mark), slashed while the tab is read-only, and when it is on it carries
   a small "AI read-only" chip (hidden below 860 px, where the sparkle and tooltip remain). Its tooltip says what it does:
   "Make this tab read-only for the AI" (on: "The AI can read this tab but not act on it, click to allow"). It shows only
   when it means something: the AI panel is open on the tab, an agent or MCP client is working, or the tab is already kept
   off. On a page you are just reading it is gone, like any other chrome that has nothing to say. The tab-strip mark is the
   same slashed sparkle instead of a shield. The tab menu's "Keep the AI from acting on this tab" is always there, so the
   control is never out of reach.
2. **Tabs without a favicon read as identical globes; a muted tab squeezed its title to one letter. FIXED.** A web page with
   no icon (or whose icon failed) now shows a monogram: the first letter of its site on a color taken from the site (all
   subdomains of a site share it), at the same 16 px as a favicon; Lumen's own pages and the new-tab page keep their icons.
   A tab with a speaker button now collapses to icon-only below 96 px (as ordinary tabs do below 72 px) instead of letting the
   reserved room for speaker and close button shrink the title to one letter.
3. **Tab state missing from the accessible name. FIXED.** The name now reads, for example, "Docs, pinned, muted, chat finished,
   not viewed yet" (pinned, asleep, muted or playing audio, then the chat and AI notes). The speaker button is no longer a Tab
   stop between the toolbar and the strip: it is `tabindex=-1`, and **M** on a focused tab mutes or unmutes it (advertised
   through `aria-keyshortcuts`), so the strip stays one roving stop.
4. **Dead "Merge All Windows (only one window open)" and "Merge Window Into" rows in the tab menu. FIXED.** With nothing to
   merge, the tab's right-click menu leaves both out. The ⋯ and Window menus keep them with the reason ("only one window
   open"), as before: a missing item there would look like a missing feature, and the explanation belongs in the menu you open
   on purpose.
5. **Menu labels were Title Case, tooltips and buttons sentence case. FIXED, in favor of sentence case** (what Windows Chrome and
   Edge use, and what the rest of Lumen already used). About 140 strings: the app menus (⋯, File/Edit/View/Window, menu bar), the
   tab, group, page, link, image, video and address-bar context menus, the private window's menus, the macros and spelling items,
   the ad-blocker items. Proper nouns and "AI" keep their capitals ("Lumen on GitHub", "Ask AI about selection",
   "Translate with Google Translate…"). Top-level names that are one word are unchanged. `test/chrome-ux-units.js` now
   fails on any new Title Case menu label, and the tests that matched labels were updated. Not changed: macOS system menu items
   that come from the OS, and dialog titles ("Keyboard Shortcuts" is a window title).
6. **The omnibox's top suggestion wasn't pre-selected. FIXED.** When what you typed is plain words and the first row is a
   page from history, that row is selected and Enter goes to it (Arrow Up goes back to what you typed, Esc reverts, as
   before). It is deliberately not selected when you typed something that is an address (a scheme, `localhost:3000`,
   `example.com/path`, an IP, `host:port`, `lumen://`), when the field already holds an inline completion (Enter goes to that
   host as before), or when the first row is only "search for ...": Enter on typed text still goes exactly where it did.
   Logic and tests: `chrome-helpers.js` `looksLikeAddress` / `defaultSuggestion`.
7. **Private windows said "Not secure" for localhost. FIXED.** The private window's address-bar chip uses the same rule as a
   normal window: an `http` address on this computer shows the neutral "i" chip, "This page is on your own computer".
8. **The AI button was a plain circle until a model was connected. FIXED.** With nothing connected it shows an accent-colored
   sparkle with a plus, its tooltip and name read "Set up AI (Ctrl+J)", and it turns into the connected model's mark
   (Claude, ChatGPT, Gemini, ...) as before. The sidebar behind it already opens on its welcome and set-up steps.
9. **The toast sits in the tab strip's row and pushes Organize and tab search along while it is up.** Not changed: it needs a
   design decision about where transient messages live (a floating toast over the page would cover content), and it is brief.
10. **The ⋯ menu is long.** Not changed: the sections are sensible and destructive items are set apart; naming the folded
    sections only when they fold is the intended behavior, and a rework of the menu is bigger than this pass. Sentence case
    makes it a little easier to scan.

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

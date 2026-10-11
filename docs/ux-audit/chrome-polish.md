# Browser chrome polish pass (pre-release v0.5.23)

Walked in a hidden window with a throwaway profile and local fixture pages, light and dark, at 1100, 700 and 480 px:
tab strip, omnibox and its suggestions, find bar, History, Bookmarks, Downloads (page and toolbar panel), error pages
(refused port, unknown host, blocked port), permission prompt wording, and the shortcut handlers against Chrome's list.
Prior audit: `chrome.md` (its items 9 and 10 stay left). Note: pictures of Lumen's own pages taken from a hidden window
render light even when the theme is dark, so dark was judged from the CSS tokens.

## Found

1. The omnibox's selected suggestion lost its icon: the list's page used `--accent` for the selected row's icon but never defined it, so the stroke was invalid and the highlighted row (the one Enter goes to) had no clock or magnifier.
2. History: the time column was 52 px wide, so "12:49 AM" wrapped onto two lines and the rows beside it were taller than the others.
3. Ctrl+H a second time opened a second History tab (Bookmarks and Downloads reuse theirs).
4. A page on `127.0.0.1` or `[::1]` got a green tab tile with the letter "1".
5. Ctrl+Shift+I did nothing on Windows and Linux (only F12 opened DevTools); the shortcuts sheet did not list F6 / Alt+D (address bar) or F3 / Ctrl+G (find next), which work.
6. Labels still in Title Case after the round 2 sentence-case change: the site chip's "Reset Zoom for This Site", "Clear Cookies and Site Data…", "Site Settings…", the permission prompt's "Don't Allow", "Manage Passwords…", and two error hints that quoted the menu as "Ad Blocker" and "Clear Cookies and Site Data".
7. The Downloads page showed size and site but not when a download finished (the toolbar panel does).
8. The error page sat 4 vh lower and 32 px wider than the certificate, HTTPS-only and Safe Browsing pages, so the layout jumped between error kinds.

## Fixed

All of the above (1 to 8). Tests: `test/chrome-ux-units.js` (new "polish pass" checks, and the Title Case guard now covers
the page-info, permission and passwords labels), `test/chrome-ux.js` (History reuse; a `localhost` tab keeps its "L"
monogram and a `127.0.0.1` tab keeps the globe), `test/basics-units.js` (the shortcuts-sheet check also reads
`extraShortcut`), `test/dialogs.js`.

## Left

- **Ctrl+K / Ctrl+E (search from the address bar), Alt+Home, Ctrl+Shift+B (bookmarks bar), Ctrl+Shift+C.** Not added: Lumen's key handler runs before the page, so taking Ctrl+K would break the command palettes of Notion, Slack, GitHub and Linear; there is no bookmarks bar to toggle.
- **Internal pages (History, Bookmarks, Downloads) show an empty address bar** ("Search or enter address"), where Chrome shows `chrome://history`. Needs a decision on a `lumen://` display address for them (Settings and the chat page already have one).
- **Permission prompt for camera and microphone always says "use your camera and microphone"** even when a site asks for one. The decision is stored once for both (`main.js` `setupPermissions`, key `origin|media`), so a more precise sentence would understate what Allow grants; splitting the stored decision is a larger change.
- **Downloads page keeps only the latest 50** (`features/downloads.js`) and removing a row or bookmark has no undo toast; both match what the page promised and are low stakes.
- **Toast in the strip pushes Organize along; the ⋯ menu is long** (items 9 and 10 of `chrome.md`).
- `cert-error.html`, `https-only.html` and `safe-browsing.html` have English text baked into the HTML instead of `locales/en.json`.

## Round 2

Fixes for the "Left" list above, then another sweep of the tab hover card, the tab context menu, the ⋯ menu and the
download panel (a hidden window with a throwaway profile; native menus were read from their templates, since they can't
be screenshotted). Shots in `docs/ux-audit/shots/` (gitignored).

### Found
1. Internal pages (History, Bookmarks, Downloads) showed an empty address bar, and once they showed an address the star and AI buttons would have appeared on them.
2. Removing a bookmark or a download had no way back.
3. Downloads kept 50 entries.
4. Certificate, HTTPS-only and Safe Browsing pages had English baked into HTML and scripts.
5. The camera / microphone prompt always named both.
6. Sweep: History, Bookmarks, Downloads and Back / Forward menu labels used page titles raw. On Windows and Linux a native menu reads "&" as a mnemonic, so "Q&A" showed as "QA"; History cut titles at 60 characters with no ellipsis, Bookmarks did not cut at all.
7. Sweep: the Bookmarks page said "Removed ..." in a status line under the search box, which would now repeat the Undo note.

### Fixed
1. `main.js` tab state gives `lumen://history`, `lumen://bookmarks`, `lumen://downloads`; `app.js` treats any Lumen page (`tab.page`) as having no star, site chip or AI-off button.
2. New `renderer/managers-toast.js` (the organize note's look: a pill with an accent Undo, about 8 s, Ctrl+Z outside a text field). Bookmarks restore through `bookmarks:restore` at the old index; downloads through a `restore` action that puts the row back where it was (the file was never deleted).
3. `KEEP` is 1000. The page shows 100 and a "Show more N" button; the toolbar panel and the taskbar still get only the latest 50 / 10, and the page's "file still there" check is cached for 3 s so 1000 rows are not stat()ed on every progress tick.
4. `locales/en.json` has `certError.*`, `httpsOnly.*`, `safeBrowsing.*`; the three pages load `i18n.js` and a small `interstitial.js` (fills `{host}` with an element); `error-preload.js` hands them the table. `cert-reasons.js` now maps errors to keys and takes the translate function.
5. Wording only: `permission.media.video` / `.audio` from Electron's `details.mediaTypes`. The decision is still stored once (`origin|media`).
6. `browser/menu-label.js` (`&` becomes `&&`, 60-character ellipsis) used by the History, Bookmarks, Downloads, Back / Forward and Add to group menus.
7. The status line is used only when the note is missing.

Tests: `test/chrome-ux-units.js`, `test/page-i18n-units.js`, `test/core-browsing-units.js`, `test/managers.js` (address, Undo for both pages).

### Left
- **Camera-only or microphone-only Allow also covers the other**, because the decision is one entry; a later request for the other device is not asked again. Splitting the stored decision is a larger change.
- **The `&&` fix is untested on screen** (native menus can't be captured here); it follows Electron's rule for Windows and Linux labels.
- **The toolbar download panel could not be screenshotted** (an off-screen view); its text and list were read and are fine (long names clip, progress, speed and time left show).
- **Tab hover card and tab menu** were fine: the card clips long titles with an ellipsis and shows the host (`lumen://...` for Lumen pages); disabled items stay in place for internal pages.

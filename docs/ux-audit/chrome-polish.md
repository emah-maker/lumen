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

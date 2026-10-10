# Feature gaps

How Lumen's everyday browser features compare with Chrome, Arc, Safari, Brave and Edge, and what is worth building next. It covers the browser underneath, not the AI: the sidebar, MCP and the agent tools are in the [README](../README.md) and the [MCP tool reference](mcp-tools.md).

**Status:** **Have** (on par with the others for everyday use), **Partial** (works, with a gap named in the notes) or **Missing**.
**Worth it:** whether closing the gap is worth the code, and why.
**Effort:** **S** is under a day, **M** is one to three days, **L** is a week or more.

Some gaps are already being handled elsewhere, so they're marked and not built here:

- **In Evan's PR:** draft PRs [#114](https://github.com/emah-maker/lumen/pull/114) (Smart Stack widgets), [#117](https://github.com/emah-maker/lumen/pull/117) (Organize Tabs), [#119](https://github.com/emah-maker/lumen/pull/119) (Windows signing through SignPath), [#120](https://github.com/emah-maker/lumen/pull/120) (faster boot and page loads), [#121](https://github.com/emah-maker/lumen/pull/121) (a chat per tab) and [#122](https://github.com/emah-maker/lumen/pull/122) (Antigravity).
- **Other work in progress:** private windows and address-bar speed are being reworked separately.
- **Declined:** on-device translation (Bergamot). The owner turned it down.

## Added in this round

Each item is wired into its menus, has a shortcut where browsers usually have one, has strings in `src/locales/en.json`, and is covered by `test/basics.js` (real app) and `test/basics-units.js` (pure logic).

| Feature | How to use it |
|---|---|
| **New Window** | `Ctrl+N` / `Cmd+N`, ⋯ → New Window, File → New Window (macOS; works with no window open). Opens a normal window with one new tab, offset from the window in front. |
| **Close Window** | `Ctrl+Shift+W` / `Shift+Cmd+W`, File → Close Window (macOS). |
| **Page info** | Click the lock (or **Not secure**) beside the address, press Enter on it, or go to ⋯ → This Page → Site Information… The menu shows the site and its connection, **Ask / Allow / Block** for location, camera and microphone, notifications and clipboard, the site's remembered zoom with a reset, how many cookies it has, **Clear Cookies and Site Data…** (asks first), and **Site Settings…** |
| **Link and image menu** | Right-click a link for **Open Link in New Window**, **Open Link in Private Window** and **Save Link As…**. Right-click an image for **Save Image As…** and **Copy Image Address**. Save … As always asks where to save, whatever Settings → Downloads says. The page menu gets **Print…**. |
| **Per-site zoom, remembered** | A zoom you set by hand (`Ctrl+=` / `Ctrl+-`) is kept for that site across restarts (`siteZoom` in settings.json). `Ctrl+0` or the zoom pill forgets it. |
| **Crash recovery** | If Lumen didn't quit normally and **On startup** is set to open a new tab or specific pages, the next launch asks "Lumen didn't shut down correctly. Restore the N tabs you had open?" (**Not Now / Restore**). With **Continue where you left off** (the default), the tabs come back anyway, so it doesn't ask. |
| **Keyboard Shortcuts** | `Ctrl+Shift+/` (`Ctrl+?`), ⋯ → Keyboard Shortcuts, or Help → Keyboard Shortcuts on macOS. A sheet lists every shortcut for the platform you're on. |
| **Picture in Picture from the menu** | ⋯ → This Page → Picture in Picture, or View → Picture in Picture on macOS. Plays the page's video (the largest one) in a floating window, and says so when the page has no video. |
| **Esc stops loading** | Press `Esc` in a page that is still loading, as in Chrome. |
| **Site data** | Settings → Privacy and security → Site data lists every site that keeps cookies, grouped by site, with the cookie count, a filter and **Remove** for each (`lumen://settings/site-data`). |
| **Clear browsing data shortcut** | `Ctrl+Shift+Delete` (`Shift+Cmd+Backspace`) opens Settings → Privacy and security. |
| **About Lumen (macOS)** | Lumen → About Lumen shows the version, Electron and Chromium versions, the license and the project's site, instead of Electron's default panel. |

Polish in the same round:

- The error page names what went wrong and what to try for the common network errors ("You're offline", "This site can't be found: check the address for a typo", "refused to connect", "took too long to respond", a redirect loop with a hint to clear the site's cookies, the ad blocker), instead of one "Can't open this page" for all of them.
- English strings that bypassed `t()` now go through it: the page menu's Save Page As and View Page Source, the video menu (Picture in Picture, Open Video in New Tab, Copy Video Address), the spelling items (No Spelling Suggestions, Add to Dictionary), the risky-download prompt, the Open File dialog and the Export Chat dialog.
- Windows high contrast (forced colors): the active and selected tabs, pressed toolbar buttons, the address field, focus rings and Settings' switches stay visible. Before, they were drawn with backgrounds the system flattens.
- Settings → About Lumen has **Copy version details** and **Report a problem**, for bug reports.
- On macOS the UI's shortcut hints read the Mac way (New tab (⌘T), Search tabs (⇧⌘A)) instead of "Ctrl+".
- The lock is now a real, focusable button with a focus ring, an accessible name and `aria-haspopup`. Before, it was a picture with a tooltip.

## Index

| Area | Lumen | Chrome / Edge / Brave | Arc | Safari | Status | Worth it | Effort |
|---|---|---|---|---|---|---|---|
| **Tabs**: pin, mute, duplicate, reopen closed, close others or to the right, move, multi-select | All of them, plus tab search (`Ctrl+Shift+A`) | Same | Same, plus a vertical sidebar | Same | Have | — | — |
| **Tab groups** | By site, by topic, or with AI; Organize Tabs | Manual groups | Spaces and folders | Tab groups | Have (Organize: in Evan's PR #117) | — | — |
| **Tab sleep** | Automatic (`tabSleep`) | Memory Saver, with a "keep active" site list | Auto-archive | Automatic | Partial: no "sleep this tab now" and no always-awake sites | No: rarely asked for, and the automatic rules already skip tabs that play audio or have unsent input | S |
| **Windows** | New window (added), private window, merge, move tabs, restore every window | Same | Same | Same | Have | — | — |
| **Private windows** | Yes | Yes | Yes | Yes | Have (being reworked separately) | — | — |
| **History** | Searchable page, remove an entry, clear by time range | Per-visit timeline, journeys | Same as Chrome | Per-visit | Partial: one entry per address (latest visit), page not localized | Later: a per-visit list needs a new history store | M |
| **Bookmarks** | Ctrl+D, manager, one folder level, HTML import and export | Bar, nested folders, side panel | Pinned tabs replace them | Favorites bar, nested folders | Partial: no bookmarks bar, no nested folders | Yes for the bar: it's the most-noticed missing piece for people coming from Chrome or Safari, though Arc users don't miss it | M |
| **Downloads** | Panel and page, ask where to save, risky files held, Save … As (added) | Same | Same | Same | Have | — | — |
| **Find in page** | Count, next and previous, Esc | Same (no match case either) | Same | Plus match case and "begins with" | Have | Match case: later, small | S |
| **Zoom** | Pill in the address bar, default zoom, per-site zoom remembered (added) | Same, plus a +/− bubble | Same | Same | Have | — | — |
| **Print** | Ctrl+P to the system dialog (Save as PDF is in the system dialog on macOS; Windows has Microsoft Print to PDF) | Built-in preview | System | System | Partial: no print preview on Windows | No: the system dialog already previews on macOS, and a Chromium-style preview is a large UI job | L |
| **Reader mode** | Address-bar button and ⋯ menu | Reading mode side panel | — | Reader | Have (no font or width settings) | Later: font and width controls are small and nice to have | S |
| **Picture in Picture** | Video right-click, ⋯ → This Page, View menu (added) | Same, plus automatic PiP | Automatic when you switch tabs | Same | Have | Automatic PiP on tab switch: later, since it plays video without being asked | S |
| **Site permissions** | Prompt, defaults, per-site list in Settings, page info from the lock (added) | Same | Same | Same | Have (4 kinds: location, camera and microphone, notifications, clipboard) | — | — |
| **Page info / security** | Lock states (secure, mixed, not secure, past a certificate warning), page info (added), certificate warning page | Plus a certificate viewer | Same as Chrome | Plus a certificate viewer | Partial: no certificate viewer | Later: Electron gives no certificate object for a page that loaded fine; it would need a fetch with `ses.setCertificateVerifyProc` | M |
| **Cookies and site data** | Clear all, by time range, or per site from page info or Settings → Site data (both added) | "See all site data" list | Same as Chrome | Manage Website Data | Have | — | — |
| **Clear browsing data** | Settings → Privacy, by time range, `Ctrl+Shift+Delete` (added) | Same | Same | Same | Have | — | — |
| **Privacy toggles** | HTTPS-only, Do Not Track, GPC (on), third-party cookies (requests only), ad and tracker blocker, Safe Browsing (opt-in); on by default: tab-focus and window-size hiding, canvas/WebGL/audio fingerprint noise per site, WebRTC IP protection, tracking-parameter stripping, ping/beacon blocking ([privacy-protections.md](privacy-protections.md)) | Same; Brave blocks by default | Same | ITP | Have (third-party cookie blocking is best effort) | — | — |
| **Settings search** | Yes (`Ctrl+F` or `/` on the page) | Same | Same | Same | Have | — | — |
| **Keyboard shortcuts** | Chrome's set, plus a shortcuts sheet (added) | No sheet | Sheet | Menus only | Have | — | — |
| **Accessibility** | ARIA labels, live regions, reduced motion, focus rings, minimum font size, Windows high contrast (added) | Same, plus caret browsing | Same | Same | Partial: no caret browsing (F7) | Later: rarely used, and Chromium's own caret browsing isn't exposed by Electron | M |
| **Crash recovery** | Session saved as you go, crashed-tab page with Reload, the UI reloads itself, restore offer after a crash (added) | Same | Same | Same | Have | — | — |
| **Session restore** | Continue where you left off (default), new tab, or specific pages; every window | Same | Same | Same | Have | — | — |
| **Default-browser prompt** | One quiet line in the welcome, ⋯ menu item, Settings | Infobar | Asks at setup | Asks | Have (it never nags, on purpose) | — | — |
| **Import** | Bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera, Firefox and Safari; passwords from CSV | Plus passwords, autofill, search engines | Plus passwords and cookies | Plus passwords | Partial: last-used profile only, no passwords from another browser directly | No: reading another browser's passwords or cookies is a security surface Lumen avoids, and CSV covers passwords | M |
| **Extensions** | Chrome Web Store, toolbar actions, remove | Same, plus turn on or off and developer mode | Same | Safari extensions | Partial: no on/off switch, no load unpacked | Later: Electron can't pause an extension; load unpacked is S if developers ask | S |
| **Password manager** | Opt-in; save, fill on click, Touch ID to reveal, CSV import | Same, plus a generator and leak checks | Same | iCloud Keychain | Have (opt-in) | A generator: later | S |
| **Spellcheck** | On by default, suggestions, Add to Dictionary, languages (Windows) | Same | Same | System | Have | — | — |
| **Context menus** | Link, image, video, text, editable and page items, now with New Window, Private Window, Save Link As, Save Image As, Copy Image Address and Print (added) | Same, plus Cast | Same | Same | Have | — | — |
| **Startup and home** | Startup pages; no home button | Optional home button | — | Homepage | Partial | No: the new-tab page is the home, and Arc and Safari's default toolbars have no home button either | S |
| **Full screen** | F11 and macOS full screen | Same, plus presentation mode | Same | Same | Have | — | — |
| **Address bar** | Inline completion, history and seed suggestions, search engine choice, Ask the AI (`Alt+Enter`) | Remote suggestions, site search keywords, paste and go | Same | Same | Partial: no remote search suggestions, no keywords | Remote suggestions: no (they send every keystroke to the search engine, against "private by default"). Keywords: later. Speed is being reworked separately | M |
| **About and version** | Settings → Updates (versions, paths), Internals, macOS About panel (added) | `chrome://version` | Same | About Safari | Have | — | — |
| **Task manager** | Settings → Advanced (every process, memory and CPU) | Shift+Esc window, end process | Same | Activity Monitor | Partial: no end process | Later | S |
| **Fonts** | Font size and minimum font size | Plus font families | Same | Same | Partial | No: rarely changed | S |
| **Media hub and autoplay** | — | Global media controls, autoplay settings | Media controls in the sidebar | Autoplay per site | Missing | Later: a small media button for tabs playing audio would fit the tab strip, which already shows audio | M |
| **Profiles and guest mode** | One profile, plus private windows | Profiles, guest | Spaces with profiles | Profiles | Missing | Later: every store (settings, keys, history) would need a profile root | L |
| **Sync** | — | Google account | Arc account | iCloud | Missing | No: Lumen has no servers of its own (no telemetry, no accounts) | L |
| **Split view** | — | Edge and Chrome split screen | Split view | — | Missing | Later: the sidebar covers the most common side-by-side use | L |
| **Translation** | Your connected AI, or Google Translate with consent | Built in | Built in | Built in, on device | Have (by AI) | On-device (Bergamot): declined by the owner | — |
| **Error pages** | Certificate, HTTPS-only, Safe Browsing, crashed, and network errors with their own wording and hint: offline, site not found, refused, timed out, reset, proxy, redirect loop, blocked (added) | Same, plus an offline game | Same | Same | Partial: the error, history, bookmarks and downloads pages aren't localized | Yes: localize these pages (they need the strings handed in, as the settings page does) | M |
| **Notifications** | Web notifications through the permission prompt; Lumen's own for background tasks | Plus quieter prompts | Same | Same | Have | — | — |
| **Protocol handlers** | http and https, html and pdf files; mailto, tel and sms ask, then open the system app | `registerProtocolHandler` | Same | Same | Partial | No: rarely used, and each handler is a page that can take links from other apps | M |

## Next up

The biggest gaps worth the work, roughly in order:

1. **Bookmarks bar** (M): the one thing Chrome and Safari users notice first.
2. **Localize the remaining pages** (M): error, history, bookmarks, downloads and reader pages, and the English row labels in Settings.
3. **Media controls** for tabs playing audio (M).
4. **Profiles** (L): when there's demand.

Known housekeeping: `npm run lint` reports 16 errors that already fail on `main`: browser-side globals in `src/browser/chrome-identity.js` and `src/browser/google-auth-identity.js`, two renderer globals in `src/renderer/app.js`, and one in `test/windows.js`.

# UX audit: Settings and Lumen's own pages

Scope: Settings (8 categories, search, site permissions including the device permissions, AI providers and sign-in rows, widget editors) and the internal pages (History, Bookmarks, Downloads page and panel, saved passwords, error, certificate, HTTPS-only and Safe Browsing pages, PDF viewer, Reader, print preview, source view, private-window new tab).

Method: a throwaway profile in hidden windows; every Settings category and sub-page, and each internal page, captured at 1280 px and 760 px wide in light and dark and looked at; 40 realistic searches run through the Settings search box; an accessible-name scan of every control. Screenshots are named `settings-<category>-<theme>-<width>.png`, `sub-<page>-<theme>.png` and `page-<name>-<theme>-<width>.png`, in a `before` and an `after` set (kept outside the repository).

Overall: the Settings redesign holds up. Sections are where you expect, labels are sentence case, descriptions clamp with Show more, every control has an accessible name, and light and dark both read well. The problems found are mostly irreversible actions that ask nothing, searches that find nothing, and small inconsistencies between the internal pages.

## Findings, ranked by user impact

Items marked **Fixed** are fixed in this change.

1. **Clear data deletes history, cookies and cache on one click.** Settings > Privacy and security > Clear browsing data. History and cache are ticked by default, so one stray click removes them with no way back. **Fixed**: the button asks "Clear it? Click again" first (the pattern Reset settings and translation packs already use).
2. **Delete all saved passwords deletes every login on one click.** Settings > Privacy and security > Saved passwords. It was also enabled when there were no passwords. **Fixed**: asks twice, and is disabled when the list is empty.
3. **Searches that found nothing sensible.** "default search" found only Reset; "dark mode" found only the experimental website darkening and not Theme; "bluetooth", "pop-ups" and "certificate" found nothing; "location" found Downloads > Location first and no permission; "notifications" found only a collapsed link. **Fixed**: keywords on the search engine, HTTPS-only and site-permission rows, and synonyms (mode = theme, mic, webcam, gps, popup, notification). See the table below. "incognito", "sync" and "print" now answer with an explanatory row (round 2, below).
4. **The History page has no way to clear history.** Bookmarks and Downloads have header buttons; History only had a per-row remove, so clearing a week of history meant knowing to go to Settings. **Fixed**: a Clear browsing data button in the History header opens Settings at Privacy and security.
5. **Raw internal error text in Settings.** When a section can't load (seen on Updates in the test profile), the row showed "Error invoking remote method 'settings:updates-state': Error: No handler registered...". **Fixed**: a plain sentence says what to do, with the cleaned-up detail after it.
6. **Site permissions page repeats its own title.** The page "Site permissions" contained a row "Site permissions" (the list of allowed and blocked sites). **Fixed**: the row is "Allowed and blocked sites". The page was also only reachable by "camera microphone location notifications"; it now also answers to bluetooth, usb, hid, serial, clipboard, pop-ups, gamepad and hardware.
7. **Platform-specific wording.** Saved passwords said "Touch ID where the Mac has it" to Windows users. **Fixed**: "(Touch ID, Windows Hello or your system password)".
8. **Error page button in Title Case.** "Try Again" next to "Go back" and "Back to safety" on the other warning pages. **Fixed**: "Try again".
9. **PDF viewer page buttons were text glyphs.** Previous and next page were drawn as the characters "^" and "v" (the Unicode glyphs are missing from Segoe UI, so they rendered tiny and misaligned). **Fixed**: drawn as chevrons.
10. **Bookmarks heading repeats the page title.** With no folders, the page showed "Bookmarks" over a group called "Bookmarks". **Fixed**: the group heading only appears once there is a folder to tell it apart from.

### Left for later (round 2: all handled)

- **Dead-end DNS error. Fixed.** When a name doesn't resolve, the error page now has a "Search for “host”" button next to Try again; main passes it the default search engine's URL for the host (only for ERR_NAME_NOT_RESOLVED and its alias).
- **"clear history" ranked Widget cards. Fixed.** The cause was a synonym: "history" also meant "clear", so any row with the word "clear" (Widget cards' Clear option) matched. "history" and "cache" now mean only "browsing data". Separately, a sub-page shown in place while searching (Site permissions) had no sort order and always landed after other pages.
- **"camera" and "microphone" listed Put unused tabs to sleep first. Fixed.** Site permissions (Default for new sites) is now ordered by its best row, so it comes first; the sleep row stays below as a weaker match.
- **"incognito", "sync", "print" found nothing. Fixed.** New rows: Privacy and security > Private windows (incognito) (what is and isn't kept, Ctrl+Shift+N); General > Downloads > Printing (no print settings; Ctrl+P previews and prints or saves as PDF); General > Sync across devices (Lumen doesn't sync; bookmarks move by Export on the Bookmarks page and Import, and Import brings data from another browser). A search with no match now also offers clickable suggestions (Privacy, Theme, Downloads, Passwords, Search engine) next to Clear search.
- **AI toggles phrased as negatives. Fixed.** "Don't let the AI act on my pages" is now "Let the AI act on my pages"; "Never switch away from my tab" is "Let the AI bring its tabs to the front"; "Agents in their own window don't ask" is "Ask before agents act in their own window"; "Never put pinned tabs to sleep" is "Keep pinned tabs awake". The three that are inverted show the opposite of the stored value; the saved keys (aiHandsOff, aiStayOnMyTab, agentsNoAsk) and their meaning are unchanged, as are the element ids and the #hands-off link. Descriptions now say what On and Off do.
- **PDF viewer horizontal scrollbar at Fit width. Fixed where it reproduced.** Lumen's own viewer (pdf.js) was measured at 500 to 1400 px wide at Fit width, Fit page, Automatic, 100% and 200%: no horizontal overflow except when zoomed past the width, as expected. The scrollbar the audit saw is in the print preview, which uses Chromium's built-in viewer with #view=FitH; it sized the pages to the full width and the vertical scrollbar then pushed a horizontal one in. It now loads with #zoom=page-width, which does not (checked in a screenshot of the sheet).
- **Reader view, print preview, downloads panel.** These can be driven from a hidden window after all (test hooks __pageTools.toggleReader and __printPreview; the print-preview suite takes LUMEN_SHOT_DIR). Reader (dark, 1200 and 600 px): title, byline, spacing and line length look right, nothing to fix. Print preview: the scrollbar above was the only issue. Downloads panel: test/downloads.js fails before reaching the panel in this environment (an ENOENT reading its temp folder, also on unmodified code), so it was not captured; its own suite and the downloads-panel units still cover its behavior.
- Delete on one saved login and Clear list on Downloads are single click; both are low stakes, left as is.

## Search results (40 realistic searches)

"Before" is the top hit before the fixes; "After" after. NONE means "No settings match".

| Search | Before | After |
|---|---|---|
| dark mode | Dark mode for all websites (experimental) | Theme, then the experimental row |
| default search | Restore settings to their original defaults | Search engine used in the address bar |
| clear cookies | Clear browsing data | same |
| passwords | Save passwords | same |
| block ads | Show ads and trackers blocked | same |
| ai model | Use AI to name and group topics, Model | same (33 hits) |
| downloads folder | Location | same |
| zoom | Page zoom | same |
| language | Preferred languages | same |
| notifications | Site permissions (link) | Default for new sites (permissions page) |
| camera | Put unused tabs to sleep, Site permissions | Default for new sites first, then the sleep row |
| keyboard device | Devices sites can use | same |
| startup | On startup | same |
| tabs sleep | Put unused tabs to sleep | same |
| privacy | Clear browsing data | same |
| spotify | Widgets | same |
| todoist | Widgets | same |
| proxy | Proxy | same |
| reset | Restore settings to their original defaults | same |
| update | Updates (page failed to load in the test profile) | same |
| bluetooth | NONE | Devices sites can use |
| usb | Site permissions | Devices sites can use |
| microphone | Put unused tabs to sleep | Default for new sites first, then the sleep row |
| location | Location (Downloads) | plus Default for new sites |
| pop-ups | NONE | Site permissions |
| clear history | Widget cards, Clear browsing data | Clear browsing data only |
| homepage | On startup | same |
| default browser | Default browser | same |
| text size | Font size | same |
| incognito | NONE | Private windows (incognito) |
| api key | Safe Browsing API key | same |
| font | Page zoom, Font size | same |
| sync | NONE | Sync across devices |
| do not track | Send a "Do Not Track" request | same |
| safe browsing | Warn about dangerous sites | same |
| certificate | NONE | Always use secure connections |
| print | NONE | Printing |
| pdf | Open PDFs with | same |
| spell check | Check spelling when you type | same |
| vpn | Proxy | same |

## What was checked and is fine

- Every button, input, switch and link in all categories and sub-pages has an accessible name.
- Dangerous actions already confirmed: Reset settings (arms for 4 seconds), translation pack delete, and Continue past a certificate or Safe Browsing warning (Lumen's own dialog).
- Error pages explain the problem in plain words and show the technical code last; the certificate, HTTPS-only and Safe Browsing pages share layout and a "go back" primary action with a quiet link for the risky choice.
- History, Bookmarks and Downloads share header, search box and empty-state wording.
- The private-window new tab states plainly what is and isn't kept.

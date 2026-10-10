# UX audit: Settings and Lumen's own pages

Scope: Settings (8 categories, search, site permissions including the device permissions, AI providers and sign-in rows, widget editors) and the internal pages (History, Bookmarks, Downloads page and panel, saved passwords, error, certificate, HTTPS-only and Safe Browsing pages, PDF viewer, Reader, print preview, source view, private-window new tab).

Method: a throwaway profile in hidden windows; every Settings category and sub-page, and each internal page, captured at 1280 px and 760 px wide in light and dark and looked at; 40 realistic searches run through the Settings search box; an accessible-name scan of every control. Screenshots are named `settings-<category>-<theme>-<width>.png`, `sub-<page>-<theme>.png` and `page-<name>-<theme>-<width>.png`, in a `before` and an `after` set (kept outside the repository).

Overall: the Settings redesign holds up. Sections are where you expect, labels are sentence case, descriptions clamp with Show more, every control has an accessible name, and light and dark both read well. The problems found are mostly irreversible actions that ask nothing, searches that find nothing, and small inconsistencies between the internal pages.

## Findings, ranked by user impact

Items marked **Fixed** are fixed in this change.

1. **Clear data deletes history, cookies and cache on one click.** Settings > Privacy and security > Clear browsing data. History and cache are ticked by default, so one stray click removes them with no way back. **Fixed**: the button asks "Clear it? Click again" first (the pattern Reset settings and translation packs already use).
2. **Delete all saved passwords deletes every login on one click.** Settings > Privacy and security > Saved passwords. It was also enabled when there were no passwords. **Fixed**: asks twice, and is disabled when the list is empty.
3. **Searches that found nothing sensible.** "default search" found only Reset; "dark mode" found only the experimental website darkening and not Theme; "bluetooth", "pop-ups" and "certificate" found nothing; "location" found Downloads > Location first and no permission; "notifications" found only a collapsed link. **Fixed**: keywords on the search engine, HTTPS-only and site-permission rows, and synonyms (mode = theme, mic, webcam, gps, popup, notification). See the table below. Still empty: "incognito", "sync", "print" (no such setting; see "Left for later").
4. **The History page has no way to clear history.** Bookmarks and Downloads have header buttons; History only had a per-row remove, so clearing a week of history meant knowing to go to Settings. **Fixed**: a Clear browsing data button in the History header opens Settings at Privacy and security.
5. **Raw internal error text in Settings.** When a section can't load (seen on Updates in the test profile), the row showed "Error invoking remote method 'settings:updates-state': Error: No handler registered...". **Fixed**: a plain sentence says what to do, with the cleaned-up detail after it.
6. **Site permissions page repeats its own title.** The page "Site permissions" contained a row "Site permissions" (the list of allowed and blocked sites). **Fixed**: the row is "Allowed and blocked sites". The page was also only reachable by "camera microphone location notifications"; it now also answers to bluetooth, usb, hid, serial, clipboard, pop-ups, gamepad and hardware.
7. **Platform-specific wording.** Saved passwords said "Touch ID where the Mac has it" to Windows users. **Fixed**: "(Touch ID, Windows Hello or your system password)".
8. **Error page button in Title Case.** "Try Again" next to "Go back" and "Back to safety" on the other warning pages. **Fixed**: "Try again".
9. **PDF viewer page buttons were text glyphs.** Previous and next page were drawn as the characters "^" and "v" (the Unicode glyphs are missing from Segoe UI, so they rendered tiny and misaligned). **Fixed**: drawn as chevrons.
10. **Bookmarks heading repeats the page title.** With no folders, the page showed "Bookmarks" over a group called "Bookmarks". **Fixed**: the group heading only appears once there is a folder to tell it apart from.

### Left for later

- Dead-end DNS error: the page says "search for the site instead" but only offers Try again. A "Search for it" button needs the error page to know the user's search engine.
- "clear history" lists "Widget cards" ahead of Clear browsing data (a Widgets description mentions history).
- "camera" and "microphone" list "Put unused tabs to sleep" first because its description mentions them; correct, but not what the person wants.
- No Settings entry for "incognito" or "private browsing". The private window's rules are only explained on its own new-tab page. A one-line row under Privacy and security would help.
- Several AI toggles are phrased as negatives ("Don't let the AI act on my pages", "Never switch away from my tab"): on means restricted. Positive phrasing would read more clearly but changes saved meaning, so it needs a design pass.
- PDF viewer: with Fit width a horizontal scrollbar shows in the test capture; worth checking in a real window.
- The Reader view and print preview could not be driven from a hidden test window here (no application menu), so they were reviewed in code and by their existing tests only. The Downloads panel is a separate popup view and could not be captured while hidden.
- Delete on one saved login and Clear list on Downloads are single click; both are low stakes.

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
| camera | Put unused tabs to sleep, Site permissions | permission rows included |
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
| microphone | Put unused tabs to sleep | permission rows included |
| location | Location (Downloads) | plus Default for new sites |
| pop-ups | NONE | Site permissions |
| clear history | Widget cards, Clear browsing data | same |
| homepage | On startup | same |
| default browser | Default browser | same |
| text size | Font size | same |
| incognito | NONE | NONE |
| api key | Safe Browsing API key | same |
| font | Page zoom, Font size | same |
| sync | NONE | NONE |
| do not track | Send a "Do Not Track" request | same |
| safe browsing | Warn about dangerous sites | same |
| certificate | NONE | Always use secure connections |
| print | NONE | NONE |
| pdf | Open PDFs with | same |
| spell check | Check spelling when you type | same |
| vpn | Proxy | same |

## What was checked and is fine

- Every button, input, switch and link in all categories and sub-pages has an accessible name.
- Dangerous actions already confirmed: Reset settings (arms for 4 seconds), translation pack delete, and Continue past a certificate or Safe Browsing warning (Lumen's own dialog).
- Error pages explain the problem in plain words and show the technical code last; the certificate, HTTPS-only and Safe Browsing pages share layout and a "go back" primary action with a quiet link for the risky choice.
- History, Bookmarks and Downloads share header, search box and empty-state wording.
- The private-window new tab states plainly what is and isn't kept.

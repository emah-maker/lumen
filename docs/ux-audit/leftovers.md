# UX audit: the "left for later" items, checked against main (after v0.5.25)

Every "Left", "Not done", "Missing" or "left for later" item in `docs/ux-audit/*.md` was checked against `origin/main` (code read, and the new fixes driven in the real app, hidden). "Already fixed in #n" is from `git log` plus the code. Areas owned by other agents this round (first run and onboarding, performance and console errors) were not touched.

## Fixed now

| Item | Status |
|---|---|
| settings-pages: Delete on one saved login is a single click | fixed now: asks "Delete? Click again" (Settings, Saved passwords); `test/e2e/passwords.js` |
| settings-pages: Clear list (Recent downloads) is a single click | fixed now: same two-click pattern, now that the list holds up to 1000 entries |
| chat-features-2 "known limits": the "Switched to X" divider is not saved | fixed now: a reopened chat draws it again before the first message the new model answered (never for replies Auto chose); `test/e2e/chat-features2.js` |

## Already fixed

| Item | Status |
|---|---|
| ai-surfaces-polish: Claude API 400 shows raw JSON | already fixed in #402 (`apiErrorText` in `src/ai/agent.js` uses the body's message) |
| chrome-polish: internal pages show an empty address bar, no Undo on removing a bookmark or download, only 50 downloads, English baked into the warning pages, camera and microphone asked as one | already fixed in #403 |
| chrome.md items 1 to 8 and chrome-polish "Left" labelled as fixed in round 2 | already fixed in #383, #399, #403 |
| settings-pages round 2 (DNS dead end, search ranking, incognito/sync/print rows, negative toggles, PDF scrollbar) | already fixed in #382 |
| pages-polish: Add page silently ignoring input, Proxy saved empty, port echo, `lumen://history` etc. | already fixed in #397 |
| newtab: all 14 findings (round 2 items too) | already fixed in #376 and #385 |
| chat-features gaps 1 to 4, 14 (partly), 16, 18, 19, 20, 35, 38 to 43 (edit and version any message, copy on your own bubbles, Continue after Stop, timestamps, per-reply model after reopen, thumbs, undo delete, Ctrl+K, Up to edit, Ctrl+Shift+C, per-chat drafts, long message collapse) | already fixed in #401, #402, #404 |
| chat-features gaps 7 to 11, 13 and bugs B1 to B6, B15 (more highlight languages, code wrap, tables with a fit mode, Mermaid, quotes, nested lists, citations) | already fixed in #400 |
| chat-features gaps 30 to 34, 36 (search, pin, projects, archive, PDF and Markdown export), B10, B11 | already fixed in #401 and #416 |
| chat-features B7, B8, B12, B13, B16 to B18, gap 27 (read aloud), 37 (custom instructions), 12 (canvas) | already fixed in #396, #402, #404, #416 |
| chat-features-2: search hit jump, retry with another model, Stop then Edit, title in the header | already fixed in #416 |

## Skipped

| Item | Status |
|---|---|
| Ctrl+K / Ctrl+E from the address bar, Ctrl+Shift+B | skipped: deliberate (Lumen's key handler runs before the page and would break Notion, Slack, GitHub and Linear palettes; there is no bookmarks bar) |
| Alt+Home on web pages | skipped: Lumen has no home page setting or Home button; the new tab is home |
| Toast in the tab strip pushes Organize along (chrome.md 9) | skipped: recorded design decision (a floating toast would cover page content) |
| The ⋯ menu is long (chrome.md 10) | skipped: recorded decision, sections are intended |
| Follow-up suggestion chips | skipped: a second model call per reply (token cost); needs an opt-in setting |
| Memory across chats | skipped: needs a review page, off switch and a prompt-injection story |
| Project files | skipped: needs its own storage and size limits |
| Voice dictation | skipped: no confirmed speech backend in Electron without Google keys |
| Share links, connected apps, scheduled tasks for teammates | skipped: need a server or accounts |
| Per-step Stop in the AI sidebar | skipped: a tool call has no abort handle; Stop stays the whole run |
| Model-generated chat titles | skipped: a paid call per chat; titles are made locally |
| Test-site artifact (sidebar.md 7) | skipped: needs a normal profile; the test hook is unchanged |
| Chat page "In 2 tabs: ..., This tab" row text | skipped: "This tab" is literally correct; the wording needs a decision about chat-page tabs |
| Chat page has no Helpers, Tasks, Research entries | skipped: recorded decision (sidebar-only) |
| Thinking shown as plain text, file chips without a preview, citation hover cards | skipped: small value; each needs its own design |
| `&&` in native menu labels, the toolbar download panel, Settings under 800 px | skipped: native menus and an off-screen view cannot be captured; the layout was covered by earlier audits |
| About page links, "AI starts on Auto when Claude Code is signed in" | skipped: fine as is, expected |
| Welcome and first-run steps, AI setup, the first new tab | skipped: owned by another agent this round |

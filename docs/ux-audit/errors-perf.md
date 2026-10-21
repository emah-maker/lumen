# Errors and performance: a robustness pass on 0.5.25

Measured on `origin/main` at 0.5.25 (a05a7a40), hidden window, throwaway profile, a busy shared Windows machine, so read the numbers as ratios, not absolutes.

## 1. Error sweep

`test/no-errors.js` (new, in `npm test`) launches Lumen through a tiny entry point that loads `test/_no-errors-hook.js` before `main.js`. The hook records, to a file, every `console.error` / `console.warn` and uncaught exception or rejection in the main process, every warning or error logged by every web contents (the chrome UI, sidebar, new tab and widgets, Settings, History, Downloads, Bookmarks, the chat page and canvas, the PDF and slide viewers, error pages, sleeping and woken tabs), plus render-process crashes, preload errors and failed main-frame loads. The suite also reads the process's stderr.

The session it drives: 15+ tabs (11 local pages, a PDF, a deck, a local file, a refused address for the error page), switching through all of them, sidebar open/close, two chat messages through a fake client, the chat page and an HTML reply opened in the canvas, Organize, History, Bookmarks, Downloads, every Settings section and the Settings search, dark mode, three resizes, a new tab, eight tabs put to sleep and woken, quit. It fails on anything not in its `ALLOW` list, and every entry there has a reason (the deliberate refused address and what Electron and Chromium print about it, the DevTools attach line Playwright causes, GPU-less test noise).

### Found, and fixed at the source

| # | What was logged | Cause | Fix |
|---|---|---|---|
| 1 | About 60 `MaxListenersExceededWarning: 11 did-navigate / did-start-navigation / destroyed ... listeners added to [WebContents]` per session, one burst per tab | Every feature that watches a tab adds its own listener; there are 11 or more per tab, a fixed number, and Node's default limit is 10 | `wc.setMaxListeners(40)` in `wireView` (main.js), with the reason in a comment. The count is bounded per tab, so this is not a leak |
| 2 | `did-fail-load -2 ERR_FAILED` for `lumen-pdf://app/viewer.html?...` on every PDF opened from the disk, then the error page failing to load itself about 180 times in a row, each with a longer address (`error.html?url=error.html?url=...`) | The PDF router swapped the address to the viewer inside `did-start-navigation`, while the first navigation was still starting, and Chromium refused. The failure handler then loaded the error page, which failed for the same reason, and each failure scheduled another error page | (a) `pdf-viewer.js`: the swap is deferred one tick (`setImmediate`). (b) `openTab` loads a PDF or a local deck straight at its viewer instead of loading the file first. (c) `tabFailPage` and `popupFailPage` never build an error page for a failure of the error page itself |
| 3 | `Electron sandboxed_renderer.bundle.js script failed to run` / `Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null`, two per session, intermittently | The renderer started for the first navigation of a PDF or deck (a file that is then swapped for the viewer, or turned into a download) is torn down before it finishes starting | Gone with (b) above: there is no first navigation to cancel. Three clean runs in a row after the change; it showed in 2 of 4 runs before |
| 4 | `injectExtensionAPIs error (chrome-extension://.../index.html)` / `Cannot bind an API on top of an existing property` on the PDF | Chrome's own PDF viewer started because #2 left the file page standing | Gone with #2 |

### Test-environment artefacts (allowlisted, with reasons)

- `electron: Failed to load URL: http://127.0.0.1:<port>/refused with error: ERR_CONNECTION_REFUSED`: Electron itself reports a refused main-frame load even though Lumen catches the rejection. The session opens that address on purpose to show the error page.
- `Waiting for the debugger to disconnect...` (Playwright's attach), and the `--trace-warnings` hint line that follows the line above.
- Chromium GPU / network-service lines on a GPU-less run.

Before the fixes a session logged 28 distinct unexpected lines (hundreds of repeats). After: none, in three consecutive runs.

### Not covered

Real-profile behaviours (the user's Spotify, Apple Music, Gmail and extension setups) were not driven: the rules for this pass keep tests on a throwaway profile, and those services need accounts. Their diagnostic lines (`[spotify]`, `[lumen]` and the like) never fire in this session; they are untouched. The `[lumen] ... had no response` stuck-load line is also kept.

## 2. Performance

`scripts/measure/measure-perf.js` and a purpose-built script were run against v0.5.22 (a `git worktree` at the tag) and the current tree, alternating, three runs each; the median is shown, the first run of each is slower (cold disk cache).

| Metric | 0.5.22 | 0.5.25 + this change |
|---|---|---|
| First paint of the browser UI | not recorded in 0.5.22 | about 540 ms |
| UI visible after launch | 648 ms | 601 ms |
| Toolbar interactive (new-tab button enabled) | 727 ms | 723 ms |
| Main process `uiReady` mark | 550 ms | 535 ms |
| Project modules loaded at startup | 300 | 315 (budget 335) |
| Idle `setInterval` timers | 2 | 2 |
| Memory after startup (all processes, working set) | 826 MB | 859 MB |
| Memory with 15 tabs | 2513 MB | 2606 MB |
| Idle CPU, 15 tabs with the new tab page open | 0.2% | 0.1% |
| Opening the sidebar (click to painted frame) | 5 ms | 7 ms |
| Idle CPU with the sidebar open | 0.3% | 0.5% |
| Opening the chat page (click to content) | 304 ms | 236 ms |
| Memory added by the chat page | 127 MB | 129 MB |
| Idle CPU with the chat page open | 0.1% | 0.1% |

Run-to-run spread on this machine is larger than most of these differences (the 15-tab memory ranged 2414 to 2564 MB on 0.5.22 alone), so the honest reading is: no measurable regression in startup, idle CPU, the sidebar or the chat page; the app holds about 15 more modules and about 30 MB more at rest (the larger UI bundle: 950 KB budget, Markdown blocks, canvas, projects), and 15 tabs cost about the same.

### The features named in the brief, by reading the code

- **Chat page redesign, Projects, canvas:** the page's scripts load only in `lumen://chat`; the sidebar bundle holds the shared pieces. `startStepClock` (chat-core.js) is a 1 s interval that clears itself when no step is running. Mermaid (3.5 MB) loads on the first diagram only.
- **ai-files:** there is no watcher. `features/ai-files.js` has no timers; it resolves and stats at most 24 candidates per reply, and previews are read on demand.
- **Stuck-load guard:** one `unref`'d timer per tab, armed only while one of Lumen's own pages is loading and cleared on `did-navigate`, `did-stop-loading` and `destroyed`.
- **Organize file reads, music view:** the music engine's unload timer runs only while a music view exists. Nothing eager showed up at startup (the startup module list gained small pure modules only: `file-tabs`, `shared-files`, `stuck-load`, `profile-guard`, `hide-activity`, `device-chooser`, `ai-files`, and so on). `markdown.js` is required lazily in main.
- `test/perf-budget.js` still passes (uiKB 950, modules 335).

Nothing was changed for performance: there was no obvious eager load, forgotten timer or leaking listener to fix. The one listener finding (#1 above) is a warning, not a leak.

## Logs

The session's main-process output is empty apart from the items above: no repeated or noisy lines remain. The previous log held about 60 listener warnings and the Electron load-failure line per refused address.

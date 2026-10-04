# Architecture

A short map of how Lumen is put together, for anyone reading or changing the code. The [Layout](../README.md#layout) section of the README lists every file; this page explains how the pieces fit.

Lumen is an Electron app with no bundler or framework: plain CommonJS in the main process and plain `<script>` files in its pages.

## Processes

```
Lumen.exe (main process: main.js)
├── UI window: one BrowserWindow showing src/renderer/index.html (tab strip, address bar, sidebar)
│   ├── tab views: one WebContentsView per tab, each a normal Chromium renderer
│   ├── suggestions view: the address-bar dropdown (src/renderer/suggest.html)
│   └── dialog view: Lumen's own alert/confirm/permission cards (src/renderer/dialog.html)
├── hidden reader views: background reading and web search for the AI, in a separate in-memory session
├── Chromium's GPU, network and utility processes
└── optional children: the Claude Code, Grok Build or Antigravity CLI when that engine is chosen
```

- **`src/main.js`** owns the window, the tabs array, sessions, menus, IPC and the startup order. Larger areas live in `src/features/` and in top-level modules (`src/ai/agent.js`, `src/browser/tab-groups.js`, `src/settings/settings-backend.js`, …) that `src/main.js` wires up with small dependency objects.
- **One running copy per profile.** A second launch hands its arguments (links, files) to the first and exits (`src/features/instance.js`).
- **Settings and state** live in `settings.json` in the profile folder, written atomically (`src/settings/settings-file.js`). See the [settings reference](settings.md).

## The UI and the tabs

- The browser's own UI is a local page, `src/renderer/index.html`, with a preload (`src/preload/preload.js`) that exposes a narrow bridge (`window.browser`, plus `lumenPrefs` and `lumenUpdates`) to the main process.
- **Tabs are separate `WebContentsView`s** laid over the UI window. The UI tells the main process where the content area is; the main process positions the active tab there. Web pages never share a renderer with the UI.
- **IPC gate.** Every IPC handler checks who sent the message. Privileged calls (keys, sign-ins, what outside programs may do) and UI-only calls answer only Lumen's own UI and, where relevant, its settings page. Web pages in tabs can't reach them.
- **Lumen's own pages** (settings, history, new tab, error and HTTPS-only pages) are local files loaded in ordinary tabs. Only the page that needs it gets its preload (for example `src/preload/settings-preload.js` for `lumen://settings`), and those tabs can't navigate elsewhere.
- **Preloads for web pages** are registered per session: page dialogs (`src/preload/page-dialogs-preload.js`), readable dropdowns on dark sites, the ad blocker's scriptlets, extension helpers and the Chrome Web Store fix.

## The AI in the sidebar

- **`src/ai/agent.js`** runs the agent loop in the main process: it sends the chat to the chosen model, runs the tools it asks for, and streams events to the sidebar.
- **Engines.** Claude through Anthropic's SDK; OpenAI, Grok, Gemini and OpenRouter through `src/ai/providers.js`, which converts the conversation to and from Chat Completions. "Your account" engines run the user's own CLI headless and let it call Lumen's tools over MCP: `src/ai/claude-code.js` (Claude Code) `src/ai/grok-build.js` (Grok Build, experimental) and `src/ai/antigravity.js` (Google Antigravity's `agy`, which replaces Gemini CLI; experimental). Each is launched with Lumen's tools only (see [settings](settings.md#antigravity-in-the-sidebar)).
- **Auto model.** The picker's first row, **Auto**, lets Lumen choose the model per message with a pure, local router (`src/ai/auto-model.js`): tiers, availability, escalation. See [auto-model.md](auto-model.md).
- **Tools** are defined once in `src/ai/agent.js` (`TOOLS`) and shared with every engine and with MCP clients. Page scripts live in `src/ai/page-scripts.js`; the token-efficient tools (`compact` reads, diffs, `find`, `batch`) are in `src/ai/snapshot.js`. Embedded frames (iframes, out-of-process ones included) are read and acted on in `src/ai/frames.js`: each in a named isolated world created through the tab's DevTools session (the frame's own session for an out-of-process frame), with element ids that name the frame (frame n's element k is `n * 100000 + k`). The full list is in the [MCP tool reference](mcp-tools.md).
- **Approval gate.** The first time the AI acts on a site in a chat, the sidebar shows an approval card. Once the AI has read page content, opening, fetching or searching a site not yet approved in that chat asks too. Approvals last for the chat. Content from pages is treated as untrusted data. What is asked and when: [Asking before it acts](../README.md#asking-before-it-acts).
- **A chat per tab** (`src/features/tab-chats.js`, the "[chat per tab]" section of `src/main.js`). Each tab is bound to a chat id; the sidebar shows the chat of the tab in front, and each window's sidebar follows its own front tab. A new tab starts with its own empty chat, except that the one chat no tab holds (the last chat after a restart, or one whose tab closed) is adopted by the tab you are on. Each chat runs on its own messages array and its own task scope pinned to the tab it started in, so tools act on that tab, never on whichever tab is in front; `open_tab` and `switch_tab` only bring a tab to the front when the user is looking at the run's own tab. Chats work at the same time up to a setting (default 3, `maxChatRuns`); the next waits in line (`createRunSlots`), and Claude Code and Grok Build take turns one chat at a time, because their tool calls come back over one MCP connection that finds its run through a single pin. Model fallback cooldowns stay shared. Bindings are saved with the session by tab order (`session.chats`), a tab that moves to another window keeps its chat, and a chat whose tab closes while it works carries on in a background tab.
- **Background reading** (`read_urls`, `web_search`) uses hidden views in an in-memory session with none of the user's cookies. That session refuses permission requests and downloads. The exception is `read_urls` with `as_user` (`src/features/signed-in-sites.js`): after the user allows a host (once, or always from Settings → You and AI; banks, payments and password managers only once), that page is read in a background tab of the user's own session, locked to that host (any redirect elsewhere is read signed out instead) and closed when the run ends. Outside agents over MCP and background tasks never get it.

## Outside agents

- **MCP** (`mcp.js`, `src/features/ai-agents.js`): CLI agents start a small stdio bridge (Lumen's executable in Node mode running `mcp.js`). The bridge connects to the running Lumen over a per-user local channel (a named pipe on Windows, a Unix socket elsewhere) and proves it can read a random token in the profile folder with an HMAC challenge-response. Tool calls then go through the same tools and the same approval cards as the sidebar. Grok Build instead reaches the same tools over local HTTP with a per-run token (`src/automation/mcp-http.js`), and Lumen checks each of its tool calls before it runs.
- **Automation (CDP)** (`src/automation/automation.js`, `src/automation/launcher.js`): off by default. When on, a proxy on `127.0.0.1` with a secret token in its URL serves the Chrome DevTools Protocol to Playwright and similar tools. It shows only the user's tabs and turns "new page" into a real Lumen tab. On Windows and Linux `src/automation/launcher.js` starts the browser with `--remote-debugging-pipe`, so the proxy talks to Chromium over a private pipe. On macOS a launcher would lose the `open-url`/`open-file` events LaunchServices sends to the process it started, so `src/automation/cdp-inproc.js` stands in for Chromium's browser-level connection inside Lumen (Electron's `webContents.debugger` per tab, flat sessions mapped per client); the same proxy filters run on top of it. Either way no debugging port is opened. `LUMEN_AUTOMATION_INPROC=1` selects the in-process backend on any platform (the tests use it).

## Browsing features

- **Extensions** (`electron-chrome-extensions`, `electron-chrome-web-store`): Chrome Web Store installs, the toolbar's extension buttons and the `chrome.*` APIs extensions need. Lumen shows its own install dialog with the permissions an extension asks for (`src/browser/extension-permissions.js`).
- **Ad blocking** (`src/features/adblock.js`): runs in the main process with uBlock Origin-compatible lists, so pages see no extension or injected globals.
- **Page info** (`src/features/page-info.js`): the lock's menu, a native menu drawn outside the page, reading and changing the same per-site permission decisions as Settings. **Site data** (`src/features/site-data.js`: Settings' list of sites with cookies), **per-site zoom** (`src/features/site-zoom.js`), **crash recovery** (`src/features/crash-recovery.js`: a `running` marker in the profile folder), the **Keyboard Shortcuts** sheet (`src/features/shortcuts-help.js`) and the link and image menu items (`src/features/link-menu.js`).
- **Downloads** (`src/features/downloads.js`), **dialogs** (`src/features/dialogs.js`), **tab groups** (`src/browser/tab-groups.js`), **search engines** (`src/browser/search.js`), **history and favicons** (`src/browser/favicon-store.js`), **import from other browsers** (`src/browser/importer.js`).

## Updates

`src/features/updates.js` looks for a new version on GitHub Releases (`electron-updater` only reads `latest.yml` / `latest-mac.yml`; it downloads and installs nothing). It checks the download's SHA-512 against the release's entry for the zip.

- Every copy that can write to its install location (Windows setup per-user install, zip or hand-copied folder; the Mac app in a writable Applications folder) downloads the release zip for its platform in the app, unpacks it next to the install, and swaps it in on restart (`src/features/zip-update.js`). Windows runs the swap with a byte-identical copy of the signed `Lumen.exe` in Node mode running `src/features/swap-helper.js`, so Smart App Control has no script or unsigned binary to block; macOS uses a shell script that also clears quarantine flags. The profile is never touched, the NSIS uninstaller is carried over, and a failed swap keeps the old version and shows why in Settings.
- Per-machine installs, unwritable Mac apps, the portable exe and Linux show a Download button (zip, dmg or the releases page) instead. Lumen never runs an installer.
- Updates never run in development runs (`electron .`), test mode or the MCP bridge.

## Build and tests

- `scripts/build.js` packages with electron-builder. `Lumen.exe` stays byte-identical to Electron's own binary, so the icon comes from shortcuts and the window rather than the executable.
- Tests in `test/` drive the real app with Playwright's Electron support and a throwaway profile (`CLAUDE_BROWSER_TEST=1`, `CLAUDE_BROWSER_PROFILE=<folder>`). Test mode only works in a development run (`src/test-mode.js`); a packaged Lumen ignores it. `test/units.js` covers the logic that doesn't need a window. `npm test` (`scripts/test-all.js`) runs the core suites one at a time and reports every failure. `npm run test:units` (`scripts/test-units.js`) runs only the pure-node suites; CI (`.github/workflows/ci.yml`) and the release build run it.

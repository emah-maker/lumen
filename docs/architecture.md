# Architecture

A short map of how Lumen is put together, for anyone reading or changing the code. The [Layout](../README.md#layout) section of the README lists every file; this page explains how the pieces fit.

Lumen is an Electron app with no bundler or framework: plain CommonJS in the main process and plain `<script>` files in its pages.

## Processes

```
Lumen.exe (main process: main.js)
├── UI window: one BrowserWindow showing renderer/index.html (tab strip, address bar, sidebar)
│   ├── tab views: one WebContentsView per tab, each a normal Chromium renderer
│   ├── suggestions view: the address-bar dropdown (renderer/suggest.html)
│   └── dialog view: Lumen's own alert/confirm/permission cards (renderer/dialog.html)
├── hidden reader views: background reading and web search for the AI, in a separate in-memory session
├── Chromium's GPU, network and utility processes
└── optional children: the Claude Code or Grok Build CLI when that engine is chosen
```

- **`main.js`** owns the window, the tabs array, sessions, menus, IPC and the startup order. Larger areas live in `features/` and in top-level modules (`agent.js`, `tab-groups.js`, `settings-backend.js`, …) that `main.js` wires up with small dependency objects.
- **One running copy per profile.** A second launch hands its arguments (links, files) to the first and exits (`features/instance.js`).
- **Settings and state** live in `settings.json` in the profile folder, written atomically (`settings-file.js`). See the [settings reference](settings.md).

## The UI and the tabs

- The browser's own UI is a local page, `renderer/index.html`, with a preload (`preload.js`) that exposes a narrow bridge (`window.browser`, plus `lumenPrefs` and `lumenUpdates`) to the main process.
- **Tabs are separate `WebContentsView`s** laid over the UI window. The UI tells the main process where the content area is; the main process positions the active tab there. Web pages never share a renderer with the UI.
- **IPC gate.** Every IPC handler checks who sent the message. Privileged calls (keys, sign-ins, what outside programs may do) and UI-only calls answer only Lumen's own UI and, where relevant, its settings page. Web pages in tabs can't reach them.
- **Lumen's own pages** (settings, history, new tab, error and HTTPS-only pages) are local files loaded in ordinary tabs. Only the page that needs it gets its preload (for example `settings-preload.js` for `lumen://settings`), and those tabs can't navigate elsewhere.
- **Preloads for web pages** are registered per session: page dialogs (`page-dialogs-preload.js`), readable dropdowns on dark sites, the ad blocker's scriptlets, extension helpers and the Chrome Web Store fix.

## The AI in the sidebar

- **`agent.js`** runs the agent loop in the main process: it sends the chat to the chosen model, runs the tools it asks for, and streams events to the sidebar.
- **Engines.** Claude through Anthropic's SDK; OpenAI, Grok, Gemini and OpenRouter through `providers.js`, which converts the conversation to and from Chat Completions. "Your account" engines run the user's own CLI headless and let it call Lumen's tools over MCP: `claude-code.js` (Claude Code) and `grok-build.js` (Grok Build, experimental).
- **Tools** are defined once in `agent.js` (`TOOLS`) and shared with every engine and with MCP clients. Page scripts live in `page-scripts.js`; the token-efficient tools (`compact` reads, diffs, `find`, `batch`) are in `snapshot.js`. The full list is in the [MCP tool reference](mcp-tools.md).
- **Approval gate.** The first time the AI acts on a site in a chat, the sidebar shows an approval card. Once the AI has read page content, opening, fetching or searching a site not yet approved in that chat asks too. Approvals last for the chat. Content from pages is treated as untrusted data. What is asked and when: [Asking before it acts](../README.md#asking-before-it-acts).
- **Background reading** (`read_urls`, `web_search`) uses hidden views in an in-memory session with none of the user's cookies. That session refuses permission requests and downloads.

## Outside agents

- **MCP** (`mcp.js`, `features/ai-agents.js`): CLI agents start a small stdio bridge (Lumen's executable in Node mode running `mcp.js`). The bridge connects to the running Lumen over a per-user local channel (a named pipe on Windows, a Unix socket elsewhere) and proves it can read a random token in the profile folder with an HMAC challenge-response. Tool calls then go through the same tools and the same approval cards as the sidebar.
- **Automation (CDP)** (`automation.js`, `launcher.js`): off by default. When on, a proxy on `127.0.0.1` with a secret token in its URL serves the Chrome DevTools Protocol to Playwright and similar tools. It shows only the user's tabs and turns "new page" into a real Lumen tab. On Windows and Linux, `launcher.js` starts the browser with `--remote-debugging-pipe`, so the proxy talks to Chromium over a private pipe and no debugging port is opened.

## Browsing features

- **Extensions** (`electron-chrome-extensions`, `electron-chrome-web-store`): Chrome Web Store installs, the toolbar's extension buttons and the `chrome.*` APIs extensions need. Lumen shows its own install dialog with the permissions an extension asks for (`extension-permissions.js`).
- **Ad blocking** (`features/adblock.js`): runs in the main process with uBlock Origin-compatible lists, so pages see no extension or injected globals.
- **Downloads** (`features/downloads.js`), **dialogs** (`features/dialogs.js`), **tab groups** (`tab-groups.js`), **search engines** (`search.js`), **history and favicons** (`favicon-store.js`), **import from other browsers** (`importer.js`).

## Updates

`features/updates.js` uses `electron-updater` with GitHub Releases. It reads `latest.yml` / `latest-mac.yml` from the newest release and checks the download's SHA-512 against it.

- A Windows copy installed with the setup program downloads updates in the background and installs on restart.
- A Windows zip copy and macOS say when a new version is out and download the zip or disk image when asked.
- Updates never run in development runs (`electron .`), test mode or the MCP bridge.

## Build and tests

- `scripts/build.js` packages with electron-builder. `Lumen.exe` stays byte-identical to Electron's own binary, so the icon comes from shortcuts and the window rather than the executable.
- Tests in `test/` drive the real app with Playwright's Electron support and a throwaway profile (`CLAUDE_BROWSER_TEST=1`, `CLAUDE_BROWSER_PROFILE=<folder>`). Test mode only works in a development run (`test-mode.js`); a packaged Lumen ignores it. `test/units.js` covers the logic that doesn't need a window.

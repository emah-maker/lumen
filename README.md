# Lumen

A Chromium browser (Electron) with a Claude sidebar that can read the current page and act on it: click, type, scroll, open tabs, search the web.

## Run

```
npm install
npm start
```

## Install as a Windows app

```
npm run dist         # builds distwin-unpacked
npm run install_app  # copies it to %LOCALAPPDATA%ProgramsLumen, adds Desktop + Start menu shortcuts
```

The app ships the official Electron `.exe` byte for byte (`signAndEditExecutable: false`, `asar: false`, `electronDist` from node_modules). Windows 11 Smart App Control blocks unsigned executables it doesn't recognise, and editing the exe (icon, version info, asar integrity), or an NSIS installer, produces exactly that. The untouched Electron binary is recognised, so it runs. The window and taskbar use the app icon at runtime. To ship a normal installer instead, sign the build with a trusted code-signing certificate.

Add your Anthropic API key with the gear icon in the Claude sidebar (stored encrypted with the OS keychain), or set `ANTHROPIC_API_KEY` before launching.

## Use

| Action | How |
|---|---|
| Open or close Claude | `Ctrl+J` or the Claude button |
| Ask Claude from the address bar | type, then `Alt+Enter` |
| New tab / close tab / focus address | `Ctrl+T` / `Ctrl+W` / `Ctrl+L` |
| Switch tabs | `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1`–`9` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Find in page | `Ctrl+F` |
| Zoom | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Ask Claude about selected text | right-click → Ask Claude About Selection |
| Tab devtools | `F12` |

Sites must ask before using your camera, microphone, location, or notifications. Claude can only open http(s) pages. Claude asks before purchases, sending messages, or submitting personal data, and never types passwords. Page content is treated as untrusted input.

## Features

- **Claude in the sidebar** reads the page and operates the browser. Low-level actions: click, type, keys and shortcuts, scroll, hover, click at a point on a screenshot, tabs, back/forward/reload. High-level actions:
  - click by visible text
  - `fill_form` fills a whole form by field labels
  - `read_urls` reads up to 6 pages in parallel in hidden tabs
  - `run_script` runs JavaScript in the page for bulk extraction or edits
  - `wait_for` waits for text to appear
  - web search
- **ADHD mode** (on by default, toggle in Claude settings): answers lead with the next action, use short numbered steps, and end with one small next step.
- **Ad blocker** built into the browser, not an extension. It uses uBlock Origin–compatible lists (Ghostery engine). Toggle it, or allow ads on one site, from **⋯ → Ad Blocker**. Hidden-element rules are applied in a way pages can't read, and uBlock's scripts disarm known anti-adblock checks. Blocked requests are cancelled, so a determined site can still notice that its ad request failed.
- **Chrome extensions** from the Chrome Web Store: open **⋯ → Extensions → Get Extensions…** and click *Add to Lumen*. Extension buttons appear in the toolbar. Note: the ad blocker takes over Electron's request hooks, so extensions that block requests through the old `chrome.webRequest` API (Manifest V2) can't block. Manifest V3 extensions work.

- **Other AI models:** add an OpenAI, Grok (xAI) or Gemini key in Claude settings → Other models. Their models appear in the model menu, work with every browser tool, and can take over a chat mid-conversation.
- **Search engine:** Google, DuckDuckGo, Bing, Brave Search, Ecosia or Startpage (settings, or ⋯ → Search Engine).
- **Import:** bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera or Firefox (settings, or ⋯ → Import Bookmarks and History). Passwords and cookies are never read.

## Use Lumen from Claude Code, Codex, Gemini CLI

Lumen is an MCP server: any MCP-capable agent can drive the browser with the same tools the
sidebar uses (read_page, click by text, fill_form, navigate, tabs, screenshot, read_urls,
run_script, web_search, group_tabs…). The exact commands for your install, with the right
paths, are in **Settings → AI agents (MCP) → Connect an AI agent** (each with a Copy button).
They run Lumen's own executable in Node mode on `mcp.js`:

```sh
# Claude Code
claude mcp add lumen -e ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<you>\AppData\Local\Programs\Lumen\Lumen.exe" "C:\Users\<you>\AppData\Local\Programs\Lumen\resources\app\mcp.js"
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.lumen]
command = 'C:\Users\<you>\AppData\Local\Programs\Lumen\Lumen.exe'
args = ['C:\Users\<you>\AppData\Local\Programs\Lumen\resources\app\mcp.js']
env = { ELECTRON_RUN_AS_NODE = "1" }
```

```json
// Gemini CLI (~/.gemini/settings.json), Cursor, Claude Desktop and other MCP clients
{ "mcpServers": { "lumen": {
  "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Lumen\\Lumen.exe",
  "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Lumen\\resources\\app\\mcp.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```

How it works and what keeps it safe:

- The agent starts a small bridge that connects to the running Lumen over a per-user local
  channel (a named pipe on Windows, a Unix socket elsewhere) with a random token stored in
  Lumen's profile folder. If Lumen isn't open, the bridge starts it.
- Every new site still needs your OK: an approval card appears in the sidebar
  ("An external agent (Claude Code) wants to interact with example.com").
- While an agent is connected, the toolbar says **Lumen is being driven by …**, each tool call
  shows as a step in the sidebar, and **Stop** disconnects it.
- Turn it off in **Settings → AI agents (MCP) → Allow AI agents to connect**.
- `Lumen --mcp` also works as the command, but on Windows GUI-mode Electron prints one blank
  line on stdout first, which strict clients may log as a parse error; the Node-mode command
  above avoids that.

## Layout

- `main.js`: window, tabs (`WebContentsView`), shortcuts, menus, settings, permissions, history and suggestions, extensions, ad blocker, IPC
- `mcp.js`: MCP server for external agents (stdio bridge + local authenticated channel)
- `providers.js`: OpenAI / Grok / Gemini adapter (Chat Completions, history conversion)
- `importer.js`, `search.js`: browser import and search engines
- `agent.js`: agent loop (`claude-opus-5`, streaming, adaptive thinking, web search, browser tools, ADHD mode)
- `page-scripts.js`: scripts injected into pages to read and operate them
- `renderer/`: browser chrome UI, sidebar, suggestion dropdown, new-tab and error pages
- `test/`: Playwright tests: `smoke.js`, `tools.js` (agent actions), `ui.js` (address bar, find), `extensions.js`, `adblock.js`, `adhd.js`

## License

GPL-3.0, because it uses `electron-chrome-extensions` (GPL-3.0).

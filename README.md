# Lumen

**Every AI, one browser.** Lumen is a fast, calm Chromium browser with an AI built into the sidebar. Bring the one you like: **Claude (with your own Claude account through Claude Code), ChatGPT, Gemini, Grok, or any model on OpenRouter**. Switch between them mid-conversation, or plug in **any AI agent over MCP**.

- **An AI that does things, not just chats.** It reads the page you're on and acts on it: clicks, types, fills in forms, opens and groups tabs, and researches several pages at once. It asks before acting on a new site, and never submits a half-filled form.
- **Your choice of model.** Claude (Opus, Sonnet, Haiku, Fable), OpenAI, Grok, Gemini and OpenRouter. Use your Claude account through Claude Code, add a key, sign in to Anthropic with its CLI, or sign in with OpenRouter. The toolbar button takes on each company's mark.
- **A real browser underneath.** Tabs that group themselves by site or by topic, bookmarks, history, downloads, find, zoom, Chrome Web Store extensions, a built-in ad and tracker blocker, and import from Chrome, Edge, Brave, Vivaldi, Opera or Firefox.
- **Private by default.** Background reading and search run without your cookies, page scripts are hidden from sites, chats are encrypted at rest, and the start page makes no network requests.
- **Made to feel alive.** Light and dark themes that follow your system, spring animations, and an aurora start page.

## Run

```
npm install
npm start
```

## Download

Installers are built by GitHub Actions (`.github/workflows/release.yml`) and attached to [Releases](https://github.com/emah-maker/lumen/releases) when a version tag (`v*`) is pushed. Manual runs of the workflow keep the builds as run artifacts instead. The repository is **private**, so only people with access to it can download them.

| Computer | File |
|---|---|
| Windows 10/11 (x64) | `Lumen-Setup-<version>.exe` (installer) or `Lumen-<version>-win-x64.zip` (unzip and run `Lumen.exe`) |
| Mac with Apple silicon (M1 and later) | `Lumen-<version>-mac-arm64.dmg` |
| Mac with Intel | `Lumen-<version>-mac-x64.dmg` |

**Windows:** the builds aren't code-signed. SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**. On PCs with Smart App Control turned on, the zip is the one that runs. Its `Lumen.exe` is the untouched Electron binary, which Windows recognises, while a freshly built installer isn't. Or build and install locally (below).

**Mac:** the app is ad-hoc signed, not signed with an Apple Developer ID, so the first launch is blocked. Right-click **Lumen** in Applications and choose **Open**, then **Open** again. If macOS says the app "is damaged", run:

```
xattr -dr com.apple.quarantine /Applications/Lumen.app
```

## Build and install locally

```
npm install
npm run dist          # this computer's platform; or dist:win / dist:mac
npm run install_app   # Windows: installs to %LOCALAPPDATA%\Programs\Lumen with Desktop + Start menu shortcuts
```

Builds go to a local folder that isn't synced, even when the project itself lives in OneDrive:

- Windows: `%LOCALAPPDATA%\Lumen\build`
- macOS: `~/Library/Caches/Lumen/build`
- Linux: `~/.cache/lumen/build`

Set `LUMEN_BUILD_DIR` to use a different folder. The installed Windows app lives on the local drive at `%LOCALAPPDATA%\Programs\Lumen`.

The Windows build ships the official Electron `.exe` byte for byte (`signAndEditExecutable: false`, `asar: false`, and Electron taken from node_modules), and `scripts/build.js` checks this after every build. Windows 11 Smart App Control blocks unsigned executables it doesn't recognise, and editing the exe (icon, version info, asar integrity) produces one. The untouched Electron binary is recognised, so it runs. The window, taskbar and shortcuts use Lumen's icon at runtime. For a normal signed installer, sign the build with a trusted code-signing certificate.

Set up an AI from the sidebar's empty state or **Settings → You and AI** (`Ctrl+,`; the sidebar's gear opens it): your Claude account through Claude Code, an Anthropic, OpenAI, Grok, Gemini or OpenRouter key (stored encrypted with the OS keychain), or **Sign in with OpenRouter**. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY` work too.

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
- **ADHD mode** (on by default, toggle in Settings → You and AI): answers lead with the next action, use short numbered steps, and end with one small next step.
- **Ad blocker** built into the browser, not an extension. It uses uBlock Origin–compatible lists (Ghostery engine). Toggle it, or allow ads on one site, from **⋯ → Ad Blocker**. Hidden-element rules are applied in a way pages can't read, and uBlock's scripts disarm known anti-adblock checks. Blocked requests are cancelled, so a determined site can still notice that its ad request failed.
- **Chrome extensions** from the Chrome Web Store: open **⋯ → Extensions → Get Extensions…** and click *Add to Lumen*. Extension buttons appear in the toolbar. Note: the ad blocker takes over Electron's request hooks, so extensions that block requests through the old `chrome.webRequest` API (Manifest V2) can't block. Manifest V3 extensions work.

- **Other AI models:** add an OpenAI, Grok (xAI), Gemini or OpenRouter key in Settings → You and AI → API keys. Their models appear in the model menu, work with every browser tool, and can take over a chat mid-conversation.
- **OpenRouter:** paste a key or **Sign in with OpenRouter** (OAuth with PKCE through a one-time local address; the key it returns is stored like a pasted one). The menu shows the newest Claude, GPT, Gemini, Llama, DeepSeek and Grok models; **More models…** searches all of them (the list is cached for a day). Models that can't use tools are marked **(chat only)**: they read the page with you but can't click or type in your tabs.
- **Tab groups:** ⋯ → Tab Groups → Group Automatically **Off / By Site / By Topic**. By topic finds related tabs (recipes, one trip, a library's docs) on your computer from titles and addresses; turn on **Use AI to name and group topics** in Settings to send only titles and addresses to the cheapest model of your chat's provider. **Organize Tabs by Topic** (tab menu or ⋯ → Tab Groups) regroups on demand, with **Undo Organize**. Groups you made and tabs you moved by hand are left alone.
- **Search engine:** Google, DuckDuckGo, Bing, Brave Search, Ecosia or Startpage (Settings, or ⋯ → Search Engine).
- **Import:** bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera or Firefox (Settings, or ⋯ → Import Bookmarks and History). Passwords and cookies are never read.

## Use your own Claude account

### Through Claude Code

If [Claude Code](https://claude.com/claude-code) is installed, the model menu starts with a
**Your Claude account** group: **Claude · your account (Claude Code)**. Each message runs your
own `claude` CLI headless, signed in with your own login (including a school or work plan), and
it drives Lumen through Lumen's MCP server:

- Lumen never sees your claude.ai credentials; the CLI keeps its own login. Not signed in? Run
  `claude` once in a terminal and type `/login`.
- The CLI only gets Lumen's browser tools (no shell, no file edits), and Lumen's approval card
  still asks before it acts on a new site. Follow-ups continue the same Claude Code session;
  **New chat** starts a fresh one. **Stop** ends the CLI and everything it started.
- Uses your Claude Code login. For personal use; apps offered to others need Anthropic's
  approval to use claude.ai logins.

### The page you're on goes with your message

Like Comet, every message, whichever AI answers it (Claude by key or CLI sign-in, Claude Code, OpenAI, Grok, Gemini, OpenRouter), includes the current tab's title, address and first ~7,000
characters of readable text (not for new-tab or internal pages), marked as untrusted page
content. The chip above the message box shows **Using: <page>**; click **×** to stop sending the
page (remembered), **Include** to turn it back on.

## Use Lumen from Claude Code, Codex, Gemini CLI

Lumen is an MCP server: any MCP-capable agent can drive the browser with the same tools the
sidebar uses (read_page, click by text, fill_form, navigate, tabs, screenshot, read_urls,
run_script, web_search, group_tabs…). The exact commands for your install, with the right
paths, are in **Settings → AI agents (MCP) → Connect an AI agent** (each with a Copy button).
For Claude Code there is also a one-click **Add to Claude Code** button (it says **Already
connected** if `claude mcp get lumen` finds it). They run Lumen's own executable in Node mode on `mcp.js`:

```powershell
# Claude Code on Windows (PowerShell or cmd). Use claude.cmd: in PowerShell the npm claude.ps1
# shim swallows the "--", and the command fails with "missing required argument 'commandOrUrl'".
claude.cmd mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<you>\AppData\Local\Programs\Lumen\Lumen.exe" "C:\Users\<you>\AppData\Local\Programs\Lumen\resources\app\mcp.js"
```

```sh
# Claude Code on macOS / Linux
claude mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Lumen.app/Contents/MacOS/Lumen /Applications/Lumen.app/Contents/Resources/app/mcp.js
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
  channel (a named pipe on Windows, a Unix socket elsewhere) and proves it can read the random
  token in Lumen's profile folder (HMAC challenge-response; the token itself never crosses the
  channel). If Lumen isn't open, the bridge starts it.
- Every new site still needs your OK: an approval card appears in the sidebar
  ("An external agent (Claude Code) wants to interact with example.com").
- While an agent is connected, the toolbar says **Lumen is being driven by …**, each tool call
  shows as a step in the sidebar, and **Stop** disconnects it.
- Turn it off in **Settings → AI agents (MCP) → Allow AI agents to connect**.
- `Lumen --mcp` also works as the command, but on Windows GUI-mode Electron prints one blank
  line on stdout first, which strict clients may log as a parse error; the Node-mode command
  above avoids that.

## Drive Lumen with Playwright (Chrome DevTools Protocol)

Off by default. Turn on **Settings → AI agents (MCP) → Allow automation tools (Chrome DevTools
Protocol)**, pick a port (default 9222) and restart Lumen. Then:

```sh
# Playwright MCP, from Claude Code
claude mcp add playwright-lumen -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

```js
// Playwright
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0]; // your open tabs
const tab = await browser.contexts()[0].newPage(); // opens a real Lumen tab
```

- Lumen listens on 127.0.0.1 only, through a proxy (`automation.js`) that shows only your tabs:
  Lumen's own UI and hidden reader tabs can't be seen or attached to.
- `newPage()` opens a Lumen tab, `page.close()` closes it, and `browser.close()` only disconnects.
- The toolbar says **Lumen is being driven by Playwright (CDP)** while connected; **Stop** disconnects.
- Any program on your computer can use the port while it's on, including on signed-in sites.
  Turning the setting off closes it immediately.

## Token-efficient tools (all AIs)

The sidebar agent, MCP clients and OpenAI/Grok/Gemini get the same cheaper tools:

- `read_page` with `mode: "compact"`: an outline with `[id]` refs (headings, landmarks, text
  with inline links, controls with values) instead of JSON plus raw text. `since_last: true`
  returns only what changed. `mode: "full"` (the default) is unchanged.
- `find`: matching controls and short text snippets, instead of reading the page.
- `batch`: several actions (type, click, select, press, wait_for, scroll, hover) in one call,
  ending with what changed.
- `screenshot`: 1024 px JPEG by default, with `max_width`, `quality` and `region` crop.

What one call costs on real pages (tokens ≈ characters / 4, measured with Lumen's own tools):

| Page | `read_page` (full, default) | `mode: "compact"` | `since_last` (unchanged page) | `find` (one word) |
|---|---|---|---|---|
| Wikipedia: WebKit | ~6,800 | ~1,500 | ~21 | ~180 |
| DuckDuckGo results | ~2,700 | ~760 | ~21 | ~360 |
| Long article: World War II | ~7,600 | ~1,500 | ~21 | ~180 |

Compact is about 4–5× smaller than a full read. The big savings come from not reading again:
`since_last` after an action, `find` for one thing, and `batch` for several steps in one call.
`node test/measure.js` runs whole tasks both ways.

## Layout

- `main.js`: window, tabs (`WebContentsView`), shortcuts, menus, settings, permissions, history and suggestions, extensions, IPC
- `features/`: parts split out of main.js: `ai-agents.js` (MCP, CDP automation, the Claude Code engine; automation.js and claude-code.js load on first use), `adblock.js`, `downloads.js`, `instance.js` (single instance, shortcuts)
- `settings-backend.js`, `renderer/settings.*`: lumen://settings, the one place for settings
- `tab-groups.js`: groups by site and by topic (local TF-IDF clustering), undo
- `extensions-dnr-preload.js`: `browser` alias and chrome.declarativeNetRequest for extensions (rules kept, not applied; content blockers with static rulesets are refused at install)
- `mcp.js`: MCP server for external agents (stdio bridge + local authenticated channel)
- `providers.js`: OpenAI / Grok / Gemini / OpenRouter adapter (Chat Completions, history conversion, OpenRouter catalog)
- `importer.js`, `search.js`: browser import and search engines
- `agent.js`: agent loop (`claude-opus-5`, streaming, adaptive thinking, web search, browser tools, ADHD mode)
- `page-scripts.js`: scripts injected into pages to read and operate them
- `snapshot.js`: token-efficient tools (compact outline, diffs, find, batch, screenshot options)
- `automation.js`: opt-in CDP endpoint for Playwright, filtered to the user's tabs
- `renderer/`: browser chrome UI, sidebar, suggestion dropdown, new-tab and error pages
- `test/`: 22 Playwright suites (`node test/<name>.js`): smoke, tools, ui (address bar, find, focus stress, sidebar layout), browser, agentic, images, models, providers (incl. OpenRouter), import, groups (incl. topics), cli, mcp, adhd, crash, extensions, adblock, home, cdp, efficiency, claudecode, pagecontext (every engine), settings

## License

GPL-3.0, because it uses `electron-chrome-extensions` (GPL-3.0).

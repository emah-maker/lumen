# Lumen

**Every AI, one browser.** Lumen is a fast, calm Chromium browser with an AI built into the sidebar. Bring the one you like: **Claude (with your own Claude account through Claude Code), ChatGPT, Gemini, Grok, or any model on OpenRouter**. Switch between them mid-conversation, or let **any AI agent drive it over MCP**.

![Lumen's sidebar, running Claude Code, opens Hacker News and lists the top five stories with their points](docs/media/agent-task.gif)

<sub>A real, unedited run (about 18 seconds) of "Claude · your account (Claude Code)" with a Claude Code login. The capture profile auto-allows actions, so the approval card you'd normally see before the AI first acts on a site isn't shown. [MP4 version](docs/media/agent-task.mp4).</sub>

- **An AI that does things, not just chats.** It reads the page you're on and acts on it: clicks, types, fills in forms, opens and groups tabs, and researches several pages at once. It asks before acting on a new site, and a form that doesn't fill completely is never submitted.
- **Your choice of model.** Claude (Opus, Sonnet, Haiku, Fable), OpenAI, Grok, Gemini and OpenRouter. Use your Claude account through Claude Code, add a key, sign in to Anthropic with its CLI, or sign in with OpenRouter. The toolbar button takes on each company's mark.
- **A real browser underneath.** Tabs that group themselves by site or by topic, bookmarks, history, downloads, find, zoom, Chrome Web Store extensions, a built-in ad and tracker blocker, and import from Chrome, Edge, Brave, Vivaldi, Opera or Firefox.
- **Private by default.** No telemetry. Background reading and search run without your cookies, the scripts the AI uses to read pages run where sites can't see them, chats are encrypted at rest, and the start page makes no network requests.
- **Calm to look at.** Light and dark themes that follow your system, and spring animations.

## Install

Download the latest build from [Releases](https://github.com/emah-maker/lumen/releases).

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

Then set up an AI from the sidebar's empty state or **Settings → You and AI** (`Ctrl+,`; the sidebar's gear opens it): your Claude account through Claude Code, an Anthropic, OpenAI, Grok, Gemini or OpenRouter key (stored encrypted with the OS keychain), or **Sign in with OpenRouter**. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY` work too.

## The start page

<p>
  <img src="docs/media/newtab-light.png" alt="Lumen's new-tab page in the light theme" width="49%">
  <img src="docs/media/newtab-dark.png" alt="Lumen's new-tab page in the dark theme" width="49%">
</p>

Search or ask the AI from the same box (**Search | Ask AI**, `Ctrl+/` and `Alt+A` switch), with your favorites and most-visited sites underneath. It's a local page with a strict Content Security Policy: it loads nothing from the network, and site icons come from a small local cache.

## The AI in the sidebar

![The sidebar agent after a task, showing each step it took](docs/media/sidebar-agent.png)

`Ctrl+J` opens it. The AI reads the page and operates the browser.

- **Low-level actions:** click, type, keys and shortcuts, scroll, hover, click at a point on a screenshot, tabs, back/forward/reload.
- **High-level actions:**
  - click by visible text
  - `fill_form` fills a whole form by field labels
  - `read_urls` reads up to 6 pages in parallel in hidden tabs
  - `run_script` runs JavaScript in the page for bulk extraction or edits
  - `wait_for` waits for text to appear
  - web search
- **The page you're on goes with your message.** Whichever AI answers (Claude by key or CLI sign-in, Claude Code, OpenAI, Grok, Gemini, OpenRouter), each message includes the current tab's title, address and first ~7,000 characters of readable text (not for new-tab or internal pages), marked as untrusted page content. The chip above the message box shows **Using: <page>**; click **×** to stop sending the page (remembered), **Include** to turn it back on.
- **ADHD mode** (on by default, toggle in Settings → You and AI): answers lead with the next action, use short numbered steps, and end with one small next step.
- **Other AI models:** add an OpenAI, Grok (xAI), Gemini or OpenRouter key in Settings → You and AI. Their models appear in the model menu, work with every browser tool, and can take over a chat mid-conversation.
- **OpenRouter:** paste a key or **Sign in with OpenRouter** (OAuth with PKCE through a one-time local address; the key it returns is stored like a pasted one). The menu shows the newest Claude, GPT, Gemini, Llama, DeepSeek and Grok models; **More models…** searches all of them (the list is cached for a day). Models that can't use tools are marked **(chat only)**: they read the page with you but can't click or type in your tabs.

### Asking before it acts

![An approval card in the sidebar: an external agent asks to interact with a site](docs/media/mcp-approval.png)

- **New sites.** The first time the AI clicks, types, hovers, presses keys or runs a script on a site in a chat, a card asks you to allow it. The bolt in the sidebar head (**Auto-allow actions**) skips these cards for the sidebar's own AI; agents connected over MCP always ask.
- **Leaving with what it read.** Once the AI has read content in a chat (`read_page`, `find`, `screenshot`, `run_script`, `read_urls`, `list_tabs`, `batch`, or the page text Lumen sends with your message), navigating to, opening or fetching a site not yet approved in that chat shows a card ("Claude wants to open <host>"), one per new site. Approving adds the site to the chat's approved sites. This lasts for the whole chat and resets on **New chat**; a chat restored after a restart counts as having read content. Approved sites, and everything while Auto-allow is on, skip the card; MCP agents are always asked. This is so a page can't quietly tell the AI to carry what it read off to another site. Known gaps: an approved site can still redirect elsewhere, and the AI's `web_search` sends its query to DuckDuckGo without asking.
- **What it can see of your tabs.** `list_tabs` shows the AI only web pages and blank new tabs, with query strings and `#fragments` removed; internal pages (settings, history) and `file://` tabs are left out, and `switch_tab` can only go to the tabs it lists.
- **Only web pages.** The AI can only open http and https addresses.
- **Sensitive steps.** The AI is instructed to stop and ask before purchases, payments, sending messages, posting, deleting data, changing account settings, or submitting personal information, and never to type passwords, card numbers or one-time codes. These are instructions to the model, not hard blocks. What Lumen enforces itself: the values of password fields are never included when the AI reads a page, and `fill_form` does not submit a form when any field failed to fill.
- **Page content is untrusted.** Page text, search results and screenshots reach the model marked as data, not instructions.

## Your own Claude account, through Claude Code

If [Claude Code](https://claude.com/claude-code) is installed, the model menu starts with a **Your Claude account** group: **Claude · your account (Claude Code)**. Each message runs your own `claude` CLI headless, signed in with your own login (including a school or work plan), and it drives Lumen through Lumen's MCP server:

- Lumen never sees your claude.ai credentials; the CLI keeps its own login. Not signed in? Run `claude` once in a terminal and type `/login`.
- The CLI only gets Lumen's browser tools (no shell, no file edits), and Lumen's approval cards still apply. Follow-ups continue the same Claude Code session; **New chat** starts a fresh one. **Stop** ends the CLI and everything it started.
- **Claude Code** uses the model set in Claude Code; **Claude Code · Fable / Opus / Sonnet / Haiku** pass `--model` with that alias. Switching between them mid-chat keeps the same session. (Grok Build, when offered, lists the models `grok models` reports the same way; switching its model starts a new Grok session that is handed the conversation so far.)
- Uses your Claude Code login. For personal use; apps offered to others need Anthropic's approval to use claude.ai logins.

## Tabs that organize themselves

![Tabs about several topics, grouped automatically into named, coloured groups](docs/media/tab-groups.gif)

⋯ → Tab Groups → Group Automatically **Off / By Site / By Topic**. By topic finds related tabs (recipes, one trip, a library's docs) on your computer from titles and addresses. Turn on **Use AI to name and group topics** in Settings to send tab titles and site names (hostnames only) to the cheapest model of your chat's provider instead. **Organize Tabs by Topic** (tab menu or ⋯ → Tab Groups) regroups on demand, with **Undo Organize**. Groups you made and tabs you moved by hand are left alone.

## A real browser underneath

![Lumen's settings page](docs/media/settings.png)

- **Ad blocker** built into the browser, not an extension. It uses uBlock Origin–compatible lists (Ghostery engine). Toggle it, or allow ads on one site, from **⋯ → Ad Blocker**. Hidden-element rules are applied in a way pages can't read, and uBlock's scripts disarm known anti-adblock checks. Blocked requests are cancelled, so a determined site can still notice that its ad request failed.
- **Chrome extensions** from the Chrome Web Store: open **⋯ → Extensions → Get Extensions…** and click *Add to Lumen*. Extension buttons appear in the toolbar. The ad blocker takes over Electron's request hooks, so extensions that block requests through the old `chrome.webRequest` API (Manifest V2) can't block. Manifest V3 extensions work; content blockers that rely on static declarativeNetRequest rulesets are refused at install.
- **Search engine:** Google, DuckDuckGo, Bing, Brave Search, Ecosia or Startpage (Settings, or ⋯ → Search Engine).
- **Import:** bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera or Firefox (Settings, or ⋯ → Import Bookmarks and History). Passwords and cookies are never read.
- **Permissions:** sites must ask before using your camera, microphone, location, or notifications.

## Keyboard shortcuts

`Ctrl` is `Cmd` on macOS.

| Action | How |
|---|---|
| Open or close the AI sidebar | `Ctrl+J` or the toolbar's AI button |
| Ask the AI from the address bar | type, then `Alt+Enter` |
| New tab / close tab / focus address | `Ctrl+T` / `Ctrl+W` / `Ctrl+L` |
| Switch tabs | `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1`–`9` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Back / forward | `Alt+←` / `Alt+→` (macOS: `Cmd+[` / `Cmd+]`) |
| Reload | `Ctrl+R` or `F5` |
| Find in page | `Ctrl+F` |
| Zoom | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Bookmark this page | `Ctrl+D` |
| History | `Ctrl+H` (macOS: `Cmd+Y`) |
| Settings | `Ctrl+,` |
| Print | `Ctrl+P` |
| Full screen | `F11` (Windows, Linux) |
| Ask the AI about selected text | right-click → Ask Claude About Selection |
| Tab devtools | `F12` |

## Use Lumen from Claude Code, Codex, Gemini CLI

Lumen is an MCP server: any MCP-capable agent can drive the browser with the same tools the sidebar uses (read_page, click by text, fill_form, navigate, tabs, screenshot, read_urls, run_script, web_search, group_tabs…). It's off until you turn on **Settings → You and AI → Allow AI agents to connect**. The exact commands for your install, with the right paths, are under **Connect an AI agent** in the same place (each with a Copy button). Claude Code, Codex CLI, Gemini CLI and Grok Build also get a one-click **Add to …** button, which turns the setting on (Claude Code's says **Already connected** if `claude mcp get lumen` finds it). They run Lumen's own executable in Node mode on `mcp.js`:

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

- The agent starts a small bridge that connects to the running Lumen over a per-user local channel (a named pipe on Windows, a Unix socket elsewhere) and proves it can read the random token in Lumen's profile folder (HMAC challenge-response; the token itself never crosses the channel). If Lumen isn't open, the bridge starts it.
- Every new site still needs your OK: an approval card appears in the sidebar ("An external agent (Claude Code) wants to interact with example.com"). Auto-allow doesn't apply to outside agents.
- While an agent is connected, the toolbar says **Lumen is being driven by …**, each tool call shows as a step in the sidebar, and **Stop** disconnects it.
- `Lumen --mcp` also works as the command, but on Windows GUI-mode Electron prints one blank line on stdout first, which strict clients may log as a parse error; the Node-mode command above avoids that.

## Drive Lumen with Playwright (Chrome DevTools Protocol)

Off by default. Turn on **Settings → You and AI → Allow automation tools (Chrome DevTools Protocol)**, pick a port (default 9222) and restart Lumen. Then click **Copy address**: the address includes a secret key (`http://127.0.0.1:9222/<token>`), and the port refuses requests without it.

```sh
# Playwright MCP, from Claude Code
claude mcp add playwright-lumen -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222/<token>
```

```js
// Playwright
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222/<token>');
const page = browser.contexts()[0].pages()[0]; // your open tabs
const tab = await browser.contexts()[0].newPage(); // opens a real Lumen tab
```

- Lumen listens on 127.0.0.1 only, through a proxy (`automation.js`) that shows only your tabs: Lumen's own UI, hidden reader tabs and extension pages can't be seen or attached to.
- `newPage()` opens a Lumen tab, `page.close()` closes it, and `browser.close()` only disconnects.
- The toolbar says **Lumen is being driven by Playwright (CDP)** while connected; **Stop** disconnects.
- CDP clients don't get approval cards. Any program on your computer can use the port while it's on, including on signed-in sites, and Chromium's own internal debugging port (on a random localhost port) is open too. Turning the setting off closes the proxy immediately.

## Token-efficient tools (all AIs)

The sidebar agent, MCP clients and OpenAI/Grok/Gemini get the same cheaper tools:

| Tool | What it returns |
|---|---|
| `read_page` with `mode: "compact"` | an outline with `[id]` refs (headings, landmarks, text with inline links, controls with values) instead of JSON plus raw text. `mode: "full"` (the default) is unchanged. |
| `read_page` with `since_last: true` | only what changed since the last read |
| `find` | matching controls and short text snippets, instead of reading the page |
| `batch` | several actions (type, click, select, press, wait_for, scroll, hover) in one call, ending with what changed |
| `screenshot` | 1024 px JPEG by default, with `max_width`, `quality` and `region` crop |

What one call costs on real pages (tokens ≈ characters / 4, measured with Lumen's own tools):

| Page | `read_page` (full, default) | `mode: "compact"` | `since_last` (unchanged page) | `find` (one word) |
|---|---|---|---|---|
| Wikipedia: WebKit | ~6,800 | ~1,500 | ~21 | ~180 |
| DuckDuckGo results | ~2,700 | ~760 | ~21 | ~360 |
| Long article: World War II | ~7,600 | ~1,500 | ~21 | ~180 |

Compact is about 4–5× smaller than a full read. The big savings come from not reading again: `since_last` after an action, `find` for one thing, and `batch` for several steps in one call. `node test/measure.js` runs whole tasks both ways.

## Privacy and security

- **No telemetry, no analytics, no crash reports.** Lumen has no servers of its own. What leaves your computer, and to whom: [PRIVACY.md](PRIVACY.md).
- **Keys and chats** are encrypted with the OS keychain. Without a keychain, keys aren't saved (use the environment variables) and the chat isn't kept between sessions.
- **Background reading and web search** run in a separate in-memory session with none of your cookies or logins. That session denies every permission request and cancels downloads.
- **Lumen's own UI is locked down.** The browser UI, the address-bar suggestions and the dialog overlay can't be navigated away or open popups (links open as tabs), web pages in tabs can't send the UI's privileged messages, and a link dropped on the window opens as a tab.
- **Approvals** for the AI and for MCP agents are described in [Asking before it acts](#asking-before-it-acts).
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Build from source

```
npm install
npm start             # run from source
npm test              # the core Playwright suites
```

### Build and install locally

```
npm run dist          # this computer's platform; or dist:win / dist:mac
npm run install_app   # Windows: installs to %LOCALAPPDATA%\Programs\Lumen with Desktop + Start menu shortcuts
```

Builds go to a local folder that isn't synced, even when the project itself lives in OneDrive:

- Windows: `%LOCALAPPDATA%\Lumen\build`
- macOS: `~/Library/Caches/Lumen/build`
- Linux: `~/.cache/lumen/build`

Set `LUMEN_BUILD_DIR` to use a different folder. The installed Windows app lives on the local drive at `%LOCALAPPDATA%\Programs\Lumen`.

The Windows build ships the official Electron `.exe` byte for byte (`signAndEditExecutable: false`, `asar: false`, and Electron taken from node_modules), and `scripts/build.js` checks this after every build. Windows 11 Smart App Control blocks unsigned executables it doesn't recognise, and editing the exe (icon, version info, asar integrity) produces one. The untouched Electron binary is recognised, so it runs. The window, taskbar and shortcuts use Lumen's icon at runtime. For a normal signed installer, sign the build with a trusted code-signing certificate.

Release installers are built by GitHub Actions (`.github/workflows/release.yml`) and attached to [Releases](https://github.com/emah-maker/lumen/releases) when a version tag (`v*`) is pushed. Manual runs of the workflow keep the builds as run artifacts instead.

### DRM (Widevine): Netflix, Spotify, Disney+, Prime Video, YouTube Movies

`electron` is castlabs' [ECS build](https://github.com/castlabs/electron-releases) (`electron-releases#v44.1.0+wvcus`), which adds a Widevine CDM that stock Electron doesn't have. On startup Lumen calls `components.whenReady()` (with a 10s timeout so a failed/offline CDM download never blocks the window opening) and logs `components.status()`; the CDM itself downloads on first run.

That's enough for most sites out of the box. Production DRM providers (Netflix, Disney+, Spotify) additionally check that the binary is **VMP-signed**: electron-builder renames `electron.exe` to `Lumen.exe`, which invalidates the stock signature. One-time setup, then every `npm run dist:win` VMP-signs the build automatically (`scripts/after-pack.js`; it warns and continues the build if any of this isn't set up):

```
python -m pip install --upgrade castlabs-evs
python -m castlabs_evs.account signup      # or: python -m castlabs_evs.account reauth
```

To check DRM playback manually (not part of `npm test`): `node test/drm.js`.

### Screenshots and GIFs

The images in this README are captured from a throwaway profile by `node scripts/capture-media.js` (needs `ffmpeg` on PATH for the GIFs and the MP4; Windows only for the screen recording).

## Layout

- `main.js`: window, tabs (`WebContentsView`), shortcuts, menus, settings, permissions, history and suggestions, extensions, IPC
- `features/`: parts split out of main.js: `ai-agents.js` (MCP, CDP automation, the Claude Code and Grok Build engines; automation.js, claude-code.js and grok-build.js load on first use), `adblock.js`, `dialogs.js`, `downloads.js`, `instance.js` (single instance, shortcuts)
- `settings-backend.js`, `renderer/settings.*`: lumen://settings, the one place for settings
- `tab-groups.js`: groups by site and by topic (local TF-IDF clustering), undo
- `extensions-dnr-preload.js`: `browser` alias and chrome.declarativeNetRequest for extensions (rules kept, not applied; content blockers with static rulesets are refused at install)
- `mcp.js`: MCP server for external agents (stdio bridge + local authenticated channel)
- `claude-code.js`: the "your Claude account" engine (runs your own `claude` CLI headless)
- `cli-auth.js`: sign-in with the Anthropic CLI (`ant`), installed from its GitHub release if missing
- `providers.js`: OpenAI / Grok / Gemini / OpenRouter adapter (Chat Completions, history conversion, OpenRouter catalog)
- `importer.js`, `search.js`: browser import and search engines
- `agent.js`: agent loop (`claude-opus-5`, streaming, adaptive thinking, web search, browser tools, approvals, ADHD mode)
- `page-scripts.js`: scripts injected into pages to read and operate them
- `snapshot.js`: token-efficient tools (compact outline, diffs, find, batch, screenshot options)
- `automation.js`: opt-in CDP endpoint for Playwright, filtered to the user's tabs
- `renderer/`: browser chrome UI, sidebar, suggestion dropdown, new-tab, settings, history and error pages
- `scripts/`: build, install and `capture-media.js` (the README's screenshots)
- `docs/media/`: the README's screenshots and GIFs (not shipped in builds)
- `test/`: Playwright suites (`node test/<name>.js`; `npm test` runs the core set): smoke, units (settings file, address bar input, importer), tools, ui (address bar, find, focus stress, sidebar layout), tabstrip (clicks, overflow, pinning, lazy restore), browser, recovery (crashes, hung pages, links from other apps), downloads, tasklock (the agent stays on its tab), agentic, images, models, providers (incl. OpenRouter), import, groups (incl. topics), cli, mcp, adhd, crash, extensions, adblock, home, cdp, efficiency, claudecode, pagecontext (every engine), dialogs, settings, setup, hardening (UI window and reader session lockdown)

## License

GPL-3.0 (see [LICENSE](LICENSE)), because it uses `electron-chrome-extensions` (GPL-3.0).

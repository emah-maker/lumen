# Settings reference

Open the settings page with **⋯ → Settings**, or type `lumen://settings` (or `chrome://settings`) in the address bar. `lumen://settings/<section>` opens one section, for example `lumen://settings/privacy`.

## Where settings are kept

Everything is stored in `settings.json` in Lumen's profile folder:

| System | Profile folder |
|---|---|
| Windows | `%APPDATA%\Lumen` |
| macOS | `~/Library/Application Support/Lumen` |

The file is written atomically (a temp file renamed over the old one), and the previous good copy is kept as `settings.json.bak`. A file that can't be read falls back to the backup; if both are broken, the broken file is moved aside as `settings.json.corrupt-<time>` rather than overwritten.

API keys in `settings.json` are encrypted with the operating system's keychain. Without a keychain, keys aren't saved; use the environment variables instead.

The tables below give each setting's key in `settings.json` and its default. Edit the file only while Lumen is closed: Lumen rewrites it while it runs. Values that aren't valid are ignored and the default is used.

## General

| Setting | Key | Default | What it does |
|---|---|---|---|
| Default browser | — | — | Shows whether Lumen is the default browser and asks the system to make it so. On Windows, Lumen registers itself as a browser for the current user (so Default apps can offer it) and opens Default apps on Lumen; the choice is read from the user's HTTPS association. |
| First-run welcome | `welcome` | `pending` on a new install | The sidebar's welcome (connect an AI, import; an optional default-browser line) shows while this is `pending` and never again once it is `done`. Existing profiles never get it. |

## AI and agents

| Setting | Key | Default | What it does |
|---|---|---|---|
| Model | `model` | **Auto** (`auto`) on a fresh profile with two or more models connected, else Claude Opus 5.5 | The model the sidebar AI uses. The same picker is in the sidebar. **Auto** is its first row: Lumen picks the model for each message ([Auto model](auto-model.md)). A saved choice is never changed. |
| Auto may use | `autoExclude` | none | Providers Auto never chooses (a tick per connected provider in Settings → AI). See [Auto model](auto-model.md). |
| Image generation | `imageGen` | `auto` | Where a picture request goes ("draw a cat", or the AI's `generate_image` tool): `auto` (a connected provider that makes pictures, the chat's own first, then Grok Build, Grok, Gemini, OpenAI, OpenRouter; one that is out of usage goes last, one that refuses on content grounds is not retried elsewhere), `off`, or one provider (`grokbuild`, `xai`, `gemini`, `openai`, `openrouter`). Never a provider you haven't connected. See [Image generation](image-generation.md). |
| Switch models automatically when one is unavailable | `autoFallback` | on | When the picked model hits its usage or rate limit, or can't be reached (no connection, a timeout, a server error or "overloaded"), the same reply goes on with the next usable model: a lighter one from the same provider first (Opus, then Sonnet, then Haiku), then the same vendor's other route (Claude API and Claude Code, Grok API and Grok Build), then your other connected providers. Only models you have set up are used. A short note in the chat says what happened, the model picker shows the model that is really answering (marked as temporary), and each reply's label names it. The unavailable model is left alone until its reset time, or about 15 minutes after a lost connection, then the chat returns to it by itself. Never on a rejected key, a sign-in problem, a refused request or a Stop. Tools that already ran are never run again. The chat so far goes to the model it switches to, so turn this off if you want every message to stay with the provider you picked. Also covers topic naming, Organize and page translation. |
| Compact long chats automatically | `autoCompact` | on | A chat with an API model (Claude by key or sign-in, OpenAI, Grok, Gemini, OpenRouter) whose history nears what the model can take in one request is summarized by that model before the next request, as `/compact` does, instead of its oldest messages being left out. The messages stay on screen; the AI sees the summary plus the latest exchange. A short note in the chat says when it happened. Claude Code, Grok Build and Antigravity compact their own sessions, so this doesn't apply to them. |
| Short, focused answers | `adhdMode` | off | Answers lead with the next step and stay brief. Applies to new chats. |
| Warm up Grok Build when Lumen starts | `grokWarmup` | on | Starts Grok Build's setup in the background so your first message starts faster: once the first tab has loaded, Lumen finds the `grok` program, starts its local tool gate and prepares its folders and sign-in link (again after the computer wakes). It happens only while Grok Build is connected to Lumen or chosen as the model, sends nothing to Grok and never makes a model request. Off: that setup happens when you send the first message. Takes effect without a restart. |
| Group tabs automatically | `tabGrouping` | `site` | `off`, `site` (3 or more tabs from one site) or `topic` (related tabs, once 4 or more are loose). Tabs you group or move by hand stay put. |
| Use AI to name and group topics | `topicAi` | off | Only with **By topic**. Sends tab titles and site names (never full addresses) to the cheapest model of your chat's provider. Off: topics are found on this computer. |
| API keys | `keys` | none | One per provider: Anthropic, OpenAI, xAI (Grok), Google (Gemini), OpenRouter. Stored encrypted. Environment variables also work. |
| Sign in with your Anthropic account | — | — | Uses an OAuth profile from Anthropic's CLI (`ant auth login`) instead of an API key. |
| Don't let the AI act on my pages | `aiHandsOff` | off | The AI (the sidebar, its engines, MCP agents, and programs connected through the automation port) can read your tabs but not click, type, navigate, run scripts in them, regroup or close them; it works in tabs it opened itself. Enforced in the tool layer (`src/ai/agent.js`) and in the automation proxy (`src/automation/automation.js`, which refuses acting protocol commands such as `Input.*`, `Page.navigate`, `Runtime.evaluate` on other tabs and lets reads like screenshots and `DOM.getDocument` through; only an allowlist of read commands passes). Playwright's high-level reads (`page.content()`, locators, `evaluate`) use `Runtime.evaluate`, which is refused on your tabs in this mode; attaching still works, and script injection at attach is skipped with a console warning. It does not limit a command-line AI you gave full access to this computer (below): its own tools are not Lumen's, and Lumen's browser tools stay under this setting and the approval cards. |
| Never switch away from my tab | `aiStayOnMyTab` | off | The AI never brings a tab to the front: `open_tab` and `switch_tab` with `show:true` still open or use the tab, but behind the one you are on (`src/main.js` stayOnUsersTab). Without it the AI already works in background tabs and fronts one only when it asks to show you a page while you are on its chat's tab. |
| Use my Claude Code settings in Lumen chats | `ccUserSettings` | off | Off: Lumen starts Claude Code with `--setting-sources project`, so its chats (and the one-shot helpers) skip your `~/.claude` CLAUDE.md, rules, memory, hooks and `settings.json`. Measured: about 1,870 fewer input tokens per chat (3,969 down to 2,099) and about 240 ms less cold start from your SessionStart hooks; the sign-in still works. If a chat fails to start with a sign-in, credential, proxy or certificate error while this is off (your `apiKeyHelper` or proxy variables live in `settings.json`), Lumen retries once with your settings loaded, keeps them for that chat's later messages and says so once; turn this on to avoid the retry. Changing it ends the chat's kept Claude Code process; the next message starts one with the new setting (the process key includes it). Full access (below) always loads your settings, as in a terminal. |
| Give all command-line AIs full access to this computer | — | off | A master switch for the four below. It is not stored: it shows on when all four are on, off when none is, and half-way when they differ; clicking it turns all four on only from off, and otherwise turns all four off. |
| Give Claude Code full access to this computer | `claudeCodeFullAccess` | off | Claude Code in the sidebar works as it does in a terminal: its own tools (shell, file reads and edits), your MCP servers, skills and slash commands such as `/goal`, run without asking (`--permission-mode bypassPermissions`, home folder as working folder). See [Full access for command-line AIs](#full-access-for-command-line-ais). |
| Give Grok Build full access to this computer | `grokBuildFullAccess` | off | Grok Build in the sidebar runs with `--always-approve` and `--permission-mode bypassPermissions`, its own tools (shell, files, subagents) and no deny rules, in your home folder. |
| Give Codex full access to this computer | `codexFullAccess` | off | Codex in the sidebar runs with `--sandbox danger-full-access` and `sandbox_mode = "danger-full-access"` (approval still never), its own shell, patch, picture-view and web search tools on, and your whole environment. It starts in a small empty Lumen folder, not your home folder, and is told your home folder's path. |
| Give Antigravity full access to this computer | `antigravityFullAccess` | off | Antigravity in the sidebar runs with `--dangerously-skip-permissions` and without `--sandbox` or its terminal sandbox, in your home folder. |
| Reasoning effort (per AI) | `aiEffort` | none (each AI's own default) | `{ "claudecode": "high", "openai": "low", … }`, one entry per AI, set in Settings → AI → AI providers; a missing entry means the AI's default, an invalid level is dropped. Levels: Claude Code `low`..`max` (`--effort`), Grok Build `low`/`medium`/`high` (`--reasoning-effort`; a chosen effort skips "Keep Grok Build connected" because a kept process keeps the effort it started with), Antigravity `low`..`max` (`--effort`), Codex `low`..`max` (`-c model_reasoning_effort=`), Claude API `low`/`medium`/`high` (only models Lumen already sends an effort to, such as Opus 5.5), OpenAI `minimal`..`high` (`reasoning_effort`, o-series and GPT-5), Grok API `low`/`high` (Grok 3 Mini only), Gemini `low`/`medium`/`high` (2.5 and newer), OpenRouter `low`/`medium`/`high` (`reasoning.effort`). A level a model does not take is not sent for the API providers; the CLIs report their own error. |
| Offer Claude Code in the model menu | `claudeCodeSidebar` | on | Off hides Claude Code and its models from every model picker without uninstalling or signing out. |
| Offer Grok Build / Antigravity in the model menu | `grokSidebar`, `antigravitySidebar` | off until you connect or choose them | The same switch for the other CLIs (Codex has `codexSidebar` above). |
| Usage budget (per AI) | — (kept in `usage.json`) | none | Settings → Usage: an optional daily and weekly budget in dollars at API prices or in tokens, for each AI, counting only what Lumen itself used. Lumen tells you at 80% and 100%, shows a bar toward it, and never blocks anything. |
| Close tabs the AI opened when it finishes | `closeAiTabs` | off | Off / Ask / Always. Never closes a tab you used, pinned or that holds typed text, nor the tab a chat lives in. Closing shows Undo. You can also close them any time, in every window, from the ⋯ menu (Close Tabs Opened by AI) or from Lumen's taskbar icon: right-click it and choose Close tabs the AI opened (Windows, installed Lumen) or use its Dock menu (macOS). |
| Hide tabs the AI opened (tab strip button) | `hideAiTabs` | off | Leaves the AI's tabs out of the tab strip (they stay open); the tab in front and one playing sound stay shown. |
| Allow AI agents to connect | `mcpEnabled` | off | Turns on Lumen's MCP server for Claude Code, Codex CLI, Grok Build, Antigravity and other MCP clients. The commands to connect each one are listed under it. See the [MCP tool reference](mcp-tools.md). |
| Agents in their own window don't ask | `agentsNoAsk` | on | An outside agent (MCP) works in a Lumen window of its own; with this on, its clicks, typing, scripts, PDF reads and visits to new sites there run without approval cards (`src/ai/agent.js` autoAllows, set per call in `src/features/ai-agents.js` mcpCallTool), so it keeps working while Lumen is minimized or behind other windows. Per-site AI off, tabs kept off and hands-off mode still refuse. Off: each new site asks, as before. |
| Offer Codex in the model menu | `codexSidebar` | on | Once the Codex CLI is found and signed in, **Codex** (and each model it lists, plus its own **Auto**) is in every model picker under "Your OpenAI account". Turn it off to hide it. See [Codex in the sidebar](#codex-in-the-sidebar). |
| Antigravity | `antigravitySidebar` | off until you choose it | Google's coding agent (`agy`), which replaces Gemini CLI as a sidebar engine. **Use in the sidebar** (here, or the "Use your own Antigravity" card in an empty sidebar) offers it in the model menu once it is installed; if it isn't, this row shows Google's own install command for your system and runs it only when you click **Run this command**. You sign in by running `agy` once in a terminal; Lumen never sees the login. Like Claude Code and Grok Build it gets Lumen's browser tools only (see [Antigravity in the sidebar](#antigravity-in-the-sidebar)). |
| Allow automation tools (Chrome DevTools Protocol) | `automationEnabled` | off | For Playwright and other CDP tools, through a filtering proxy on localhost. Turning it on takes effect after a relaunch; turning it off closes the proxy at once. |
| Port (localhost only) | `automationPort` | `9222` | The proxy's port. The address you copy includes a secret key; requests without it are refused. |
| Import bookmarks and history | — | — | From Chrome, Edge, Brave, Vivaldi, Opera, Firefox or (on macOS) Safari on this computer. Passwords and cookies are not imported. |

### Full access for command-line AIs

Off by default, and each command-line AI has its own switch (plus the master switch above). Turning one on runs only that CLI's sidebar chats the way the CLI runs in your terminal, from the next message: its own tools (shell commands, reading and changing any file) work without asking, and Lumen's approval cards and **Don't let the AI act on my pages** do not apply to those tools. Background tasks and Routines never get full access, and the one-shot helpers (Organize Tabs, naming) stay tool-less.

What does not change: Lumen's browser tools are still Lumen's. They go through Lumen's MCP server, so site approvals, the approval card, hands-off mode and the sites where you turned AI off still apply to them, and the page text sent with your message is still labelled untrusted data. For Grok Build and Antigravity Lumen's tool gate still fails closed for anything named like one of Lumen's tools that isn't one. A web page the AI reads could still try to trick it into using its own tools, which is why this is opt-in.

| CLI | What full access passes | Verified |
|---|---|---|
| Claude Code | `--permission-mode bypassPermissions`, no `--tools ""` / `--allowedTools` / `--strict-mcp-config`, `--append-system-prompt`, working folder = home | checked against Claude Code 2.1.287 (#123) |
| Grok Build | `--always-approve --permission-mode bypassPermissions`; no `--disallowed-tools`, `--deny`, `--allow`, `--no-subagents`, `--no-plan`, `--disable-web-search`; no `[permission]` deny rules; `--cwd` and `HOME` = home folder; your whole environment; `GROK_HOME` stays Lumen's (your `~/.grok` config and skills are not loaded) | flag names and the mode value are listed by `grok --help` (1.0.44); no model call was made with them. `--sandbox` is not passed: its profile names are not in the help, so Grok's own default (or your `GROK_SANDBOX`) applies |
| Antigravity | `--dangerously-skip-permissions` instead of `--sandbox`; `settings.json` without deny rules and with the terminal sandbox off; working folder = home; your whole environment; `HOME` stays Lumen's config folder (agy has no config-folder flag), so your `~/.gemini` config is not loaded and `~` in a shell is not your home (the note agy gets names the real path) | flag names listed by `agy --help` (1.2.14); no model call was made with them |
| Codex | `--sandbox danger-full-access` and `sandbox_mode = "danger-full-access"` instead of read-only; the `[features]` shell, unified exec and view_image tools back on and `web_search = "live"` (plugins, apps, hooks, memories, sub-agents, browser and computer use stay off); `approval_policy = "never"` (never `--dangerously-bypass-approvals-and-sandbox`); your whole environment; working folder = a small empty Lumen folder, with your home folder's path in the note Codex gets; the Code Mode host stays on | checked live with Codex 0.160 (free tier, `gpt-6-luna`): a shell command runs with it and is refused without it |

If a CLI doesn't know one of these options it exits with a usage error before doing anything, and Lumen says so ("didn't accept the options Lumen uses to give it full access… Nothing ran") and points at the setting. It never carries on without the option while Settings says full access is on. Changing the setting mid-chat starts a new Antigravity conversation (its instructions ride on the first message); Claude Code and Grok Build pick it up on the next message.

### Codex in the sidebar

Two separate things use Codex. **Add to Codex CLI** (Settings → AI → Connect an AI agent) lets Codex drive Lumen from a terminal: it writes a `[mcp_servers.lumen]` entry to `~/.codex/config.toml`, with `startup_timeout_sec = 30` and `tool_timeout_sec = 600` (Codex's own 10 s and 60 s would end Lumen's start-up or an approval card the user is still reading), and the "driven by" pill names Codex. **Codex in the model menu** is the other direction: your chat answers with your own Codex sign-in. Lumen runs `codex exec --json` headless for each message (the prompt on stdin) and gives it Lumen's browser tools over MCP, and nothing else:

- its own Codex home per chat (`<profile>/codex-chats/<chat id>`), so your `~/.codex` servers, skills, hooks and `AGENTS.md` are not loaded and chats in different tabs never share a config or a thread; only the sign-in file (`auth.json`) is copied in before a run and back after it, never read or printed;
- `config.toml` there names one MCP server, `lumen`, over Lumen's local HTTP server with a token of its own for that run, handed to Codex by environment variable (`bearer_token_env_var`), never in a file or on the command line;
- `sandbox_mode = "read-only"`, `approval_policy = "never"`, Codex's own tools off (shell, pictures, browser, computer use, sub-agents, apps, plugins and web search: `[features]` and `web_search = "disabled"`, checked with `codex exec --strict-config` on codex-cli 0.160.0), an empty temp working folder (`lumen-cx-*`, removed after the run); never `--dangerously-bypass-approvals-and-sandbox`, `--full-auto` or a writable sandbox. If Codex reports a shell command, file change, web search or another server's tool anyway, Lumen stops the run;
- follow-ups resume the chat's thread (`codex exec resume <id>`); turns another model answered meanwhile, and a reply cut off by **Send now**, are handed over in front of the next message; **Stop** ends the process tree;
- the models are the ones `codex debug models` lists for your account (else Codex's own `models_cache.json`), else GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna and GPT-5.6 Sol; **Codex · Auto** picks between them ([Auto model](auto-model.md#auto-for-one-provider));
- usage is the turn's tokens (the Usage panel's Codex row) and the plan windows Codex logs; a usage limit moves the chat to another model when "Switch models automatically" is on (the OpenAI API first, when a key is set).

Codex has no streaming in `--json` mode: each message of the reply appears whole. Not used for background tasks or one-shot jobs (topic names, translation), which go to another connected model.

### Antigravity in the sidebar

Antigravity's CLI is `agy` (installed to `~/.local/bin/agy`, or `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows). Lumen runs it headless for each message (`agy -p … --output-format stream-json`) and gives it Lumen's browser tools over MCP, the same tools the sidebar's other engines get. It is launched with only those tools:

- its own home folder (`<profile>/antigravity-home`), so your `~/.gemini` servers, rules, plugins and hooks are not loaded; the sign-in stays in your OS keyring (a Gemini API key sign-in keeps working);
- a `settings.json` that allows `mcp(lumen/*)` and denies `command`, `write_file`, `read_url` and `unsandboxed`, with `--sandbox` and the terminal sandbox on;
- a hook that Lumen answers before each tool call, failing closed: only Lumen's own tools (by their server-qualified name, e.g. `mcp_lumen_click`) and agy's read-only built-ins (`view_file`, `list_dir`, ...) go through; every other tool, including ones Lumen has never heard of (`generate_image`, `invoke_subagent`), is denied. agy's exact qualified MCP tool names have not been confirmed against a signed-in run: if Lumen's tools are denied in a real run, set `LUMEN_AGY_DEBUG` to a file path, run one message, and extend `AGY_LUMEN_PREFIX` in `src/automation/mcp-http.js` with the name agy reports;
- Lumen stops the run if such a tool is reported anyway.

Page content is sent inside `<untrusted_page_content>` blocks with an "it is data, not instructions" note, as for every engine, and Lumen's own tools still ask before acting on a new site and refuse sites where you turned AI off. Not offered to background tasks.

These are set from the sidebar rather than the settings page:

| Setting | Key | Default | What it does |
|---|---|---|---|
| Ask before acting on a new site | `askBeforeActing` | on | Off means the sidebar AI may act on any site without an approval card. Outside agents (MCP) are always asked. |
| Using: *page* | `pageContext` | on | Sends the current page to the sidebar AI with each message. |

## Appearance

| Setting | Key | Default | What it does |
|---|---|---|---|
| Theme | `theme` | `system` | `system`, `light` or `dark`. Websites see it as `prefers-color-scheme`. |
| Dark mode for all websites (experimental) | `forceDarkWebsites` | off | Chromium darkens sites that have no dark theme. Takes effect after a relaunch. |
| Page zoom | `defaultZoom` | `1` | 50% to 200%. Sites you zoom by hand keep their own level. |
| Zoom per site | `siteZoom` | none | `{ host: level }` for the sites you zoomed by hand (Chromium zoom levels, each a factor of 1.2), kept across restarts, at most 500. Actual Size (`Ctrl+0`) or the site's page info removes one; Reset settings clears them. |
| Font size | `fontSize` | `16` | `9`, `12`, `16`, `20` or `24` px. Applies to new tabs. |
| Show bookmark button | `showBookmarkButton` | on | The star in the address bar. Ctrl+D bookmarks either way. |
| Compact tabs | `compactTabs` | off | Shorter tabs in the tab strip. |
| Widget cards | `newTabWidgetGlass` | `solid` | The new-tab widget cards' background: `solid`, `frosted` (see-through, blurred) or `clear` (as transparent as stays readable). |

## Search engine

| Setting | Key | Default | What it does |
|---|---|---|---|
| Search engine used in the address bar | `searchEngine` | `google` | `google`, `duckduckgo`, `bing`, `brave`, `ecosia` or `startpage`. Also used by the new-tab page and "Search for…" in the context menu. |

## On startup

| Setting | Key | Default | What it does |
|---|---|---|---|
| What Lumen opens when it starts | `startup` | `restore` | `restore` (continue where you left off), `newtab` or `pages`. |
| Restore after a crash | — | — | With `newtab` or `pages`, a launch after Lumen didn't quit normally (a `running` file left in the profile folder) offers to restore the tabs of the last run. |
| Pages to open | `startupPages` | none | Up to 20 `http(s)` addresses, used with `pages`. |

## Translation

Settings → General → Translation. Translating is always a click (the address-bar button, the page menu or the bar); nothing is sent anywhere before that.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Offer to translate pages | `translateOffer` | on | A button and a bar appear when a page is in another language than yours. The language is detected on your computer (the page's `lang`, else its letters and common words). |
| Translate pages into | `translateTarget` | Lumen's language | One of 23 languages. |
| Translate with | `translateEngine` | `local` | `local`: on this device, with Mozilla's open-source Bergamot engine (the one in Firefox Translations), running in its own process. The page's text never leaves your computer. `ai`: your connected AI first. Either one falls back to the other when it can't take the page (no language pack for the pair, or none connected), and the page menu always lets you pick: Translate on this device, Translate with your AI, Google Translate. |
| Download language packs without asking | `translateLocalAuto` | off | On-device translation needs a language pack per direction (about 20 to 55 MB, downloaded once from Mozilla's servers and checked against Mozilla's published SHA-256). Off: the bar asks first ("Download the French → English language pack (37 MB)?"), with an "Always download" button that turns this on. Two languages with no pack between them are translated through English, as Firefox does, which needs both packs. |
| Sites never offered translation | `translateNever` | none | Hosts where the bar stays away. |
| Allowed to receive page text | `translateConsent` | none | Providers (your AI, Google Translate) you let receive a page's text or address. On-device translation needs no entry here. |
| Language packs on this device | — | — | Each downloaded pack with its size and a Delete button, the total, and Delete all. Packs live in `translation-models/` in Lumen's data folder. |
| Download for offline | — | — | Download a language's packs (to and from English) ahead of time, with the language, size and percent, and Cancel. Cancel, closing the settings page or leaving it stops only the download started here; a tab that is fetching the same pack keeps going. Deleting a pack that a tab is downloading stops that download and the tab's bar says the pack was deleted. A download that stalls (no data for 30 seconds) is retried once, a full disk is caught before the download starts, and leftover half-downloads are cleaned up. |

On-device translation sends whole sentences: the text nodes of one block (a paragraph, list item, heading or cell, with its links and emphasis) are joined into one request with numbered markers (` ⟦1⟧ `, chosen by measuring the real engine: it kept 8 of 8 numbered markers intact, against 5 of 8 for private-use characters, which also garbled neighbouring words) at the seams, and the reply is cut at the markers again, so `A <b>quick</b> brown <a>fox</a> jumps.` is translated as one sentence and each piece lands back in its own element. Code, form fields and `translate="no"` text split a sentence instead of being sent. A line break (`<br>`) also splits a sentence, and a page whose own text contains a marker is not grouped. If the engine drops, adds, renumbers or garbles a marker, that block is translated node by node instead, and after three such blocks in a row (two for a pair that has never worked) the run stops grouping, and so does that language pair for 10 minutes. A page that changes a node while its block is being translated keeps the block as written and has it collected again. Delete and Delete all in the language packs list ask for a second click. Numbers, prices, dates and percentages inside a sentence ("Showing <b>10</b> of <b>200</b> results") travel with it; one on its own is left as written. The engine may reformat a number for the target (٢٠٠, 1.000,5, 5,99 €); one whose value changed (1.5 to 15, 200 to 2000) is never written to the page, and after three such segments in a row the pair's numbers are left out of its sentences for 10 minutes (re-probed after that, with the pause doubling up to an hour). Dates, times and numbers turned into words are kept as written and count for nothing. The comparison is of signed values: a lost minus sign or brackets (-5 to 5) is corruption, and so are shifted digits in a range (5-10 to 51-0). Words the engine puts inside a number's own part are never written there: the number stays as it was, and if a neighbouring word node came back empty because its words moved into the number, that block is translated node by node instead, so nothing is lost. A lone . or , is read by the languages involved when they are known ("1,234" is 1234 in English but 1.234 for a German target, so writing it unchanged for German is refused); with no language the rule is: three digits after 1 to 3 is thousands, anything else decimal. Dates (5.6.2024, 12.05.24, 2024-05-01) are never read as one number: the same groups in the same order are fine with any separator, any other reformat is kept as written, and none of it counts against a pair. Vulgar fractions (1½, 1 1/2) and mirrored brackets for a right-to-left target (`)5(`) are left as written. En and em dashes count as minus signs. A block is translated node by node instead when any number would show more times than the source has it (the engine moved or copied a number into a neighbouring part: "Zeige 10 von | 10 | von | 200"), or when words were put into a plain number's part (they would be dropped). Three such blocks in a row switch numbers off for the pair, with the same 10, 20, 40, 60 minute backoff, re-probe and clearing as corrupt numbers. A number copied back unchanged is never judged (so "1,234" copied for a German target is not counted), list markers that lose their brackets ((1) to 1) are left as written, coordinates and ranges are compared token by token including each sign, and codes such as 192.168.0.1 are compared group by group. What is verified: all of the number rules above are covered by unit tests against fake engines that return the shapes described (`test/translate-group-units.js`); the real engine was measured only for whether the markers survive (`docs/translate-seam-measurement.md`), not for each number format, so how often a real model produces these shapes is not known. Known gap: this value check covers numbers that are their own text node (`<b>10</b>`); a number inside a word node ("Page 10 of 20" in one node) or in text the engine received unsplit is only as accurate as the engine, and is not value-checked. A pair that has never worked starts with a small first request, and a failed probe costs one chunk. A segment holds at most 12 text nodes. The pause on a pair lasts 10 minutes, then one grouped run probes again (each failed probe doubles the pause: 10, 20, 40, then 60 minutes at most; a working probe clears it). The markers' real-engine survival rates per language pair are in `docs/translate-seam-measurement.md`: they survive well into English and Arabic and badly into Persian, which is what the pause is for. Words can land next to the wrong element when the engine reorders across a marker (the text stays complete). Attributes such as `placeholder`, `title`, `aria-label` and button values are not translated yet. Known limit: this is not full HTML-mode translation (as Firefox does), so word order can move within a block but the markup around each piece stays where it was.

Private windows: an unclicked offer never happens there; a click translates on this device with no consent card.

## Privacy and security

| Setting | Key | Default | What it does |
|---|---|---|---|
| Clear browsing data | — | — | History follows the chosen time range. Cookies, site data and the cache are cleared for all time. |
| Block third-party cookies (best effort) | `blockThirdPartyCookies` | off | Stops sending cookies with requests to other sites embedded in a page. |
| Send a "Do Not Track" request | `sendDoNotTrack` | off | Adds `DNT: 1` to every request. |
| Send Global Privacy Control | `sendGpc` | off | Adds `Sec-GPC: 1` to every request. |
| Always use secure connections | `httpsOnly` | off | Upgrades `http://` to `https://` and warns before loading a site with no secure version. Local addresses are left alone. |
| Save passwords | `savePasswords` | off | Offers to save a password when you sign in on an https site (or `http://localhost`), and fills a saved one when you click the key in the address field (never by itself, never submitting). Not in private windows or the AI's research tabs. The logins are in `passwords.bin` in the profile, encrypted with the OS keychain (safeStorage), never in `settings.json`; without OS encryption it won't turn on. Turning it off asks whether to delete them (Keep is the default). Changed only from its switch, not with `prefs:set`. |
| Saved passwords | — | — | Privacy and security → Saved passwords: site and username per login, Show and Copy (Touch ID where the Mac has it, a confirmation otherwise), Edit, Delete, Import from CSV (Chrome, Apple Passwords, Firefox, Bitwarden exports) and Delete all. |
| Never saved for | `passwordsNever` | none | Sites where you chose "Never for this site". |
| Use passkeys and security keys (Windows Hello) | `passkeys` | on | Windows 10 1903+: pages may use WebAuthn (passkeys, Windows Hello, security keys, a phone over QR), run by Windows' own WebAuthn API (`features/passkeys.js`, `features/webauthn-windows.js`); Windows keeps the credentials, Lumen stores nothing. Requests come only from the tab in front of a focused window, never from a page the AI opened or is using. Off, or on macOS/Linux/older Windows: pages see no passkey API (`browser/webauthn-gate.js` hide mode) and offer a password or a code. No passkey autofill (conditional mediation). Applies to pages loaded after the change. |
| Warn about dangerous sites (Google Safe Browsing) | `safeBrowsing` | off | Checks each page against Google's lists of suspected phishing and malware, kept on your computer; a listed page shows a warning instead. Needs your own Google API key (stored encrypted in `keys.safebrowsing`, or `GOOGLE_SAFE_BROWSING_API_KEY`). Only 4-byte partial hashes of a matching address go to Google. |
| Block ads and trackers | `adblock` | on | Built-in blocker using uBlock Origin-compatible filter lists. |
| Sites where ads are allowed | `adblockAllow` | none | Host names the blocker leaves alone. |
| Default for new sites | `permissionDefaults` | ask | Per permission (location, camera and microphone, notifications, clipboard): `ask` or `block`. |
| Site permissions | — | — | What you allowed or blocked per site. Revoke to be asked again. |
| Site data | — | — | Every site that keeps cookies, grouped by site with its cookie count. Remove deletes that site's cookies and what it stored on this computer. |

## Downloads

| Setting | Key | Default | What it does |
|---|---|---|---|
| Location | `downloadDir` | Downloads folder | An existing folder. Empty means the system Downloads folder. |
| Ask where to save each file before downloading | `askWhereToSave` | off | Shows a save dialog for every download. |

Programs and scripts are held until you agree to keep them, whatever these settings say.

## Languages

| Setting | Key | Default | What it does |
|---|---|---|---|
| Preferred languages | `languages` | Chromium's default | Up to 12 language tags, most preferred first. Websites see them as the `Accept-Language` header. |
| Check spelling when you type | `spellcheck` | on | Right-click a misspelled word for suggestions. |
| Spell-check languages | `spellcheckLanguages` | none | Windows only; macOS uses the languages in System Settings. |

## Accessibility

| Setting | Key | Default | What it does |
|---|---|---|---|
| Reduce motion | `reduceMotion` | off | Turns off animations in Lumen's own UI and pages. |
| Minimum font size | `minimumFontSize` | `0` (none) | `6` to `24` px. Applies to new tabs. |
| Show a focus ring | `focusRings` | off | Always outline the focused control in Lumen, not only when using the keyboard. |

## System

| Setting | Key | Default | What it does |
|---|---|---|---|
| Use graphics acceleration when available | `hardwareAcceleration` | on | Turn off if pages flicker. Takes effect after a relaunch. |
| Put unused tabs to sleep | `tabSleep` | on | Frees memory from background tabs left alone for a while; switching back reloads them. |
| Keep Lumen running when its window is closed | `keepRunningInBackground` | on | macOS only. |
| Proxy | `proxy` | `system` | `mode` is `system`, `direct`, `fixed_servers` (with `rules` and `bypass`), `pac_script` (with `pacUrl`) or `auto_detect`. Applies straight away. |
| Download updates automatically | `autoDownloadUpdates` | on | New versions download in the background and "Restart to update" appears when one is ready. Off: Lumen asks before downloading. Copies that can't replace themselves (portable exe, per-machine install, unwritable Mac app) say when a version is out and download it when you ask. |
| Show what’s new after updates | `showWhatsNew` | on | The first time Lumen starts on a newer version, the release notes for every version since the one you last ran come up once (from `CHANGELOG.md`, which ships inside Lumen, so no network is needed). A first run ever shows nothing. The same switch is on the card itself; **Show what’s new** here, or **What’s New in Lumen…** in the ⋯ menu (More Tools) and the Mac Help menu, opens the notes any time. The last version you ran is kept as `lastSeenVersion` (internal; Lumen records it, Reset settings keeps it). |

## Background tasks

Kept in one `bgTasks` object (Tasks panel > Settings, in the sidebar). Every task runs in a work tab of its own that is not in your tab strip.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Allow background tasks | `bgTasks.enabled` | on | Off stops running tasks and hides the composer button and menu items. |
| Tasks at the same time | `bgTasks.maxConcurrent` | 2 | 1 to 3. More wait in line (the panel shows their place). Performance mode can lower it to 1. A task waiting for your answer still holds its place. |
| Stop a task after | `bgTasks.timeoutMin` | 30 | 10, 30, 60 or 120 minutes of working time; time spent waiting for you does not count. |
| Notify me when a task finishes or needs me | `bgTasks.notifications` | on | An in-app banner, plus a system notification when Lumen is not the window in front. |
| Also notify me when a task finishes fine | `bgTasks.notifyDone` | on | Off: only failures, questions, watch alerts and interruptions notify. |
| Refuse an unanswered question after | `bgTasks.approvalWaitMin` | 60 | 15, 60 or 240 minutes. A card nobody answered is refused (never approved) so the task can finish and free its place. |

## Extensions

Lists the Chrome Web Store extensions you installed, with **Remove** (deletes the extension and its data) and a link to the Chrome Web Store. Electron can't pause an extension, so there is no on/off switch.

## Reset settings

**Restore settings to their original defaults** resets appearance, search engine, startup, privacy, site permissions, languages and system settings. Bookmarks, history, API keys and sign-ins stay.

## About Lumen and Internals

**About Lumen** shows the version, update status and **Check for updates**. **Internals** shows versions, a task manager (every Lumen process with memory and CPU), GPU features, the proxy in use and command-line switches. Nothing there changes a setting.

**Report an issue.** About has **Report a problem** (and **Copy version details**), and on macOS Help → Report an Issue does the same. Both open a new issue at [github.com/emah-maker/lumen/issues](https://github.com/emah-maker/lumen/issues/new/choose); the Help item fills in your Lumen version and OS. Nothing is sent until you submit the issue on GitHub.

### Usage for every AI

Settings → Usage has the same sections for each AI. What each one can show, and why:

| AI | Plan limits | Rate limits | Lumen counted |
|---|---|---|---|
| Claude Code | 5-hour and weekly windows from `claude -p /usage` and each turn's `rate_limit_event` | — | yes, with cost at API prices |
| Codex CLI | 5-hour and weekly windows from Codex's own session logs (ChatGPT sign-in) | — | tokens (Codex reports no price) |
| Grok Build | none published; Grok's limit-reached message and its reset time when it names one | — | yes |
| Antigravity | none published; the quota message with its reset time ("Resets in 110h") when a run hits it | — | tokens (no price) |
| Claude (API key) | none (an API key has no plan balance) | `anthropic-ratelimit-*` headers of the last reply | yes, estimated from the price table |
| OpenAI, Grok (API key) | none | `x-ratelimit-*` headers of the last reply | tokens; cost where the price table knows the model |
| Gemini | none | none sent by its OpenAI-compatible endpoint | tokens; cost where the price table knows the model |
| OpenRouter | none | `x-ratelimit-*` when sent | yes (OpenRouter reports each request's cost) |

Nothing is requested for this: rate limits are read from responses Lumen already received, plan windows from commands and logs it already read, and the rest is Lumen's own log (35 days, `usage.json`). A cost shows only when the provider reported it or the model is in the price table (`src/features/chat-usage.js`); otherwise the count says "no price known".

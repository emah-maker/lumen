# Settings reference

Open the settings page with **⋯ → Settings**, or type `lumen://settings` (or `chrome://settings`) in the address bar. `lumen://settings/<section>` opens one section, for example `lumen://settings/privacy`.

## How the page is laid out

Settings works like System Settings. The list on the left is the **topics**; a topic is a short page of rows, and a row that holds more opens a **page** with a Back button (a row with a value and a chevron, like “Default AI · Auto ›”). A small **i** next to a row's name opens its longer explanation; nothing on a page is a paragraph. Search (the box on top, or `/`) looks through every row of every page and shows the pages it found in place, each headed with where it is. In a narrow window (Settings beside the AI sidebar) the topics are one list, like iOS Settings, and a topic opens on its own page.

| Topic | What is on its page | Pages |
|---|---|---|
| **General** | Theme, search engine, on startup, default AI, apps and connections, default browser, import | Language and spelling, Sync, Focus mode |
| **Appearance** | Theme, accent color, page zoom, font size, toolbar buttons | |
| **Accessibility** | Reduce motion, minimum font size, focus ring, screen reader support | |
| **AI** | Model, short answers | Models and answers, API keys and sign-ins, AI providers, Instructions and memory, Asking before it acts, Tabs the AI opens, Helpers and research, Chat box and voice, Computer access, What the AI can see, Let agents use Lumen (with Connect an AI agent, Let other apps use Lumen, Phone (Telegram)), Routines, Skills, Macros, Usage |
| **Apps and connections** | One list of services | One page per service, Cards without an account, Custom MCP servers |
| **New tab page** | Search bar width, favorites, frequent sites, blocked-trackers count, widget cards, packing | Background, Animated effect, Clock and greeting |
| **Tabs and browsing** | Tab layout, side tabs, compact tabs | Group tabs automatically, Sleeping tabs |
| **Privacy and security** | Private windows | Clear browsing data, Tracking protection, Ad blocker, Passwords and passkeys, Safe Browsing, Site permissions, Site data, Extensions |
| **Downloads and files** | Download folder, ask where to save, printing, PDF viewer, recent files | Recent downloads |
| **Updates and about** | Software update | About Lumen |
| **Advanced** | Dark mode for all websites (experimental), reset | Performance and graphics, Network and proxy, Remote control for developers, Diagnostics (with Task manager and Internals) |

Every older link still works: `lumen://settings/connectors` opens Apps and connections, `lumen://settings/memory` the memory page, `lumen://settings/proxy` Network and proxy, and so on (the list is `ALIASES` in `src/renderer/settings.js`, and `test/units/settings-links-units.js` keeps it, the command bar and the backend in step).

### Apps and connections

Connectors (what the AI can use) and Widgets (cards on the new tab page) were two lists with separate sign-ins for the same services. They are one list now, made from the connector registry (`src/features/connectors/registry.js`), so a connector added there appears by itself, plus the services that only have a card (Spotify, Apple Music, Slack, Meta Muse). A service's page has one **Connect** (or Disconnect), then two switches, **Show on new tab page** (the card) and **Let the AI use it** (the connector), then its own options (Gmail: drafts and sending; a card's title, width and what it shows; tools of an MCP preset). Turning the AI switch off keeps the sign-in (`connectors:set-paused`); turning the card switch off only hides the card and keeps the sign-in.

| Service | One sign-in? |
|---|---|
| Gmail | Yes. The card and the AI use the same Google sign-in. |
| GitHub | Yes. One sign-in (the device flow) serves both. |
| Todoist | Yes. One token: the card's, and the connector reads it from there. |
| Google Calendar | The card's calendar link and the connector's secret address are separate stores. Connect saves the connector's and makes the card from the same link while the page is open. |
| Google Drive, Sheets | Their own Google grant, asked for when they are connected. The Google client under **Advanced** (your own client ID) is the one Gmail, Drive and Sheets sign in through. |
| Spotify, Apple Music, Slack, Meta Muse | Cards only; Slack's guided setup is in the card's options. |

## Where settings are kept

Everything is stored in `settings.json` in Lumen's profile folder:

| System | Profile folder |
|---|---|
| Windows | `%APPDATA%\Lumen` |
| macOS | `~/Library/Application Support/Lumen` |

The file is written atomically (a temp file renamed over the old one), and the previous good copy is kept as `settings.json.bak`. A file that can't be read falls back to the backup; if both are broken, the broken file is moved aside as `settings.json.corrupt-<time>` rather than overwritten.

The same rule holds for the other files Lumen keeps: `background-tasks.json` (routines and scheduled tasks), `skills.json`, `macros.json` and `mcp-servers.json`. A missing file means a fresh start. A file that exists but can't be read, parsed or decrypted is copied to `<file>.corrupt-<time>` (once per distinct content), is not overwritten by Lumen's own start-up or status saves, and nothing is deleted on the strength of it. A change you make yourself (add, edit, delete) does write the file, since the copy is kept; with no keychain, routines are not written at all. Likewise old pictures, uploads, AI conversation folders and project files are not cleaned up when the chat list was empty, unreadable or rebuilt this run.

API keys in `settings.json` are encrypted with the operating system's keychain. Without a keychain, keys aren't saved; use the environment variables instead.

The tables below give each setting's key in `settings.json` and its default. Edit the file only while Lumen is closed: Lumen rewrites it while it runs. Values that aren't valid are ignored and the default is used.

## General

| Setting | Key | Default | What it does |
|---|---|---|---|
| Default browser | — | — | Shows whether Lumen is the default browser and asks the system to make it so. On Windows, Lumen registers itself as a browser for the current user (so Default apps can offer it) and opens Default apps on Lumen; the choice is read from the user's HTTPS association. |
| First-run welcome | `welcome` | `pending` on a new install | The sidebar's welcome (connect an AI, import; an optional default-browser line) shows while this is `pending` and never again once it is `done`. Existing profiles never get it. |
| Remember files I open | `filesRemember` | on | Downloads and files → Files. Local files you open in Lumen (a file tab, a PDF, deck or email, a download you opened, a file the AI opened or made) go on the Files list: the Recent part of the new-tab page's Files card and the Ctrl+Shift+F picker ("Open a recent file"). Lumen remembers names and places only, on this computer, never the contents: path, name, size and times, encrypted with the OS keychain in `files.json` in the profile (500 entries at most; without OS encryption nothing is written to disk). Off: nothing new is recorded; what you pinned stays, and the Files card offers a **Turn on** button. Privacy and security → Files has a pointer row to this one. |
| Sync through a folder | `syncFolder` | off | General → Sync. Keeps bookmarks, history, chats, home page widgets and a short list of preferences the same on your computers through a folder your own cloud drive syncs (OneDrive, Dropbox, Google Drive, iCloud Drive). Stored as `{ on, path, kinds, passwords }`: `kinds` has a `true`/`false` for `bookmarks`, `history`, `chats`, `widgets` and `settings`; `passwords` (**Also sync saved passwords**, off, needs Save passwords on) adds the saved logins. Everything in the folder is encrypted (scrypt and AES-256-GCM) with a sync passphrase that is kept only on this computer, in `sync-secret.bin` in the profile, encrypted with the system keychain, never in `settings.json`. No Lumen server; nothing leaves the computer except into that folder. Off: none of its code is loaded. See [Sync through a folder](sync.md). |
| Start focus mode | — | — | General → Focus mode: a length (25 minutes to 3 hours) and **Start**. Blocks the sites below until the time is up. Also the toolbar button, `/focus`, and `focus for 90 minutes` typed in the chat. Nothing is blocked until it is started. See [Focus mode](focus.md). |
| Blocked sites | `focusSites` | youtube.com, youtu.be, reddit.com, tiktok.com, instagram.com, x.com, twitter.com, facebook.com, twitch.tv, netflix.com | General → Focus mode. Host names (a site and its subdomains) that show the focus page instead while focus mode is on. An empty list blocks nothing. Can't be changed while focus mode is on. |
| Focus schedules | `focusSchedules` | none | General → Focus mode. Recurring focus as a list of `{ id, days, from, to, on }` (days 0 = Sunday to 6, times `HH:MM` in local time, a window may cross midnight). Can't be changed while focus mode is on. |
| Clear Files list | — | — | Downloads and files → Files: empties the Files list (pins and recent files) and the index of pinned folders. Asks first. `lumen://settings/files` opens this group. |

## AI

| Setting | Key | Default | What it does |
|---|---|---|---|
| Model | `model` | **Auto** (`auto`) on a fresh profile with two or more models connected, else Claude Opus 5.5 | The model the sidebar AI uses. The same picker is in the sidebar. **Auto** is its first row: Lumen picks the model for each message ([Auto model](auto-model.md)). A saved choice is never changed. |
| Auto may use | `autoExclude` | none | Providers Auto never chooses (a tick per connected provider in Settings → AI). See [Auto model](auto-model.md). |
| Image generation | `imageGen` | `auto` | Where a picture request goes ("draw a cat", or the AI's `generate_image` tool): `auto` (a connected provider that makes pictures, the chat's own first, then Grok Build, Grok, Gemini, OpenAI, OpenRouter; one that is out of usage goes last, one that refuses on content grounds is not retried elsewhere), `off`, or one provider (`grokbuild`, `xai`, `gemini`, `openai`, `openrouter`). Never a provider you haven't connected. See [Image generation](image-generation.md). |
| Keep a list of what the AI couldn't do | `aiGapLog` | on | When the AI still hands a task back to you after Lumen's one automatic second try, Lumen notes it in `diagnostics/ai-gaps.jsonl` in the profile folder: date, site (host name only), what was missing and the tool error, never page content or your words. The list is under Settings → AI → Show what the AI couldn't do, where you can copy it to send to us or clear it. Off: nothing is written. Nothing leaves the computer on its own. |
| Switch models automatically when one is unavailable | `autoFallback` | on | When the picked model hits its usage or rate limit, or can't be reached (no connection, a timeout, a server error or "overloaded"), the same reply goes on with the next usable model: a lighter one from the same provider first (Opus, then Sonnet, then Haiku), then the same vendor's other route (Claude API and Claude Code, Grok API and Grok Build), then your other connected providers. Only models you have set up are used. A short note in the chat says what happened, the model picker shows the model that is really answering (marked as temporary), and each reply's label names it. The unavailable model is left alone until its reset time, or about 15 minutes after a lost connection, then the chat returns to it by itself. Never on a rejected key, a sign-in problem, a refused request or a Stop. Tools that already ran are never run again. The chat so far goes to the model it switches to, so turn this off if you want every message to stay with the provider you picked. Also covers topic naming, Organize and page translation. |
| Compact long chats automatically | `autoCompact` | on | A chat with an API model (Claude by key or sign-in, OpenAI, Grok, Gemini, OpenRouter) whose history nears what the model can take in one request is summarized by that model before the next request, as `/compact` does, instead of its oldest messages being left out. The messages stay on screen; the AI sees the summary plus the latest exchange. A short note in the chat says when it happened. Claude Code, Grok Build and Antigravity compact their own sessions, so this doesn't apply to them. |
| Use custom instructions | `aiInstructionsOn` | on | Sends your two notes below to the AI at the start of every new chat, as your preferences. Off keeps what you wrote but does not send it. |
| What should Lumen know about you? | `aiInstructionsAbout` | empty | A note about you (for example: I am a nursing student; I use Windows). Up to 1,500 characters. Never overrides the safety and ask-before-acting rules. |
| How should Lumen respond? | `aiInstructionsStyle` | empty | How you want answers (for example: plain language, no bullet lists). Up to 1,500 characters. |
| Let the AI remember things between chats | `aiMemory` | off | Settings → AI → Instructions and memory. The sidebar AI saves short notes about you when you tell it something (shown in the chat with Undo) and gets them at the start of every chat. Never in temporary chats. See [Memory](memory.md). |
| Search past chats | `aiMemoryChatSearch` | on | While Memory is on, the AI may search the titles and text of your saved chats and gets short snippets. |
| Short, focused answers | `adhdMode` | on | Answers lead with the next step and stay brief. Applies to new chats. |
| Prefer fractions | `aiPreferFractions` | off | The AI writes exact values as fractions (4/3, not 1.333) and keeps √ and π, unless you ask for decimals. Fractions show stacked, with the number on top and the bar below. A plain 3/4 in an answer is stacked too (not dates, paths, units or code). Applies to new chats; `/fractions on` or `/fractions off` in the chat changes it. |
| Warm up Grok Build when Lumen starts | `grokWarmup` | on | Starts Grok Build's setup in the background so your first message starts faster: once the first tab has loaded, Lumen finds the `grok` program, starts its local tool gate and prepares its folders and sign-in link (again after the computer wakes). It happens only while Grok Build is connected to Lumen or chosen as the model, sends nothing to Grok and never makes a model request. Off: that setup happens when you send the first message. Takes effect without a restart. |
| Group tabs automatically | `tabGrouping` | `topic` | `off`, `site` (3 or more tabs from one site) or `topic` (related tabs, once 4 or more are loose). Tabs you group or move by hand stay put. |
| Organize only when topics are mixed | `organizeOnlyMixed` | on | Automatic organize leaves loose tabs alone when they are all about one thing. Off: those get a group too. |
| Organize after | `organizeDelaySeconds` | `5` | Seconds after the tabs change before loose tabs are grouped (2, 5, 10, 30 or 60). |
| Use AI to name and group topics | `topicAi` | off | Only with **By topic**. Sends tab titles and site names (never full addresses) to the cheapest model of your chat's provider. Off: topics are found on this computer. |
| API keys | `keys` | none | One per provider: Anthropic, OpenAI, xAI (Grok), Google (Gemini), OpenRouter. Stored encrypted. Environment variables also work. |
| Sign in with your Anthropic account | — | — | Uses an OAuth profile from Anthropic's CLI (`ant auth login`) instead of an API key. |
| Don't let the AI act on my pages | `aiHandsOff` | off | The AI (the sidebar, its engines, MCP agents, and programs connected through the automation port) can read your tabs but not click, type, navigate, run scripts in them, regroup or close them; it works in tabs it opened itself. Enforced in the tool layer (`src/ai/agent.js`) and in the automation proxy (`src/automation/automation.js`, which refuses acting protocol commands such as `Input.*`, `Page.navigate`, `Runtime.evaluate` on other tabs and lets reads like screenshots and `DOM.getDocument` through; only an allowlist of read commands passes). Playwright's high-level reads (`page.content()`, locators, `evaluate`) use `Runtime.evaluate`, which is refused on your tabs in this mode; attaching still works, and script injection at attach is skipped with a console warning. It does not limit a command-line AI you gave full access to this computer (below): its own tools are not Lumen's, and Lumen's browser tools stay under this setting and the approval cards.  **Stored the other way round:** the Settings switch is *Let the AI act on my pages* (on = the key is `false`). |
| Voice input | `dictationProvider` | `auto` | Who turns the chat box's mic recordings (and the Meeting helper's **Listen**) into text, with your own key: `auto` (OpenAI if it has a key, else Gemini), `openai` (`gpt-4o-mini-transcribe` via `/v1/audio/transcriptions`, `whisper-1` when the key can't use it), `gemini` (a Flash model, sent the audio inline as 16 kHz WAV with "transcribe verbatim") or `off` (the button explains how to turn it on). With no usable key the mic button says which key to add. The audio goes to that provider only, once, and is never saved (`src/ai/dictation.js`). |
| Send voice messages at once | `dictationAutoSend` | off | On: what you said is sent as soon as it is turned into text. Off: it goes into the chat box at the cursor so you can read it over first. |
| Tab to finish what I'm typing | `chatAutocomplete` | on | After a pause in the chat box, a cheaper model of the chat's own provider (Haiku / mini / Flash; never a CLI, and never another company) guesses the rest of the message and shows it in grey. It is sent what you have typed (up to 2,000 characters), the last few turns of the chat (up to 4,000 characters) and the tab's title. A chat on Claude Code, Codex, Grok Build or Antigravity gets no guess unless an API key from the same company is saved; a chat on Auto uses the model Auto would pick. Off: nothing is sent while you type (see [PRIVACY.md](../PRIVACY.md)). Tab takes it, Ctrl+Right one word (`src/ai/autocomplete.js`, `src/renderer/chat-autocomplete.js`). Its tokens go to the usage log, not the chat's totals. |
| One chat per tab | `oneChatPerTab` | off | Off: a tab with no chat of its own (a new tab, one you opened, one the AI opened) keeps showing the chat you were in; it joins that chat, and a message sent there makes that tab the chat's working tab, so the AI acts on the tab in front. A tab that has its own chat shows it; New chat starts a fresh chat bound to the tab. On: such a tab starts with an empty chat (`followPlan` in `src/features/tab-chats.js`). |
| Never switch away from my tab | `aiStayOnMyTab` | off | The AI never brings a tab to the front: `open_tab` and `switch_tab` with `show:true` still open or use the tab, but behind the one you are on (`src/main.js` stayOnUsersTab). Without it the AI already works in background tabs and fronts one only when it asks to show you a page while you are on its chat's tab.  **Stored the other way round:** the Settings switch is *Bring tabs the AI opened to the front* (on = the key is `false`). |
| Use my Claude Code settings in Lumen chats | `ccUserSettings` | off | Off: Lumen starts Claude Code with `--setting-sources project`, so its chats (and the one-shot helpers) skip your `~/.claude` CLAUDE.md, rules, memory, hooks and `settings.json`. Measured: about 1,870 fewer input tokens per chat (3,969 down to 2,099) and about 240 ms less cold start from your SessionStart hooks; the sign-in still works. If a chat fails to start with a sign-in, credential, proxy or certificate error while this is off (your `apiKeyHelper` or proxy variables live in `settings.json`), Lumen retries once with your settings loaded, keeps them for that chat's later messages and says so once; turn this on to avoid the retry. Changing it ends the chat's kept Claude Code process; the next message starts one with the new setting (the process key includes it). Full access (below) always loads your settings, as in a terminal. |
| Give all command-line AIs full access to this computer | — | off | A master switch for the four below. It is not stored: it shows on when all four are on, off when none is, and half-way when they differ; clicking it turns all four on only from off, and otherwise turns all four off. |
| Give Claude Code full access to this computer | `claudeCodeFullAccess` | off | Claude Code in the sidebar works as it does in a terminal: its own tools (shell, file reads and edits), your MCP servers, skills and slash commands such as `/goal`, run without asking (`--permission-mode bypassPermissions`, home folder as working folder). See [Full access for command-line AIs](#full-access-for-command-line-ais). |
| Give Grok Build full access to this computer | `grokBuildFullAccess` | off | Grok Build in the sidebar runs with `--always-approve` and `--permission-mode bypassPermissions`, its own tools (shell, files, subagents) and no deny rules, in your home folder. |
| Give Codex full access to this computer | `codexFullAccess` | off | Codex in the sidebar runs with `--sandbox danger-full-access` and `sandbox_mode = "danger-full-access"` (approval still never), its own shell, patch, picture-view and web search tools on, and your whole environment. It starts in a small empty Lumen folder, not your home folder, and is told your home folder's path. |
| Give Antigravity full access to this computer | `antigravityFullAccess` | off | Antigravity in the sidebar runs with `--dangerously-skip-permissions` and without `--sandbox` or its terminal sandbox, in your home folder. |
| Reasoning effort (per AI) | `aiEffort` | none (each AI's own default) | `{ "claudecode": "high", "openai": "low", … }`, one entry per AI, set in Settings → AI → AI providers; a missing entry means the AI's default, an invalid level is dropped. Levels: Claude Code `low`..`max` (`--effort`), Grok Build `low`/`medium`/`high` (`--reasoning-effort`; a chosen effort skips "Keep Grok Build connected" because a kept process keeps the effort it started with), Antigravity `low`..`max` (`--effort`), Codex `low`..`max` (`-c model_reasoning_effort=`), Claude API `low`/`medium`/`high` (only models Lumen already sends an effort to, such as Opus 5.5), OpenAI `minimal`..`high` (`reasoning_effort`, o-series and GPT-5), Grok API `low`/`high` (Grok 3 Mini only), Gemini `low`/`medium`/`high` (2.5 and newer), OpenRouter `low`/`medium`/`high` (`reasoning.effort`). A level a model does not take is not sent for the API providers; the CLIs report their own error. |
| Local models | `localAI` | off | Ollama or LM Studio on this computer: `{ "enabled": true, "flavor": "ollama" or "lmstudio", "url": "http://127.0.0.1:11434", "confirmedHost": "", "models": [{ "id": "llama3.2", "tools": true }] }`, set in Settings → AI → AI providers → Local (Detect fills `models`). Only `localhost`, `127.0.0.1` and `::1` addresses are used unless `confirmedHost` names the one other host you agreed to. See [Local models](local-models.md). |
| Projects folder | `projectsDir` | DocumentsLumen Projects | Where new projects get their own folder (an existing folder). A project's folder is made with the project, or you pick one ("Use an existing folder…"); deleting a project never deletes its folder. Chats in a project are also saved in the folder as Markdown files (`Chats<date> <title>.md`; a chat moved out goes to `ChatsRemoved`, a deleted one to `ChatsDeleted`). **These files are not encrypted.** Turn it off per project ("Save chats as Markdown files in this folder"), or press **Write all now** to export every chat. Chats outside projects are never saved this way. |
| Working folder | — | the project's folder | Per project (project editor) and per chat ("Work in folder…" in the chat's More menu; the composer shows it). Lumen's `list_files` lists it by default and reads text files in it without the device-access setting, and Claude Code, Codex, Grok Build and Antigravity run with it as their working folder. Without full access Claude Code may read and write only inside it; Codex may write only inside it. A drive root or your home folder needs a confirm. |
| Offer Claude Code in the model menu | `claudeCodeSidebar` | on | Off hides Claude Code and its models from every model picker without uninstalling or signing out. |
| Offer Grok Build in the model menu | `grokSidebar` | off until you connect or choose it | The same switch as Codex has (`codexSidebar` above). Antigravity's is `antigravitySidebar`, below. |
| Usage budget (per AI) | — (kept in `usage.json`) | none | Settings → Usage: an optional daily and weekly budget in dollars at API prices or in tokens, for each AI, counting only what Lumen itself used. Lumen tells you at 80% and 100%, shows a bar toward it, and never blocks anything. |
| When the AI finishes (AI tabs) | `closeAiTabs` | always (Close) | Leave open / Ask / Close. Close (the default) closes the tabs the AI opened as soon as it finishes, with Undo, but keeps the tab in front, a tab playing sound, and a tab the AI marked as one you still need (`open_tab` / `switch_tab` with `keep: true`: a page you asked to see, a sign-in or checkout left for you to finish). Leave open keeps the tabs, but a Close button still sits under any reply that opened tabs. A close never touches a tab you used, pinned or that holds typed text, nor the tab a chat lives in, and keeps a tab a chat is still working in (the toast says so). Closing shows Undo. You can also close them any time, in every window, from the ⋯ menu (Close tabs the AI opened) or from Lumen's taskbar icon: right-click it and choose Close tabs the AI opened (Windows, installed Lumen) or use its Dock menu (macOS). |
| Max steps per task | `maxSteps` | `0` | Most steps the sidebar AI takes on one request before it wraps up; 0 is Unlimited (it still stops if it loops). |
| Helpers that work in parallel | `aiSubagents` | `auto` | `off`, `auto` or `on`: the AI may hand independent read-only jobs to helpers that run side by side. Auto offers them only for a request with several parts. |
| Model for helpers | `aiSubagentModel` | `auto` | `auto` (a cheaper model of the chat's provider) or `same` (the chat's own model). |
| Chats working at once | `maxChatRuns` | `0` | Sidebar chats (one per tab) that may work at the same time; 0 is no limit. Past a limit they wait their turn. |
| Pick the model for me when I choose an engine's Default | `autoModel` | on | On Claude Code, Codex, Grok Build and Antigravity, Default picks a model per message (small for quick chat, mid for multi-step, large for hard problems). See [Auto model](auto-model.md). |
| Show usage bars in pickers | `usageBars` | on | The thin usage bars in the model menus and the AI status card. They use numbers Lumen already has. |
| Sites the AI may read signed in | `aiSignedInSites` | none | `[{ host, added }]`: sites you chose to let the AI read with your signed-in session. Added only from its approval card. |
| Let the AI use files on this computer | `aiDeviceAccess` | off | The AI can look in folders such as Desktop and Downloads, upload a file to a site you asked it to, and read the clipboard. Credentials folders and Lumen's own profile stay out of reach. |
| Let Grok Build ask to run terminal commands | `grokTerminal` | on | Grok Build in the sidebar may ask to run a command (an approval card each time). Off: every call is denied without asking. |
| Keep Grok Build connected | `grokKeepConnected` | off | Each Grok Build chat keeps its own process between messages, so replies start sooner (about 70 MB each while it waits). |
| Keep Codex connected | `codexKeepConnected` | on | Each Codex chat keeps its own `codex app-server` between messages (about 80 MB each while it waits). |
| Stop an idle Grok Build, Codex or Claude Code after | `grokKeepIdleMinutes` | `15` | Minutes before a kept process that was not used ends; 0 is only when its chat goes. |
| Show AI research in tabs | `researchTabs` | on | `web_search` and `read_urls` also open what they look at in background tabs, grouped "AI: <query>". |
| Sidebar button starts a new chat | `sidebarNewChat` | on | The AI button (and `Ctrl+J`) opens the sidebar on a new empty chat (an empty open chat is reused). Off: it reopens the chat it had. |
| Group tabs the AI opens (AI tabs) | `groupAiTabs` | on | Every tab the AI opens in a window joins one gray "AI tabs" group there, folded when it is made (your unfolding is kept). A tab you type in leaves the group. Research tabs keep their own "AI: …" groups. Off: the AI's tabs sit loose in the strip. |
| Keep AI tabs I click on | `keepViewedAiTabs` | on | A tab the AI opened stays open after it finishes if you clicked it in the tab strip (or the side list) to look at it. Off: such a tab closes like any other AI tab. Tabs you pinned, typed in or that are downloading are kept either way. |
| Hide AI tabs (AI tabs; also the tab strip button) | `hideAiTabs` | off | Leaves the tabs the AI opened out of the tab strip in every window (they stay open); the tab in front and one playing sound stay shown. A hidden tab that needs you (an approval, a dialog, an error page) turns the button's chip into "1 needs you", and a click shows that tab. Right-click the button, or press the Menu key or Shift+F10 on it, for the Hide switch and **Close tabs the AI opened, in all windows (N)**. |
| Connectors (Settings → Apps and connections) | — (kept in `connectors.json`) | none connected | Services the AI can use once you press Connect: Canvas (your signed-in session), Gmail, Google Calendar, Google Drive and Sheets (one Google sign-in in your browser), GitHub, Todoist and Notion. **Custom MCP servers** you add yourself are listed on the same page. A token is stored encrypted and never returned to the page; Disconnect deletes it. The AI gets one `connector` tool listing only the connected ones, and anything that changes something asks first. See [Connectors](connectors.md). |
| Allow AI agents to connect / Let other apps use Lumen | `mcpEnabled` | off | Turns on Lumen's MCP server for Claude Code, Codex CLI, Grok Build, Antigravity and other MCP clients (the commands to connect each one are listed under it), and is the master switch of Settings → AI → Let other apps use Lumen. Each app (Claude Desktop, Cursor, VS Code, Claude Code) gets a token of its own, kept encrypted in `external-apps.json`; Revoke deletes it. See the [MCP tool reference](mcp-tools.md) and [Let other apps use Lumen](external-apps.md). |
| Require a token for every app | `externalAppsRequireToken` | on when Let other apps use Lumen is first turned on from its page; unset (off) for someone who already had agent connections on | An app without a token is refused. Off: each token-less connection waits for Allow / Deny as an unverified app (Allow lasts that session, the app always asks before it acts, and it can't use the name of an app you set up). Settings shows a warning while it is off. |
| Agents in their own window don't ask | `agentsNoAsk` | on | An outside agent (MCP) works in a Lumen window of its own; with this on, its clicks, typing, scripts, PDF reads and visits to new sites there run without approval cards (`src/ai/agent.js` autoAllows, set per call in `src/features/ai-agents.js` mcpCallTool), so it keeps working while Lumen is minimized or behind other windows. Per-site AI off, tabs kept off and hands-off mode still refuse. Off: each new site asks, as before.  **Stored the other way round:** the Settings switch is *Ask before agents act in their own window* (on = the key is `false`). |
| Offer Codex in the model menu | `codexSidebar` | on | Once the Codex CLI is found and signed in, **Codex** (and each model it lists, plus its own **Auto**) is in every model picker under "Your OpenAI account". Turn it off to hide it. See [Codex in the sidebar](#codex-in-the-sidebar). |
| Antigravity | `antigravitySidebar` | off until you choose it | Google's coding agent (`agy`), which replaces Gemini CLI as a sidebar engine. **Use in the sidebar** (here, or the "Use your own Antigravity" card in an empty sidebar) offers it in the model menu once it is installed; if it isn't, this row shows Google's own install command for your system and runs it only when you click **Run this command**. You sign in by running `agy` once in a terminal; Lumen never sees the login. Like Claude Code and Grok Build it gets Lumen's browser tools only (see [Antigravity in the sidebar](#antigravity-in-the-sidebar)). |
| Allow automation tools (Chrome DevTools Protocol) | `automationEnabled` | off | For Playwright and other CDP tools, through a filtering proxy on localhost. Turning it on takes effect after a relaunch; turning it off closes the proxy at once. |
| Port (localhost only) | `automationPort` | `9222` | The proxy's port. The address you copy includes a secret key; requests without it are refused. |
| Import bookmarks and history | — | — | From Chrome, Edge, Brave, Vivaldi, Opera, Firefox or (on macOS) Safari on this computer. Passwords and cookies are not imported. |

### Full access for command-line AIs

Off by default, and each command-line AI has its own switch (plus the master switch above). Turning one on runs only that CLI's sidebar chats the way the CLI runs in your terminal, from the next message: its own tools (shell commands, reading and changing any file) work without asking, and Lumen's approval cards and **Don't let the AI act on my pages** do not apply to those tools. Background tasks and Routines never get full access, and the one-shot helpers (Organize Tabs, naming) stay tool-less.

What does not change: Lumen's browser tools are still Lumen's. They go through Lumen's MCP server, so site approvals, the approval card, hands-off mode, tabs you keep the AI from acting on and the sites where you turned AI off still apply to them, and the page text sent with your message is still labelled untrusted data. For Grok Build and Antigravity Lumen's tool gate still fails closed for anything named like one of Lumen's tools that isn't one. A web page the AI reads could still try to trick it into using its own tools, which is why this is opt-in.

| CLI | What full access passes | Verified |
|---|---|---|
| Claude Code | `--permission-mode bypassPermissions`, no `--tools ""` / `--allowedTools` / `--strict-mcp-config`, `--append-system-prompt`, working folder = home | checked against Claude Code 2.1.287 (#123) |
| Grok Build | `--always-approve --permission-mode bypassPermissions`; no `--disallowed-tools`, `--deny`, `--allow`, `--no-subagents`, `--no-plan`, `--disable-web-search`; no `[permission]` deny rules; `--cwd` and `HOME` = home folder; your whole environment; `GROK_HOME` stays Lumen's (your `~/.grok` config and skills are not loaded) | flag names and the mode value are listed by `grok --help` (1.0.44); no model call was made with them. `--sandbox` is not passed: its profile names are not in the help, so Grok's own default (or your `GROK_SANDBOX`) applies |
| Antigravity | `--dangerously-skip-permissions` instead of `--sandbox`; `settings.json` without deny rules and with the terminal sandbox off; working folder = home; your whole environment; `HOME` stays Lumen's config folder (agy has no config-folder flag), so your `~/.gemini` config is not loaded and `~` in a shell is not your home (the note agy gets names the real path) | flag names listed by `agy --help` (1.2.14); no model call was made with them |
| Codex | `--sandbox danger-full-access` and `sandbox_mode = "danger-full-access"` instead of read-only; the `[features]` shell, unified exec and view_image tools back on and `web_search = "live"` (plugins, apps, hooks, memories, sub-agents, browser and computer use stay off); `approval_policy = "never"` (never `--dangerously-bypass-approvals-and-sandbox`); your whole environment; working folder = a small empty Lumen folder, with your home folder's path in the note Codex gets; the Code Mode host stays on | checked live with Codex 0.160 (free tier, `gpt-6-luna`): a shell command runs with it and is refused without it |

If a CLI doesn't know one of these options it exits with a usage error before doing anything, and Lumen says so ("didn't accept the options Lumen uses to give it full access… Nothing ran") and points at the setting. It never carries on without the option while Settings says full access is on. Changing the setting mid-chat starts a new Antigravity conversation (its instructions ride on the first message); Claude Code and Grok Build pick it up on the next message.

### Codex in the sidebar

Two separate things use Codex. **Add to Codex CLI** (Settings → AI → Let agents use Lumen → Connect an AI agent) lets Codex drive Lumen from a terminal: it writes a `[mcp_servers.lumen]` entry to `~/.codex/config.toml`, with `startup_timeout_sec = 30` and `tool_timeout_sec = 600` (Codex's own 10 s and 60 s would end Lumen's start-up or an approval card the user is still reading), and the "driven by" pill names Codex. **Codex in the model menu** is the other direction: your chat answers with your own Codex sign-in. Lumen runs `codex exec --json` headless for each message (the prompt on stdin) and gives it Lumen's browser tools over MCP, and nothing else:

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
| Ask before acting on a new site | `askBeforeActing` | on | Off means the sidebar AI may act on any site without an approval card (the bolt menu's **Auto-allow actions**). Outside agents (MCP) are asked unless they work in their own window. |
| Files the AI may always see | `aiSharedFiles` | none | Files on this computer you chose **Allow always for this file** for, on the card that asks before the AI looks at a file you are asking about ("what does this say?"): their addresses. Added only from that card, removed in Settings → AI → **Files on this computer the AI can see**. **Turn off AI here** for local files overrides it. |
| Work on files in their apps | `aiFilesInApps` | Automatic | Where the AI works on a document of an app (Word, Excel, PowerPoint, MATLAB...). **In the app** opens it in the app that owns it and reads and edits it there, so you can watch; it still needs the matching switch on and asks as usual. **From the file** reads and edits the file's own data and does not open apps. **Automatic** lets the AI choose, as before. See [docs/word.md](word.md) and [docs/desktop-apps.md](desktop-apps.md). |
| Let the AI use Microsoft Word | `aiWordControl` | on | The AI can read and write Word documents directly: Word's own automation on Windows, and `.docx` files without Word. Every change to a document asks first, saving shows the file first, hands-off mode refuses changes, and nothing starts until the AI is asked to work with a document. A card in the chat shows the document live. See [docs/word.md](word.md). |
| Let the AI use other apps on this computer | `aiDesktopControl` | off | Windows and macOS. The AI can read and operate programs such as Word, File Explorer, Finder or MATLAB, one app at a time, after you allow each one. A banner shows it working; Esc held stops it. Passwords, security prompts, password managers, banking, system settings and Lumen itself are never available. On macOS it also needs Accessibility (and Screen Recording for pictures) in System Settings → Privacy & Security. See [docs/desktop-apps.md](desktop-apps.md). |
| Also allow terminals | `aiDesktopTerminals` | off | Lets the AI use Command Prompt, PowerShell and Windows Terminal (Terminal, iTerm, Warp, Ghostty and others on macOS) once the switch above is on. A terminal can run anything on this computer. |
| Apps the AI can use | `aiDesktopApps` | none | The apps you chose Always for. Added only from the approval card; Revoke removes one. |
| Bypass permissions | `bypassPermissions` | off | Every approval card is answered Allow for you (a PDF, a signed-in account, an upload of a file you attached, an MCP tool, Grok Build's terminal commands, new sites, leaving with what it read), for the sidebar AI on every model and for connected agents, and each one shows as a step ("Allowed automatically: …"). Chosen from the bolt menu in the sidebar head or Settings → AI → **Asking before it acts** (**Ask** / **Auto-allow actions** / **Bypass permissions**); the three levels are one choice. Sites with AI off, tabs kept off and hands-off mode still apply, uploads still use only files you attached or picked, and the **Choose file…** card still waits for you. Background tasks bypass only with the next setting on. |
| Bypass in background tasks and routines too | `bypassBackground` | off | With Bypass permissions on, background tasks and routines also get every card answered Allow, including steps that buy, send, post or submit something; each is listed in the task's steps. Does nothing without Bypass permissions, and switches itself off when you leave Bypass permissions (it is chosen again each time). Sites with AI off and tabs kept off still apply; a task has no files to upload. |
| Let helpers act in tabs | `actingHelpers` | off | Settings → AI. The sidebar AI may hand up to 3 independent browser jobs to helpers that work at the same time, each in a background tab of its own (the `parallel_tasks` tool): they navigate, click, type, fill forms, find, read (compact), wait and take screenshots, on the helpers' model (**Model for helpers**), at most 20 steps and 5 minutes each. No scripts, uploads, other apps, connectors, memory or tab switching. Each acting step on a new site asks on the chat's usual card, marked "Helper 2:"; sites you already allowed in the chat carry over, and Ask, Auto and Bypass behave as in the chat. Helpers are told never to buy, send or submit and to hand that step back; `fill_form` with submit is refused for them. A finished helper's tab is left to **When the AI finishes**; a stopped, failed or timed-out helper's tab is closed at once. API key models only: Claude Code, Grok Build, Antigravity and Codex have subagents of their own. |
| Start new chats in plan mode | `planModeDefault` | off | A new sidebar chat starts with **Plan** on (the button next to the message box): the AI only reads pages, tabs and the web, then shows a plan card with its steps, the sites it will act on and the risky steps. **Run plan** sends the plan as your next message and lets the AI click and type on exactly those sites in that chat (opening or sending to them after reading a page still asks); **Edit** lets you change the steps or drop sites first; **Keep planning** sends it back. Plan can be turned on or off per chat in the message box, or used once with `/plan <task>`. API models only: on Claude Code, Codex, Grok Build and Antigravity the button is off. |
| Take requests from my Telegram bot | `telegramChannel` | off | Settings → AI → Let agents use Lumen → Phone (Telegram). While Lumen is open, messages from the paired chat of your own Telegram bot run as background tasks and the results are sent back; the tasks' approval questions come with Allow and Deny buttons. Needs a bot token (stored encrypted) and pairing. Messages and results pass through Telegram's servers. See [Phone (Telegram)](telegram.md). |
| Save photos and files I send to the bot | `telegramFiles` | on | Photos and files you send to your Telegram bot are saved to Downloads/From phone, with an **Attach to chat** toast (a caption goes into the empty prompt, never sent by itself). Links you send open as tabs. Off: the bot only takes text requests. See [Phone (Telegram)](telegram.md#send-files-and-links-from-your-phone). |
| Use my sign-ins in these tasks | `telegramSignedIn` | off | Tasks started from Telegram use your cookies (a background task's **Use my sign-ins**). Off: they work signed out. |
| Using: *page* | `pageContext` | on | Sends the current page to the sidebar AI with each message. |

### Skills

Settings → Skills (`lumen://settings/skills`): saved instructions you run with `/name`, import and export as JSON or as SKILL.md folders (the Agent Skills format Claude Code uses), and let the AI load on its own. Kept in `skills.json` in the profile folder. See [Skills](skills.md).

| Setting | Key | Default | What it does |
|---|---|---|---|
| Let the AI use skills on its own | `skillsAutoUse` | on | Skills marked **AI can use this on its own** (none by default) are listed by name and one line in each new chat's system prompt, and the AI loads one with `use_skill` when the request matches. Off: skills run only from `/`. Sidebar API chats only. |
| Use my Claude Code skills | `skillsFromClaudeCode` | off | Also offers `~/.claude/skills/*/SKILL.md` as read-only `/` commands, and to the AI on its own. Only each SKILL.md is read; scripts beside it are never run. |
| Offer to save and improve skills | `skillsSuggest` | off | After a run that ended well and took 8 or more tool steps, offers **Save how I did this as a skill?**. After you correct a skill's result, offers **Update the skill with what changed?** with a diff to accept. Never saves or changes a skill without your click. |

### Macros

Settings → Macros (`lumen://settings/macros`): saved step lists you run from the ⋯ menu, a keyboard shortcut, `/macro name` in the sidebar, or the AI's `run_macro` tool. Record one, describe one, or add steps by hand; a macro never stores a password or card number. Kept in `macros.json` in the profile folder. See [Macros](macros.md).

## Appearance

| Setting | Key | Default | What it does |
|---|---|---|---|
| Theme | `theme` | `system` | `system`, `light` or `dark`. Websites see it as `prefers-color-scheme`. |
| Dark mode for all websites (experimental) | `forceDarkWebsites` | off | Chromium darkens sites that have no dark theme. Takes effect after a relaunch. |
| Page zoom | `defaultZoom` | `1` | 50% to 200%. Sites you zoom by hand keep their own level. |
| Pinch to zoom | `pinchZoom` | on | A trackpad or touch pinch magnifies the page in place, as in Chrome. `Ctrl`/`Cmd` plus + or - still change page zoom. |
| Zoom per site | `siteZoom` | none | `{ host: level }` for the sites you zoomed by hand (Chromium zoom levels, each a factor of 1.2), kept across restarts, at most 500. Actual Size (`Ctrl+0`) or the site's page info removes one; Reset settings clears them. |
| Font size | `fontSize` | `16` | `9`, `12`, `16`, `20` or `24` px. Applies to new tabs. |
| Show bookmark button | `showBookmarkButton` | on | The star in the address bar. Ctrl+D bookmarks either way. |
| Show the AI read-only button in the address bar | `showAiOffButton` | on | The shield in the address bar that keeps the AI from acting on a tab (it can still read it). Hidden on Lumen's own pages either way; the tab menu has the same choice, and a tab already kept off keeps its shield so you can turn it back on. |
| Show extensions in the toolbar | `extensionsToolbar` | `pinned` | `pinned` (only the extensions you pin have a button; the rest are listed under the puzzle button, as in Chrome), `all` (every extension has a button) or `none` (no extension buttons and no puzzle button; extensions keep running and stay listed in Settings → Extensions and the ⋯ menu). |
| Pinned extensions | `extensionPins` | all you had | The extensions pinned to the toolbar, left to right, and the ones that have had their first choice: `{ order: [ids], seen: [ids], migrated }`. Every extension installed when this was added starts pinned, in its current order (`migrated` records that); one installed later starts pinned while fewer than three are pinned; after that it starts in the puzzle button's menu. Changed with the pin switches in Settings → Extensions, the puzzle menu, ⋯ → Extensions, or by dragging (or Alt+Left / Alt+Right) in the toolbar; not set directly. |
| Tab layout | `tabLayout` | top | Top puts the tabs across the top of the window; Side lists them down the left (favicon and title, pinned tabs first, groups you can fold). Right-clicking the empty part of the tab strip switches too. |
| Side tabs: icons only | `sideTabsCollapsed` | off | Shrinks the side list to icons; it opens out while the pointer is over it. |
| Side tab list width | `sideTabsWidth` | 240 | How wide the side list is (160 to 420 pixels). Drag its right edge to change it; Lumen remembers it. |
| Compact tabs | `compactTabs` | off | Shorter tabs in the tab strip. |
| Accent color | `accentColor` | `blue` | The color of buttons, links, the selected tab and focus rings, on every page of Lumen. One of thirteen: `blue`, `indigo`, `purple`, `pink`, `rose`, `red`, `orange`, `amber`, `lime`, `green`, `teal`, `cyan`, `graphite`; or `wallpaper` (take it from the new-tab background: a picture's dominant color, a gradient's own; Plain gives Blue); or any `#rrggbb`. Whatever is chosen is fitted in light and dark so that text in it stays readable (at least 4.5:1), white on its buttons too (4.5:1) and the color as a focus ring or icon at least 3:1: a color that already passes is used as it is, one that does not keeps its hue and gets lighter or darker (`src/features/theme-colors.js`). Applies at once everywhere: the window, Settings, the chat page, the PDF viewer, the new-tab page and the small popups. |
| New tab background | `newTabBackground` | `plain` | Behind the new-tab page: `plain` (the page's own colors), one of 21 gradients and 10 solid tones (the pictures are CSS: nothing is bundled or downloaded), or `image` (a picture you chose, resized and kept in your profile). Each is made for white text or for dark text, and the page follows: a light background keeps dark text and turns the cards to white glass (`src/features/backgrounds.js`). |
| Shuffle daily | `newTabShuffle` | off | A new gradient every day instead of the chosen background: the same one all day (and on every computer, for that date), never the same twice in a row, each of the 21 once before any repeats. |
| Animated effect | `newTabEffect` | `none` | A light animation over the background: `particles`, `stars`, `bubbles`, `snow`, `aurora` (slow curtains of light), `blobs` (soft glows that float) or `grain` (a faint shifting film grain). Drawn in a small canvas at one pixel per screen pixel (half that for the soft ones), at most 30 frames a second (15 for aurora and blobs, 8 for grain), nothing asked for while the tab is not in front, and one still frame with Reduce motion, Performance mode, battery saver or a thermal limit. |
| Effect color | `newTabEffectColor` | `auto` | `auto` (white or your text color; the soft effects have their own palettes), `accent`, `rainbow` or `#rrggbb`. |
| Effect amount, speed, size | `newTabEffectAmount`, `newTabEffectSpeed`, `newTabEffectSize` | `normal` | `few`/`normal`/`many`, `slow`/`normal`/`fast`, `small`/`normal`/`large`. |
| React to the pointer | `newTabEffectInteract` | on | Particles reach for the pointer, stars light up near it, bubbles and snow move aside. |
| Music-reactive home screen | `newTabMusicReactive` | off | The new-tab page's background moves with the sound the PC is playing (Windows' output loopback; any program, the Spotify desktop app included): soft dots drift, burst on the beat, swirl and twinkle. Only loudness numbers are read; nothing is recorded or sent. Simpler (40 dots, 15 frames a second) with Visual effects: Light or software drawing; off with Reduce motion and Performance mode. Settings has a Preview. A music card can react on its own too (its own settings: React to music). |
| Removed shortcut tiles | `newTabHiddenTiles` | none | Tiles taken off the new-tab page with the ⋮ button, a right-click or Delete: `favorites` (bookmark addresses; the bookmark itself stays) and `frequent` (hosts of frequently visited sites, so they do not come back). The page saves it itself (internal); **Restore all** (under Favorites, or in the clock and greeting panel) empties it. |
| Widget cards | `newTabWidgetGlass` | `solid` | The new-tab widget cards' background: `solid`, `frosted` (see-through, blurred) or `clear` (as transparent as stays readable). |
| Show the header | `newTabHeader` | on | Settings → New tab page. The clock, date and greeting at the top of the new-tab page. Off hides all of it. |
| Show the clock | `newTabClock` | on | The big clock above the greeting. Off keeps the date and the greeting. |
| Clock size | `newTabClockSize` | `m` | `s`, `m`, `l` or `xl`. Edit layout on the page resizes it too. |
| Clock style | `newTabClockStyle` | `classic` | `classic`, `rounded`, `thin`, `serif`, `mono` or `bold`. |
| Clock hours | `newTabClockHours` | `auto` | `auto` (as the system language writes it), `12` or `24`. |
| Show seconds | `newTabClockSeconds` | off | Small seconds after the minutes. |
| Show the date | `newTabClockDate` | on | The date with the clock (above the time in the Thin style). |
| Behind the clock | `newTabClockCard` | `none` | `none`, `soft` or `glass`: a card behind the clock and date. |
| Stronger text shadow | `newTabClockShadow` | off | A stronger shadow under the clock and greeting, for reading over a background or picture. |
| Greeting font | `newTabGreetingFont` | `classic` | `classic`, `match` (the clock's), `rounded`, `serif`, `thin`, `mono` or `hand`. |
| Your name | `newTabName` | empty | The greeting reads "Good evening, <name>". |
| Search bar width | `newTabSearchWidth` | `640` | The centred column and search bar, 480 to 960 px (640 is Automatic). Edit layout can drag its edges too. |
| Show favorites | `newTabFavorites` | on | Your bookmarks on the new-tab page. |
| Show frequently visited sites | `newTabFrequent` | on | The sites you open most. |
| Show ads and trackers blocked | `newTabPrivacy` | on | The counter of what Lumen blocked. |
| Keep widgets packed | `newTabWidgetsPacked` | off | On: widget cards slide up into gaps as you move and resize them. Off: a card stays in the cell it was put in. |
| Let Lumen look up my city | `weatherLocation` | `unset` | `unset`, `granted` or `denied`: whether a weather widget may ask an IP service which city this is. |

## Search engine

| Setting | Key | Default | What it does |
|---|---|---|---|
| Search engine used in the address bar | `searchEngine` | `google` | `google`, `duckduckgo`, `bing`, `brave`, `ecosia` or `startpage`. Also used by the new-tab page and "Search for…" in the context menu. |

## On startup

| Setting | Key | Default | What it does |
|---|---|---|---|
| What Lumen opens when it starts | `startup` | `restore` | `restore` (continue where you left off), `newtab` or `pages`. |
| Open files | — | — | A PDF, deck, text file or image that is open when you close the window or quit comes back with "continue where you left off" (the PDF on the page you were reading); one whose file was moved or deleted shows "This file was moved or deleted" with Choose file and Show in folder. Ctrl+Shift+T reopens a window closed while others stayed open. |
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

On-device translation sends whole sentences: the text nodes of one block (a paragraph, list item, heading or cell, with its links and emphasis) are joined into one request with numbered markers (` ⟦1⟧ `, chosen by measuring the real engine: it kept 8 of 8 numbered markers intact, against 5 of 8 for private-use characters, which also garbled neighbouring words) at the seams, and the reply is cut at the markers again, so `A <b>quick</b> brown <a>fox</a> jumps.` is translated as one sentence and each piece lands back in its own element. Code, form fields and `translate="no"` text split a sentence instead of being sent. A line break (`<br>`) also splits a sentence, and a page whose own text contains a marker is not grouped. If the engine drops, adds, renumbers or garbles a marker, that block is translated node by node instead, and after three such blocks in a row (two for a pair that has never worked) the run stops grouping, and so does that language pair for 10 minutes. A page that changes a node while its block is being translated keeps the block as written and has it collected again. Delete and Delete all in the language packs list ask for a second click. Numbers, prices, dates and percentages inside a sentence ("Showing <b>10</b> of <b>200</b> results") travel with it; one on its own is left as written. The engine may reformat a number for the target (٢٠٠, 1.000,5, 5,99 €); one whose value changed (1.5 to 15, 200 to 2000) is never written to the page, and after three such segments in a row the pair's numbers are left out of its sentences for 10 minutes (re-probed after that, with the pause doubling up to an hour). Dates, times and numbers turned into words are kept as written and count for nothing. The comparison is of signed values: a lost minus sign or brackets (-5 to 5) is corruption, and so are shifted digits in a range (5-10 to 51-0). Words the engine puts inside a number's own part are never written there: the number stays as it was, and if a neighbouring word node came back empty because its words moved into the number, that block is translated node by node instead, so nothing is lost. A lone . or , is read by the languages involved when they are known ("1,234" is 1234 in English but 1.234 for a German target, so writing it unchanged for German is refused); with no language the rule is: three digits after 1 to 3 is thousands, anything else decimal. Dates (5.6.2024, 12.05.24, 2024-05-01) are never read as one number: the same groups in the same order are fine with any separator, any other reformat is kept as written, and none of it counts against a pair. Vulgar fractions (1½, 1 1/2) and mirrored brackets for a right-to-left target (`)5(`) are left as written. En and em dashes count as minus signs. A block is translated node by node instead when any number would show more times than the source has it (the engine moved or copied a number into a neighbouring part: "Zeige 10 von | 10 | von | 200"), or when words were put into a plain number's part (they would be dropped). Three such blocks in a row switch numbers off for the pair, with the same 10, 20, 40, 60 minute backoff, re-probe and clearing as corrupt numbers. A number copied back unchanged is never judged (so "1,234" copied for a German target is not counted), list markers that lose their brackets ((1) to 1) are left as written, coordinates and ranges are compared token by token including each sign, and codes such as 192.168.0.1 are compared group by group. What is verified: all of the number rules above are covered by unit tests against fake engines that return the shapes described (`test/units/translate-group-units.js`); the real engine was measured only for whether the markers survive (`docs/translate-seam-measurement.md`), not for each number format, so how often a real model produces these shapes is not known. Known gap: this value check covers numbers that are their own text node (`<b>10</b>`); a number inside a word node ("Page 10 of 20" in one node) or in text the engine received unsplit is only as accurate as the engine, and is not value-checked. A pair that has never worked starts with a small first request, and a failed probe costs one chunk. A segment holds at most 12 text nodes. The pause on a pair lasts 10 minutes, then one grouped run probes again (each failed probe doubles the pause: 10, 20, 40, then 60 minutes at most; a working probe clears it). The markers' real-engine survival rates per language pair are in `docs/translate-seam-measurement.md`: they survive well into English and Arabic and badly into Persian, which is what the pause is for. Words can land next to the wrong element when the engine reorders across a marker (the text stays complete). Attributes such as `placeholder`, `title`, `aria-label` and button values are not translated yet. Known limit: this is not full HTML-mode translation (as Firefox does), so word order can move within a block but the markup around each piece stays where it was.

Private windows: an unclicked offer never happens there; a click translates on this device with no consent card.

## Privacy and security

| Setting | Key | Default | What it does |
|---|---|---|---|
| Clear browsing data | — | — | History follows the chosen time range. Cookies, site data and the cache are cleared for all time. |
| Block third-party cookies (best effort) | `blockThirdPartyCookies` | off | Stops sending cookies with requests to other sites embedded in a page. |
| Send a "Do Not Track" request | `sendDoNotTrack` | off | Adds `DNT: 1` to every request. |
| Send Global Privacy Control | `sendGpc` | on | Adds `Sec-GPC: 1` to every request, and pages see `navigator.globalPrivacyControl`. |
| Hide when you leave the tab | `hideTabActivity` | off | Pages always read as the visible, focused tab: no `visibilitychange`, window blur/focus or pointer-leaving events. See [Privacy protections](privacy-protections.md). |
| Hide your window size | `hideWindowSize` | on | `screen.*` and `screenX`/`screenY` match the window, so split screen or a small window looks full-screen. |
| Protect against fingerprinting | `fingerprintProtection` | on | Canvas, WebGL and audio readouts change slightly, per site and per launch; bot checks get the real readings. |
| Hide your IP address from WebRTC | `webrtcIpProtection` | off | WebRTC offers only the default route's public address (`default_public_interface_only`). |
| Remove tracking from links | `stripTrackingParams` | on | `utm_`, `fbclid`, `gclid`, `msclkid`, share ids and similar come off an address before the page opens. |
| Block tracking pings | `blockTrackingPings` | on | Cancels `<a ping>` and `navigator.sendBeacon` reports while the ad blocker is on. |
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
| Open PDFs with | `pdfViewer` | `lumen` | `lumen` or `chrome`: which viewer a PDF opens in. PDFs inside a page always use Chrome's. |

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
| Screen reader support | `screenReaderSupport` | `auto` | `auto`: accessibility another program switches on (a password manager's desktop app, Phone Link) is kept to Lumen's own controls unless a screen reader runs (Narrator, NVDA, JAWS, ZoomText, Dolphin; VoiceOver on a Mac), so big pages can't stall Lumen; `on`: always the full set; `off`: never. |
| Show a focus ring | `focusRings` | off | Always outline the focused control in Lumen, not only when using the keyboard. |

## System

| Setting | Key | Default | What it does |
|---|---|---|---|
| Use graphics acceleration when available | `hardwareAcceleration` | on | Turn off if pages flicker. Takes effect after a relaunch. |
| Visual effects | `graphicsMode` | `auto` | Shown as **Visual effects** (it was called Graphics; the key is unchanged): `auto`, `full` or `light`. A status line under it says what is on right now (with Performance mode), shows a Restart button when drawing is in software, and on a hybrid-GPU Windows laptop names the discrete card and how to use it. Light is Lumen's integrated-GPU path: no backdrop blur on Lumen's own pages (the composer, the new-tab cards, the clock card; a flat, slightly denser tint stands in), no drifting background layer, and a cheaper new-tab effect (half the particles, a canvas of about 0.55 million pixels, 20 frames a second, a rest after 20 seconds without input). Automatic picks Light when the GPU Chromium is drawing with is integrated (Intel, or an AMD APU), or when it is the only GPU. This is decided once at start-up from the GPU and never follows battery, power or speed-limit changes (Performance mode does). **Software mode:** when drawing is in software (graphics acceleration off in the setting or by safe drawing mode, or Chromium fell back to software after GPU crashes, including mid-session), Automatic is Light plus a software level (`softwareGfx` in the UI prefs): the new-tab effect is one still frame, no backdrop blur anywhere, no blurred shadows or hover glows, short transitions, no repeating animations on large areas, and the sidebar opens without a page snapshot (a capture is a CPU readback there). Full, chosen by hand, keeps every effect even in software. After a safe-drawing restart a strip says so, with Restart normally. Applies at once. |
| Performance mode | `performanceMode` | `auto` | `auto`, `on` or `off`: Lumen runs lighter on a slow computer (background tabs sleep sooner, smaller caches, no blur or animation). Auto turns it on when needed. |
| Unload inactive tabs | `tabSleep` | on | Master switch of Settings → Tabs and browsing > Page unloading (below). Frees memory from background tabs left alone for a while; switching back reloads them. |
| Keep Lumen running when its window is closed | `keepRunningInBackground` | on | macOS only. |
| Record tab-switch timings | `recordSwitchTimings` | off | Settings > Advanced > Diagnostics. Times each tab switch on this computer so a slow one can be understood: when the click reached Lumen, when the page was shown, when the tab drew its first frame and when the tab strip updated; whether the tab was loaded, frozen or unloaded (and reloaded); whether it was a Lumen page or a web page; its renderer's process id; the longest main-process stall during the switch; and the CPU use of the GPU, renderer and browser processes; the renderer's Windows priority just before and after the switch (idle: Windows had parked it), how long the tab was out of sight, whether it was kept ready (see Keep the latest tabs ready), whether the computer was on battery, how many view changes the switch made, and whether it was part of a burst. The export adds a summary by those, the tab settings, the Windows version, memory and launch switches, and the last 50 lines of `diagnostics/main-errors.log` (what it holds: PRIVACY.md). The last 200 switches are kept in memory (not on disk, and gone when Lumen quits). **No address, title or site is recorded, and no hash of one.** The GPU feature status (graphics acceleration, compositing, rasterization) is noted once. Nothing is sent anywhere: **Export timings…** saves a JSON file to a place you choose (**Clear** empties the list). Off: the recorder is not even loaded, and no switch does any extra work. |
| Proxy | `proxy` | `system` | `mode` is `system`, `direct`, `fixed_servers` (with `rules` and `bypass`), `pac_script` (with `pacUrl`) or `auto_detect`. Applies straight away. |
| Download updates automatically | `autoDownloadUpdates` | on | New versions download in the background and "Restart to update" appears when one is ready. Off: Lumen asks before downloading. Copies that can't replace themselves (portable exe, per-machine install, unwritable Mac app) say when a version is out and download it when you ask. |
| Show what’s new after updates | `showWhatsNew` | on | The first time Lumen starts on a newer version, the release notes for every version since the one you last ran come up once (from `CHANGELOG.md`, which ships inside Lumen, so no network is needed). A first run ever shows nothing. The same switch is on the card itself; **Show what’s new** here, or **What’s New in Lumen…** in the ⋯ menu (More Tools) and the Mac Help menu, opens the notes any time. The last version you ran is kept as `lastSeenVersion` (internal; Lumen records it, Reset settings keeps it). |

## Page unloading

Settings → Tabs and browsing > Page unloading. Every change applies at once; "Reset to defaults" at the bottom of the section restores all of them (and clears the site lists).

| Setting | Key | Default | What it does |
|---|---|---|---|
| Unload after | `tabSleepMinutes` | 20 | Minutes a background tab can go unused (1 to 10080); 0 is Never (memory pressure, the cap and the site list still apply). Performance mode can shorten it. |
| How tabs unload | `tabSleepHow` | `unload` | `unload` closes the page; `freeze` keeps it paused in memory. |
| Freeze first, then unload | `tabSleepFreezeFirstMinutes` | 10 | An idle tab is frozen this many minutes before it unloads; 0 unloads at once. |
| Most background tabs kept loaded | `tabSleepMaxAwake` | 0 | 0 is Unlimited; otherwise 1 to 500. The tabs unused longest unload first. Performance mode's own cap also applies; the lower wins. |
| Always keep the latest tabs loaded | `tabSleepKeepRecent` | 3 | The most recently used background tabs the idle timer leaves alone (0 to 8). Ordinary low memory leaves them alone too; only very low memory (under half the chosen free-memory level), Lumen passing its own GB limit, or the cap above unloads them. |
| Keep the latest tabs ready | `tabReadyRecent` | 3 | How many of your latest background tabs have their renderer kept out of Windows' background state (low priority, efficiency mode), so the first frame after a switch is not slow after a pause (0, 1, 2, 3 or 5; 0 keeps only the tab under the pointer, which is always kept ready for as long as the pointer rests on it plus 1.5 s). Costs a little battery; one tab on battery, none when memory is low, in Performance mode, or while the window is hidden or minimised. |
| Unload sooner when memory is low | `tabSleepPressure` | `medium` | `off`, `low` (under 5% free, tabs idle 5 minutes), `medium` (10%, 2 minutes) or `aggressive` (20%, 1 minute). Least recently used first. |
| Also when Lumen uses more than | `tabSleepLumenGb` | 0 | GB of memory Lumen itself may use before tabs unload; 0 is no limit. |
| Tabs playing audio or video | `tabSleepKeepAudio` | on | Such a tab stays loaded. |
| Pinned tabs | `tabSleepKeepPinned` | on | Pinned tabs stay loaded. |
| Tabs with unsaved input or a "Leave site?" prompt | `tabSleepKeepForms` | on | Typed, unsent text or a `beforeunload` handler keeps the tab loaded. |
| Tabs with a download or upload | `tabSleepKeepTransfers` | on | A download coming in or a chosen upload keeps the tab loaded. |
| Tabs in a tab group | `tabSleepKeepGroups` | off | Grouped tabs stay loaded. |
| Always keep these sites loaded | `tabSleepNever` | none | Hosts (subdomains included) or patterns with `*`, such as `*.example.com`. Tabs in a call, sharing the camera, microphone or screen, or used by the AI or a background task always stay loaded; there is no switch for those. |
| Unload these sites sooner | `tabSleepSoon` | none | Hosts or patterns whose tabs unload after `tabSleepSoonMinutes` instead. The always-keep list wins. |
| Unload those sites after | `tabSleepSoonMinutes` | 5 | 1, 2, 5, 10, 15 or 30 minutes; never longer than the usual time. |
| Dim unloaded tabs in the tab strip | `tabSleepDim` | on | An unloaded tab shows a dimmed icon and title. |
| Show the memory freed when you hover an unloaded tab | `tabSleepShowFreed` | on | The hover card adds "about N MB freed" (an estimate). |
| When you switch to an unloaded tab | `tabSleepOnReturn` | `reload` | `reload` loads it at once; `placeholder` shows a page with a Reload button and loads nothing until pressed (hovering a tab no longer wakes it, and startup preloading is off). |
| When tabs unload | `tabSleepMode` | `both` | `off`, `idle` (after the idle time), `memory` (only when memory is low) or `both`. |
| Wake likely next tabs | `tabPreload` | `1` | After startup, how many likely next tabs wake in the background; 0 is off. |

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

### Routine web links

In Settings → AI → Routines. See [Routines](routines.md#triggers).

| Setting | Key | Default | What it does |
|---|---|---|---|
| Routine web links | `routineWebhooks` | off | Listens on 127.0.0.1 (this computer only) so a program can start a routine whose trigger is **From a web link**: `POST /routines/<id>/run` with `Authorization: Bearer <key>`, the routine's own key (shown once in its editor). An optional `{"text": "..."}` body (up to 4 KB) goes to the AI as untrusted input. The request's Host header must be `127.0.0.1:<port>` or `localhost:<port>` (a tunnel must rewrite it). At most one started run a minute per routine (refused calls don't count); approvals apply as for any routine run. |
| Port | `routineWebhookPort` | 47821 | The local port the web links use (1024 to 65535). If another program has it, Settings says so and nothing listens. |

## Extensions

Lists the Chrome Web Store extensions you installed, each with a **Show in toolbar** switch (the same pin as the puzzle button's menu), **Options** and **Remove** (deletes the extension and its data) and a link to the Chrome Web Store. Electron can't pause an extension, so there is no on/off switch. **Show extensions in the toolbar** chooses between only the ones you pin, all of them, or none: with none, the extension buttons and the puzzle button are gone, and the extensions still run.

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

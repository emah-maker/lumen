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
| Model | `model` | Claude Opus 5 (`claude-opus-5`) | The model the sidebar AI uses. The same picker is in the sidebar. |
| Switch models automatically when one is unavailable | `autoFallback` | on | When the picked model hits its usage or rate limit, or can't be reached (no connection, a timeout, a server error or "overloaded"), the same reply goes on with the next usable model: a lighter one from the same provider first (Opus, then Sonnet, then Haiku), then the same vendor's other route (Claude API and Claude Code, Grok API and Grok Build), then your other connected providers. Only models you have set up are used. A short note in the chat says what happened, the model picker shows the model that is really answering (marked as temporary), and each reply's label names it. The unavailable model is left alone until its reset time, or about 15 minutes after a lost connection, then the chat returns to it by itself. Never on a rejected key, a sign-in problem, a refused request or a Stop. Tools that already ran are never run again. The chat so far goes to the model it switches to, so turn this off if you want every message to stay with the provider you picked. Also covers topic naming, Organize and page translation. |
| Compact long chats automatically | `autoCompact` | on | A chat with an API model (Claude by key or sign-in, OpenAI, Grok, Gemini, OpenRouter) whose history nears what the model can take in one request is summarized by that model before the next request, as `/compact` does, instead of its oldest messages being left out. The messages stay on screen; the AI sees the summary plus the latest exchange. A short note in the chat says when it happened. Claude Code, Grok Build and Antigravity compact their own sessions, so this doesn't apply to them. |
| Short, focused answers | `adhdMode` | off | Answers lead with the next step and stay brief. Applies to new chats. |
| Warm up Grok Build when Lumen starts | `grokWarmup` | on | Starts Grok Build's setup in the background so your first message starts faster: once the first tab has loaded, Lumen finds the `grok` program, starts its local tool gate and prepares its folders and sign-in link (again after the computer wakes). It happens only while Grok Build is connected to Lumen or chosen as the model, sends nothing to Grok and never makes a model request. Off: that setup happens when you send the first message. Takes effect without a restart. |
| Group tabs automatically | `tabGrouping` | `site` | `off`, `site` (3 or more tabs from one site) or `topic` (related tabs, once 4 or more are loose). Tabs you group or move by hand stay put. |
| Use AI to name and group topics | `topicAi` | off | Only with **By topic**. Sends tab titles and site names (never full addresses) to the cheapest model of your chat's provider. Off: topics are found on this computer. |
| API keys | `keys` | none | One per provider: Anthropic, OpenAI, xAI (Grok), Google (Gemini), OpenRouter. Stored encrypted. Environment variables also work. |
| Sign in with your Anthropic account | — | — | Uses an OAuth profile from Anthropic's CLI (`ant auth login`) instead of an API key. |
| Don't let the AI act on my pages | `aiHandsOff` | off | The AI (the sidebar, its engines, MCP agents, and programs connected through the automation port) can read your tabs but not click, type, navigate, run scripts in them, regroup or close them; it works in tabs it opened itself. Enforced in the tool layer (`src/ai/agent.js`) and in the automation proxy (`src/automation/automation.js`, which refuses acting protocol commands such as `Input.*`, `Page.navigate`, `Runtime.evaluate` on other tabs and lets reads like screenshots and `DOM.getDocument` through; only an allowlist of read commands passes). Playwright's high-level reads (`page.content()`, locators, `evaluate`) use `Runtime.evaluate`, which is refused on your tabs in this mode; attaching still works, and script injection at attach is skipped with a console warning. |
| Close tabs the AI opened when it finishes | `closeAiTabs` | off | Off / Ask / Always. Never closes a tab you used, pinned or that holds typed text, nor the tab a chat lives in. Closing shows Undo. |
| Hide tabs the AI opened (tab strip button) | `hideAiTabs` | off | Leaves the AI's tabs out of the tab strip (they stay open); the tab in front and one playing sound stay shown. |
| Allow AI agents to connect | `mcpEnabled` | off | Turns on Lumen's MCP server for Claude Code, Codex CLI, Grok Build, Antigravity and other MCP clients. The commands to connect each one are listed under it. See the [MCP tool reference](mcp-tools.md). |
| Antigravity | `antigravitySidebar` | off until you choose it | Google's coding agent (`agy`), which replaces Gemini CLI as a sidebar engine. **Use in the sidebar** (here, or the "Use your own Antigravity" card in an empty sidebar) offers it in the model menu once it is installed; if it isn't, this row shows Google's own install command for your system and runs it only when you click **Run this command**. You sign in by running `agy` once in a terminal; Lumen never sees the login. Like Claude Code and Grok Build it gets Lumen's browser tools only (see [Antigravity in the sidebar](#antigravity-in-the-sidebar)). |
| Allow automation tools (Chrome DevTools Protocol) | `automationEnabled` | off | For Playwright and other CDP tools, through a filtering proxy on localhost. Turning it on takes effect after a relaunch; turning it off closes the proxy at once. |
| Port (localhost only) | `automationPort` | `9222` | The proxy's port. The address you copy includes a secret key; requests without it are refused. |
| Import bookmarks and history | — | — | From Chrome, Edge, Brave, Vivaldi, Opera, Firefox or (on macOS) Safari on this computer. Passwords and cookies are not imported. |

### Antigravity in the sidebar

Antigravity's CLI is `agy` (installed to `~/.local/bin/agy`, or `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows). Lumen runs it headless for each message (`agy -p … --output-format stream-json`) and gives it Lumen's browser tools over MCP, the same tools the sidebar's other engines get. It is launched with only those tools:

- its own home folder (`<profile>/antigravity-home`), so your `~/.gemini` servers, rules, plugins and hooks are not loaded; the sign-in stays in your OS keyring (a Gemini API key sign-in keeps working);
- a `settings.json` that allows `mcp(lumen/*)` and denies `command`, `write_file`, `read_url` and `unsandboxed`, with `--sandbox` and the terminal sandbox on;
- a hook that Lumen answers before each tool call: Lumen's tools go through, a shell or file tool of agy's own is denied;
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

On-device translation sends whole sentences: the text nodes of one block (a paragraph, list item, heading or cell, with its links and emphasis) are joined into one request with numbered markers (` ⟦1⟧ `, chosen by measuring the real engine: it kept 8 of 8 numbered markers intact, against 5 of 8 for private-use characters, which also garbled neighbouring words) at the seams, and the reply is cut at the markers again, so `A <b>quick</b> brown <a>fox</a> jumps.` is translated as one sentence and each piece lands back in its own element. Code, form fields and `translate="no"` text split a sentence instead of being sent. A line break (`<br>`) also splits a sentence, and a page whose own text contains a marker is not grouped. If the engine drops, adds, renumbers or garbles a marker, that block is translated node by node instead, and after three such blocks in a row (two for a pair that has never worked) the run stops grouping, and so does that language pair for 10 minutes. A page that changes a node while its block is being translated keeps the block as written and has it collected again. Delete and Delete all in the language packs list ask for a second click. Numbers, prices, dates and percentages inside a sentence ("Showing <b>10</b> of <b>200</b> results") travel with it; one on its own is left as written. The engine may reformat a number for the target (٢٠٠, 1.000,5, 5,99 €); one whose digits changed is never written to the page, and after three such segments the pair's numbers are left out of its sentences for 10 minutes. A pair that has never worked starts with a small first request, and a failed probe costs one chunk. A segment holds at most 12 text nodes. The pause on a pair lasts 10 minutes, then one grouped run probes again (each failed probe doubles the pause: 10, 20, 40, then 60 minutes at most; a working probe clears it). The markers' real-engine survival rates per language pair are in `docs/translate-seam-measurement.md`: they survive well into English and Arabic and badly into Persian, which is what the pause is for. Words can land next to the wrong element when the engine reorders across a marker (the text stays complete). Attributes such as `placeholder`, `title`, `aria-label` and button values are not translated yet. Known limit: this is not full HTML-mode translation (as Firefox does), so word order can move within a block but the markup around each piece stays where it was.

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

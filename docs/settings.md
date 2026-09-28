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

## You and AI

| Setting | Key | Default | What it does |
|---|---|---|---|
| Model | `model` | Claude Opus 5 (`claude-opus-5`) | The model the sidebar AI uses. The same picker is in the sidebar. |
| Short, focused answers | `adhdMode` | off | Answers lead with the next step and stay brief. Applies to new chats. |
| Group tabs automatically | `tabGrouping` | `site` | `off`, `site` (3 or more tabs from one site) or `topic` (related tabs, once 4 or more are loose). Tabs you group or move by hand stay put. |
| Use AI to name and group topics | `topicAi` | off | Only with **By topic**. Sends tab titles and site names (never full addresses) to the cheapest model of your chat's provider. Off: topics are found on this computer. |
| API keys | `keys` | none | One per provider: Anthropic, OpenAI, xAI (Grok), Google (Gemini), OpenRouter. Stored encrypted. Environment variables also work. |
| Sign in with your Anthropic account | — | — | Uses an OAuth profile from Anthropic's CLI (`ant auth login`) instead of an API key. |
| Allow AI agents to connect | `mcpEnabled` | off | Turns on Lumen's MCP server for Claude Code, Codex CLI, Gemini CLI and other MCP clients. The commands to connect each one are listed under it. See the [MCP tool reference](mcp-tools.md). |
| Allow automation tools (Chrome DevTools Protocol) | `automationEnabled` | off | For Playwright and other CDP tools, through a filtering proxy on localhost. Turning it on takes effect after a relaunch; turning it off closes the proxy at once. |
| Port (localhost only) | `automationPort` | `9222` | The proxy's port. The address you copy includes a secret key; requests without it are refused. |
| Import bookmarks and history | — | — | From Chrome, Edge, Brave, Vivaldi, Opera, Firefox or (on macOS) Safari on this computer. Passwords and cookies are not imported. |

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
| Font size | `fontSize` | `16` | `9`, `12`, `16`, `20` or `24` px. Applies to new tabs. |
| Show bookmark button | `showBookmarkButton` | on | The star in the address bar. Ctrl+D bookmarks either way. |
| Compact tabs | `compactTabs` | off | Shorter tabs in the tab strip. |

## Search engine

| Setting | Key | Default | What it does |
|---|---|---|---|
| Search engine used in the address bar | `searchEngine` | `google` | `google`, `duckduckgo`, `bing`, `brave`, `ecosia` or `startpage`. Also used by the new-tab page and "Search for…" in the context menu. |

## On startup

| Setting | Key | Default | What it does |
|---|---|---|---|
| What Lumen opens when it starts | `startup` | `restore` | `restore` (continue where you left off), `newtab` or `pages`. |
| Pages to open | `startupPages` | none | Up to 20 `http(s)` addresses, used with `pages`. |

## Privacy and security

| Setting | Key | Default | What it does |
|---|---|---|---|
| Clear browsing data | — | — | History follows the chosen time range. Cookies, site data and the cache are cleared for all time. |
| Block third-party cookies (best effort) | `blockThirdPartyCookies` | off | Stops sending cookies with requests to other sites embedded in a page. |
| Send a "Do Not Track" request | `sendDoNotTrack` | off | Adds `DNT: 1` to every request. |
| Send Global Privacy Control | `sendGpc` | off | Adds `Sec-GPC: 1` to every request. |
| Always use secure connections | `httpsOnly` | off | Upgrades `http://` to `https://` and warns before loading a site with no secure version. Local addresses are left alone. |
| Block ads and trackers | `adblock` | on | Built-in blocker using uBlock Origin-compatible filter lists. |
| Sites where ads are allowed | `adblockAllow` | none | Host names the blocker leaves alone. |
| Default for new sites | `permissionDefaults` | ask | Per permission (location, camera and microphone, notifications, clipboard): `ask` or `block`. |
| Site permissions | — | — | What you allowed or blocked per site. Revoke to be asked again. |

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
| Download updates automatically | `autoDownloadUpdates` | on | Windows setup installs only: new versions download in the background and install on restart. Other copies say when a version is out and download it when you ask. |

## Extensions

Lists the Chrome Web Store extensions you installed, with **Remove** (deletes the extension and its data) and a link to the Chrome Web Store. Electron can't pause an extension, so there is no on/off switch.

## Reset settings

**Restore settings to their original defaults** resets appearance, search engine, startup, privacy, site permissions, languages and system settings. Bookmarks, history, API keys and sign-ins stay.

## About Lumen and Internals

**About Lumen** shows the version, update status and **Check for updates**. **Internals** shows versions, a task manager (every Lumen process with memory and CPU), GPU features, the proxy in use and command-line switches. Nothing there changes a setting.

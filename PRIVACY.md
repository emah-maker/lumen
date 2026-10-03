# Lumen privacy policy

Lumen has no account, no servers of its own, no telemetry, no analytics and no crash reporting. The people who make Lumen never receive your browsing, your chats or your keys.

## What stays on your computer

- **Browsing data:** history, bookmarks, open tabs, downloads, cookies and site data are stored in Lumen's profile folder on your computer.
- **API keys:** stored encrypted with your operating system's keychain (Windows DPAPI, macOS Keychain, or the Linux secret service). If your system has no keychain, which happens on some Linux setups, Lumen doesn't save keys at all; set them as environment variables instead.
- **Background tasks:** the request, schedule, steps and result (which can hold text from pages the task read) are stored encrypted the same way, at most 50 tasks; with no keychain they aren't kept between sessions. A task sends data only to your AI provider and the sites you allowed for it. Deleting a task removes it.
- **Saved passwords (off by default):** with Settings → Privacy and security → **Save passwords** on, the logins you save are kept in one file in Lumen's profile folder, encrypted with your operating system's keychain the same way. Without a keychain the feature doesn't turn on; there is no unencrypted fallback. They never leave your computer: the AI in the sidebar, outside agents (MCP and CDP) and the page text Lumen sends with your messages can't read them, a password field's value is never included when the AI reads a page, and the AI can't run scripts on a site in a tab where you filled a saved password. Turning the feature off asks whether to delete them.
- **Chats with the AI:** stored encrypted the same way, without the page text and tool results that went with them. If your system has no keychain, the chat isn't kept between sessions. **New chat** deletes the saved conversation.

## What leaves your computer, and to whom

- **The AI you choose.** When you send a message, Lumen sends it to the provider you picked, with the page context it needs to answer: the text of the page you're on, and a screenshot when the AI asks for one. The provider can be Anthropic (directly or through Claude Code), OpenAI, xAI, Google or OpenRouter. Each provider's own privacy policy applies to what it receives. Nothing is sent to an AI until you ask it something or start a task. With a key saved, Lumen also asks that provider which models the key can use, to fill the model menu.
- **The websites you visit,** as with any browser. The AI's background reading (`read_urls`) runs without your cookies, unless you let it use your signed-in account on a site: when it asks ("Let the AI use your signed-in example.com account?", off until you answer), you can say No, Just this once, or Always for that site. Allowed, it loads that page with your cookies in a background tab marked as the AI's, sees it as you do, and the page text goes to your AI provider like any page it reads. Nothing is clicked, typed or submitted there without the usual approvals. A redirect to any other site is read without your cookies. Banks, payment services, password managers and account-security pages can only be allowed once. The sites you allowed always are listed in Settings → AI and agents → Signed-in sites the AI can use, where you can remove them. Outside AI agents (MCP) and background tasks never read with your cookies. When the AI works in your own tabs (navigate, open_tab, clicking), it sees them as you do, signed in, as before.
- **Your search engine,** when you search from the address bar or the start page.
- **DuckDuckGo, for the AI's web search.** When the AI searches the web through Lumen's own search tool (OpenAI, Grok, Gemini and OpenRouter models, Claude Code and other MCP agents), Lumen loads DuckDuckGo's results page for the query without your cookies. Claude by API key or Anthropic sign-in uses Anthropic's own web search instead.
- **Component downloads.** Lumen downloads ad and tracker block lists (Ghostery's published lists) and Google's Widevine component, which lets DRM video play. Extensions you install come from the Chrome Web Store.
- **Sign-in.** "Sign in with OpenRouter" opens OpenRouter's own sign-in page, and the key it returns is stored as described above.

### Smaller requests, and what triggers them

- **On-device translation language packs.** The first time you translate to or from a language on this device, Lumen asks, then downloads that language's pack (about 20 to 55 MB per direction) from Mozilla's servers: it reads Mozilla's public model list (`firefox.settings.services.mozilla.com`, cached for a week) and the files from `firefox-settings-attachments.cdn.mozilla.net`, and checks each file against the SHA-256 Mozilla publishes. The requests name the pack and carry nothing about the page you were on. The translation itself runs on your computer in a separate process; the page's text is never sent anywhere. Packs are kept in Lumen's data folder and can be deleted in Settings → General → Translation. Packs are not tied to a window: a pack downloaded from a private window stays in the data folder afterwards (it records which language you downloaded, never any page or site), so delete it in Settings if that matters to you. Translating with your AI or Google Translate is a different choice, covered by their own consent.
- **Site icons for the start page.** When a site that's in your favorites or most-visited list shows its icon, Lumen downloads a copy of that icon once (from the address the site names, often the site itself or its CDN) and keeps it on your computer, so the start page never has to load anything.
- **OpenRouter's model list.** With OpenRouter connected, Lumen downloads OpenRouter's public model catalog (`openrouter.ai/api/v1/models`) to fill the model menu and **More models…**. It's cached on your computer for a day.
- **The Anthropic CLI.** Clicking **Sign in with your Anthropic account** in Settings → AI and agents, when the `ant` CLI isn't already installed, downloads a pinned version from Anthropic's GitHub releases (`github.com/anthropics/anthropic-cli`) and checks it against a built-in SHA-256 checksum before installing it in Lumen's profile folder. Signing in then happens on Anthropic's own site.
- **Lumen updates.** Shortly after Lumen starts, every few hours, and when you click **Check for updates**, Lumen asks GitHub for the newest release of `emah-maker/lumen` and reads its `latest.yml` (`latest-mac.yml` on a Mac). The request carries nothing beyond what any download from GitHub does (your IP address and Lumen's user agent). An installed Windows copy with **Download updates automatically** on (Settings → About Lumen) then downloads the new installer from the same release. Development runs never check.
- **Extension updates.** If you've installed Chrome Web Store extensions, Lumen checks Google's update service (`update.googleapis.com`) for newer versions: at startup, when the window gets focus (at most once every 3 hours), and every 5 hours. The check sends the installed extensions' ids, your operating system and processor type, and the Chromium version. With no extensions installed, no check is made.
- **AI topic grouping.** If you turn on **Use AI to name and group topics**, Lumen sends the titles and site names (hostnames, not full addresses) of the tabs being grouped to the cheapest model of your chat's AI provider. This happens when you choose **Organize Tabs by Topic**, and, with **Group Automatically → By Topic** on, a few seconds after you have four or more ungrouped tabs. It's off by default.
- **Google Safe Browsing (off by default).** If you turn on **Warn about dangerous sites** (Settings → Privacy) and add your own Google API key, Lumen downloads Google's lists of suspected phishing and malware sites (`safebrowsing.googleapis.com`) and keeps them up to date, as often as Google allows. Each page you open is checked against these lists on your computer. Only when an address matches does Lumen send Google 4-byte partial hashes of it (never the address), without your cookies. Google works to provide the most accurate and up-to-date information about unsafe web resources. However, Google cannot guarantee that its information is comprehensive and error-free: some risky sites may not be identified, and some safe sites may be identified in error.

## AI agents over MCP

If you turn on **Allow AI agents to connect**, AI apps on your computer (such as Claude Code, Codex, Antigravity or Cursor) can read and control your tabs through Lumen. They're asked before acting on a new site. This setting is off by default. Whatever those apps read is then sent to their own AI provider, under that app's privacy policy.

Settings → Usage can show your Codex plan limits and token totals. To do that Lumen reads the numbers (token counts, the used percentage and reset time of each limit window, the plan name) from the newest lines of Codex's own session logs in `~/.codex/sessions` on your computer, never your prompts, replies, file names or sign-in details, and keeps only those numbers in its `usage.json` like its other usage figures. "Add to Codex CLI" asks the `codex` program whether you are signed in and only adds one `[mcp_servers.lumen]` entry to `~/.codex/config.toml` (after copying the file); Lumen does not read `auth.json`.

Settings → AI also has optional **Give … full access to this computer** switches for Claude Code, Grok Build and Antigravity in the sidebar (all off by default, one each plus a master switch). With one on, that command-line AI can read any file on your computer and run commands, as it does in your terminal, and what it reads is sent to its own AI provider under that provider's privacy policy. Lumen does not see or keep it.

The same goes for **Allow automation tools (Chrome DevTools Protocol)**, also off by default: while it's on, programs on your computer can read and control your tabs without asking.

## Removing your data

Settings → Privacy and security → Clear browsing data clears history, cookies and site data. Removing a key in Settings → AI and agents deletes it. To remove everything, delete Lumen's profile folder:

- Windows: `%APPDATA%\Lumen`
- macOS: `~/Library/Application Support/Lumen`
- Linux: `~/.config/Lumen`

## Contact

Questions about this policy: open an issue on Lumen's GitHub repository. Security problems: see [SECURITY.md](SECURITY.md).

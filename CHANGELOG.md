# Changelog

Notable changes to Lumen. Versions follow the tags on GitHub; downloads are on [Releases](https://github.com/emah-maker/lumen/releases).

## Unreleased

- New Slack widget for the new-tab page (default 4x4): unread DM and mention counts and recent messages from up to four channels, read-only. You sign in with your own Slack app over OAuth (Slack requires an https redirect, so approving ends on a page you paste back into Settings), or paste a user token. Tokens, including Slack's rotating refresh token, are stored encrypted and never reach the page; rate limits back off and a refused sign-in shows a Reconnect button. The OAuth pieces (state, PKCE, redirect parsing, expiry, token storage) are in `features/oauth.js` for other sign-in widgets to reuse.

## 0.2.13 (2026-09-29)

- New-tab widgets sit on a free grid: drag them anywhere (beside the search box too), resize from any edge, snap to a side or the top, and the others move out of the way. Edit widgets (or press and hold) wiggles them like a home screen. Existing widgets keep their order and sizes.
- Weather: several places, My location (asks first), hourly and by-day views. Todoist: choose the filter, grouping, sort and fields, undo completing, quick add. Calendar, weather and Todoist can match the screen colors.
- New-tab animated backgrounds (particles, stars, bubbles, snow) with color, amount, speed, size and pointer options; they stop when Reduce motion or Performance mode is on, and while the tab is hidden. Fixed the vertical bands that could show across the search box and cards while an effect ran.
- Background tasks now run on Claude Code and Grok Build too, each in its own process with the same approval cards and no shell access.
- A usage bar for Grok Build: how full the chat's context is, your own daily or weekly budget if you set one, and a "limit reached" state with the reset time. Grok doesn't publish plan limits, so the bar never claims plan usage.

## 0.2.12 (2026-09-29)

- Skills: saved prompts you run from the sidebar with a slash command (`/summarize`, `/explain`, `/reply` and more), editable in Settings, with import and export.
- Ask across your open tabs: type `@` in the sidebar to attach specific tabs or all of them, or ask "compare these tabs"; the AI can also read several tabs at once.
- The AI no longer goes wrong when you switch tabs while it is working: it stays on its own tab, and the sidebar shows "Working in: …" so you can see which.
- Translate a page with your connected AI (or Google Translate), a screenshot tool (Ctrl+Shift+S) with visible, full-page and select-area capture, and a QR code for the page or selected text.
- Dragging a tab out of the tab strip now opens its window at once and it follows your mouse; drop it on another window's strip to merge, or drag a window's only tab to move the window.
- Performance mode (Settings, System; Auto by default) turns on for slower PCs: tabs sleep sooner, caches are capped, and blur and animation are off. The install is about 60 MB smaller.
- Organize is faster and smarter: the local organizer applies at once and the AI only refines names and leftover tabs (a 200-tab session finishes in about 4 s instead of 6 s), with learning from your drags, a "Close duplicate tabs" item, and an optional idle organizer.
- On Mac, the Keychain's "Always Allow" for Lumen now survives updates (builds are signed with one stable certificate).
- The model menu no longer hides under the chat history list, and the usage panel says "this PC" on Windows.
- New-tab page widgets (weather, calendar, Todoist, web pages) that you can drag and resize.
- Background tasks: let the AI do a job on its own in a hidden tab while you keep browsing (the clock button next to Send, or `/background …`), on a schedule, or watch a page and get told when it changes or a condition holds (`/watch …`, or Watch This Page in the menu). Tasks live in a new Tasks panel with steps, results, cost, and approval cards; they ask before visiting sites you did not list and before buying, sending or submitting anything. Scheduled and watching tasks run only while Lumen is open.
- Automation (Playwright over CDP) on macOS no longer opens Chromium's debugging port: Lumen answers the protocol itself, and links opened from other apps keep working.

## 0.2.11 (2026-09-29)

0.2.10 was tagged but its build stopped at a failing test and was never published; its changes ship here.


- Open the sidebar chat as a full page (button in the sidebar, or Ctrl+Shift+L) with your saved chats alongside; the sidebar and the page share one chat.
- A downloaded update installs by itself when you quit Lumen, and one downloaded earlier is reused instead of fetched again.
- Auto organize is smarter: better topic groups and names, new tabs and sites are placed as you browse, groups with similar names merge, and Organize with AI falls back quietly if it fails.
- The sidebar AI is faster: independent page reads run at once, repeated reads of an unchanged page are skipped, replies render incrementally, and the Claude Code and Grok Build engines start quicker.
- Runs end cleanly: hitting a step limit gives a written summary and a Continue button instead of stopping silently. There is a new "Max steps per task" setting (default Unlimited), and scripts are a last resort for the AI.
- OpenRouter, OpenAI, Grok, Gemini and the Claude API now connect through the same network stack as the browser, so proxies and campus or VPN networks no longer cause connection errors; the error now says why.
- The usage panel no longer credits Lumen with plan usage from Claude Code you ran elsewhere.
- Outside agents no longer post a "connected" and "disconnected" line in the chat for every session.
- Google loads dark from the first frame in a dark theme.

## 0.2.9 (2026-09-29)

- macOS builds are now Widevine-signed, so sites that require production Widevine (Netflix, Disney+, Spotify) can play.

## 0.2.8 (2026-09-29)

- Updates install from inside Lumen on every install type: it downloads the release zip, checks it, and swaps it in when you restart. Per-machine installs, the portable exe and unwritable Mac apps still get a Download prompt.
- Drag a tab out of the tab strip to open it in its own window, drag it onto another window to join it, or use "Move tab to window" in the tab menu.
- The sidebar AI can read a PDF you have open, after you allow it for that file.
- A usage bar for Claude Code and Grok Build.
- The AI works faster and wastes fewer steps: a clearer prompt, cached prompts, trimmed tool results, and a guard that changes course after repeated failed actions.
- Google pages that ignore the dark theme are darkened, and the taskbar icon is re-applied after load.
- Release builds can be Widevine-signed when castLabs EVS credentials are set up.
- Includes the 0.2.7 changes below, which were never published on their own.

## 0.2.7 (2026-09-28)

- PDF viewer, opening YouTube videos, and browsing local files.
- Downloads panel, plan usage tracking, new themes, and a reworked tab strip.

## 0.2.6 (2026-09-28)

- Private windows (Ctrl+Shift+N): nothing is saved, and closing the window clears its data.
- Tab search (Ctrl+Shift+A), a speaker button to mute tabs, and Mute Site.
- Save Page As, View Source, Reader mode, and Picture in Picture from the video menu.
- Bookmarks page (Ctrl+Shift+O) with HTML import and export, a Downloads page (Ctrl+Shift+J), and clearing browsing data by time range.
- Chat history in the sidebar, Markdown export, and token and cost counts per chat.
- Turn AI off for a site, and undo the tab changes an AI reply made.
- Add your own MCP servers as tools for the sidebar AI; every call asks first.
- Organize Tabs with AI works through Claude Code or Grok Build, with no API key.
- Certificate warning page, and the lock shows when a secure page loads insecure content.
- Optional Google Safe Browsing (off by default; needs your own API key).
- Keyboard navigation in the tab strip, and UI text moved into `locales/` for translation.
- Windows: the taskbar and shortcuts show Lumen's icon. Adding an extension from the Chrome Web Store no longer closes Lumen.
- Grok Build: tool calls are checked by Lumen before they run, Lumen's tools are ready before the first turn, and `XAI_API_KEY` sign-in works.
- The browser window runs sandboxed.
- New docs: MCP tools, settings and architecture.

## 0.2.5 (2026-09-28)

- In-app updates from GitHub Releases. The installer build updates itself; the zip and the Mac app offer a download.
- The sidebar can pick the model for Claude Code and Grok Build.
- Automation (Playwright over CDP) goes through a private pipe on Windows and Linux, and the automation address needs a key.
- Tighter approvals for the sidebar AI: redirects, web searches, batch steps and scripts are checked against the chat's approved sites.
- Extension installs show the permissions the extension asks for.
- Grok Build is labelled experimental in the model picker.
- Release builds ship the license and third-party notices; macOS bundles pass codesign.

## 0.2.4 (2026-09-27)

- `navigator.webdriver` stays false while AI automation is on.

## 0.2.3 (2026-09-27)

- Sends Chrome's `Sec-CH-UA` client-hint headers, with the brand list built the way Chrome builds it.

## 0.2.2 (2026-09-27)

- Cross-site iframes and workers get the same Chrome identity as the page.

## 0.2.1 (2026-09-27)

- macOS apps are built from castlabs' Electron (Widevine), and keyboard shortcuts in `press_key` work on a Mac.
- Background tabs go to sleep after 2 minutes when memory runs low.
- The Electron binary is fetched on `npm install`.

## 0.2.0 (2026-09-27)

- First public release.

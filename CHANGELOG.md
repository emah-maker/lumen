# Changelog

Notable changes to Lumen. Versions follow the tags on GitHub; downloads are on [Releases](https://github.com/emah-maker/lumen/releases).

## Unreleased

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

# Changelog

Notable changes to Lumen. Versions follow the tags on GitHub; downloads are on [Releases](https://github.com/emah-maker/lumen/releases).

## Unreleased

- Windows: the taskbar button and the installer's shortcuts show Lumen's icon instead of Electron's.
- Adding an extension from the Chrome Web Store no longer closes Lumen.
- Grok Build: waits for Lumen's tools before the first turn, stops runs that call tools outside Lumen, and reports the default model from Lumen's own settings.

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

# Polish pass: Lumen's own pages (pre-release v0.5.23)

Method: fresh profile, hidden windows; new-tab page (light, dark, with and without cards) and all eight Settings categories captured and read, console errors collected across every category, an unlabeled-control scan on the new tab and every category, and the new fixes driven in the real app. Earlier audits (newtab.md, settings-pages.md) were read first; their fixed items were not redone.

## Found
- Settings > General > Pages to open: Add page silently ignored anything that did not start with http(s)://, a duplicate, or an empty box. No Enter key.
- Settings > Advanced > Proxy: Manual with no server, or PAC with no address, saved and said "Applied."
- Settings > AI > Automation port: a port outside 1024 to 65535 was corrected in main but the box and the "Listening on ..." note kept the typed number.
- lumen://history, bookmarks, downloads and about (chrome:// too) were not understood by the address bar (only settings and chat were).
- No console errors in any Settings section or the new tab; every icon control has an accessible name; light and dark both read well.

## Fixed
- All four above (src/renderer/settings.js, src/browser/search.js internalPage, src/main.js goFromAddress). Unit tests in test/core-browsing-units.js (own-page addresses); the form fixes were driven in the real app.

## Left
- About page has no link to the licence or release notes beyond the What's new button: fine as is.
- Narrow-width (under 800 px) Settings was not re-captured; the headless emulation does not trigger the layout's media queries, and the previous audit covered it.
- Welcome (first-run) steps live in src/renderer/chat-core.js (off limits); not reviewed here.
- On a machine with Claude Code or Codex signed in, the AI section starts on "Auto" rather than the empty "No AI connected yet" note; the empty state was not reproduced here.

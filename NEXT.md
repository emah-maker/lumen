# ai-close-all (follow-up to #664): close EVERY tab the AI opened  (WIP, not pushed, not a PR yet)
Done (local, uncommitted before this WIP commit):
- src/main.js: aiPopups + aiPopupsClose: popup WINDOWS opened by an AI tab's page (window.open w/ size, sign-in popups) are tracked per run/chat and closed with the run's tabs (not if focused/typed in/unsaved/downloading). Was a leak.
- src/main.js: restoreSession closes leftover marked AI tabs 3s after start when closeAiTabs==='always' (crash/killed run). Was a leak.
- src/main.js: 'tab:switch' (user clicks a tab in the strip) now calls userTookOver: a tab the user chose stays even after they move on. Was a leak the other way (user-visited tab closed).
- test/close-ai-tabs-paths.js: new Electron suite (open_tab, navigate tab, window.open/link tabs, popup window, asleep tab, pin/type/visit stay, Stop, error, crash+restart).
Last run (before the tab:switch + crash-wait edits): all passed except "user-visited tab stays" and the crash "set up" (session not yet saved; fixed by 6s wait). NOT re-run after those edits.
Left: re-run suite via e2e-lock (check it passes), run close-ai-tabs/aimanners/perf-budget/ui-consistency/hardening, test-units, eslint, CHANGELOG entry, wire test into scripts/test-all.js suite list if needed, merge origin/main (ai-close-focus agent touches focus on close), PR + land.js.
Not covered / design: MCP outside-agent windows (not marked on purpose), AI tab left in front at run end stays (activeId), web_search/read_urls/helper/sub-agent/engine tabs are marked via runOf() by code reading only (no test drives them), download/upload check relies on pageBusyScript + downloads.list.
Also: #664 (merge 19554e1a) and #671 (merge 44429440) landed.

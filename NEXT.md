# ai-close-focus: state

Done (committed locally as WIP, not pushed):
- AI closes active tab -> lands on AI-working tab (focusAfterAiClose in src/features/ai-manners.js, aiWorkingTabAfterClose in main.js closeTab).
- Closed tab chip keeps favicon; card frame marked "closed"; chip click reopens via Reopen Closed Tab path.
- Ask AI -> new chat (toggle button, selection, command bar, new-tab empty Ask AI); only approval-pending run keeps its chat.
- Tests: new test/ai-close-focus.js (registered in scripts/test-all.js), updated sidebar-keeps-run, sidebar-open-units, command-bar-units, ai-manners/tab-chips/chat-page-from-home units. CHANGELOG entry added, bundles rebuilt.
- Passed: eslint, node --check, all unit suites (except eml-units: missing postal-mime, expected).

Left:
- No Electron suite has run yet (the e2e lock was busy). Run under the lock: ai-close-focus (last run had 3 test-expectation failures, since fixed in the test), sidebar-keeps-run, tabchats, sidebar-tabs, chats, step-labels, step-rows, tabstrip, split-view, side-tabs, command-bar, hardening, perf-budget, ui-consistency, sidebar-newchat, newtab-ask-ai, tab-chips, close-ai-tabs, aimanners, chatpage, sidebar-stays, sidebar-open-newtab. Helper: scratchpad/runall.sh.
- Fix failures, merge origin/main, rebuild bundles, push, open PR (emah-maker/lumen), node scripts/land.js <pr>. No release.
- Remove worktree afterwards (cmd /c rmdir node_modules first).

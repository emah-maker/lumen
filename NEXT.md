<<<<<<< HEAD
# card-from-first-step: state when paused

Done (uncommitted-before this WIP commit, nothing pushed, no PR):
- Card from first step: step-ui.js add() starts the card for ANY tool step (surface 'web' for searches/page reads, 'tool' otherwise via step-labels weakSurfaceOf); later weak steps join it; card flips to 'browser' when a tab step comes (watch handled via card.hb). Restored chats use the same rule. Preview eases in (step-ui.css act-shot-in).
- Host dedupe: step-labels readUrlsLabel, used by agent.js describeStep.
- Thinking: chat-core.js seg model (one row per stretch, times summed, blank blocks no row, row moved into card via stepUI.bare), dropEmptyBubbles() at finishTurn (stray bar guess; NOT confirmed visually).
- Files card: claude-code/codex resolve relative written paths against run cwd; agent.engineFiles emits {type:'card_files'}; chat-core -> stepUI.filesMade; links in status row, file list (max 5, +N more), Show in folder, step Open links; gone/blocked handled via aifiles:open (existing safety checks).
- Tests: test/card-first-step.js (new), step-labels-units, ai-files-units updated. units run: all pass except eml-units (known local). Lint clean. Bundles rebuilt (rebuild again after merging main). CHANGELOG entry added.

Left:
1. test/card-first-step.js: the card-at-first-step + host-dedupe + Files-card checks passed in the first run; the LIVE-event sections failed because the run never started in the sidebar (runId 0, no messages after fill+Enter). Debug why (compare with test/chat-actions-dup.js, which starts a run on the chat page after opening it; maybe the sidebar needs a different start) then rerun under the e2e lock (it was queued behind other agents).
2. Look at screenshots (scratchpad card-from-first-step/after) incl. 5-files-card.png: find and remove the stray highlight box behind the word "Files" in the card title (not yet found); find the stray grey bar for real.
3. Before/after screenshots; run step-labels, step-rows, chats, chatpage, composer-bar, ui-consistency, perf-budget, units, lint; merge origin/main (5 commits behind; other agents touch the same card: word-native, ai-close-focus), rebuild bundles, PR, land.js. Do not release.
4. Saved (restored) chats do not get clickable files (card_files is not stored).
Scratch tools: scratchpad/card-from-first-step/tools (ed.js, runpairs.js). The shared scratchpad is overwritten by other agents: only use that subfolder.
=======
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
>>>>>>> origin/main

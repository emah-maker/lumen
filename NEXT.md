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

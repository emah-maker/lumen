# sidebar-tab-state: paused

Done (committed locally, not pushed, no PR yet):
- test/sidebar-tab-state.js (registered in scripts/test-all.js), passes 3 runs in a row in both modes (own / default).
- Fixes: chat-core.js per-chat stash (pictures, @ tab chips, scroll from bottom, open step cards; applyView/pendingView/reopenCards), tabs-ask.js snapshot/restore, chats.js refreshOpen (open chat list marks current chat), main.js afterSettle pushes chat:sync (sidebar knew no chat id after restart so draft was lost).
- CHANGELOG entry added. Bundles rebuilt (node scripts/bundle-renderer.js).
- Passing: tabchats, sidebar-tabs, chats, composer-bar, hardening, perf-budget, ui-consistency, tabchats-follow, sidebar-stays, sidebar-keeps-run, lint, units. step-labels fails on plain main too (main-process stall timing, load).

Left:
- chat-composer and sidebar-newchat fail ("history list shows chat A" missing). Last edit (applySync refreshOpen only when the chat id changed, patch6) is NOT yet committed. A baseline run of chat-composer on origin/main is in worktree .claude/worktrees/stb-base (output: tasks/bw350fee4.output); if base passes, the cause is my change (suspect refreshOpen re-render or the afterSettle pushChatView).
- Remove worktree stb-base (rmdir its node_modules junction first, then git worktree remove).
- Re-run the failing suites, merge origin/main, rebuild bundles, push, gh pr create, node scripts/land.js <pr>, remove worktree.

# codex-context: paused

Done (committed locally, NOT pushed, no PR yet):
- codex-usage.js: contextFill, turnDelta, findRollout, threadStats, contextOf (meter = last model call from the Codex session log, not cumulative totals; window/model from the log).
- codex.js (headless exec) + codex-warm.js (app-server): return `thread` figures, emit live `codex_context` events, detect compaction.
- agent.js codexTurn: start estimate, live/final meter, per-turn usage = delta of thread total (exec usage is cumulative), compaction notice, reset on new thread; Grok/Antigravity clear stale context on new session.
- chat-usage.js (window order, name, auto flag), chat-extras.js tooltip (model name, "compacts itself"), en.json, CHANGELOG, test/codex-context-units.js (46 checks, pass).
- Passed: all unit suites (only eml-units fails, known), eslint, node --check, Electron `chats` suite. codex-warm-units ENOENT is pre-existing on main when run standalone.

Left:
- Run Electron suites test/composer-bar.js (was interrupted) and test/perf-budget.js through e2e-lock (owner codex-context).
- Rebuild bundles (node scripts/bundle-renderer.js, bundle-preload.js) after merging origin/main, commit.
- Push, open PR (gh pr create --repo emah-maker/lumen), node scripts/land.js <pr>, remove worktree (rmdir node_modules junction first).

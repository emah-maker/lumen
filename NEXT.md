# chat-render-fixes: status (paused)

Done (committed as WIP, not pushed, no PR):
- Math: src/renderer/markdown.js. `$$` now renders with content on the opening line and the close on a later line, spaces inside a sentence when plainly TeX, and an unclosed `$$` / `\[` at the end of a reply renders the partial formula (closePartial); while streaming it is held back (openMath). Money / price tiers stay text. Tests in test/math-units.js (pass).
- skill_request: step-labels.js `skillText` (shared, "Research skill: input"), used by clip, taskName (the leak was the card subtitle), chat-title.js (titles, cleanSaved), chat-store.js (search), renderer/skills.js (cut-off tag in the bubble). en.json keys skill.label / skill.label.bare. Tests in test/step-labels-units.js; test/units.js title expectation is now "Translate skill: French". CHANGELOG entry added. Bundles rebuilt.
- Passing: math-units, step-labels-units, units, markdown units, eslint (no errors), node scripts/test-units.js (only eml-units failed before; step-labels-units fixed since).

Left:
1. Run under the e2e lock (queue was long): scratchpad/chat-render-shots.js (screenshots to scratchpad/chat-render/; first run showed math OK, then I fixed the cut-tag label so rerun), then electron suites chats, chatpage, step-labels, step-rows, skills, ui-consistency, perf-budget.
2. Re-run `node scripts/test-units.js`, eslint, then push, `gh pr create --repo emah-maker/lumen`, `node scripts/land.js <pr>`. Do not release.
3. Remove worktree (unlink node_modules junction with `cmd /c rmdir node_modules` first).

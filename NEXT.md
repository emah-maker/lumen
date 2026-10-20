# effort-picker: state at pause

Done (uncommitted-before-this-WIP, now in one WIP commit, not pushed):
- src/ai/effort.js: offered(), pick(), cleanChat(), keyOfModel(), SHORT/ORDER (per-chat level, clamped to nearest level an AI takes).
- agent.js: effortFor/setEffort/openEffort; all engines + API providers use the chat's level over Settings; Auto-model chats ignore it.
- main.js: settings:set-effort IPC, `efforts` per model in pickerOptions, `effort` in settings:get and chatView. Preloads + chat-page allowlist updated.
- picker.js/css + chat-core.js + chats.js: Effort row (segmented radiogroup, Tab/arrow keys) in the model menu, "· High" suffix on the button, follows chat switch/new chat.
- en.json strings; tests test/effort-units.js (passes) and test/effort-picker.js (passed all, incl. lumen://chat); test/units.js allowlist updated for settings:set-effort.
- Bundles rebuilt with scripts/bundle-renderer.js (NOT node scripts/build.js: that packages the app).

Left:
1. Re-run node scripts/test-units.js (units should now pass; eml-units fails locally only for postal-mime).
2. Screenshots: node <scratchpad>/effort-picker/shots.js <root> before|after (before root = worktree effort-before, junction node_modules; remove that worktree at the end), via e2e-lock. Not produced yet.
3. Run via e2e lock: composer-bar, models, auto-model, chats, chatpage, ui-consistency, perf-budget, hardening; npx eslint changed files (clean except pre-existing warnings).
4. CHANGELOG entry under Unreleased + docs mention; merge origin/main (other agents touch chat-core.js); rebuild bundles; PR; land.js. No release.

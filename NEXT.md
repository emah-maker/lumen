# hide-extensions: state when paused

Done (all uncommitted work now in one local WIP commit, not pushed):
- Pin rules: src/renderer/ext-pins-core.js (pins, order, layout, migration: extensions installed before this version start pinned; later ones pinned while < 3).
- Toolbar: src/renderer/extensions-bar.js (hide/order buttons, puzzle button + dot, drag and Alt+Arrow reorder); old overflow block removed from app.js.
- Backend: settings-backend.js (extensionsToolbar, extensionPins, prefs:extension-pin, ext:pins-sync/order, extensionsLoaded); main.js (puzzle menu with Pin to toolbar + Manage, ⋯ menu "Show in toolbar", test hooks); preload + settings-preload; Settings → Extensions row and switches; strings, docs/settings.md, CHANGELOG, test-all.js list.
- Tests written: test/ext-pins-units.js (passes), test/hide-extensions.js (NOT YET RUN). Units (all but eml-units) and eslint pass. Bundles rebuilt.

Left:
1. Run Electron suites through the lock (--owner hide-extensions): hide-extensions (shots to scratchpad hide-extensions/), extensions, toolbar-layout, hardening, perf-budget, ui-consistency. Fix failures (the new suite is untested: popup-anchor and drag checks may need tuning).
2. Re-run node scripts/bundle-renderer.js and bundle-preload.js if sources change; check preload.bundle.js <= 40 KB, startup modules <= 341.
3. Merge origin/main, push, gh pr create, node scripts/land.js <pr> (retry loop), then unlink node_modules junction (cmd /c rmdir node_modules) and git worktree remove. No release.

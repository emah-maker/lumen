# tab-icons-overlap: status

Done (committed locally, not pushed):
- styles.css: on narrow tabs (container <= 96px with a speaker) the speaker is a corner badge on the icon's lower left, the chat ring lower right, sparkle upper right; favicon no longer hidden on the active tab; tabs with a working chat go icon-only below 88px; icons-only side tabs hide the close button; normal-width speaker margin clears the close button.
- test/tab-icons.js (new, in scripts/test-all.js): box-intersection checks at all widths/layouts + group chip case "Lab" (gap, title not a stub, ring = accent). Passes. Also passed: tabui, split-view, tabmenu, ui-consistency, perf-budget, units (only eml-units fails, known), eslint on the new test.
- Screenshots: scratchpad/tab-icons/after/ (dark+light: top-normal, top-pinned, side-normal, side-icons, split, top-group, top-squeezed, top-group-squeezed); before/ has the old look. Script: scratchpad/tab-icons/shots.js.
- Red ring: nothing in code makes it red; spinner and chat mark use var(--accent), so it is the user's accent colour setting.

Left:
- tabstrip and side-tabs failed in "restart / restore" checks (session restore, unrelated to CSS as far as seen); a re-run was stopped. Re-run both (and on origin/main for a baseline) to confirm they are flaky/pre-existing.
- eslint on changed files, then push, gh pr create, node scripts/land.js <pr>. Do not release.
- Then remove worktree (cmd /c rmdir node_modules first).

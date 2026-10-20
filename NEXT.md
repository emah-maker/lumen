# word-native: status

Done (committed locally, NOT pushed, no PR yet):
- src/word/ (spec, index controller, com + host.ps1 COM helper, docx fallback reader/writer, card.js live card), agent.js/main.js/settings wiring, aiWordControl ON by default, plan-mode, step-ui Word card (+css, locale), docs/word.md, README, settings.md, CHANGELOG, PRIVACY, site/docs.js.
- test/word-units.js passes (incl. real hidden Word); all unit suites pass except eml-units (postal-mime, expected); acceptance (Grok prompt budget) pass; lint 0 errors; hardening, perf-budget, ui-consistency passed earlier; test/step-labels.js (with new Word card checks + screenshots in scratchpad word-native/) passes except the known-flaky "no main-process task over 25 ms while it streams" (also fails on origin/main's own test).

Left:
1. Merge origin/main again, `node scripts/bundle-renderer.js`, re-run: eslint, node scripts/test-units.js --jobs 4, and under the e2e lock perf-budget + hardening + ui-consistency once more.
2. git push, `gh pr create --repo emah-maker/lumen` (body ends with the Claude Code line), `node scripts/land.js <pr>` in a retry loop. Do not release.
3. Remove worktree (cmd /c rmdir node_modules first).
Notes: macOS = "Windows only for now" (docx file route works anywhere). Two stray hidden WINWORD.EXE (pids 47552, 9980, /Automation) may be left from my early tests; ownership uncertain, not killed.

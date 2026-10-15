# Landing and releasing

Two commands, both plain Node (Windows Git Bash and macOS), both in `scripts/`. They need `git` and an authenticated `gh`.

```
node scripts/land.js <pr> [--dry-run]            # same as: npm run land -- <pr>
node scripts/land.js --queue <pr> <pr> ...       # lands them in order, stops at the first that cannot land
node scripts/release.js <X.Y.Z|patch|minor|major> [--dry-run] [--checks-only] [--resume] [--kill-stale] [--hold-lock|--share-machine]
```

Always try `--dry-run` first: it prints the plan and changes nothing (land.js does a `git fetch` and a trial merge in git's object store; release.js touches nothing).

## One-time setup (optional)

`node scripts/setup-merge-drivers.js` registers the merge drivers that `.gitattributes` names, in this clone's local git config (`--check` shows them, `--remove` undoes it):

- `lumen-changelog` (CHANGELOG.md): two branches adding bullets under `## Unreleased` merge cleanly, also after main cut a release. Any other section both sides changed is a normal conflict.
- `lumen-list` (scripts/test-all.js): the `SUITES` list is merged by name.
- `lumen-bundle` (the generated bundles): keep our copy; land.js rebuilds them.

Nothing depends on them: without the drivers `land.js` resolves the same files itself from the merge's index stages, with the same functions (`scripts/release-lib.js`).

## land.js

1. Finds the worktree for the PR's head branch, or makes `.claude/worktrees/land-<pr>` (removed again after the merge).
2. Stops if tracked files are dirty. Bundle files that differ only by line endings (CRLF churn after a rebuild) are reset first.
3. Fast-forwards to `origin/<branch>`, then merges `origin/main`. Conflicts in CHANGELOG.md, scripts/test-all.js and the generated bundles are resolved; any other conflicting file aborts the merge and stops.
4. Rebuilds the bundles (`scripts/bundle-renderer.js`, `bundle-preload.js`) and commits them if they changed.
5. Pushes, then polls CI on that exact commit (`gh run list --commit` with status and conclusion; not `gh run watch --exit-status`, which exits early on annotation warnings).
6. Re-reads the PR (still open, head still the commit CI passed on), then `gh pr merge --squash --match-head-commit <sha>`, then checks that origin/main matches the head in every file the PR touched and warns loudly if not.

A lock file (`<git dir>/lumen-land-<pr>.lock`, holding the PID) stops two runs on one PR. If a run was stopped but its process lives on, kill that process: the lock names it. A dead owner's lock is replaced. Options: `--ci-timeout <min>` (40), `--keep-worktree`.

## release.js

Stages, in order; each finished stage is recorded in `<worktree git dir>/lumen-release-state.json`.

0. **preflight** (always runs): refuses when another release is mid-run, and lists electron processes under the repo and its worktrees. `--kill-stale` stops exactly those PIDs; other Electron apps (an installed Lumen) are left alone.
1. **worktree**: `.claude/worktrees/release-X.Y.Z` on branch `release-X.Y.Z` from a fresh `origin/main`. Refuses if the tag already exists on origin.
2. **install**: `npm ci --ignore-scripts`, then copies `node_modules/electron/dist` and `path.txt` from the main checkout.
3. **prepare**: `## Unreleased` becomes `## X.Y.Z (date)` with a fresh empty Unreleased (refuses an empty one); `npm version X.Y.Z --no-git-tag-version`; commit "Release X.Y.Z".
4. **checks**, hidden (`LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1`), one suite at a time, each with its own `TEMP` and `CLAUDE_BROWSER_PROFILE`, a log per suite in `%TEMP%/lumen-release-X.Y.Z-*/`, and a timeout (`--suite-timeout`, 15 min). The list is derived, not kept by hand: units (`scripts/test-units.js`), acceptance, lint, then every Electron suite in `scripts/test-all.js` in that order, `perf-budget` last. A suite is pure-node when its name is `units`, `cli-json` or ends in `-units` (as test-units.js decides); everything else in test-all.js is Electron. Test files outside test-all.js (network, keys, manual) are not run. A failing Electron suite is retried once; passing the retry makes it **flaky**: listed in the summary and the PR body, not blocking. Any other failure stops the release.
5. **pr**, 6. **ci**, 7. **merge**: pushes, opens "Release X.Y.Z" (the body lists commits since the last tag and flaky suites), waits for CI, squash-merges with `--match-head-commit`.
8. **tag**: annotated `vX.Y.Z` on the merge commit, pushed.
9. **publish**: waits for `release.yml` on the tag and checks the release has 13 assets (`--assets <n>`).

`--only a,b,c` runs a targeted release: the pure-node stages and perf-budget always run, plus the named Electron suites (the ones a change touches). The set is kept for `--resume` and named in the release PR. Use it for an urgent fix; a normal release runs everything.

`--checks-only` stops after stage 4 (nothing pushed; `--resume` can ship it later). `--resume` continues from the last finished stage; inside the checks it skips suites that already passed and reruns the failed ones. With `patch` or no version it picks the unfinished release worktree.

## The machine-wide Electron lock

Several agents run hidden Electron tests on one laptop, and two at once make suites fail falsely (`video-frames` did). Only ONE Electron run may happen at a time, so every Electron run takes a lock: the directory `%LOCALAPPDATA%Templumen-e2e-lock` (override: `LUMEN_E2E_LOCK_DIR`), made with `mkdir` (atomic: it fails when the lock is held) and holding an `owner` file, `<pid> <name> <epoch>`. `scripts/e2e-lock.js` does it:

```
node scripts/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>   # waits (polls every 5 s), runs the command, always releases (failure, SIGINT too)
```

As a module: `acquire`, `acquireSync`, `release`, `withLock`, `withLockSync`. A lock is stale when its directory is older than 20 minutes AND its owner pid is dead: it is then removed and taken. A lock whose owner is alive is never taken, however old. Never hold it while writing code or thinking; take it per run.

- `scripts/release.js` holds it for the whole checks stage (`--hold-lock`, the default), so a parallel agent cannot slip in between suites. `--share-machine` takes it per Electron suite instead (the retry stays inside the same hold) and releases between suites. The pure-node stages need no lock.
- `npm test` (`scripts/test-all.js`) takes it per Electron suite; pure-node suites run without it.
- By hand: `node scripts/e2e-lock.js run -- node test/<suite>.js`, or the shell recipe (`until mkdir "$LOCALAPPDATA/Temp/lumen-e2e-lock" 2>/dev/null; do sleep 20; done`, write `"$$ <name> $(date +%s)"` to `owner`, `rm -rf` the dir after).
- A nested taker (a command run under the lock that takes it again) does not deadlock: the holder's pid travels in `LUMEN_E2E_LOCK_HELD`.

## Gotchas

- Never run it while Electron tests or another release are using the machine: they share focus and the disk cache. perf-budget is last because it needs the cache warm.
- "worktree dirty" after a bundle rebuild is line-ending churn; land.js resets it with `git checkout --` on the bundles.
- Do not squash-merge by hand while a land run is alive, and never merge from a stale head: both land and release pass `--match-head-commit`.
- Commit trailers come from `LUMEN_CO_AUTHOR` (default: the Claude Opus line used so far).

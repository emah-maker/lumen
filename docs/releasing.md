# Landing and releasing

Two commands, both plain Node (Windows Git Bash and macOS), both in `scripts/`. They need `git` and an authenticated `gh`.

```
node scripts/land.js <pr> [--dry-run]            # same as: npm run land -- <pr>
node scripts/land.js --queue <pr> <pr> ...       # lands them in order, stops at the first that cannot land
node scripts/release.js <X.Y.Z|patch|minor|major> [--dry-run] [--checks-only] [--resume] [--kill-stale] [--hold-lock|--share-machine] [--only a,b] [--no-preflight] [--no-skip-ci] [--serial-checks] [--electron-jobs n] [--full] [--fresh-install]
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
2. **install**: when the main checkout's `node_modules/.package-lock.json` (what npm installed there) matches this worktree's `package-lock.json` package for package, `node_modules` becomes a junction to it: no `npm ci`, no Electron copy. Otherwise (or with `--fresh-install`) `npm ci --ignore-scripts` and the Electron `dist` and `path.txt` are copied from the main checkout. The junction is removed when the release finishes; to delete a worktree by hand, `rmdir node_modules` first (never `npm ci` through it).
3. **prepare**: a version that was *burned* (its tag was pushed, its `release.yml` run failed, no GitHub release exists, and its section is in CHANGELOG.md) has its notes folded into `## Unreleased` first, oldest first, and its own section dropped, so the new version carries them and `whats-new-units` passes without a hand edit. Then `## Unreleased` becomes `## X.Y.Z (date)` with a fresh empty Unreleased (refuses an empty one); `npm version X.Y.Z --no-git-tag-version`; commit "Release X.Y.Z".
4. **preflight build** (starts here, runs alongside the checks): pushes `release-X.Y.Z` and dispatches `release.yml` on it (`workflow_dispatch`). That run builds Windows and macOS and runs their tests and unit suites, uploads the artifacts and a manifest (the commit's tree, every file's SHA-256), and **publishes nothing**: the publish job only runs on a tag. If the local checks fail, the run is cancelled.
5. **checks**, hidden (`LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1`), each with its own `TEMP` and `CLAUDE_BROWSER_PROFILE`, a log per stage in `%TEMP%/lumen-release-X.Y.Z-*/`, and a timeout (`--suite-timeout`, 15 min). The list is derived, not kept by hand: units (`scripts/test-units.js --jobs N`), acceptance, lint, then the Electron suites in `scripts/test-all.js` that the run selects (see "Which Electron suites run" below). A suite is pure-node when its name is `units`, `cli-json` or ends in `-units`; everything else in test-all.js is Electron. Two lanes run at once: the pure-node stages, and the Electron suites (under the lock, which is taken only when the first Electron suite starts). The Electron lane runs `--electron-jobs N` ordinary suites at the same time (default `min(3, cores / 4, RAM / 10 GB)`: 3 on a 16-core, 64 GB machine; `--electron-jobs 1` is the old one-at-a-time order; `--share-machine` and `--serial-checks` force 1), each with its own `TEMP`, `CLAUDE_BROWSER_PROFILE` and hidden windows, and units get fewer workers to leave room. Suites that cannot share the machine run **alone, one at a time, after the ordinary ones**: any that binds a fixed port (`cdp`, `cdp-inproc`, `spotify-reconnect-ui`), uses the real OS clipboard (`images`, `screenshot`, `canvas`, `ai-files`, `edit-keys`), lists every window or process on the machine (`passkeys`, `desktop-apps`) or captures the screen (`music-react`). They are found by patterns over each suite's source (`SHARED_RESOURCE_PATTERNS` in `scripts/release-lib.js`, with `KNOWN_EXCLUSIVE` for anything a pattern cannot see), so a new suite like that is picked up by itself; `test/release-tooling-units.js` checks the known ones are detected. The perf-sensitive suites (`PERF_SENSITIVE`: `perf-budget`, `step-labels`, `overlay-first-perf`, `page-load-stall`, `igpu-perf`, plus every other suite with a wall-clock budget: `tab-switch-perf`, `chat-tab-speed`, `chat-save-stall`, `desktop-apps`, `music-react`, `project-folders`, `pptx-shapes`, `tools`, `files-ai`, `gpu-health`, `video-frames`) run last and alone. A failing Electron suite is retried once, alone on the machine, when its phase is done (the other suites and the pure-node lane have finished, leftover Electron processes under the worktree are stopped by PID first); passing the retry makes it **flaky**: listed in the summary and the PR body, not blocking. Any other failure stops the release. `--serial-checks` restores the one-after-another order. Test files outside test-all.js (network, keys, manual) are not run.
6. **pr**: pushes (if needed) and opens "Release X.Y.Z" (the body lists commits since the last published tag, folded burned versions, and flaky suites).
7. **ci**: the gate before the merge. The wait for the PR's CI is skipped when the release commit is mechanically only the release: it changes nothing but `CHANGELOG.md`, `package.json` and `package-lock.json`; the package files differ from the base only in the version fields; CHANGELOG.md equals the base's with "Unreleased" cut (checked line by line against `cutChangelog`); and CI already passed on the base commit (the `origin/main` the release was cut from). Anything else, or `--no-skip-ci`, waits for CI as before. The same gate waits for the build preflight to pass, so a build or test failure surfaces here, before the tag, and no version number is burned. `--resume` dispatches a failed or cancelled preflight again.
8. **merge**: squash-merges with `--match-head-commit`. 9. **tag**: annotated `vX.Y.Z` on the merge commit, pushed.
10. **publish**: waits for `release.yml` on the tag and checks the release has 13 assets (`--assets <n>`). On the tag, `release.yml`'s plan job looks for a preflight run whose manifest tree equals the tagged commit's tree and whose version matches (a squash merge has a new SHA but the same tree when main did not move). Found: the unit and build jobs are skipped, and publish downloads that run's artifacts, checks every SHA-256 against the manifest, and attaches them: about two minutes. Not found (main moved, or no preflight): the units and the build run on the tag, in parallel jobs, as a build always did.

### Which Electron suites run

- **Default**: the core set (`CORE_SUITES`: smoke, basics, no-errors, ui, settings, tabstrip, browser, first-run, relaunch, perf-budget) plus the suites related to the files changed since the last release tag (up to the commit before the release commit). A suite is related when it is itself a changed test file, its source mentions a changed module by path or file name, or its name is the changed file's name or starts with it (`src/features/spotify.js` selects every `spotify-*` suite). If a build, dependency or workflow file changed (`package.json`, `package-lock.json`, `scripts/build*`, `scripts/bundle*`, `.github/`), or there is no tag to compare with, everything runs. The pure-node stages (units, acceptance, lint) always run in full. `--dry-run` prints the selection; the PR body says it was a selection.
- `--full`: every Electron suite in test-all.js, as releases ran before.
- `--only a,b,c`: exactly the named suites (plus perf-budget and the pure-node stages), for an urgent fix.

The choice is kept for `--resume`; `--full` on a resume widens it.

`--checks-only` stops after the checks (nothing pushed, no build preflight; `--resume` ships it and dispatches the preflight then). `--resume` continues from the last finished stage; inside the checks it skips suites that already passed and reruns the failed ones; the build preflight and the CI gate are re-evaluated rather than trusted. `--no-preflight` skips the dispatch (the build then only happens on the tag).

Every network step (`git fetch`, `git push`, `git ls-remote`, every `gh` call) is retried up to 5 times with 2, 4, 8 and 16 s waits when it fails on DNS, TLS, a dropped connection, a GitHub 5xx or a timeout; a real refusal (auth, a rejected push, not found) is not retried. A push or merge that went through before the connection dropped counts as done. Poll loops (CI, preflight) keep polling through several minutes of outage. `land.js` uses the same helpers.

## The machine-wide Electron lock

Several agents run hidden Electron tests on one laptop, and two at once make suites fail falsely (`video-frames` did). Only ONE Electron run may happen at a time, so every Electron run takes a lock: the directory `%LOCALAPPDATA%Templumen-e2e-lock` (override: `LUMEN_E2E_LOCK_DIR`), made with `mkdir` (atomic: it fails when the lock is held) and holding an `owner` file, `<pid> <name> <epoch>`. `scripts/e2e-lock.js` does it:

```
node scripts/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>   # waits (polls every 5 s), runs the command, always releases (failure, SIGINT too)
```

As a module: `acquire`, `acquireSync`, `release`, `withLock`, `withLockSync`. A lock is stale when its directory is older than 20 minutes AND its owner pid is dead: it is then removed and taken. A lock whose owner is alive is never taken, however old. Never hold it while writing code or thinking; take it per run.

- `scripts/release.js` takes it when the first Electron suite starts and holds it to the end of the checks (`--hold-lock`, the default), so a parallel agent cannot slip in between suites; the pure-node lane runs without it, so the hold is shorter than the whole stage. `--share-machine` takes it per Electron suite instead (one suite at a time; the retry takes it again) and releases between suites. The pure-node stages need no lock.
- `npm test` (`scripts/test-all.js`) takes it per Electron suite; pure-node suites run without it.
- By hand: `node scripts/e2e-lock.js run -- node test/<suite>.js`, or the shell recipe (`until mkdir "$LOCALAPPDATA/Temp/lumen-e2e-lock" 2>/dev/null; do sleep 20; done`, write `"$$ <name> $(date +%s)"` to `owner`, `rm -rf` the dir after).
- A nested taker (a command run under the lock that takes it again) does not deadlock: the holder's pid travels in `LUMEN_E2E_LOCK_HELD`.

## Gotchas

- Never run it while Electron tests or another release are using the machine: they share focus and the disk cache. perf-budget is last because it needs the cache warm.
- "worktree dirty" after a bundle rebuild is line-ending churn; land.js resets it with `git checkout --` on the bundles.
- Do not squash-merge by hand while a land run is alive, and never merge from a stale head: both land and release pass `--match-head-commit`.
- Commit trailers come from `LUMEN_CO_AUTHOR` (default: the Claude Opus line used so far).

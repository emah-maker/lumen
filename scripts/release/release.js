#!/usr/bin/env node
// Cuts a release: a release worktree from origin/main, the CHANGELOG cut and version bump, every check run hidden, and (only on a
// clean pass) the "Release X.Y.Z" PR, CI, squash-merge (a merge commit when main moved meanwhile: see the merge stage), the annotated tag on the
// commit with the pre-flighted tree, and the release.yml build.
//   node scripts/release/release.js <X.Y.Z | patch | minor | major> [options]
//   --dry-run        print the plan and the derived suite list; changes nothing (no fetch, worktree, process kill, push, dispatch or tag)
//   --checks-only    stop after the checks: nothing is pushed
//   --resume         continue the release from the last finished stage (kept in the worktree's git dir)
//   --hold-lock      (default) reserve the machine and hold the machine-wide Electron lock (scripts/test/e2e-lock.js) from the preflight to the end of the checks
//   --share-machine  lock per Electron suite instead (retry included), releasing between suites so a parallel agent can run then
//   --kill-stale     stop electron processes left under this repo's worktrees that no e2e lock accounts for (by PID, only those) before the checks
//   --lock-wait <minutes> (default 240)   how long the preflight waits for another session's run under the e2e lock (or another release's reservation)
//   --only a,b,c     a targeted release: the pure-node stages and perf-budget always run, plus the named Electron suites
//   --suite-timeout <minutes> (default 15)   --ci-timeout <minutes> (default 40)   --assets <n> (default 13)
//   --no-preflight   do not dispatch release.yml on the release branch before the PR (the build then happens only at the tag)
//   --preflight-timeout <minutes> (default 45)   how long to wait for that build
//   --no-skip-ci     always wait for CI on the release PR (default: skip when the commit is verified to be only the release)
//   --serial-checks  run the checks one after another (default: the pure-node lane alongside the Electron lane)
//   --electron-jobs <n>  run n ordinary Electron suites at once (default min(3, cores/4, RAM/10 GB); 1 = one at a time). Suites that bind a
//                    fixed port or share the clipboard or the machine's windows/processes run alone, perf-sensitive ones last and alone
//   --full           run every Electron suite (default: the core set plus the suites related to the files changed since what the last release built)
//   --fresh-install  npm ci in the worktree instead of reusing the main checkout's node_modules
// Another session's Electron run under the e2e lock is waited for; it refuses only when another release is mid-run, or Electron no lock accounts for runs.
// A fresh run (not --resume) removes what a stopped run of the same, unpublished version left (worktree, branches: release-leftover.js).
// Stages and gotchas: docs/releasing.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const e2eLock = require('../test/e2e-lock');
const {
  cutChangelog, changelogSection, readSuites, suiteFile, bumpVersion, deriveChecks, procsUnder,
  findBurned, foldBurned, compareVersions, releaseTagMessage, tagTarget, ciSkipVerdict, pickPreflightRun, runVerdict, nodeModulesMatch, planLanes, unitJobs, electronJobs, sharedResources, selectSuites, splitDiff, srcImporters, releasePlan, stageDone, stagesLeft,
} = require('./release-lib');
const { Stop, sleep, say, run, must, git, gh, ghRetry, ghJsonRetry, gitRetry, NET_TRIES, mainCheckout, worktreesDir, listWorktrees, listElectron, killTree, alive, ciState } = require('./ship-common');
const { mergeMainInto, releaseBase, contains } = require('./release-git');
const { holdMachine, freeMachine } = require('./release-machine');
const { cleanLeftover } = require('./release-leftover');

const CO_AUTHOR = process.env.LUMEN_CO_AUTHOR || 'Claude Opus 5.5 <noreply@anthropic.com>';
const STATE_FILE = 'lumen-release-state.json';

// ----------------------------------------------------------------------------------------------------------------- planning

// The checks for a tree: cheap pure-node stages first, then every Electron suite from test-all.js (perf-budget last).
function planChecks(readFile, listTestFiles) {
  const derived = deriveChecks({ suites: readSuites(readFile('scripts/test/test-all.js')), files: listTestFiles() });
  // Each Electron suite's source: which ones share a port, the clipboard or the machine (they run alone), and which a change relates to.
  const sources = {};
  for (const s of derived.electron) { try { sources[s] = readFile(suiteFile(s)); } catch { sources[s] = ''; } }
  const shared = {};
  for (const s of derived.electron) { const why = sharedResources(s, sources[s]); if (why.length) shared[s] = why; }
  const plain = (name, args) => ({ name, kind: 'plain', cmd: process.execPath, args });
  const stages = [
    plain('units', ['scripts/test/test-units.js']),
    plain('acceptance', ['scripts/test/test-acceptance.js']),
    plain('lint', ['node_modules/eslint/bin/eslint.js', '.']),
    ...derived.electron.map((s) => ({ name: s, kind: 'electron', cmd: process.execPath, args: [suiteFile(s)] })),
  ];
  return { stages, derived, sources, shared };
}

// The head of the merged "Release X.Y.Z" PR for a tag made before tags carried Release-Head (that head is what its checks ran on and its preflight
// built), or null.
function releasePrHead(wt, tag) {
  const title = `Release ${tag.replace(/^v/, '')}`;
  const r = gh(wt, 'pr', 'list', '--state', 'merged', '--search', `"${title}" in:title`, '--json', 'title,headRefOid', '--limit', '10');
  if (r.status !== 0) return null;
  try { const pr = JSON.parse(r.stdout).find((p) => p.title === title); return pr ? pr.headRefOid : null; } catch { return null; }
}

// The default suite choice (see selectSuites): the files changed since what the last release checked and built (the Release-Head in its tag,
// see releaseBase in release-git.js), up to `headRev`, with what selectSuites narrows by: each changed src file's diff, who requires whom under src/,
// and every src file's text (all at headRev). Not the tag's tree: when main moved during that release, the tag held code no release checked.
// null when there is no tag to compare with; { tag, unknown: true } when what it built cannot be found (then everything runs).
function changedSinceTag(wt, tagGuess, headRev) {
  const tag = tagGuess || git(wt, 'describe', '--tags', '--abbrev=0', headRev).stdout;
  if (!tag) return null;
  const offline = process.env.LUMEN_RELEASE_OFFLINE === '1'; // the units' dry runs: no gh, no fetch
  const base = releaseBase(wt, tag, offline ? {} : { prHead: (t) => releasePrHead(wt, t), fetch: (sha) => git(wt, 'fetch', '-q', 'origin', sha) });
  if (!base) return { tag, unknown: true };
  const r = git(wt, 'diff', '--name-only', base.rev, headRev);
  if (r.status !== 0) return { tag, unknown: true };
  const files = r.stdout.split('\n').filter(Boolean);
  const d = spawnSync('git', ['diff', '-U0', base.rev, headRev, '--', 'src'], { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true });
  const diffs = d.status === 0 ? splitDiff(d.stdout) : {};
  return { tag, base: base.rev, how: base.how, files, diffs, ...srcAt(wt, headRev) };
}
const sinceText = (ch) => `${ch.tag} (${ch.how === 'pr' ? 'its release PR head' : 'the head it built'}, ${ch.base.slice(0, 8)})`;
const unknownText = (ch) => `what ${ch.tag} built is unknown (no Release-Head in the tag, no release PR found)`;

// { srcTexts: { path: text } for the .js, .css and .html files under src/ at `rev` (not vendor/, not the generated bundles), importers }.
function srcAt(wt, rev) {
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', rev, 'src'], { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  const names = (ls.stdout || '').split('\n').filter((f) => /\.(js|css|html)$/.test(f) && !/\/vendor\/|\.bundle\./.test(f));
  if (!names.length) return { srcTexts: null, importers: {} };
  const out = spawnSync('git', ['cat-file', '--batch'], { cwd: wt, input: names.map((f) => `${rev}:${f}`).join('\n') + '\n', maxBuffer: 1 << 30, windowsHide: true }).stdout;
  const srcTexts = {};
  let at = 0;
  for (const f of names) {
    const nl = out.indexOf(10, at);
    const size = Number(out.slice(at, nl).toString().split(' ')[2]);
    srcTexts[f] = out.slice(nl + 1, nl + 1 + size).toString('utf8');
    at = nl + 1 + size + 1;
  }
  const js = Object.fromEntries(Object.entries(srcTexts).filter(([f]) => f.endsWith('.js')));
  return { srcTexts, importers: srcImporters(js) };
}

const pickSuites = (ch, derived, sources) => selectSuites({ changed: ch.files, electron: derived.electron, sources, diffs: ch.diffs, importers: ch.importers, srcTexts: ch.srcTexts });

// Electron suites at once: --electron-jobs, else min(3, cores/4, RAM/10 GB). Always 1 with --share-machine (the lock is taken per suite).
function pickElectronJobs(opts) {
  if (!opts.holdLock) return 1;
  if (opts.electronJobs) return opts.electronJobs;
  return electronJobs({ cpus: os.cpus().length, ramGb: os.totalmem() / 2 ** 30 });
}

const localDate = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function stateFile(wt) { return path.join(must(git(wt, 'rev-parse', '--absolute-git-dir'), 'git rev-parse'), STATE_FILE); }
function loadState(wt) { try { return JSON.parse(fs.readFileSync(stateFile(wt), 'utf8')); } catch { return null; } }
function saveState(wt, st) { fs.writeFileSync(stateFile(wt), JSON.stringify(st, null, 2)); }

// Release worktrees that have a state file: [{ dir, state }].
function releaseWorktrees(main) {
  return listWorktrees(main).filter((w) => /^release-\d/.test(w.branch || '')).map((w) => ({ dir: w.dir, branch: w.branch, state: loadState(w.dir) })).filter((w) => w.state);
}

const done = stageDone;

// ----------------------------------------------------------------------------------------------------------------- preflight

// Another session's Electron run under the e2e lock is waited for (with a progress line), not a reason to stop; with --hold-lock the release
// then reserves the machine and holds the lock until its checks end (release-machine.js). Only Electron under the repo that no lock accounts
// for (a stray app, a test run outside the lock) stops the run, or is stopped by PID with --kill-stale.
async function preflight(main, opts, mine, withElectron = true, owner = 'release') {
  const others = releaseWorktrees(main).filter((w) => w.dir !== mine && w.state.stage !== 'publish' && w.state.pid && alive(w.state.pid) && w.state.pid !== process.pid);
  if (others.length) throw new Stop(`another release is running (${others.map((w) => `${w.branch}, pid ${w.state.pid}`).join('; ')})`);
  if (!withElectron) { say('preflight', 'the checks are done: skipping the Electron preflight (other agents may be running tests; only the checks need a quiet machine)'); return; }
  const b = e2eLock.blocker();
  if (b && e2eLock.pidAlive(b.pid)) say('preflight', `the e2e lock is ${b.release ? 'reserved' : 'held'} by ${b.name} (pid ${b.pid}): waiting for it (up to ${opts.lockWaitMinutes} min, --lock-wait)`);
  const { waited } = await holdMachine({ owner, holdLock: opts.holdLock, waitMs: opts.lockWaitMinutes * 60000, log: (m) => say('preflight', m) });
  say('preflight', opts.holdLock ? 'the machine is the release\'s: other Electron runs wait (the e2e lock and the release reservation are held until the checks end)' : 'the e2e lock is free (--share-machine: it is taken again per Electron suite)');
  try { await strayElectron(main, opts, waited); } finally { if (!opts.holdLock) e2eLock.release(); }
}

async function strayElectron(main, opts, waited) {
  let all = listElectron();
  let stale = procsUnder(all, [main]);
  // The run just waited for may take a few seconds to close its windows after it released the lock.
  for (let i = 0; waited && stale.length && i < 10; i++) { await sleep(3000); all = listElectron(); stale = procsUnder(all, [main]); }
  if (all.length > stale.length) say('preflight', `${all.length - stale.length} electron process(es) outside this repo (an installed Lumen?) are left alone`);
  if (!stale.length) { say('preflight', 'no electron processes under the repo or its worktrees'); return; }
  const short = (p) => `pid ${p.pid} ${path.relative(main, p.exe || '') || p.exe}`;
  say('preflight', `${stale.length} electron process(es) under the repo's worktrees:\n    ${stale.map(short).join('\n    ')}`);
  if (!opts.killStale) throw new Stop('electron is running under the repo while no run holds the e2e lock (a stray app, or a test started outside scripts/test/e2e-lock.js). Close it, or rerun with --kill-stale to stop exactly those PIDs');
  for (const p of stale) killTree(p.pid);
  await sleep(2000);
  const left = procsUnder(listElectron(), [main]);
  if (left.length) throw new Stop(`could not stop pid ${left.map((p) => p.pid).join(', ')}`);
  say('preflight', `stopped ${stale.length} stale electron process(es)`);
}

// ------------------------------------------------------------------------------------------------------------------ checks

function runStage(wt, stage, logFile, timeoutMs) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-rel-'));
    const env = { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', TEMP: tmp, TMP: tmp, TMPDIR: tmp, CLAUDE_BROWSER_PROFILE: path.join(tmp, 'profile') };
    fs.mkdirSync(path.dirname(logFile), { recursive: true }); // (the logs folder is in TEMP, which a cleaner can empty while the lock is awaited)
    const fd = fs.openSync(logFile, 'a');
    fs.writeSync(fd, `\n=== ${new Date().toISOString()} ${stage.name}: ${stage.cmd} ${stage.args.join(' ')}\n`);
    const t0 = Date.now();
    const child = spawn(stage.cmd, stage.args, { cwd: wt, env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* the OS cleans temp */ }
      resolve({ ok: code === 0 && !timedOut, code: timedOut ? `timeout after ${Math.round(timeoutMs / 60000)} min` : `exit ${code}`, seconds: Math.round((Date.now() - t0) / 1000) });
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
  });
}

const failLines = (logFile) => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 5); } catch { return []; } };

async function runChecks(wt, st, opts) {
  let { stages, derived, sources, shared } = planChecks((f) => fs.readFileSync(path.join(wt, f), 'utf8'), () => ['units', 'e2e'].flatMap((d) => fs.readdirSync(path.join(wt, 'test', d))).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)));
  // --only a,b,c: a targeted release (the suites a change touches). The pure-node stages and perf-budget always run; the choice is kept
  // in the state file so --resume runs the same set, and the release PR names it.
  // Neither --only nor --full: the core set plus the suites related to the files changed since the last release tag (selectSuites); that choice is kept
  // too, and --full (also kept) runs every Electron suite instead.
  if (opts.full) { delete st.only; delete st.selection; st.full = true; saveState(wt, st); }
  let only = opts.only || (opts.full ? null : st.only) || null;
  if (!only && !opts.full && !st.full) {
    const ch = changedSinceTag(wt, st.baseTag, 'HEAD~1');
    const pick = ch && !ch.unknown ? pickSuites(ch, derived, sources) : null;
    if (pick && !pick.full) {
      only = pick.names;
      st.selection = { tag: ch.tag, base: ch.base, changed: ch.files.length, reasons: pick.reasons };
      say('checks', `default selection: ${pick.names.length} of ${derived.electron.length} Electron suites (the core set and what the ${ch.files.length} files changed since ${sinceText(ch)} relate to; --full runs all)`);
    } else say('checks', !ch ? 'running every Electron suite: no release tag to compare with' : ch.unknown ? `running every Electron suite: ${unknownText(ch)}` : `running every Electron suite: a build, dependency or workflow file changed since ${sinceText(ch)}`);
  }
  if (only) { st.only = only; saveState(wt, st); stages = stages.filter((x) => x.kind === 'plain' || x.name === 'perf-budget' || only.includes(x.name)); const unknown = only.filter((n) => !derived.electron.includes(n)); if (unknown.length) say('checks', `--only names suites test-all.js does not list (skipped): ${unknown.join(', ')}`); }
  if (derived.missing.length) say('checks', `named in test-all.js but not in test/units/ or test/e2e/ (skipped): ${derived.missing.join(', ')}`);
  fs.mkdirSync(st.logs, { recursive: true });
  const timeoutMs = opts.suiteMinutes * 60000;
  st.checks = st.checks || {};
  const owner = `release-${st.version}`;
  const isPending = (x) => !(st.checks[x.name] && st.checks[x.name].status !== 'fail');
  const pending = stages.filter((x) => x.kind === 'electron' && isPending(x));
  // Unit suites run several at a time (test-units.js --jobs), leaving cores for the Electron lane when both run at once.
  const parallel = !opts.serialChecks;
  const ej = parallel ? pickElectronJobs(opts) : 1;
  if (!opts.holdLock && opts.electronJobs > 1) say('checks', '--share-machine takes the Electron lock per suite, so Electron suites run one at a time (--electron-jobs ignored)');
  const jobs = unitJobs({ cpus: os.cpus().length, withElectron: parallel && pending.length > 0, electronJobs: ej });
  for (const s of stages) if (s.name === 'units') s.args = ['scripts/test/test-units.js', '--jobs', String(jobs)];
  const phases = planLanes(stages, { serial: !parallel, electronJobs: ej, exclusive: (n) => Boolean(shared[n]) });
  const nElectron = stages.filter((x) => x.kind === 'electron').length;
  const alone = Object.keys(shared).filter((n) => stages.some((x) => x.name === n));
  say('checks', `${stages.length} stages (${nElectron} Electron suites, ${ej} at a time${ej > 1 ? `, ${alone.length} that share a port, the clipboard or the machine alone` : ''}; perf-sensitive ones last and alone; units ${jobs} at a time; ${parallel ? 'pure-node lane alongside the Electron lane' : 'one after another'}); logs in ${st.logs}`);

  // The machine-wide Electron lock (docs/releasing.md): by default the preflight already took it and reserved the machine, and both are held to
  // the end of the checks, so no other run starts between stages (the pure-node lane included: its timings feel the load too). With
  // --share-machine it is taken per Electron suite instead. Taking it here again when it is held returns at once.
  const lockOpts = { owner, exact: true, waitMs: opts.lockWaitMinutes * 60000, onWait: (i) => say('checks', i.line) };
  let lockP = null;
  const ensureLock = () => { if (!lockP) { if (!e2eLock.holds()) say('checks', 'taking the machine-wide Electron lock'); lockP = e2eLock.acquire(lockOpts); } return lockP; };

  // One attempt at a stage. The Electron lock is taken here per suite (--share-machine) or already held (default).
  async function attempt(stage, logFile) {
    const isElectron = stage.kind === 'electron';
    const perSuite = isElectron && !opts.holdLock;
    if (isElectron && opts.holdLock) await ensureLock();
    if (perSuite) { say('checks', `waiting for the Electron lock for ${stage.name}`); await e2eLock.acquire(lockOpts); }
    try { return await runStage(wt, stage, logFile, timeoutMs); } finally { if (perSuite) e2eLock.release(); }
  }
  // Electron processes a failed suite left behind are stopped (by PID, only ones under this worktree) once no other Electron suite is running:
  // with several at once there is no telling whose they are, so the sweep waits for the last one.
  let inFlight = 0;
  let sweepWanted = false;
  const sweep = () => { sweepWanted = false; for (const p of procsUnder(listElectron(), [wt])) killTree(p.pid); };
  const settle = (stage) => { if (stage.kind !== 'electron') return; inFlight--; if (sweepWanted && inFlight === 0) sweep(); };
  function record(stage, logFile, r, status) {
    st.checks[stage.name] = { status, seconds: r.seconds, code: r.ok ? 0 : r.code, log: logFile };
    saveState(wt, st);
    const tag = { pass: 'PASS ', flaky: 'FLAKY', fail: 'FAIL ' }[status];
    say('checks', `${tag} ${stage.name} (${r.seconds}s${r.ok ? '' : `, ${r.code}`})`);
    if (status === 'fail') for (const l of failLines(logFile)) console.log(`            ${l.slice(0, 200)}`);
  }

  // Runs a stage; a failed Electron suite is not retried here (other suites may still be running) but added to `retries`, which the phase works
  // through once everything in it is done: each retried alone on the machine, passing = flaky.
  async function runOne(stage, retries) {
    const prev = st.checks[stage.name];
    if (prev && prev.status !== 'fail') { say('checks', `skip  ${stage.name} (${prev.status} earlier)`); return; }
    const logFile = path.join(st.logs, `${stage.name}.log`);
    const isElectron = stage.kind === 'electron';
    if (isElectron) inFlight++;
    let r;
    try { r = await attempt(stage, logFile); } catch (err) { settle(stage); throw err; }
    if (r.ok) { record(stage, logFile, r, 'pass'); settle(stage); return; }
    if (isElectron) {
      sweepWanted = true;
      say('checks', `FAIL  ${stage.name} (${r.code}); retrying once when the phase is done (alone on the machine)`);
      retries.push({ stage, logFile });
      settle(stage);
      return;
    }
    record(stage, logFile, r, 'fail');
  }
  async function retryOne({ stage, logFile }) {
    const r2 = await attempt(stage, logFile);
    if (r2.ok) record(stage, logFile, r2, 'flaky');
    else { record(stage, logFile, r2, 'fail'); }
    sweep();
  }
  // A lane runs its stages `lane.jobs` at a time, each worker taking the next one in order.
  async function runLane(lane, retries) {
    let next = 0;
    const worker = async () => { while (next < lane.stages.length) await runOne(lane.stages[next++], retries); };
    await Promise.all(Array.from({ length: Math.min(lane.jobs, lane.stages.length) }, worker));
  }

  const t0 = Date.now();
  try {
    for (const lanes of phases) {
      // The lanes of a phase run at once (the pure-node lane beside the Electron lane); the failed Electron suites are retried afterwards, one by one.
      const retries = [];
      await Promise.all(lanes.map((lane) => runLane(lane, retries)));
      if (retries.length) sweep();
      for (const x of retries) await retryOne(x);
    }
  } finally {
    if (lockP) { try { await lockP; } catch { /* never taken */ } }
    freeMachine(); // the lock and the reservation: other sessions' runs may start again
    say('checks', 'released the e2e lock and the release reservation');
  }
  say('checks', `all stages ran in ${Math.round((Date.now() - t0) / 1000)}s`);
  const all = stages.map((s) => ({ name: s.name, ...st.checks[s.name] }));
  const failed = all.filter((x) => x.status === 'fail');
  const flaky = all.filter((x) => x.status === 'flaky');
  const summary = [`checks: ${all.length - failed.length - flaky.length} passed, ${flaky.length} flaky, ${failed.length} failed`, ...(flaky.length ? [`flaky (failed once, passed on retry): ${flaky.map((x) => x.name).join(', ')}`] : []), ...failed.map((x) => `FAILED ${x.name} (${x.code}) ${x.log}`), `logs ${st.logs}`];
  fs.writeFileSync(path.join(st.logs, 'summary.txt'), summary.join('\n') + '\n');
  for (const l of summary) say('summary', l);
  st.flaky = flaky.map((x) => x.name);
  st.suiteCount = all.length;
  if (failed.length) throw new Stop(`${failed.length} check(s) failed: ${failed.map((x) => x.name).join(', ')} (fix, then --resume reruns only those)`);
}

// ----------------------------------------------------------------------------------------------------------------- the stages

// node_modules for the worktree: a junction to the main checkout's when what npm installed there matches this lockfile (saves the npm ci and
// the Electron copy), else npm ci. Never run npm ci through the junction: it would delete the main checkout's packages.
function installDeps(wt, main, opts) {
  const src = path.join(main, 'node_modules', 'electron');
  const mainHasElectron = fs.existsSync(path.join(src, 'dist')) && fs.existsSync(path.join(src, 'path.txt'));
  const target = path.join(wt, 'node_modules');
  if (!opts.freshInstall && mainHasElectron && !fs.existsSync(target)) {
    let verdict = { ok: false, reason: 'no readable lockfile' };
    try { verdict = nodeModulesMatch(JSON.parse(fs.readFileSync(path.join(main, 'node_modules', '.package-lock.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(wt, 'package-lock.json'), 'utf8'))); } catch { /* fall back to npm ci */ }
    if (verdict.ok) {
      fs.symlinkSync(path.join(main, 'node_modules'), target, 'junction');
      say('install', `node_modules is a junction to the main checkout's (${verdict.reason}); no npm ci`);
      return;
    }
    say('install', `not reusing the main checkout's node_modules: ${verdict.reason}`);
  }
  say('install', 'npm ci --ignore-scripts');
  must(run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: wt }), 'npm ci');
  if (!mainHasElectron) throw new Stop(`the main checkout has no Electron download (${src}); run npm install there once`);
  const dst = path.join(wt, 'node_modules', 'electron');
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(src, 'path.txt'), path.join(dst, 'path.txt'));
  say('install', 'copied electron/dist and path.txt from the main checkout');
}

// Removes the node_modules junction (the link only, never what it points at).
function dropJunction(wt) {
  const target = path.join(wt, 'node_modules');
  try { if (fs.lstatSync(target).isSymbolicLink()) { fs.unlinkSync(target); say('cleanup', 'removed the node_modules junction'); } } catch { /* none */ }
}

// Versions whose tag was pushed but whose release never published (release.yml failed after the tag): their notes move to the next version.
// -> { burned: [versions], newest: the newest published tag or null }
async function findBurnedVersions(wt, text) {
  try {
    const refs = must(await gitRetry(wt, ['ls-remote', '--tags', 'origin', 'v*'], { log: (m) => say('prepare', m) }), 'git ls-remote');
    const tags = refs.split('\n').map((l) => /refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(l.trim())).filter(Boolean).map((m) => m[1]);
    const rel = await ghJsonRetry(wt, ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft'], { tries: NET_TRIES, log: (m) => say('prepare', m) });
    const published = rel.filter((r) => !r.isDraft).map((r) => r.tagName);
    const newest = published.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => compareVersions(a.slice(1), b.slice(1))).pop() || null;
    return { burned: findBurned({ changelogText: text, tags, published }), newest };
  } catch (err) {
    say('prepare', `could not check for burned versions (${err.message.slice(0, 100)}); folding nothing`);
    return { burned: [], newest: null };
  }
}

async function prepare(wt, version, st) {
  const file = path.join(wt, 'CHANGELOG.md');
  let text = fs.readFileSync(file, 'utf8');
  const { burned, newest } = await findBurnedVersions(wt, text);
  if (newest) st.baseTag = newest;
  if (burned.length) {
    try {
      const f = foldBurned(text, burned);
      text = f.text;
      st.folded = f.folded;
      say('prepare', `${f.folded.join(', ')} was tagged but never published: its notes move into ${version}`);
    } catch (err) { throw new Stop(err.message); }
  }
  let cut;
  try { cut = cutChangelog(text, version, localDate()); } catch (err) { throw new Stop(err.message); }
  fs.writeFileSync(file, cut);
  must(run('npm', ['version', version, '--no-git-tag-version'], { cwd: wt }), 'npm version');
  must(run(process.execPath, ['--check', 'src/main.js'], { cwd: wt }), 'node --check src/main.js');
  must(git(wt, 'commit', '-qam', `Release ${version}\n\nCo-Authored-By: ${CO_AUTHOR}`), 'git commit');
  say('prepare', `CHANGELOG cut and version ${version} committed; the section:`);
  for (const l of changelogSection(cut, version).split('\n').filter(Boolean)) console.log(`    ${l.slice(0, 100)}`);
}

function releaseBody(wt, version, st) {
  const tag = st.baseTag || git(wt, 'describe', '--tags', '--abbrev=0', 'origin/main').stdout;
  const since = (st.selection && st.selection.base) || tag; // what the last release built (its tag may hold more)
  const subjects = since ? git(wt, 'log', '--no-merges', '--format=%s', `${since}..origin/main`).stdout.split('\n').filter((s) => s && !/^Release \d/.test(s)) : [];
  const lines = [`Release ${version}: version bump, and Unreleased becomes the ${version} section.`, ''];
  if (st.folded && st.folded.length) lines.push(`${st.folded.join(', ')} was tagged but never published (its build failed after the tag), so its notes are folded into ${version}.`, '');
  if (subjects.length) lines.push(`Included since ${tag}:`, ...subjects.map((s) => `- ${s}`), '');
  lines.push(`Release checks (scripts/release/release.js) ran hidden, each suite with its own profile and TEMP: ${st.suiteCount} stages (${st.only ? (st.selection ? `the core set and the suites related to the changes since ${st.selection.tag}: units, acceptance, lint, perf-budget and ${st.only.join(', ')}` : `a targeted set: units, acceptance, lint, perf-budget and ${st.only.join(', ')}`) : 'every Electron suite, units, acceptance, lint'}). All pass.${st.flaky && st.flaky.length ? ` Flaky (failed once, passed on retry): ${st.flaky.join(', ')}.` : ''}`);
  if (st.preflight) lines.push('', `The Windows and macOS build was pre-flighted on this branch (release.yml, workflow_dispatch${st.preflight.url ? `: ${st.preflight.url}` : ''}); the tag publishes those artifacts when the tagged tree is identical.`);
  lines.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- the build preflight (release.yml, dispatched)

const runJson = (wt, ...extra) => ghJsonRetry(wt, ['run', ...extra], { tries: NET_TRIES, log: (m) => say('preflight', m) });
const REMOTE_HEAD = (wt, branch, sha) => () => { const r = git(wt, 'ls-remote', 'origin', `refs/heads/${branch}`); return r.status === 0 && r.stdout.startsWith(sha) ? { status: 0, stdout: '' } : null; };

// Finds the dispatched run of release.yml for the release commit and records its id and URL.
async function findPreflightRun(wt, st) {
  const runs = await runJson(wt, 'list', '--workflow', 'release.yml', '--branch', st.branch, '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId,headSha,createdAt,status,conclusion,url');
  const r = pickPreflightRun(runs, { sha: st.preflight.sha, notBeforeMs: st.preflight.dispatchedAt });
  if (r) { st.preflight.runId = r.databaseId; st.preflight.url = r.url; }
  return r;
}

// Pushes the release branch and dispatches release.yml on it: the Windows and macOS build and their tests, publishing nothing (publish is tags only).
// Idempotent: a run already started for this commit that has not failed is kept (--resume), a failed one is dispatched again.
async function startPreflight(wt, st, log) {
  const head = must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse');
  if (st.preflight && st.preflight.sha === head) {
    if (!st.preflight.runId) await findPreflightRun(wt, st);
    if (st.preflight.runId) {
      const r = await runJson(wt, 'view', String(st.preflight.runId), '--json', 'status,conclusion,url');
      if (runVerdict(r) !== 'failed') { saveState(wt, st); log(`build preflight already running: ${st.preflight.url}`); return; }
      log(`the earlier build preflight ${r.conclusion}; dispatching a new one`);
    }
  }
  must(await gitRetry(wt, ['push', '-q', '-u', 'origin', st.branch], { recheck: REMOTE_HEAD(wt, st.branch, head), log }), 'git push');
  const dispatchedAt = Date.now();
  st.preflight = { sha: head, dispatchedAt, runId: null, url: null };
  const seen = async () => ((await findPreflightRun(wt, st)) ? { status: 0, stdout: '' } : null); // a dispatch that went through despite the error
  must(await ghRetry(wt, ['workflow', 'run', 'release.yml', '--ref', st.branch], { tries: NET_TRIES, recheck: seen, log }), 'gh workflow run release.yml');
  for (let i = 0; i < 40 && !st.preflight.runId; i++) { await findPreflightRun(wt, st); if (!st.preflight.runId) await sleep(3000); }
  saveState(wt, st);
  log(st.preflight.runId ? `build preflight dispatched on ${head.slice(0, 8)}: ${st.preflight.url}` : 'build preflight dispatched (its run has not shown up yet; it is looked for again at the CI stage)');
}

async function cancelPreflight(wt, st) {
  if (!st.preflight || !st.preflight.runId) return;
  const r = gh(wt, 'run', 'cancel', String(st.preflight.runId));
  say('preflight', r.status === 0 ? `cancelled the build preflight ${st.preflight.url}` : 'the build preflight was not cancelled (already finished?)');
}

// Can the CI wait on the release PR be skipped? See ciSkipVerdict (release-lib.js): only when the commit is mechanically the release and its base passed CI.
async function decideCiSkip(wt, st, version, opts, head = st.head) {
  if (opts.noSkipCi) return { skip: false, reasons: ['--no-skip-ci'] };
  const base = must(git(wt, 'merge-base', 'origin/main', head), 'git merge-base');
  const files = must(git(wt, 'diff', '--name-only', base, head), 'git diff').split('\n').filter(Boolean);
  const show = (rev, f) => { const r = git(wt, 'show', `${rev}:${f}`); return r.status === 0 ? r.out : null; };
  const texts = (rev) => ({ changelog: show(rev, 'CHANGELOG.md'), package: show(rev, 'package.json'), lock: show(rev, 'package-lock.json') });
  const runs = await ghJsonRetry(wt, ['run', 'list', '--workflow', 'ci.yml', '--commit', base, '--json', 'status,conclusion'], { tries: NET_TRIES, log: (m) => say('ci', m) });
  const baseCi = runs.some((r) => r.status === 'completed' && r.conclusion === 'success') ? 'success' : (runs[0] ? runs[0].conclusion || runs[0].status : '');
  const v = ciSkipVerdict({ files, version, base: texts(base), head: texts(head), baseCi });
  st.ciBase = base;
  return v;
}

// The gate before the merge: CI on the PR (unless verified skippable) and the build preflight, polled together.
async function waitGates(wt, st, version, opts, head = st.head) {
  const verdict = await decideCiSkip(wt, st, version, opts, head);
  st.skipCi = verdict.skip;
  saveState(wt, st);
  if (verdict.skip) say('ci', `not waiting for the PR's CI: ${verdict.reasons.join('; ')}`);
  else say('ci', `waiting for CI on ${head.slice(0, 8)}${opts.noSkipCi ? '' : ` (cannot skip: ${verdict.reasons.join('; ')})`}`);
  const t0 = Date.now();
  let last = '';
  let blind = 0;
  const ciMs = st.ciMinutes * 60000;
  const pfMs = (opts.preflightMinutes || 45) * 60000;
  for (;;) {
    let ciOk = true;
    let pfOk = true;
    let line = '';
    try {
      if (!verdict.skip) {
        const s = await ciState(wt, head, { log: (m) => say('ci', m) });
        if (s.state === 'failed') throw new Stop(`CI failed on ${head.slice(0, 8)}: ${s.bad.workflowName} (${s.bad.conclusion}) ${s.bad.url}`);
        if (s.state === 'none' && Date.now() - t0 > 10 * 60000) throw new Stop(`no CI run appeared for ${head.slice(0, 8)} after 10 min`);
        ciOk = s.state === 'success';
        line += ciOk ? 'CI passed' : s.state === 'none' ? 'CI not started' : 'CI running';
      }
      if (st.preflight) {
        if (!st.preflight.runId) await findPreflightRun(wt, st);
        if (!st.preflight.runId) {
          pfOk = false;
          line += `${line ? '; ' : ''}build preflight not found yet`;
          if (Date.now() - t0 > 10 * 60000) throw new Stop('the dispatched release.yml run never appeared');
        } else {
          const r = await runJson(wt, 'view', String(st.preflight.runId), '--json', 'status,conclusion,url');
          const v = runVerdict(r);
          if (v === 'failed') throw new Stop(`the build preflight ${r.conclusion}: ${r.url}\nNothing was tagged, so no version is burned. Fix it, then --resume dispatches it again.`);
          pfOk = v === 'passed';
          line += `${line ? '; ' : ''}build preflight ${pfOk ? 'passed' : 'running'}`;
        }
      }
      blind = 0;
    } catch (err) {
      if (!(err instanceof Stop) || /^CI failed|^the build preflight|^no CI run|never appeared/.test(err.message) || ++blind > 10) throw err;
      say('ci', `could not read GitHub (${err.message.slice(0, 80)}); polling again (${blind} of 10)`);
      await sleep(20000);
      continue;
    }
    if (ciOk && pfOk) { say('ci', line || 'nothing to wait for'); break; }
    if (line !== last) { say('ci', line); last = line; }
    if (!ciOk && Date.now() - t0 > ciMs) throw new Stop(`CI still not green after ${st.ciMinutes} min`);
    if (!pfOk && Date.now() - t0 > pfMs) throw new Stop(`the build preflight is still running after ${Math.round(pfMs / 60000)} min: ${st.preflight.url}`);
    await sleep(20000);
  }
}

async function ship(wt, st, version, opts) {
  const branch = st.branch;
  const log = (step) => (m) => say(step, m);
  // Idempotent: dispatches for a checks-only run or a release started before the early dispatch existed, and again when the earlier run was cancelled or failed.
  if (!opts.noPreflight && !done(st, 'ci')) await startPreflight(wt, st, log('preflight'));
  if (!done(st, 'pr')) {
    must(await gitRetry(wt, ['push', '-q', '-u', 'origin', branch], { recheck: REMOTE_HEAD(wt, branch, must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse')), log: log('pr') }), 'git push');
    const bodyFile = path.join(st.logs, 'pr-body.md');
    fs.writeFileSync(bodyFile, releaseBody(wt, version, st));
    const existing = () => { const j = gh(wt, 'pr', 'view', branch, '--json', 'url'); try { return j.status === 0 ? { status: 0, stdout: JSON.parse(j.stdout).url } : null; } catch { return null; } };
    const url = must(await ghRetry(wt, ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body-file', bodyFile], { tries: NET_TRIES, recheck: existing, log: (m) => say('pr', m) }), 'gh pr create');
    st.pr = Number(url.trim().split('/').pop());
    st.head = must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse');
    st.stage = 'pr'; saveState(wt, st);
    say('pr', `release PR #${st.pr} ${url.trim()}`);
  }
  if (!done(st, 'ci')) {
    await waitGates(wt, st, version, opts);
    st.stage = 'ci'; saveState(wt, st);
    say('ci', 'gates passed');
  }
  if (!done(st, 'merge')) {
    // Main may have moved while the checks ran (a PR merged). A squash onto it would put code no check ran on into the tagged tree, and GitHub's
    // own CHANGELOG merge filed the new PR's bullets under the release (0.5.115 took #1124's). Instead the branch takes main in (mergeMainInto:
    // the version section stays the pre-flighted head's, the new bullets stay under Unreleased), CI runs on that, and the PR is merged with a merge
    // commit, so the pre-flighted head stays in main's history and is what gets tagged.
    let prHead = (st.sync && st.sync.sha) || st.head;
    for (let syncs = 0; ;) {
      must(await gitRetry(wt, ['fetch', '-q', 'origin'], { log: log('merge') }), 'git fetch');
      // A merge of main pushed by hand (after the Stop below): take it, once its version section is still the pre-flighted head's.
      const pushed = git(wt, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${st.branch}`).stdout;
      if (pushed && pushed !== prHead && contains(wt, pushed, prHead)) {
        const sectionOf = (rev) => changelogSection(git(wt, 'show', `${rev}:CHANGELOG.md`).out, version);
        if (sectionOf(pushed) !== sectionOf(st.head)) throw new Stop(`${st.branch} on origin (${pushed.slice(0, 8)}) changes the ${version} section of CHANGELOG.md; it must stay the pre-flighted head's`);
        prHead = pushed;
        st.sync = { sha: pushed, main: null, kept: [], gated: false, byHand: true }; saveState(wt, st);
        say('merge', `${st.branch} on origin moved to ${pushed.slice(0, 8)} (a merge of main by hand): merging that`);
      }
      if (contains(wt, prHead, 'origin/main')) {
        if (!st.sync || st.sync.gated) break;
        await waitGates(wt, st, version, opts, prHead); // CI on the merge of main (kept across --resume), then main is looked at again
        st.sync.gated = true; saveState(wt, st);
        continue;
      }
      if (++syncs > 3) throw new Stop(`main keeps moving (merged into ${st.branch} 3 times); --resume tries again`);
      const main = must(git(wt, 'rev-parse', 'origin/main'), 'git rev-parse');
      let s;
      try { s = mergeMainInto(wt, { head: prHead, main, version, message: `Merge main into the ${version} release\n\nPRs merged while the release ran stay under Unreleased: ${version} ships the pre-flighted head ${st.head.slice(0, 8)}.\n\nCo-Authored-By: ${CO_AUTHOR}` }); } catch (err) {
        throw new Stop(`main moved during the release, and ${err.message}. Merge origin/main into ${st.branch} by hand (the ${version} section unchanged, new bullets under Unreleased), push, then --resume.`);
      }
      must(await gitRetry(wt, ['push', '-q', '--force-with-lease', 'origin', `${s.sha}:refs/heads/${st.branch}`], { recheck: REMOTE_HEAD(wt, st.branch, s.sha), log: log('merge') }), 'git push');
      if (git(wt, 'merge', '-q', '--ff-only', s.sha).status !== 0) say('merge', `(the worktree stays at ${prHead.slice(0, 8)}; the branch on origin is ${s.sha.slice(0, 8)})`);
      prHead = s.sha;
      st.sync = { sha: s.sha, main, kept: s.kept, gated: false }; saveState(wt, st);
      say('merge', `main moved during the release: merged it into ${st.branch} as ${s.sha.slice(0, 8)}; ${s.kept.length} new bullet(s) stay under Unreleased${s.kept.length ? `:\n    ${s.kept.map((l) => l.slice(0, 100)).join('\n    ')}` : ''}`);
    }
    // A transient error may hit after GitHub merged: before each retry, an already-merged PR counts as success.
    const merged = () => { const j = gh(wt, 'pr', 'view', String(st.pr), '--json', 'state'); try { return j.status === 0 && JSON.parse(j.stdout).state === 'MERGED' ? { status: 0, stdout: '' } : null; } catch { return null; } };
    must(await ghRetry(wt, ['pr', 'merge', String(st.pr), st.sync ? '--merge' : '--squash', '--match-head-commit', prHead], { tries: NET_TRIES, recheck: merged, log: (m) => say('merge', m) }), 'gh pr merge');
    must(await gitRetry(wt, ['fetch', '-q', 'origin'], { log: log('merge') }), 'git fetch');
    st.mergeSha = (await ghJsonRetry(wt, ['pr', 'view', String(st.pr), '--json', 'mergeCommit'], { tries: NET_TRIES, log: (m) => say('merge', m) })).mergeCommit.oid;
    st.stage = 'merge'; saveState(wt, st);
    say('merge', `${st.sync ? 'merged (merge commit)' : 'squash-merged'} as ${st.mergeSha.slice(0, 8)}`);
    // Main moving again in the seconds before the merge is left to GitHub's merge: say so when it changed the CHANGELOG section.
    const sectionAt = (rev) => { const r = git(wt, 'show', `${rev}:CHANGELOG.md`); return r.status === 0 ? changelogSection(r.out, version) : null; };
    if (sectionAt(st.mergeSha) !== sectionAt(st.head)) say('merge', `WARNING: main moved again just before the merge and the ${version} section on main differs from the pre-flighted head's; the tag and its notes use the head's. Move any extra bullets on main back under Unreleased.`);
  }
  // The tag goes on a commit with the pre-flighted tree (see tagTarget), so the tag run publishes the preflight's artifacts and the notes are its CHANGELOG.
  const treeOf = (rev) => git(wt, 'rev-parse', `${rev}^{tree}`).stdout;
  const target = tagTarget({ head: st.head, mergeSha: st.mergeSha, sameTree: Boolean(st.mergeSha && treeOf(st.mergeSha) && treeOf(st.mergeSha) === treeOf(st.head)), headOnMain: Boolean(st.mergeSha) && contains(wt, st.mergeSha, st.head) });
  st.tagSha = target.sha;
  st.reuse = Boolean(st.preflight && st.preflight.runId);
  say('merge', `the tag goes on ${target.sha.slice(0, 8)}: ${target.why}; ${st.reuse ? 'the tag run will publish the pre-flighted artifacts' : 'no build preflight: the tag run builds that tree'}`);
  if (!done(st, 'tag')) {
    const tag = `v${version}`;
    const have = git(wt, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`);
    if (have.status !== 0) must(git(wt, 'tag', '-a', tag, '-m', releaseTagMessage(version, st.head), target.sha), 'git tag');
    else if (have.stdout !== target.sha) throw new Stop(`local tag ${tag} points at ${have.stdout.slice(0, 8)}, not ${target.sha.slice(0, 8)}`);
    const onRemote = () => { const r = git(wt, 'ls-remote', '--tags', 'origin', tag); return r.status === 0 && r.stdout ? { status: 0, stdout: '' } : null; };
    must(await gitRetry(wt, ['push', '-q', 'origin', tag], { recheck: onRemote, log: log('tag') }), 'git push tag');
    st.stage = 'tag'; saveState(wt, st);
    say('tag', `${tag} (annotated, Release-Head ${st.head.slice(0, 8)}) on ${target.sha.slice(0, 8)}, pushed`);
  }
  if (!done(st, 'publish')) {
    const tag = `v${version}`;
    say('publish', st.reuse ? 'waiting for release.yml on the tag (publishing the pre-flighted artifacts)' : 'waiting for release.yml on the tag');
    const t0 = Date.now();
    for (;;) {
      const runs = await ghJsonRetry(wt, ['run', 'list', '--workflow', 'release.yml', '--branch', tag, '--json', 'status,conclusion,url'], { tries: NET_TRIES, log: (m) => say('publish', m) });
      const r = runs && runs[0];
      if (r && r.status === 'completed') {
        if (r.conclusion !== 'success') throw new Stop(`release.yml ${r.conclusion}: ${r.url}`);
        break;
      }
      if (!r && Date.now() - t0 > 10 * 60000) throw new Stop('release.yml did not start within 10 min of the tag');
      if (Date.now() - t0 > 120 * 60000) throw new Stop('release.yml still running after 2 h');
      await sleep(st.reuse ? 15000 : 30000);
    }
    const assets = await ghJsonRetry(wt, ['release', 'view', tag, '--json', 'assets,url'], { tries: NET_TRIES, log: (m) => say('publish', m) });
    if (assets.assets.length !== st.assets) throw new Stop(`release ${tag} has ${assets.assets.length} assets, expected ${st.assets}: ${assets.url}`);
    st.stage = 'publish'; saveState(wt, st);
    say('publish', `${assets.assets.length} assets: ${assets.url}`);
  }
}

// ------------------------------------------------------------------------------------------------------------- dry run

function dryRun(main, spec, opts) {
  const have = git(main, 'rev-parse', '-q', '--verify', 'origin/main').status === 0;
  if (!have) throw new Stop('no origin/main here (git fetch first)');
  const show = (f) => must(git(main, 'show', `origin/main:${f}`), `git show origin/main:${f}`);
  const current = JSON.parse(show('package.json')).version;
  const resumable = opts.resume ? releaseWorktrees(main).filter((w) => w.state.stage !== 'publish') : [];
  const version = opts.resume && resumable.length ? resumable[resumable.length - 1].state.version : bumpVersion(current, spec);
  const wt = path.join(worktreesDir(main), `release-${version}`);
  const { stages, derived, sources, shared } = planChecks(show, () => must(git(main, 'ls-tree', '--name-only', 'origin/main', 'test/units/', 'test/e2e/'), 'git ls-tree').split('\n').filter((f) => f.endsWith('.js')).map((f) => path.basename(f, '.js')));
  let only = opts.full ? null : opts.only;
  let selectionNote = 'every Electron suite (--full)';
  let why = null;
  if (!only && !opts.full) {
    const ch = changedSinceTag(main, null, 'origin/main');
    const pick = ch && !ch.unknown ? pickSuites(ch, derived, sources) : null;
    if (pick && !pick.full) { only = pick.names; why = pick.reasons; selectionNote = `the core set plus suites related to the ${ch.files.length} files changed since ${sinceText(ch)}: ${pick.names.length} of ${derived.electron.length} Electron suites (--full runs all)`; }
    else selectionNote = !ch ? 'every Electron suite (no release tag to compare with)' : ch.unknown ? `every Electron suite (${unknownText(ch)})` : `every Electron suite (a build, dependency or workflow file changed since ${sinceText(ch)})`;
  } else if (only) selectionNote = `--only: ${only.length} named Electron suites`;
  const kept = only ? stages.filter((x) => x.kind === 'plain' || x.name === 'perf-budget' || only.includes(x.name)) : stages;
  const ej = opts.serialChecks ? 1 : pickElectronJobs(opts);
  const phases = planLanes(kept, { serial: opts.serialChecks, electronJobs: ej, exclusive: (n) => Boolean(shared[n]) });
  say('plan', `origin/main (as last fetched) is ${current}; releasing ${version} (${spec}), worktree ${wt}`);
  if (!opts.resume && fs.existsSync(wt)) say('plan', `${wt} already exists: a fresh run checks it belongs to an unpublished, stopped run of ${version} and removes it with its branches (release-leftover.js), else STOPs (use --resume to continue it instead)`);
  if (opts.resume) say('plan', resumable.length ? `--resume would continue ${resumable[resumable.length - 1].branch} after stage "${resumable[resumable.length - 1].state.stage}" (stages left: ${stagesLeft(resumable[resumable.length - 1].state, opts).join(', ') || 'none'}; the build preflight is checked again before the PR, never trusted blindly)` : '--resume found no unfinished release; it would stop');
  const stale = procsUnder(listElectron(), [main]);
  const b = e2eLock.blocker();
  const lockNote = b && e2eLock.pidAlive(b.pid) ? `the e2e lock is ${b.release ? 'reserved' : 'held'} by ${b.name} (pid ${b.pid}): would wait for it (up to ${opts.lockWaitMinutes} min), then check again` : 'the e2e lock is free';
  say('plan', `0. preflight: refuse if another release is mid-run; ${lockNote}; ${opts.holdLock ? 'reserve the machine and hold the e2e lock until the checks end' : '--share-machine: no reservation, the lock per Electron suite'}; then electron under the repo that no lock accounts for: ${stale.length ? `${stale.length} now: ${stale.map((p) => p.pid).join(', ')} (${opts.killStale ? 'would be stopped by PID' : 'would STOP the run unless they belong to the run waited for; --kill-stale stops them'})` : 'none now'}`);
  const plan = releasePlan({ version, date: localDate(), opts, counts: { stages: kept.length, electronJobs: ej } });
  let n = 0;
  for (const s of plan) say('plan', s.parallel ? `   | ${s.id}: ${s.text}` : `${++n}. ${s.id}: ${s.text}`);
  say('plan', `   selection: ${selectionNote}`);
  if (why) for (const [name, reason] of Object.entries(why)) if (reason !== 'core') say('plan', `      ${name}: ${reason}`);
  say('plan', `   checks lanes: ${phases.map((lanes) => lanes.map((l) => `[${l.stages.map((s) => s.name).slice(0, 3).join(', ')}${l.stages.length > 3 ? `, ... ${l.stages.length} in all` : ''}${l.jobs > 1 ? `; ${l.jobs} at a time` : ''}]`).join(' + ')).join('  then  ')}`);
  const aloneNames = Object.keys(shared).filter((n) => kept.some((x) => x.name === n));
  if (ej > 1 && aloneNames.length) say('plan', `   run alone (shared port, clipboard or machine): ${aloneNames.map((n) => `${n} (${shared[n].join(', ')})`).join('; ')}`);
  say('plan', `   units: --jobs ${unitJobs({ cpus: os.cpus().length, withElectron: !opts.serialChecks && derived.electron.length > 0, electronJobs: ej })}; each stage has its own TEMP and CLAUDE_BROWSER_PROFILE, LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1, ${opts.suiteMinutes} min timeout, a log per suite; an Electron suite that fails is retried once, alone on the machine, after its phase (passing = flaky, reported, not blocking)`);
  if (derived.missing.length) say('plan', `   in test-all.js but no file (skipped): ${derived.missing.join(', ')}`);
  say('plan', `   not run (not in test-all.js, need network/keys/manual): ${derived.manual.length} file(s)`);
  say('plan', 'network steps (git fetch/push/ls-remote, every gh call) retry up to 5 times with 2 s, 4 s, 8 s, 16 s backoff, and polls tolerate a dropped connection for several minutes');
  say('dry-run', 'nothing was fetched, created, stopped, pushed, dispatched or tagged');
}

// ------------------------------------------------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, checksOnly: false, resume: false, killStale: false, holdLock: true, suiteMinutes: 15, ciMinutes: 40, preflightMinutes: 45, assets: 13, only: null, noPreflight: false, noSkipCi: false, serialChecks: false, freshInstall: false, electronJobs: 0, full: false, lockWaitMinutes: 240 };
  let spec = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--checks-only') opts.checksOnly = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--kill-stale') opts.killStale = true;
    else if (a === '--hold-lock') opts.holdLock = true;
    else if (a === '--share-machine') opts.holdLock = false;
    else if (a === '--no-preflight') opts.noPreflight = true;
    else if (a === '--no-skip-ci') opts.noSkipCi = true;
    else if (a === '--serial-checks') opts.serialChecks = true;
    else if (a === '--fresh-install') opts.freshInstall = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--electron-jobs') { opts.electronJobs = Math.floor(Number(args[++i])); if (!(opts.electronJobs >= 1 && opts.electronJobs <= 8)) { console.error('--electron-jobs takes a number from 1 to 8'); process.exit(2); } }
    else if (a === '--lock-wait') opts.lockWaitMinutes = Number(args[++i]) || 240;
    else if (a === '--suite-timeout') opts.suiteMinutes = Number(args[++i]) || 15;
    else if (a === '--ci-timeout') opts.ciMinutes = Number(args[++i]) || 40;
    else if (a === '--preflight-timeout') opts.preflightMinutes = Number(args[++i]) || 45;
    else if (a === '--assets') opts.assets = Number(args[++i]) || 13;
    else if (a === '--only') opts.only = String(args[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (!a.startsWith('-') && !spec) spec = a;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!spec && !opts.resume) { console.error('usage: node scripts/release/release.js <X.Y.Z|patch|minor|major> [--dry-run] [--checks-only] [--resume] [--kill-stale] [--lock-wait min] [--hold-lock|--share-machine] [--only suite,suite] [--no-preflight] [--no-skip-ci] [--serial-checks] [--electron-jobs n] [--full] [--fresh-install]'); process.exit(2); }
  const main = mainCheckout(process.cwd());
  if (opts.dryRun) return dryRun(main, spec || 'patch', opts);

  let wt;
  let st = null;
  let version;
  if (opts.resume) {
    const open = releaseWorktrees(main).filter((w) => w.state.stage !== 'publish' && (!spec || w.state.version === spec || spec === 'patch' || spec === 'minor' || spec === 'major'));
    if (!open.length) throw new Stop('nothing to resume: no unfinished release worktree');
    const pick = open[open.length - 1];
    wt = pick.dir; st = pick.state; version = st.version;
    say('resume', `${pick.branch}, last finished stage: ${st.stage}; stages left: ${stagesLeft(st, opts).join(', ') || 'none'}`);
  } else {
    const current = JSON.parse(must(git(main, 'show', 'origin/main:package.json'), 'git show').toString()).version;
    version = bumpVersion(current, spec);
  }
  wt = wt || path.join(worktreesDir(main), `release-${version}`);
  await preflight(main, opts, wt, !st || !done(st, 'checks'), `release-${version}`);

  if (!st) {
    must(await gitRetry(main, ['fetch', '-q', '--tags', 'origin'], { log: (m) => say('worktree', m) }), 'git fetch');
    const current = JSON.parse(must(git(main, 'show', 'origin/main:package.json'), 'git show')).version;
    version = bumpVersion(current, spec);
    wt = path.join(worktreesDir(main), `release-${version}`);
    if (must(await gitRetry(main, ['ls-remote', '--tags', 'origin', `v${version}`], { log: (m) => say('worktree', m) }), 'git ls-remote')) throw new Stop(`tag v${version} already exists on origin`);
    // A stopped earlier run of this version (not resumed) leaves its worktree and branches; they are checked and removed (release-leftover.js).
    const removed = await cleanLeftover(main, version, { log: (m) => say('worktree', m) });
    if (removed.length) say('worktree', `cleaned up a stopped run of ${version}: ${removed.join('; ')}`);
    must(git(main, 'worktree', 'add', '-q', wt, '-b', `release-${version}`, 'origin/main'), 'git worktree add');
    st = { version, branch: `release-${version}`, stage: 'none', pid: process.pid, started: new Date().toISOString(), logs: path.join(os.tmpdir(), `lumen-release-${version}-${Date.now()}`) };
    saveState(wt, st);
    say('worktree', `${wt} from origin/main`);
    st.stage = 'worktree'; saveState(wt, st);
  }
  Object.assign(st, { pid: process.pid, ciMinutes: opts.ciMinutes, assets: opts.assets });
  saveState(wt, st);

  if (!done(st, 'install')) { installDeps(wt, main, opts); st.stage = 'install'; saveState(wt, st); }
  if (!done(st, 'prepare')) { await prepare(wt, version, st); st.stage = 'prepare'; saveState(wt, st); }
  // The build preflight starts now, so it runs alongside the local checks (its cost on this machine is nothing).
  if (!done(st, 'preflight') && !opts.noPreflight && !opts.checksOnly) { await startPreflight(wt, st, (m) => say('preflight', m)); st.stage = 'preflight'; saveState(wt, st); }
  if (!done(st, 'checks')) {
    try { await runChecks(wt, st, opts); } catch (err) { await cancelPreflight(wt, st); throw err; }
    st.stage = 'checks'; saveState(wt, st);
  }
  if (opts.checksOnly) { say('done', `checks passed; --checks-only, so nothing was pushed. Worktree ${wt}; --resume ships it`); return; }
  await ship(wt, st, version, opts);
  dropJunction(wt);
  say('done', `Lumen ${version} released`);
}

main().catch((err) => {
  if (err instanceof Stop) { console.error(`\nSTOP: ${err.message}\n(--resume continues from the last finished stage)`); process.exit(1); }
  console.error(err.stack || err.message);
  process.exit(1);
});

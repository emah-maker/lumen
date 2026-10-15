#!/usr/bin/env node
// Cuts a release: a release worktree from origin/main, the CHANGELOG cut and version bump, every check run hidden, and (only on a
// clean pass) the "Release X.Y.Z" PR, CI, squash-merge, annotated tag on the merge commit, and the release.yml build.
//   node scripts/release.js <X.Y.Z | patch | minor | major> [options]
//   --dry-run        print the plan and the derived suite list; changes nothing (no fetch, worktree, process kill, push or tag)
//   --checks-only    stop after the checks: nothing is pushed
//   --resume         continue the release from the last finished stage (kept in the worktree's git dir)
//   --hold-lock      (default) hold the machine-wide Electron lock (scripts/e2e-lock.js) for the whole checks stage
//   --share-machine  lock per Electron suite instead (retry included), releasing between suites so a parallel agent can run then
//   --kill-stale     stop electron processes left under this repo's worktrees (by PID, only those) before the checks
//   --suite-timeout <minutes> (default 15)   --ci-timeout <minutes> (default 40)   --assets <n> (default 13)
// Never run it while another Lumen test or release is using Electron: it refuses when a release worktree is mid-run.
// Stages and gotchas: docs/releasing.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const e2eLock = require('./e2e-lock');
const { cutChangelog, changelogSection, readSuites, bumpVersion, deriveChecks, procsUnder } = require('./release-lib');
const { Stop, sleep, say, run, must, git, gh, ghRetry, ghJsonRetry, mainCheckout, worktreesDir, listWorktrees, listElectron, killTree, alive, waitForCi } = require('./ship-common');

const STAGES = ['worktree', 'install', 'prepare', 'checks', 'pr', 'ci', 'merge', 'tag', 'publish'];
const CO_AUTHOR = process.env.LUMEN_CO_AUTHOR || 'Claude Opus 5.5 <noreply@anthropic.com>';
const STATE_FILE = 'lumen-release-state.json';

// ----------------------------------------------------------------------------------------------------------------- planning

// The checks for a tree: cheap pure-node stages first, then every Electron suite from test-all.js (perf-budget last).
function planChecks(readFile, listTestFiles) {
  const derived = deriveChecks({ suites: readSuites(readFile('scripts/test-all.js')), files: listTestFiles() });
  const plain = (name, args) => ({ name, kind: 'plain', cmd: process.execPath, args });
  const stages = [
    plain('units', ['scripts/test-units.js']),
    plain('acceptance', ['scripts/test-acceptance.js']),
    plain('lint', ['node_modules/eslint/bin/eslint.js', '.']),
    ...derived.electron.map((s) => ({ name: s, kind: 'electron', cmd: process.execPath, args: [`test/${s}.js`] })),
  ];
  return { stages, derived };
}

const localDate = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function stateFile(wt) { return path.join(must(git(wt, 'rev-parse', '--absolute-git-dir'), 'git rev-parse'), STATE_FILE); }
function loadState(wt) { try { return JSON.parse(fs.readFileSync(stateFile(wt), 'utf8')); } catch { return null; } }
function saveState(wt, st) { fs.writeFileSync(stateFile(wt), JSON.stringify(st, null, 2)); }

// Release worktrees that have a state file: [{ dir, state }].
function releaseWorktrees(main) {
  return listWorktrees(main).filter((w) => /^release-\d/.test(w.branch || '')).map((w) => ({ dir: w.dir, branch: w.branch, state: loadState(w.dir) })).filter((w) => w.state);
}

const done = (st, stage) => STAGES.indexOf(st.stage) >= STAGES.indexOf(stage);

// ----------------------------------------------------------------------------------------------------------------- preflight

async function preflight(main, opts, mine, withElectron = true) {
  const others = releaseWorktrees(main).filter((w) => w.dir !== mine && w.state.stage !== 'publish' && w.state.pid && alive(w.state.pid) && w.state.pid !== process.pid);
  if (others.length) throw new Stop(`another release is running (${others.map((w) => `${w.branch}, pid ${w.state.pid}`).join('; ')})`);
  if (!withElectron) { say('preflight', 'the checks are done: skipping the Electron preflight (other agents may be running tests; only the checks need a quiet machine)'); return; }
  const all = listElectron();
  const stale = procsUnder(all, [main]);
  if (all.length > stale.length) say('preflight', `${all.length - stale.length} electron process(es) outside this repo (an installed Lumen?) are left alone`);
  if (!stale.length) { say('preflight', 'no electron processes under the repo or its worktrees'); return; }
  const short = (p) => `pid ${p.pid} ${path.relative(main, p.exe || '') || p.exe}`;
  say('preflight', `${stale.length} electron process(es) under the repo's worktrees:\n    ${stale.map(short).join('\n    ')}`);
  if (!opts.killStale) throw new Stop('electron is running under the repo (a test or a release may be using it). Close it, or rerun with --kill-stale to stop exactly those PIDs');
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
  let { stages, derived } = planChecks((f) => fs.readFileSync(path.join(wt, f), 'utf8'), () => fs.readdirSync(path.join(wt, 'test')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)));
  // --only a,b,c: a targeted release (the suites a change touches). The pure-node stages and perf-budget always run; the choice is kept
  // in the state file so --resume runs the same set, and the release PR names it.
  const only = opts.only || st.only || null;
  if (only) { st.only = only; saveState(wt, st); stages = stages.filter((x) => x.kind === 'plain' || x.name === 'perf-budget' || only.includes(x.name)); const unknown = only.filter((n) => !derived.electron.includes(n)); if (unknown.length) say('checks', `--only names suites test-all.js does not list (skipped): ${unknown.join(', ')}`); }
  if (derived.missing.length) say('checks', `named in test-all.js but not in test/ (skipped): ${derived.missing.join(', ')}`);
  say('checks', `${stages.length} stages (${derived.electron.length} Electron suites, perf-budget last); logs in ${st.logs}`);
  fs.mkdirSync(st.logs, { recursive: true });
  const timeoutMs = opts.suiteMinutes * 60000;
  st.checks = st.checks || {};
  const owner = `release-${st.version}`;
  const pending = stages.filter((x) => x.kind === 'electron' && !(st.checks[x.name] && st.checks[x.name].status !== 'fail'));
  // The machine-wide Electron lock (docs/releasing.md): the whole checks stage by default, or per suite with --share-machine.
  if (opts.holdLock && pending.length) { say('checks', 'taking the machine-wide Electron lock for the whole checks stage'); await e2eLock.acquire({ owner }); }
  try {
  for (const stage of stages) {
    const prev = st.checks[stage.name];
    if (prev && prev.status !== 'fail') { say('checks', `skip  ${stage.name} (${prev.status} earlier)`); continue; }
    const logFile = path.join(st.logs, `${stage.name}.log`);
    const perSuite = stage.kind === 'electron' && !opts.holdLock;
    if (perSuite) { say('checks', `waiting for the Electron lock for ${stage.name}`); await e2eLock.acquire({ owner }); }
    try {
    let r = await runStage(wt, stage, logFile, timeoutMs);
    let status = r.ok ? 'pass' : 'fail';
    if (!r.ok) {
      const leftover = procsUnder(listElectron(), [wt]);
      for (const p of leftover) killTree(p.pid);
      if (stage.kind === 'electron') {
        say('checks', `FAIL  ${stage.name} (${r.code}); retrying once`);
        const r2 = await runStage(wt, stage, logFile, timeoutMs);
        if (r2.ok) { status = 'flaky'; r = r2; } else { r = r2; for (const p of procsUnder(listElectron(), [wt])) killTree(p.pid); }
      }
    }
    st.checks[stage.name] = { status, seconds: r.seconds, code: r.ok ? 0 : r.code, log: logFile };
    saveState(wt, st);
    const tag = { pass: 'PASS ', flaky: 'FLAKY', fail: 'FAIL ' }[status];
    say('checks', `${tag} ${stage.name} (${r.seconds}s${r.ok ? '' : `, ${r.code}`})`);
    if (status === 'fail') for (const l of failLines(logFile)) console.log(`            ${l.slice(0, 200)}`);
    } finally { if (perSuite) e2eLock.release(); }
  }
  } finally { if (opts.holdLock) e2eLock.release(); }
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

function installDeps(wt, main) {
  say('install', 'npm ci --ignore-scripts');
  must(run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: wt }), 'npm ci');
  const src = path.join(main, 'node_modules', 'electron');
  if (!fs.existsSync(path.join(src, 'dist')) || !fs.existsSync(path.join(src, 'path.txt'))) throw new Stop(`the main checkout has no Electron download (${src}); run npm install there once`);
  const dst = path.join(wt, 'node_modules', 'electron');
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(src, 'path.txt'), path.join(dst, 'path.txt'));
  say('install', 'copied electron/dist and path.txt from the main checkout');
}

function prepare(wt, version) {
  const file = path.join(wt, 'CHANGELOG.md');
  let cut;
  try { cut = cutChangelog(fs.readFileSync(file, 'utf8'), version, localDate()); } catch (err) { throw new Stop(err.message); }
  fs.writeFileSync(file, cut);
  must(run('npm', ['version', version, '--no-git-tag-version'], { cwd: wt }), 'npm version');
  must(run(process.execPath, ['--check', 'src/main.js'], { cwd: wt }), 'node --check src/main.js');
  must(git(wt, 'commit', '-qam', `Release ${version}\n\nCo-Authored-By: ${CO_AUTHOR}`), 'git commit');
  say('prepare', `CHANGELOG cut and version ${version} committed; the section:`);
  for (const l of changelogSection(cut, version).split('\n').filter(Boolean)) console.log(`    ${l.slice(0, 100)}`);
}

function releaseBody(wt, version, st) {
  const tag = git(wt, 'describe', '--tags', '--abbrev=0', 'origin/main').stdout;
  const subjects = tag ? git(wt, 'log', '--no-merges', '--format=%s', `${tag}..origin/main`).stdout.split('\n').filter((s) => s && !/^Release \d/.test(s)) : [];
  const lines = [`Release ${version}: version bump, and Unreleased becomes the ${version} section.`, ''];
  if (subjects.length) lines.push(`Included since ${tag}:`, ...subjects.map((s) => `- ${s}`), '');
  lines.push(`Release checks (scripts/release.js) ran hidden, each suite with its own profile and TEMP: ${st.suiteCount} stages (${st.only ? `a targeted set: units, acceptance, lint, perf-budget and ${st.only.join(', ')}` : 'every Electron suite, units, acceptance, lint'}). All pass.${st.flaky && st.flaky.length ? ` Flaky (failed once, passed on retry): ${st.flaky.join(', ')}.` : ''}`, '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n');
}

async function ship(wt, st, version) {
  const branch = st.branch;
  if (!done(st, 'pr')) {
    must(git(wt, 'push', '-q', '-u', 'origin', branch), 'git push');
    const bodyFile = path.join(st.logs, 'pr-body.md');
    fs.writeFileSync(bodyFile, releaseBody(wt, version, st));
    const existing = () => { const j = gh(wt, 'pr', 'view', branch, '--json', 'url'); try { return j.status === 0 ? { status: 0, stdout: JSON.parse(j.stdout).url } : null; } catch { return null; } };
    const url = must(await ghRetry(wt, ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body-file', bodyFile], { recheck: existing, log: (m) => say('pr', m) }), 'gh pr create');
    st.pr = Number(url.trim().split('/').pop());
    st.head = must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse');
    st.stage = 'pr'; saveState(wt, st);
    say('pr', `release PR #${st.pr} ${url.trim()}`);
  }
  if (!done(st, 'ci')) {
    say('ci', `waiting on ${st.head.slice(0, 8)}`);
    await waitForCi(wt, st.head, { timeoutMs: st.ciMinutes * 60000, log: (m) => say('ci', m) });
    st.stage = 'ci'; saveState(wt, st);
    say('ci', 'passed');
  }
  if (!done(st, 'merge')) {
    // A transient error may hit after GitHub merged: before each retry, an already-merged PR counts as success.
    const merged = () => { const j = gh(wt, 'pr', 'view', String(st.pr), '--json', 'state'); try { return j.status === 0 && JSON.parse(j.stdout).state === 'MERGED' ? { status: 0, stdout: '' } : null; } catch { return null; } };
    must(await ghRetry(wt, ['pr', 'merge', String(st.pr), '--squash', '--match-head-commit', st.head], { recheck: merged, log: (m) => say('merge', m) }), 'gh pr merge');
    git(wt, 'fetch', '-q', 'origin');
    st.mergeSha = (await ghJsonRetry(wt, ['pr', 'view', String(st.pr), '--json', 'mergeCommit'], { log: (m) => say('merge', m) })).mergeCommit.oid;
    st.stage = 'merge'; saveState(wt, st);
    say('merge', `squash-merged as ${st.mergeSha.slice(0, 8)}`);
  }
  if (!done(st, 'tag')) {
    const tag = `v${version}`;
    const have = git(wt, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`);
    if (have.status !== 0) must(git(wt, 'tag', '-a', tag, '-m', `Lumen ${version}`, st.mergeSha), 'git tag');
    else if (have.stdout !== st.mergeSha) throw new Stop(`local tag ${tag} points at ${have.stdout.slice(0, 8)}, not the merge commit ${st.mergeSha.slice(0, 8)}`);
    must(git(wt, 'push', '-q', 'origin', tag), 'git push tag');
    st.stage = 'tag'; saveState(wt, st);
    say('tag', `${tag} (annotated) on the merge commit, pushed`);
  }
  if (!done(st, 'publish')) {
    const tag = `v${version}`;
    say('publish', 'waiting for release.yml on the tag');
    const t0 = Date.now();
    for (;;) {
      const runs = await ghJsonRetry(wt, ['run', 'list', '--workflow', 'release.yml', '--branch', tag, '--json', 'status,conclusion,url'], { log: (m) => say('publish', m) });
      const r = runs && runs[0];
      if (r && r.status === 'completed') {
        if (r.conclusion !== 'success') throw new Stop(`release.yml ${r.conclusion}: ${r.url}`);
        break;
      }
      if (!r && Date.now() - t0 > 10 * 60000) throw new Stop('release.yml did not start within 10 min of the tag');
      if (Date.now() - t0 > 120 * 60000) throw new Stop('release.yml still running after 2 h');
      await sleep(60000);
    }
    const assets = await ghJsonRetry(wt, ['release', 'view', tag, '--json', 'assets,url'], { log: (m) => say('publish', m) });
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
  const { stages, derived } = planChecks(show, () => must(git(main, 'ls-tree', '--name-only', 'origin/main', 'test/'), 'git ls-tree').split('\n').filter((f) => f.endsWith('.js')).map((f) => path.basename(f, '.js')));
  say('plan', `origin/main (as last fetched) is ${current}; releasing ${version} (${spec}), worktree ${wt}`);
  if (!opts.resume && fs.existsSync(wt)) say('plan', `would STOP: ${wt} already exists (a release of ${version} is in progress or unfinished: use --resume, or remove that worktree)`);
  if (opts.resume) say('plan', resumable.length ? `--resume would continue ${resumable[resumable.length - 1].branch} after stage "${resumable[resumable.length - 1].state.stage}"` : '--resume found no unfinished release; it would stop');
  const stale = procsUnder(listElectron(), [main]);
  say('plan', `0. preflight: ${stale.length ? `${stale.length} electron process(es) under the repo: ${stale.map((p) => p.pid).join(', ')} (${opts.killStale ? 'would be stopped by PID' : 'would STOP the run; --kill-stale stops them'})` : 'no electron under the repo'}; refuse if another release is mid-run`);
  say('plan', `1. worktree: git fetch, worktree add release-${version} from origin/main`);
  say('plan', '2. install: npm ci --ignore-scripts, copy node_modules/electron/dist and path.txt from the main checkout');
  say('plan', `3. prepare: CHANGELOG "## Unreleased" -> "## ${version} (${localDate()})" with a fresh empty Unreleased; npm version ${version} --no-git-tag-version; node --check src/main.js; commit "Release ${version}"`);
  say('plan', `4. checks: ${stages.length} stages, each with its own TEMP and CLAUDE_BROWSER_PROFILE, LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1, ${opts.suiteMinutes} min timeout, a log per suite; the Electron lock is ${opts.holdLock ? 'held for the whole stage' : 'taken per suite (--share-machine)'}; an Electron suite that fails is retried once (passing the retry = flaky, reported, not blocking)`);
  say('plan', `   order: ${stages.slice(0, 3).map((s) => s.name).join(', ')}, then ${derived.electron.length} Electron suites from scripts/test-all.js (${derived.electron.slice(0, 4).join(', ')}, ... ${derived.electron.slice(-3).join(', ')})`);
  if (derived.missing.length) say('plan', `   in test-all.js but no file (skipped): ${derived.missing.join(', ')}`);
  say('plan', `   not run (not in test-all.js, need network/keys/manual): ${derived.manual.length} file(s)`);
  if (opts.checksOnly) say('plan', 'stop here (--checks-only): nothing pushed');
  else {
    say('plan', `5. pr: push release-${version}, gh pr create "Release ${version}" (body lists the commits since the last tag and any flaky suites)`);
    say('plan', '6. ci: poll the PR head commit until every run completes; 7. merge: gh pr merge --squash --match-head-commit');
    say('plan', `8. tag: annotated v${version} on the merge commit, pushed; 9. publish: wait for release.yml on the tag, expect ${opts.assets} release assets`);
  }
  say('dry-run', 'nothing was fetched, created, stopped, pushed or tagged');
}

// ------------------------------------------------------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, checksOnly: false, resume: false, killStale: false, holdLock: true, suiteMinutes: 15, ciMinutes: 40, assets: 13, only: null };
  let spec = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--checks-only') opts.checksOnly = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--kill-stale') opts.killStale = true;
    else if (a === '--hold-lock') opts.holdLock = true;
    else if (a === '--share-machine') opts.holdLock = false;
    else if (a === '--suite-timeout') opts.suiteMinutes = Number(args[++i]) || 15;
    else if (a === '--ci-timeout') opts.ciMinutes = Number(args[++i]) || 40;
    else if (a === '--assets') opts.assets = Number(args[++i]) || 13;
    else if (a === '--only') opts.only = String(args[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (!a.startsWith('-') && !spec) spec = a;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!spec && !opts.resume) { console.error('usage: node scripts/release.js <X.Y.Z|patch|minor|major> [--dry-run] [--checks-only] [--resume] [--kill-stale] [--hold-lock|--share-machine] [--only suite,suite]'); process.exit(2); }
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
    say('resume', `${pick.branch}, last finished stage: ${st.stage}`);
  } else {
    const current = JSON.parse(must(git(main, 'show', 'origin/main:package.json'), 'git show').toString()).version;
    version = bumpVersion(current, spec);
  }
  wt = wt || path.join(worktreesDir(main), `release-${version}`);
  await preflight(main, opts, wt, !st || !done(st, 'checks'));

  if (!st) {
    must(git(main, 'fetch', '-q', '--tags', 'origin'), 'git fetch');
    const current = JSON.parse(must(git(main, 'show', 'origin/main:package.json'), 'git show')).version;
    version = bumpVersion(current, spec);
    wt = path.join(worktreesDir(main), `release-${version}`);
    if (fs.existsSync(wt)) throw new Stop(`${wt} exists: use --resume, or remove that worktree`);
    if (must(git(main, 'ls-remote', '--tags', 'origin', `v${version}`), 'git ls-remote')) throw new Stop(`tag v${version} already exists on origin`);
    must(git(main, 'worktree', 'add', '-q', wt, '-b', `release-${version}`, 'origin/main'), 'git worktree add');
    st = { version, branch: `release-${version}`, stage: 'none', pid: process.pid, started: new Date().toISOString(), logs: path.join(os.tmpdir(), `lumen-release-${version}-${Date.now()}`) };
    saveState(wt, st);
    say('worktree', `${wt} from origin/main`);
    st.stage = 'worktree'; saveState(wt, st);
  }
  Object.assign(st, { pid: process.pid, ciMinutes: opts.ciMinutes, assets: opts.assets });
  saveState(wt, st);

  if (!done(st, 'install')) { installDeps(wt, main); st.stage = 'install'; saveState(wt, st); }
  if (!done(st, 'prepare')) { prepare(wt, version); st.stage = 'prepare'; saveState(wt, st); }
  if (!done(st, 'checks')) { await runChecks(wt, st, opts); st.stage = 'checks'; saveState(wt, st); }
  if (opts.checksOnly) { say('done', `checks passed; --checks-only, so nothing was pushed. Worktree ${wt}; --resume ships it`); return; }
  await ship(wt, st, version);
  say('done', `Lumen ${version} released`);
}

main().catch((err) => {
  if (err instanceof Stop) { console.error(`\nSTOP: ${err.message}\n(--resume continues from the last finished stage)`); process.exit(1); }
  console.error(err.stack || err.message);
  process.exit(1);
});

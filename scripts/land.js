#!/usr/bin/env node
// Lands a pull request: merge origin/main into its branch, resolve the files that always conflict, rebuild the generated bundles,
// push, wait for CI on that exact commit, squash-merge. One command, any worktree:
//   node scripts/land.js <pr> [--dry-run]
//   node scripts/land.js --queue <pr> <pr> ...     lands them in order, stops at the first one that cannot land
//   --ci-timeout <minutes>   how long to wait for CI (default 40)     --keep-worktree   do not remove a worktree this script made
// A merge conflict in anything but CHANGELOG.md, scripts/test-all.js and the generated bundles stops it (nothing is pushed).
// --dry-run reads (git fetch, gh pr view, a trial merge in git's object store) and prints the plan: no worktree, push or merge.
// Details and the known gotchas: docs/releasing.md.
const fs = require('fs');
const path = require('path');
const { mergeChangelog, mergeSuiteList, mergeBlocker, lockDecision } = require('./release-lib');
const { Stop, say, run, must, git, gh, ghRetry, ghJsonRetry, gitRetry, NET_TRIES, mainCheckout, worktreesDir, listWorktrees, waitForCi, alive } = require('./ship-common');

const CHANGELOG = 'CHANGELOG.md';
const SUITE_LIST = 'scripts/test-all.js';
const BUNDLES = ['src/renderer/ui.bundle.js', 'src/renderer/ui.bundle.css', 'src/renderer/index.html', 'src/renderer/settings.bundle.js', 'src/renderer/settings.bundle.css', 'src/renderer/settings.html', 'src/preload/preload.bundle.js'];
const RESOLVABLE = [CHANGELOG, SUITE_LIST, ...BUNDLES];
const CO_AUTHOR = process.env.LUMEN_CO_AUTHOR || 'Claude Opus 5.5 <noreply@anthropic.com>';

// Rebuild the generated files from the sources in the work tree.
function rebuildBundles(wt) {
  for (const script of ['scripts/bundle-renderer.js', 'scripts/bundle-preload.js']) {
    if (!fs.existsSync(path.join(wt, script))) continue;
    must(run(process.execPath, [script], { cwd: wt }), `node ${script}`);
  }
}

// The bundles git thinks changed only because of line endings (CRLF churn after a rebuild on Windows): put them back.
function dropBundleChurn(wt) {
  const changed = git(wt, 'diff', '--name-only', '--', ...BUNDLES).stdout.split('\n').filter(Boolean);
  const real = git(wt, 'diff', '--ignore-cr-at-eol', '--name-only', '--', ...BUNDLES).stdout.split('\n').filter(Boolean);
  const churn = changed.filter((f) => !real.includes(f));
  if (churn.length) must(git(wt, 'checkout', '--', ...churn), 'git checkout (bundle line endings)');
  return churn;
}

// Resolve one unmerged text file by merging its three index stages with the same functions the git merge drivers use.
function resolveFromStages(wt, file, merge) {
  const stage = (n) => { const r = git(wt, 'show', `:${n}:${file}`); return r.status === 0 ? r.out : ''; };
  const res = merge(stage(1), stage(2), stage(3));
  if (!res.ok) throw new Stop(`${file}: ${res.conflicts ? `both sides changed ${res.conflicts.join(', ')}` : res.reason}. Resolve by hand`);
  const onDisk = path.join(wt, file);
  const crlf = fs.existsSync(onDisk) && fs.readFileSync(onDisk, 'utf8').includes('\r\n');
  fs.writeFileSync(onDisk, crlf ? res.text.replace(/\r?\n/g, '\r\n') : res.text);
  must(git(wt, 'add', '--', file), `git add ${file}`);
}

function mergeMain(wt, log) {
  const m = git(wt, 'merge', 'origin/main', '--no-edit');
  if (m.status === 0) return /Already up to date/.test(m.stdout) ? 'up to date with main' : 'merged origin/main cleanly';
  const unmerged = git(wt, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
  if (!unmerged.length) { git(wt, 'merge', '--abort'); throw new Stop(`git merge origin/main failed: ${(m.stderr || m.stdout).split('\n').slice(0, 3).join(' | ')}`); }
  const other = unmerged.filter((f) => !RESOLVABLE.includes(f));
  if (other.length) { git(wt, 'merge', '--abort'); throw new Stop(`conflicts beyond CHANGELOG, test-all and the bundles: ${other.join(', ')}. Merge origin/main by hand`); }
  try {
    if (unmerged.includes(CHANGELOG)) { resolveFromStages(wt, CHANGELOG, mergeChangelog); log('resolved CHANGELOG.md (union of the Unreleased bullets)'); }
    if (unmerged.includes(SUITE_LIST)) {
      resolveFromStages(wt, SUITE_LIST, mergeSuiteList);
      must(run(process.execPath, ['--check', SUITE_LIST], { cwd: wt }), `node --check ${SUITE_LIST}`);
      log('resolved scripts/test-all.js (union of the suite list)');
    }
    const bundles = unmerged.filter((f) => BUNDLES.includes(f));
    if (bundles.length) {
      for (const f of bundles) must(git(wt, 'checkout', '--theirs', '--', f), `git checkout --theirs ${f}`);
      rebuildBundles(wt);
      must(git(wt, 'add', '--', ...BUNDLES.filter((f) => fs.existsSync(path.join(wt, f)))), 'git add bundles');
      log(`rebuilt the conflicting generated files (${bundles.length})`);
    }
    must(git(wt, 'commit', '--no-edit', '-q'), 'git commit (merge)');
  } catch (err) {
    git(wt, 'merge', '--abort');
    throw err;
  }
  return 'merged origin/main, conflicts resolved';
}

// A worktree for the PR's head branch: the one already checked out, or a new one under .claude/worktrees/.
function findOrCreateWorktree(main, branch, pr) {
  const have = listWorktrees(main).find((w) => w.branch === branch);
  if (have) return { dir: have.dir, created: false };
  const dir = path.join(worktreesDir(main), `land-${pr}`);
  const local = git(main, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).status === 0;
  if (local) must(git(main, 'worktree', 'add', dir, branch), 'git worktree add');
  else must(git(main, 'worktree', 'add', dir, '-b', branch, '--track', `origin/${branch}`), 'git worktree add');
  return { dir, created: true };
}

function dryRun(main, info, existing) {
  const head = info.headRefName;
  say('plan', `PR #${info.number} "${info.title}": ${head} -> ${info.baseRefName}, state ${info.state}${info.isDraft ? ' (draft)' : ''}`);
  if (info.state !== 'OPEN') say('plan', `would STOP: the PR is ${info.state}, there is nothing to land (the steps below show what a live PR would get)`);
  say('plan', existing ? `1. use the worktree ${existing.dir}` : `1. create a worktree .claude/worktrees/land-${info.number} on ${head} (tracking origin/${head})`);
  say('plan', `2. stop if tracked files are dirty (bundle line-ending churn is reset first); fast-forward to origin/${head}`);
  const mt = git(main, 'merge-tree', '--write-tree', '--name-only', 'origin/main', `origin/${head}`);
  if (mt.status === 0) say('plan', '3. git merge origin/main: no conflicts expected');
  else if (mt.status === 1) {
    const files = mt.stdout.split('\n').slice(1).join('\n').split(/\n\n/)[0].split('\n').filter(Boolean);
    const other = files.filter((f) => !RESOLVABLE.includes(f));
    say('plan', `3. git merge origin/main: conflicts in ${files.join(', ')}`);
    say('plan', other.length ? `   would STOP: ${other.join(', ')} cannot be resolved automatically` : '   all auto-resolvable (CHANGELOG, test-all list, generated bundles)');
  } else say('plan', `3. git merge origin/main: cannot preview (${(mt.stderr || `origin/${head} not found`).split('\n')[0]})`);
  say('plan', '4. rebuild the generated bundles (node scripts/bundle-renderer.js, bundle-preload.js); commit them if the merge changed them');
  say('plan', '5. git push, then wait for CI on the pushed commit (gh run list --commit, polled)');
  say('plan', `6. gh pr merge ${info.number} --squash --match-head-commit <that commit>`);
  say('dry-run', 'nothing was created, pushed or merged');
}

// One land run per PR: a lock file in the git dir holding our PID. A run that was stopped but whose process lives on keeps the lock.
function takeLock(main, pr) {
  const file = path.join(must(git(main, 'rev-parse', '--absolute-git-dir'), 'git rev-parse'), `lumen-land-${pr}.lock`);
  if (fs.existsSync(file)) {
    const d = lockDecision(fs.readFileSync(file, 'utf8'), alive);
    if (d.action === 'busy') throw new Stop(`another land run for #${pr} is active (pid ${d.pid}); stop that process first (lock ${file})`);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } };
}

async function landOne(pr, opts) {
  if (opts.dryRun) return landRun(pr, opts);
  const release = takeLock(mainCheckout(process.cwd()), pr);
  try { await landRun(pr, opts); } finally { release(); }
}

async function landRun(pr, opts) {
  const main = mainCheckout(process.cwd());
  say('pr', `#${pr}`);
  // Every network step retries on a dropped connection or a GitHub 5xx (ship-common.js: NET_TRIES attempts, 2 s, 4 s, 8 s ... between them).
  const log = (step) => (m) => say(step, m);
  must(await gitRetry(main, ['fetch', '-q', 'origin'], { log: log('pr') }), 'git fetch');
  const info = await ghJsonRetry(main, ['pr', 'view', String(pr), '--json', 'number,title,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft'], { tries: NET_TRIES, log: log('pr') });
  const existing = listWorktrees(main).find((w) => w.branch === info.headRefName);
  if (opts.dryRun) return dryRun(main, info, existing);
  if (info.state !== 'OPEN') throw new Stop(`PR #${pr} is ${info.state}`);
  if (info.baseRefName !== 'main') throw new Stop(`PR #${pr} targets ${info.baseRefName}, not main`);
  if (info.isCrossRepository) throw new Stop(`PR #${pr} comes from a fork: this script cannot push to it`);
  if (info.isDraft) throw new Stop(`PR #${pr} is a draft`);
  const branch = info.headRefName;

  const wtInfo = findOrCreateWorktree(main, branch, pr);
  const wt = wtInfo.dir;
  say('worktree', `${wt}${wtInfo.created ? ' (created)' : ''}`);

  const churn = dropBundleChurn(wt);
  if (churn.length) say('worktree', `reset bundle line-ending churn: ${churn.join(', ')}`);
  const dirty = git(wt, 'status', '--porcelain', '--untracked-files=no').stdout;
  if (dirty) throw new Stop(`worktree dirty (commit or discard first):\n${dirty}`);

  const [ahead, behind] = must(git(wt, 'rev-list', '--left-right', '--count', `HEAD...origin/${branch}`), 'git rev-list').split(/\s+/).map(Number);
  if (behind && ahead) throw new Stop(`${branch} has diverged from origin/${branch} (${ahead} ahead, ${behind} behind)`);
  if (behind) { must(git(wt, 'merge', '--ff-only', `origin/${branch}`), 'git merge --ff-only'); say('sync', `fast-forwarded ${behind} commit(s) from origin/${branch}`); }

  say('merge', mergeMain(wt, (m) => say('merge', m)));

  rebuildBundles(wt);
  const churnAfter = dropBundleChurn(wt);
  const real = git(wt, 'diff', '--name-only', '--', ...BUNDLES).stdout.split('\n').filter(Boolean);
  if (real.length) {
    must(git(wt, 'add', '--', ...real), 'git add bundles');
    must(git(wt, 'commit', '-q', '-m', `Rebuild generated bundles after merging main\n\nCo-Authored-By: ${CO_AUTHOR}`), 'git commit (bundles)');
    say('bundles', `rebuilt and committed: ${real.join(', ')}`);
  } else say('bundles', `up to date${churnAfter.length ? ' (line-ending churn reset)' : ''}`);

  const unpushed = Number(must(git(wt, 'rev-list', '--count', `origin/${branch}..HEAD`), 'git rev-list'));
  if (unpushed) {
    // A push that dropped after reaching GitHub counts as done: the remote branch is already at HEAD.
    const pushed = () => { const r = git(wt, 'ls-remote', 'origin', `refs/heads/${branch}`); return r.status === 0 && r.stdout.startsWith(must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse')) ? { status: 0, stdout: '' } : null; };
    must(await gitRetry(wt, ['push', '-q'], { recheck: pushed, log: log('push') }), 'git push');
    say('push', `pushed ${unpushed} commit(s)`);
  } else say('push', 'nothing new to push');
  const sha = must(git(wt, 'rev-parse', 'HEAD'), 'git rev-parse');

  say('ci', `waiting on ${sha.slice(0, 8)}`);
  await waitForCi(wt, sha, { timeoutMs: opts.ciMinutes * 60000, log: (m) => say('ci', m) });
  say('ci', 'passed');

  // Re-read the PR right before merging: it must still be open with the head CI passed on (a commit pushed meanwhile would be lost).
  const mainBefore = must(git(wt, 'rev-parse', 'origin/main'), 'git rev-parse');
  const blocked = mergeBlocker(await ghJsonRetry(wt, ['pr', 'view', String(pr), '--json', 'state,headRefOid'], { tries: NET_TRIES, log: log('merge') }), sha);
  if (blocked) throw new Stop(`not merging #${pr}: ${blocked}`);
  // A transient error may hit after GitHub merged: before each retry, an already-merged PR counts as success.
  const merged = () => { const j = gh(wt, 'pr', 'view', String(pr), '--json', 'state'); try { return j.status === 0 && JSON.parse(j.stdout).state === 'MERGED' ? { status: 0, stdout: '' } : null; } catch { return null; } };
  must(await ghRetry(wt, ['pr', 'merge', String(pr), '--squash', '--match-head-commit', sha], { tries: NET_TRIES, recheck: merged, log: log('merge') }), 'gh pr merge');
  say('merged', `#${pr} squash-merged (head ${sha.slice(0, 8)})`);
  await gitRetry(main, ['fetch', '-q', 'origin'], { log: log('merged') });
  // Verify main now carries what the PR changed: the files the PR touched must match the head's content (unless main moved on since).
  const touched = git(wt, 'diff', '--name-only', mainBefore, sha).stdout.split('\n').filter(Boolean);
  if (touched.length && git(wt, 'diff', '--quiet', sha, 'origin/main', '--', ...touched).status !== 0) {
    const differ = git(wt, 'diff', '--name-only', sha, 'origin/main', '--', ...touched).stdout.split('\n').filter(Boolean);
    console.error(`\n!!!! WARNING: origin/main does not match PR #${pr}'s head ${sha.slice(0, 8)} in: ${differ.slice(0, 10).join(', ')}`);
    console.error('!!!! Either main moved on since, or part of the PR did not land: compare with git diff <head> origin/main -- <file>\n');
  } else say('verify', "origin/main carries the PR head's changes");
  if (wtInfo.created && !opts.keepWorktree) {
    if (git(main, 'worktree', 'remove', wt).status === 0) say('worktree', 'removed the worktree this run created');
  }
}

async function cli() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, keepWorktree: false, ciMinutes: 40, queue: false };
  const prs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--queue') opts.queue = true;
    else if (a === '--keep-worktree') opts.keepWorktree = true;
    else if (a === '--ci-timeout') opts.ciMinutes = Number(args[++i]) || 40;
    else if (/^#?\d+$/.test(a)) prs.push(Number(a.replace('#', '')));
    else { console.error(`unknown argument: ${a}\nusage: node scripts/land.js <pr> [--dry-run] | --queue <pr> <pr> ...`); process.exit(2); }
  }
  if (!prs.length || (prs.length > 1 && !opts.queue)) { console.error('usage: node scripts/land.js <pr> [--dry-run]\n       node scripts/land.js --queue <pr> <pr> ... [--dry-run]'); process.exit(2); }
  for (const pr of prs) {
    try { await landOne(pr, opts); } catch (err) {
      if (!(err instanceof Stop)) throw err;
      console.error(`\nSTOP #${pr}: ${err.message}`);
      if (prs.length > 1) console.error(`not landed: ${prs.slice(prs.indexOf(pr)).join(', ')}`);
      process.exit(1);
    }
  }
}

cli().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

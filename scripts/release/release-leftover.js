// What a stopped release leaves behind, and cleaning it up on a fresh run (not --resume) of the same version: the worktree
// .claude/worktrees/release-X.Y.Z (empty, or still on its old branch), the local branch release-X.Y.Z and the branch on origin (pushed for the
// build preflight). Everything is checked first, and anything that does not look like an unpublished release run of that version stops the run
// instead of being deleted:
//   - the tag vX.Y.Z on origin (a published or burned release: its branch is never deleted),
//   - a release worktree whose state file names another version, or whose release pid is still alive,
//   - a worktree on another branch, a branch checked out somewhere else, a non-empty folder that is not a git worktree,
//   - files changed beyond the release's own (CHANGELOG.md, package.json, package-lock.json), or commits beyond "Release X.Y.Z" and merges,
//   - a pull request from the branch that is open or merged (that release got as far as the PR: --resume it, or close the PR by hand).
// The node_modules junction is unlinked first (the link only: removing the folder through it would delete the main checkout's packages).
const fs = require('fs');
const path = require('path');
const { Stop, git, ghJsonRetry, gitRetry, must, worktreesDir, listWorktrees, alive, NET_TRIES } = require('./ship-common');

const STATE_FILE = 'lumen-release-state.json';
const RELEASE_FILES = new Set(['CHANGELOG.md', 'package.json', 'package-lock.json']);
const RELEASE_SUBJECT = /^Release \d+\.\d+\.\d+$/;

const samePath = (a, b) => { const n = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };

// Commits on `ref` that are not on origin/main and that a release run would not have made (not "Release X.Y.Z", not a merge): their subjects,
// or null when git cannot tell.
function ownCommits(cwd, ref) {
  const r = git(cwd, 'log', '--format=%P%x09%s', `origin/main..${ref}`);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => { const [p, ...s] = l.split('\t'); return { merge: p.trim().split(/\s+/).length > 1, subject: s.join('\t') }; })
    .filter((c) => !c.merge && !RELEASE_SUBJECT.test(c.subject)).map((c) => c.subject);
}

// Files changed in a worktree beyond the release's own edits (node_modules, the junction, never counts).
function strayChanges(wt) {
  const r = git(wt, 'status', '--porcelain', '--untracked-files=all');
  if (r.status !== 0) return null;
  // r.out, not r.stdout: untrimmed, since a status line starts with a space (" M file")
  return r.out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => !/^node_modules(\/|$)/.test(f) && !RELEASE_FILES.has(f));
}

function readState(wt) {
  const gd = git(wt, 'rev-parse', '--absolute-git-dir');
  if (gd.status !== 0) return null;
  try { return JSON.parse(fs.readFileSync(path.join(gd.stdout, STATE_FILE), 'utf8')); } catch { return null; }
}

// Unlinks wt/node_modules when it is a junction or symlink; true when it did.
function unlinkJunction(wt) {
  const target = path.join(wt, 'node_modules');
  try { if (fs.lstatSync(target).isSymbolicLink()) { fs.unlinkSync(target); return true; } } catch { /* none */ }
  return false;
}

// The default remote checks, through git and gh.
const defaultRemote = (main) => ({
  tagExists: async (tag) => Boolean(must(await gitRetry(main, ['ls-remote', '--tags', 'origin', tag]), 'git ls-remote')),
  branchSha: async (branch) => (must(await gitRetry(main, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]), 'git ls-remote').split(/\s+/)[0] || null),
  prs: (branch) => ghJsonRetry(main, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,title', '--limit', '20'], { tries: NET_TRIES }),
});

// Cleans up a stopped release of `version` so a fresh run can start, or throws Stop saying why it will not. -> the list of what it removed.
// remote: { tagExists(tag), branchSha(branch), prs(branch) } (defaults: git ls-remote and gh pr list); log(msg).
async function cleanLeftover(main, version, { remote = {}, log = () => {} } = {}) {
  const r = { ...defaultRemote(main), ...remote };
  const branch = `release-${version}`;
  const wt = path.join(worktreesDir(main), branch);
  const removed = [];
  const localBranch = git(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).status === 0;
  const remoteSha = await r.branchSha(branch);
  if (!fs.existsSync(wt) && !localBranch && !remoteSha) return removed;
  if (await r.tagExists(`v${version}`)) throw new Stop(`tag v${version} already exists on origin: ${version} was released (or burned), so its leftovers stay; release the next version`);

  // 1. Everything is checked before anything is removed, so a refusal leaves the leftovers exactly as they were.
  git(main, 'worktree', 'prune'); // a registered worktree whose folder is gone
  const wts = listWorktrees(main);
  const elsewhere = wts.find((w) => w.branch === branch && !samePath(w.dir, wt));
  if (elsewhere) throw new Stop(`${branch} is checked out in ${elsewhere.dir}; remove that worktree by hand`);
  const why = (list, what) => (list ? list.slice(0, 3).join('; ') : `${what} failed`);
  const hasDir = fs.existsSync(wt);
  const reg = hasDir ? wts.find((w) => samePath(w.dir, wt)) : null;
  if (reg) {
    const st = readState(wt);
    if (st && st.version && st.version !== version) throw new Stop(`${wt} holds a release of ${st.version}, not ${version}; remove it by hand`);
    if (st && st.pid && st.pid !== process.pid && alive(st.pid)) throw new Stop(`${wt} belongs to a release that is still running (pid ${st.pid})`);
    if (reg.branch && reg.branch !== branch) throw new Stop(`${wt} is on branch ${reg.branch}, not ${branch}; remove it by hand`);
    const stray = strayChanges(wt);
    if (stray === null || stray.length) throw new Stop(`${wt} has changes of its own (${why(stray, 'git status')}): --resume it, or remove it by hand`);
    const own = ownCommits(wt, 'HEAD');
    if (own === null || own.length) throw new Stop(`${wt} has commits of its own (${why(own, 'git log')}): --resume it, or remove it by hand`);
  } else if (hasDir) {
    const left = fs.readdirSync(wt).filter((n) => !(n === 'node_modules' && fs.lstatSync(path.join(wt, n)).isSymbolicLink()));
    if (left.length) throw new Stop(`${wt} exists, is not a git worktree and is not empty (${left.slice(0, 5).join(', ')}); remove it by hand`);
  }
  if (localBranch) {
    const own = ownCommits(main, `refs/heads/${branch}`);
    if (own === null || own.length) throw new Stop(`the local branch ${branch} has commits of its own (${why(own, 'git log')}); delete it by hand`);
  }
  if (remoteSha) {
    const prs = (await r.prs(branch)) || [];
    const live = prs.filter((p) => /^(OPEN|MERGED)$/i.test(p.state));
    if (live.length) throw new Stop(`origin/${branch} has ${live.map((p) => `PR #${p.number} (${String(p.state).toLowerCase()})`).join(', ')}: --resume that release, or close the PR by hand`);
    const tmpRef = `refs/lumen-leftover/${branch}`;
    must(await gitRetry(main, ['fetch', '-q', 'origin', `+refs/heads/${branch}:${tmpRef}`]), `git fetch origin ${branch}`);
    const own = ownCommits(main, tmpRef);
    git(main, 'update-ref', '-d', tmpRef);
    if (own === null || own.length) throw new Stop(`origin/${branch} has commits of its own (${why(own, 'git log')}); delete it by hand`);
  }

  // 2. Remove: the junction first (the link only), then the worktree, the local branch, the branch on origin.
  if (hasDir) {
    if (unlinkJunction(wt)) removed.push(`${path.join(wt, 'node_modules')} (the junction only)`);
    if (reg) must(git(main, 'worktree', 'remove', '--force', '--force', wt), 'git worktree remove');
    else fs.rmdirSync(wt);
    removed.push(`worktree ${wt}`);
    log(`removed the leftover worktree ${wt}`);
  }
  if (git(main, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).status === 0) {
    must(git(main, 'branch', '-D', branch), 'git branch -D');
    removed.push(`local branch ${branch}`);
    log(`deleted the leftover local branch ${branch}`);
  }
  if (remoteSha) {
    must(await gitRetry(main, ['push', '-q', 'origin', '--delete', branch]), `git push origin --delete ${branch}`);
    removed.push(`origin/${branch}`);
    log(`deleted the leftover branch origin/${branch} (${remoteSha.slice(0, 8)})`);
  }
  return removed;
}

module.exports = { cleanLeftover, ownCommits, strayChanges, unlinkJunction };

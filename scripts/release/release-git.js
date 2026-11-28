// The git side of two release.js rules, kept apart so the units can run them on a temp repo (no network, no gh: callers pass those in).
//
// 1. What gets tagged is what was checked and pre-flighted. When main moved during the release (a PR merged while the checks ran), the release branch
//    takes main in with a merge commit built here, its CHANGELOG merged by mergeChangelog: the version section keeps exactly the bullets of the
//    pre-flighted head and the bullets that arrived on main stay under "## Unreleased". GitHub's own merge knows nothing of the CHANGELOG (it put
//    #1124's bullets into 0.5.115), so the PR is merged only once it is a plain fast-forward of main plus this commit.
// 2. The next release's default test selection diffs against what this release checked and built, recorded as a "Release-Head:" trailer in the tag
//    message, not against the tag's tree (which held unchecked code when main moved).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./ship-common');
const { mergeChangelog, changelogSection, parseChangelog, parseReleaseHead } = require('./release-lib');

const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts });
const ok = (r) => r.status === 0;
const blob = (cwd, rev, file) => { const r = git(cwd, ['show', `${rev}:${file}`]); return ok(r) ? r.out : null; };

// Is `main` already in `head`'s history? Then a squash of the PR has the same tree as `head`.
const contains = (cwd, head, main) => ok(git(cwd, ['merge-base', '--is-ancestor', main, head]));

// Merges `main` into `head` without touching the worktree or the index (git merge-tree, a temp index, commit-tree), the CHANGELOG by mergeChangelog.
// -> { moved: false } when main is already in head; { moved: true, sha, kept: [Unreleased bullet lines on main that stay unreleased] };
// throws when another file conflicts or the CHANGELOG sections cannot be merged (a person resolves those).
function mergeMainInto(cwd, { head, main, version, message }) {
  if (contains(cwd, head, main)) return { moved: false };
  const base = git(cwd, ['merge-base', head, main]);
  if (!ok(base)) throw new Error(`no merge base between ${head.slice(0, 8)} and ${main}`);
  // --name-only: the tree id, then one conflicted path per line, then a blank line and git's messages. Exit 1 means conflicts.
  const mt = git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, main]);
  if (mt.status !== 0 && mt.status !== 1) throw new Error(`git merge-tree failed: ${mt.stderr}`);
  const [tree, ...conflicted] = mt.out.split('\n').filter(Boolean);
  const others = [...new Set(conflicted)].filter((f) => f !== 'CHANGELOG.md');
  if (others.length) throw new Error(`main conflicts with the release branch in ${others.join(', ')}`);
  const [b, o, t] = [base.stdout, head, main].map((rev) => blob(cwd, rev, 'CHANGELOG.md'));
  const m = mergeChangelog(b || '', o, t);
  if (!m.ok) throw new Error(`CHANGELOG.md: main and the release both changed ${m.conflicts.join(', ')}`);
  if (changelogSection(m.text, version) !== changelogSection(o, version)) throw new Error(`the merged CHANGELOG's ${version} section differs from the pre-flighted head's`);
  // The merged tree with our CHANGELOG in it, through a temp index so the worktree and its index are left alone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-release-merge-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
    const file = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(file, m.text);
    const id = git(cwd, ['hash-object', '-w', file]);
    const mode = git(cwd, ['ls-tree', head, 'CHANGELOG.md']).stdout.split(/\s/)[0] || '100644';
    for (const args of [['read-tree', tree], ['update-index', '--cacheinfo', `${mode},${id.stdout},CHANGELOG.md`]]) {
      const r = git(cwd, args, { env });
      if (!ok(r)) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    }
    const w = git(cwd, ['write-tree'], { env });
    if (!ok(id) || !ok(w)) throw new Error(`could not write the merged tree: ${id.stderr || w.stderr}`);
    const c = git(cwd, ['commit-tree', w.stdout, '-p', head, '-p', main, '-m', message || `Merge main into the ${version} release`]);
    if (!ok(c)) throw new Error(`git commit-tree failed: ${c.stderr}`);
    const unreleased = (text) => { const s = parseChangelog(text).sections.find((x) => /^## Unreleased/.test(x.key)); return s ? s.body.filter((l) => /^[-*] /.test(l)) : []; };
    const before = new Set(unreleased(o));
    return { moved: true, sha: c.stdout, kept: unreleased(m.text).filter((l) => !before.has(l)) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The commit the previous release checked and built, for the default suite choice.
// -> { rev, how } (how: 'trailer' from the tag's Release-Head, 'pr' from the release PR's head for tags made before the trailer), or null when unknown.
// prHead(tag) -> sha | null (release.js asks gh for the merged "Release X.Y.Z" PR); fetch(sha) -> tries to get a commit that is not here.
function releaseBase(cwd, tag, { prHead = () => null, fetch = () => {} } = {}) {
  if (!tag) return null;
  const msg = git(cwd, ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]);
  let rev = ok(msg) ? parseReleaseHead(msg.out) : null;
  let how = 'trailer';
  if (!rev) { try { rev = prHead(tag) || null; } catch { rev = null; } how = 'pr'; }
  if (!rev) return null;
  const have = () => ok(git(cwd, ['cat-file', '-e', `${rev}^{commit}`]));
  if (!have()) { try { fetch(rev); } catch { /* checked below */ } }
  return have() ? { rev, how } : null;
}

module.exports = { mergeMainInto, releaseBase, contains };

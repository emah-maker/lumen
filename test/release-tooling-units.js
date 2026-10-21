// The release tooling's pure parts (scripts/release-lib.js, merge-driver.js, setup-merge-drivers.js): the CHANGELOG and test-all.js merges
// that scripts/land.js and the git merge drivers share, the CHANGELOG cut and version bump of scripts/release.js, the release-check suite list
// derived from test-all.js and test/, and finding electron processes under the repo. Plain Node plus git in a temp repo; no Electron, no network.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../scripts/release-lib');
const { register } = require('../scripts/setup-merge-drivers');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const lines = (...l) => l.join('\n') + '\n';

// ---- CHANGELOG merge
const HEAD = ['# Changelog', '', 'Notable changes.', ''];
const cl = (unreleased, ...released) => lines(...HEAD, '## Unreleased', '', ...unreleased, '', ...released.flatMap((r) => r));
const REL = ['## 0.5.33 (2026-10-14)', '', '- **Old thing.** It was added.', ''];
{
  const base = cl(['- **A.** first']);
  const ours = cl(['- **A.** first', '- **B.** from the branch']);
  const theirs = cl(['- **A.** first', '- **C.** from main']);
  const r = lib.mergeChangelog(base, ours, theirs);
  check('changelog: two branches adding Unreleased bullets keep both, ours first', r.ok && r.text === cl(['- **A.** first', '- **C.** from main', '- **B.** from the branch']) || r.ok && r.text === cl(['- **A.** first', '- **B.** from the branch', '- **C.** from main']), r.text);
  check('changelog: both new bullets are present exactly once', r.ok && (r.text.match(/\*\*B\.\*\*/g) || []).length === 1 && (r.text.match(/\*\*C\.\*\*/g) || []).length === 1, r.text);
}
{
  // main released 0.5.34 (cut Unreleased into a new section) while the branch added a bullet
  const base = cl(['- **A.** first', '- **B.** second'], REL);
  const theirs = lines(...HEAD, '## Unreleased', '', '## 0.5.34 (2026-10-15)', '', '- **A.** first', '- **B.** second', '', ...REL);
  const ours = cl(['- **A.** first', '- **B.** second', '- **D.** new on the branch'], REL);
  const r = lib.mergeChangelog(base, ours, theirs);
  const want = lines(...HEAD, '## Unreleased', '', '- **D.** new on the branch', '', '## 0.5.34 (2026-10-15)', '', '- **A.** first', '- **B.** second', '', ...REL);
  check('changelog: a release cut on main plus a new bullet on the branch leaves only the new bullet under Unreleased', r.ok && r.text === want, r.text);
}
{
  const base = cl(['- **A.** first'], REL);
  const edit = (t) => cl(['- **A.** first'], ['## 0.5.33 (2026-10-14)', '', t, '']);
  const r = lib.mergeChangelog(base, edit('- **Old thing.** Edited on the branch.'), edit('- **Old thing.** Edited on main.'));
  check('changelog: both sides editing a released section stops', !r.ok && r.conflicts.includes('## 0.5.33 (2026-10-14)'), JSON.stringify(r));
  const one = lib.mergeChangelog(base, edit('- **Old thing.** Edited on the branch.'), base);
  check('changelog: a released section only one side edited comes through', one.ok && one.text.includes('Edited on the branch.'), JSON.stringify(one));
}
{
  const base = cl(['- **A.** first', '- **B.** second']);
  const r = lib.mergeChangelog(base, cl(['- **A.** first']), cl(['- **A.** first', '- **B.** second', '- **C.** third']));
  check('changelog: a bullet one side removed stays removed, the other side\'s addition stays', r.ok && !r.text.includes('**B.**') && r.text.includes('**C.**'), r.text);
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const c = lib.mergeChangelog(crlf(base), crlf(cl(['- **A.** first', '- **X.** x'])), crlf(cl(['- **A.** first', '- **Y.** y'])));
  check('changelog: CRLF in ours is kept throughout', c.ok && !/[^\r]\n/.test(c.text.replace(/^\n/, '')) && c.text.includes('**X.**') && c.text.includes('**Y.**'), JSON.stringify(c.text));
}

// ---- the CHANGELOG cut
{
  const text = cl(['- **A.** first', '- **B.** second'], REL);
  const cut = lib.cutChangelog(text, '0.5.34', '2026-10-15');
  check('cut: Unreleased becomes the new version section, with a fresh empty Unreleased above it', cut === lines(...HEAD, '## Unreleased', '', '## 0.5.34 (2026-10-15)', '', '- **A.** first', '- **B.** second', '', ...REL), cut);
  const crlf = lib.cutChangelog(text.replace(/\n/g, '\r\n'), '0.5.34', '2026-10-15');
  check('cut: keeps CRLF', crlf.includes('## Unreleased\r\n\r\n## 0.5.34 (2026-10-15)\r\n') && !/[^\r]\n/.test(crlf), JSON.stringify(crlf.slice(0, 200)));
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('cut: refuses an empty Unreleased', throws(() => lib.cutChangelog(cl([], REL), '0.5.34', '2026-10-15')));
  check('cut: refuses a version that already has a section', throws(() => lib.cutChangelog(text, '0.5.33', '2026-10-15')));
  check('cut: refuses a file with no Unreleased heading', throws(() => lib.cutChangelog('# Changelog\n\n## 0.5.33 (x)\n\n- a\n', '0.5.34', 'x')));
  check('cut: changelogSection reads the section back', lib.changelogSection(cut, '0.5.34').startsWith('- **A.** first'), lib.changelogSection(cut, '0.5.34'));
}

// ---- the suite list (scripts/test-all.js)
const testAll = (names, tail = '') => `// header\nconst { spawnSync } = require('child_process');\n\nconst SUITES = [\n${names}\n];\n${tail}`;
{
  const base = testAll("  'units', 'a-units', 'perf-budget',\n  'ui', 'tabs',");
  const ours = testAll("  'units', 'a-units', 'mine-units', 'perf-budget',\n  'ui', 'tabs', 'mine-ui',");
  const theirs = testAll("  'units', 'a-units', 'perf-budget',\n  'ui', 'theirs-ui', 'tabs',");
  const r = lib.mergeSuiteList(base, ours, theirs);
  check('list: both sides adding suites keeps both, each next to its predecessor', r.ok && r.text === testAll("  'units', 'a-units', 'mine-units', 'perf-budget',\n  'ui', 'theirs-ui', 'tabs', 'mine-ui',"), r.text);
  const names = r.ok ? lib.readSuites(r.text) : [];
  check('list: readSuites reads the merged list', names.join() === 'units,a-units,mine-units,perf-budget,ui,theirs-ui,tabs,mine-ui', names.join());
  const only = lib.mergeSuiteList(base, base, theirs);
  check('list: a list only theirs changed is taken verbatim', only.ok && only.text === theirs, only.text);
  const removed = lib.mergeSuiteList(base, testAll("  'units', 'perf-budget',\n  'ui', 'tabs',"), theirs);
  check('list: a suite ours removed stays removed, theirs\' addition stays', removed.ok && !removed.text.includes("'a-units'") && removed.text.includes("'theirs-ui'"), removed.text);
  const tailMerge = lib.mergeSuiteList(base, testAll("  'units', 'a-units', 'perf-budget',\n  'ui', 'tabs', 'mine-ui',", 'process.exit(1);\n'), theirs);
  check('list: an edit outside the list on one side merges with the list edit on the other', tailMerge.ok && tailMerge.text.endsWith('process.exit(1);\n') && tailMerge.text.includes("'theirs-ui'"), tailMerge.text);
  const clash = lib.mergeSuiteList(base, testAll("  'units', 'a-units', 'perf-budget',\n  'ui', 'tabs', 'mine-ui',", 'one();\n'), testAll("  'units', 'a-units', 'perf-budget',\n  'ui', 'tabs', 'theirs-ui',", 'two();\n'));
  check('list: edits outside the list on both sides stop', !clash.ok, JSON.stringify(clash));
  check('list: CRLF in ours is kept', lib.mergeSuiteList(base.replace(/\n/g, '\r\n'), ours.replace(/\n/g, '\r\n'), theirs.replace(/\n/g, '\r\n')).text.includes("'ui', 'theirs-ui', 'tabs', 'mine-ui',\r\n];"));
  const real = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'test-all.js'), 'utf8');
  const all = lib.readSuites(real);
  check('list: readSuites finds the real scripts/test-all.js list', all.length > 100 && all[0] === 'units' && all.includes('perf-budget'), all.length);
}

// ---- deriving the release checks
{
  const suites = ['units', 'x-units', 'ui', 'perf-budget', 'cli-json', 'tabs', 'gone'];
  const files = ['units', 'x-units', 'ui', 'perf-budget', 'cli-json', 'tabs', 'y-units', 'manual-thing', 'claudecode', '_helper'];
  const d = lib.deriveChecks({ suites, files });
  check('derive: Electron suites come from test-all.js in order, perf-budget last, pure-node suites excluded', d.electron.join() === 'ui,tabs,perf-budget', d.electron.join());
  check('derive: a suite named in test-all.js with no file is reported, not run', d.missing.join() === 'gone', d.missing.join());
  check('derive: test files outside test-all.js that need a window or a key are listed as manual (no helpers, no units)', d.manual.join() === 'claudecode,manual-thing', d.manual.join());
  check('derive: pure-node suites are recognised by name, as scripts/test-units.js does', ['units', 'cli-json', 'foo-units'].every(lib.isPlainSuite) && !lib.isPlainSuite('ui') && !lib.isPlainSuite('perf-budget'));
  const dir = path.join(__dirname);
  const real = lib.deriveChecks({ suites: lib.readSuites(fs.readFileSync(path.join(dir, '..', 'scripts', 'test-all.js'), 'utf8')), files: fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)) });
  check('derive: on this repo, perf-budget is last and every Electron suite has a file', real.electron.length > 100 && real.electron[real.electron.length - 1] === 'perf-budget' && !real.missing.length, `${real.electron.length} electron, missing ${real.missing}`);
  check('derive: this suite is a pure-node one (so it never reaches the Electron list)', !real.electron.includes('release-tooling-units'));
}

// ---- the version bump
{
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('bump: patch', lib.bumpVersion('0.5.33', 'patch') === '0.5.34');
  check('bump: patch carries past 9 without rolling over', lib.bumpVersion('0.5.9', 'patch') === '0.5.10');
  check('bump: minor and major reset the lower parts', lib.bumpVersion('0.5.33', 'minor') === '0.6.0' && lib.bumpVersion('0.5.33', 'major') === '1.0.0');
  check('bump: an explicit newer version is accepted', lib.bumpVersion('0.5.33', '0.6.1') === '0.6.1');
  check('bump: an older, equal or malformed version is refused', throws(() => lib.bumpVersion('0.5.33', '0.5.33')) && throws(() => lib.bumpVersion('0.5.33', '0.4.99')) && throws(() => lib.bumpVersion('0.5.33', 'v0.6')) && throws(() => lib.bumpVersion('0.5', 'patch')));
  check('bump: compares numerically, not as text', lib.compareVersions('0.5.10', '0.5.9') === 1);
}

// ---- stale electron processes
{
  const main = 'C:\\Users\\me\\dev\\lumen';
  const procs = [
    { pid: 1, exe: 'C:\\Users\\me\\dev\\lumen\\.claude\\worktrees\\release-1\\node_modules\\electron\\dist\\electron.exe', cmd: '' },
    { pid: 2, exe: 'C:\\Users\\me\\AppData\\Local\\Programs\\Lumen\\Lumen.exe', cmd: '' },
    { pid: 3, exe: '', cmd: '"C:/Users/me/dev/lumen/node_modules/electron/dist/electron.exe" .' },
    { pid: 4, exe: 'C:\\Users\\me\\dev\\lumen-other\\electron.exe', cmd: '' },
  ];
  check('procs: only electron processes under the repo are picked, by PID', lib.procsUnder(procs, [main]).map((p) => p.pid).join() === '1,3', lib.procsUnder(procs, [main]).map((p) => p.pid).join());
}

// ---- landing safety
{
  const sha = 'a'.repeat(40);
  check('land: an open PR whose head is the CI-tested commit may merge', lib.mergeBlocker({ state: 'OPEN', headRefOid: sha }, sha) === null);
  check('land: a head that moved since CI is blocked', /moved/.test(lib.mergeBlocker({ state: 'OPEN', headRefOid: 'b'.repeat(40) }, sha)));
  check('land: a closed or merged PR is blocked', /MERGED/.test(lib.mergeBlocker({ state: 'MERGED', headRefOid: sha }, sha)));
  check('land: no lock, a garbled lock, or a dead owner is taken', lib.lockDecision('', () => true).action === 'take' && lib.lockDecision('{', () => true).action === 'take' && lib.lockDecision('{"pid":5}', () => false).action === 'take');
  const busy = lib.lockDecision('{"pid":5}', (p) => p === 5);
  check('land: a lock held by a live process is busy', busy.action === 'busy' && busy.pid === 5);
}

// ---- the git merge drivers, end to end in a temp repo (nothing is run when git is missing)
{
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (git(os.tmpdir(), '--version').status !== 0) console.log('SKIP  merge drivers: git is not available');
  else {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-merge-drivers-'));
    const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
    const g = (...a) => git(repo, ...a);
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false'); g('config', 'commit.gpgsign', 'false');
    w('.gitattributes', 'CHANGELOG.md merge=lumen-changelog\nscripts/test-all.js merge=lumen-list\ngen.js merge=lumen-bundle\n');
    register(repo, { script: path.join(__dirname, '..', 'scripts', 'merge-driver.js') });
    w('CHANGELOG.md', cl(['- **A.** first'], REL));
    w('scripts/test-all.js', testAll("  'units', 'ui',"));
    w('gen.js', 'base\n');
    g('add', '.'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'feature');
    w('CHANGELOG.md', cl(['- **A.** first', '- **B.** branch'], REL));
    w('scripts/test-all.js', testAll("  'units', 'ui', 'branch-ui',"));
    w('gen.js', 'branch\n');
    g('commit', '-qam', 'feature');
    g('checkout', '-q', 'main');
    w('CHANGELOG.md', cl(['- **A.** first', '- **C.** main'], REL));
    w('scripts/test-all.js', testAll("  'units', 'ui', 'main-ui',"));
    w('gen.js', 'main\n');
    g('commit', '-qam', 'main');
    g('checkout', '-q', 'feature');
    const m = g('merge', 'main', '--no-edit');
    const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
    check('drivers: git merge with both sides adding bullets and suites completes without conflicts', m.status === 0, m.stdout + m.stderr);
    check('drivers: CHANGELOG has both bullets and no markers', changelog.includes('**B.**') && changelog.includes('**C.**') && !/^<<<<<<<|^>>>>>>>/m.test(changelog), changelog);
    check('drivers: test-all.js has both suites', lib.readSuites(fs.readFileSync(path.join(repo, 'scripts', 'test-all.js'), 'utf8')).join() === 'units,ui,main-ui,branch-ui' || lib.readSuites(fs.readFileSync(path.join(repo, 'scripts', 'test-all.js'), 'utf8')).join() === 'units,ui,branch-ui,main-ui', fs.readFileSync(path.join(repo, 'scripts', 'test-all.js'), 'utf8'));
    check('drivers: the generated file keeps our copy (land.js rebuilds it)', fs.readFileSync(path.join(repo, 'gen.js'), 'utf8') === 'branch\n');

    // a conflict inside a released section must stop, with ordinary markers
    g('reset', '-q', '--hard', 'HEAD~0');
    g('checkout', '-q', '-B', 'one', 'main');
    const rel = (t) => cl(['- **A.** first', '- **C.** main'], ['## 0.5.33 (2026-10-14)', '', t, '']);
    w('CHANGELOG.md', rel('- **Old thing.** one')); g('commit', '-qam', 'one');
    g('checkout', '-q', '-B', 'two', 'main~1');
    w('CHANGELOG.md', cl(['- **A.** first'], ['## 0.5.33 (2026-10-14)', '', '- **Old thing.** two', ''])); g('commit', '-qam', 'two');
    const c = g('merge', 'one', '--no-edit');
    const marked = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
    check('drivers: both sides editing a released section is a conflict with markers left for a person', c.status !== 0 && /^<<<<<<< /m.test(marked) && /^>>>>>>> /m.test(marked), c.stdout + c.stderr + marked);
    g('merge', '--abort');
  }
}

// ---- gh retries and the checks-only preflight
const sc = require('../scripts/ship-common');
const rr = (status, stderr = '') => ({ status, stdout: '', stderr });
check('retry: transient errors are recognised (GraphQL, 502/503/504, timeouts)', [rr(1, 'GraphQL: Something went wrong while executing your query'), rr(1, 'HTTP 502: Bad Gateway'), rr(1, 'HTTP 503'), rr(1, 'HTTP 504 gateway timeout'), rr(1, 'dial tcp: i/o timeout'), rr(1, 'read ECONNRESET')].every(sc.isTransient) && !sc.isTransient(rr(1, 'Pull request is not mergeable')) && !sc.isTransient(rr(0)));
const relSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.js'), 'utf8');
check('preflight: the Electron preflight runs only while the checks are still to run', /preflight\(main, opts, wt, !st \|\| !done\(st, 'checks'\)\)/.test(relSrc) && /if \(!withElectron\)/.test(relSrc));
check('retry: pr create, merge and publish go through ghRetry/ghJsonRetry', /ghRetry\(wt, \['pr', 'create'/.test(relSrc) && /ghRetry\(wt, \['pr', 'merge'/.test(relSrc) && /ghJsonRetry\(wt, \['release', 'view'/.test(relSrc));

// ---- a version burned by a failed build: its notes fold into the next release
{
  const REL5 = ['## 0.5.37 (2026-10-15)', '', '- **Shipped thing.** It reached everyone.', ''];
  const BURNED = ['## 0.5.38 (2026-10-16)', '', '- **Burned A.** Its build failed after the tag.', '- **Burned B.** Same release.', ''];
  const text = cl(['- **New C.** Added since.'], BURNED, REL5);
  check('burned: a section whose tag exists but whose release was never published is found', JSON.stringify(lib.findBurned({ changelogText: text, tags: ['v0.5.37', 'v0.5.38'], published: ['v0.5.37'] })) === '["0.5.38"]');
  check('burned: a published version is not burned', lib.findBurned({ changelogText: text, tags: ['v0.5.37', 'v0.5.38'], published: ['v0.5.37', 'v0.5.38'] }).length === 0);
  check('burned: a section with no tag is history or unreleased work, not burned', lib.findBurned({ changelogText: text, tags: ['v0.5.37'], published: ['v0.5.37'] }).length === 0);
  check('burned: sections older than the newest published release (an old unpublished tag) are left alone', lib.findBurned({ changelogText: cl([], REL5, ['## 0.5.30 (2026-10-01)', '', '- **Old.** x', '']), tags: ['v0.5.30', 'v0.5.37'], published: ['v0.5.37'] }).length === 0);
  check('burned: two in a row come out oldest first', JSON.stringify(lib.findBurned({ changelogText: cl([], ['## 0.5.39 (2026-10-17)', '', '- **Z.** z', ''], BURNED, REL5), tags: ['v0.5.37', 'v0.5.38', 'v0.5.39'], published: ['v0.5.37'] })) === '["0.5.38","0.5.39"]');
  const f = lib.foldBurned(text, ['0.5.38']);
  check('burned: the burned section is gone and its notes lead Unreleased, the new notes after them', f.folded.join() === '0.5.38' && !f.text.includes('## 0.5.38') && f.text.indexOf('Burned A') < f.text.indexOf('Burned B') && f.text.indexOf('Burned B') < f.text.indexOf('New C') && f.text.indexOf('New C') < f.text.indexOf('## 0.5.37'), f.text);
  const cut = lib.cutChangelog(f.text, '0.5.39', '2026-10-17');
  const parsed = require('../src/features/whats-new').parseChangelog(cut);
  const v39 = parsed.find((r) => r.version === '0.5.39');
  check('burned: after the cut the new version carries both burned and new notes, 0.5.38 has no section, and the CHANGELOG parses as whats-new needs', v39 && v39.blocks.length === 3 && !parsed.some((r) => r.version === '0.5.38') && parsed[0].version === '0.5.39' && parsed[1].version === '0.5.37', JSON.stringify(parsed.map((r) => [r.version, r.blocks.length])));
  check('burned: folding nothing (a version not in the file) changes nothing', lib.foldBurned(text, ['0.5.99']).text === text && lib.foldBurned(text, ['0.5.99']).folded.length === 0);
  const empty = lib.foldBurned(cl([], BURNED, REL5), ['0.5.38']);
  check('burned: with an empty Unreleased the burned notes alone become the release', lib.cutChangelog(empty.text, '0.5.39', '2026-10-17').includes('## 0.5.39 (2026-10-17)\n\n- **Burned A.**'), empty.text);
  check('burned: CRLF is kept', !/[^\r]\n/.test(lib.foldBurned(text.replace(/\n/g, '\r\n'), ['0.5.38']).text));
}

// ---- when the release PR's CI wait can be skipped
{
  const V = '0.5.47';
  const baseCl = cl(['- **A.** first'], REL);
  const headCl = lib.cutChangelog(baseCl, V, '2026-10-18');
  const pkg = (v, extra = {}) => JSON.stringify({ name: 'lumen', version: v, dependencies: { a: '1.0.0' }, ...extra }, null, 2) + '\n';
  const lock = (v, dep = '1.0.0') => JSON.stringify({ name: 'lumen', version: v, lockfileVersion: 3, packages: { '': { name: 'lumen', version: v, dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: dep } } }, null, 2) + '\n';
  const ok = { files: ['CHANGELOG.md', 'package-lock.json', 'package.json'], version: V, base: { changelog: baseCl, package: pkg('0.5.46'), lock: lock('0.5.46') }, head: { changelog: headCl, package: pkg(V), lock: lock(V) }, baseCi: 'success' };
  const v0 = lib.ciSkipVerdict(ok);
  check('skip-ci: exactly the CHANGELOG cut and the version fields, with CI green on the base, may skip the wait', v0.skip === true, JSON.stringify(v0));
  const no = (label, patch, expect) => { const v = lib.ciSkipVerdict({ ...ok, ...patch }); check(`skip-ci: ${label} does not skip`, v.skip === false && (!expect || v.reasons.some((r) => expect.test(r))), JSON.stringify(v)); };
  no('a third changed file', { files: [...ok.files, 'src/main.js'] }, /src\/main\.js/);
  no('a source file changed instead of the lockfile', { files: ['CHANGELOG.md', 'package.json', 'scripts/test-all.js'] }, /test-all/);
  no('a dependency bumped in package.json', { head: { ...ok.head, package: pkg(V, { dependencies: { a: '2.0.0' } }) } }, /package\.json changes more/);
  no('a new script added in package.json', { head: { ...ok.head, package: pkg(V, { scripts: { x: 'y' } }) } }, /package\.json changes more/);
  no('a package.json whose version is not the release version', { head: { ...ok.head, package: pkg('0.5.50') } }, /package\.json changes more/);
  no('a lockfile with a changed dependency version', { head: { ...ok.head, lock: lock(V, '1.0.1') } }, /package-lock\.json changes more/);
  no('a lockfile that bumps the root but not the package entry', { head: { ...ok.head, lock: JSON.stringify({ name: 'lumen', version: V, lockfileVersion: 3, packages: { '': { name: 'lumen', version: '0.5.46', dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } } }, null, 2) + '\n' } }, /package-lock\.json changes more/);
  no('a CHANGELOG that also edited an older section', { head: { ...ok.head, changelog: headCl.replace('Old thing.', 'Old thing, edited.') } }, /CHANGELOG/);
  no('a CHANGELOG with an extra bullet slipped into the cut', { head: { ...ok.head, changelog: headCl.replace('- **A.** first', '- **A.** first\n- **Sneaky.** x') } }, /CHANGELOG/);
  no('a CHANGELOG with no dated section for the version', { head: { ...ok.head, changelog: baseCl } }, /CHANGELOG/);
  no('a package.json that is not bumped at all', { files: ['CHANGELOG.md'] }, /not bumped/);
  no('a base commit whose CI failed', { baseCi: 'failure' }, /base commit/);
  no('a base commit with no CI run', { baseCi: '' }, /base commit/);
  no('an empty diff', { files: [] }, /nothing/);
  const noLock = lib.ciSkipVerdict({ ...ok, files: ['CHANGELOG.md', 'package.json'] });
  check('skip-ci: a release that leaves the lockfile alone is fine too', noLock.skip === true, JSON.stringify(noLock));
  const crlfHead = lib.ciSkipVerdict({ ...ok, head: { ...ok.head, changelog: headCl.replace(/\n/g, '\r\n') } });
  check('skip-ci: CRLF line endings in the CHANGELOG do not matter', crlfHead.skip === true, JSON.stringify(crlfHead));
  // The real thing: the last release commits in this repo's history (skipped in a shallow clone, where the parent is missing).
  const g = (...a) => spawnSync('git', a, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const rel = g('log', '-n', '1', '--format=%H', '--grep=^Release [0-9]', '--first-parent', 'HEAD');
  const sha = (rel.stdout || '').trim();
  const parent = sha && g('rev-parse', '-q', '--verify', `${sha}^`);
  if (sha && parent && parent.status === 0) {
    const files = g('diff', '--name-only', `${sha}^`, sha).stdout.split('\n').filter(Boolean);
    const at = (rev, file) => { const r = g('show', `${rev}:${file}`); return r.status === 0 ? r.stdout : null; };
    const version = JSON.parse(at(sha, 'package.json')).version;
    const real = lib.ciSkipVerdict({ files, version, base: { changelog: at(`${sha}^`, 'CHANGELOG.md'), package: at(`${sha}^`, 'package.json'), lock: at(`${sha}^`, 'package-lock.json') }, head: { changelog: at(sha, 'CHANGELOG.md'), package: at(sha, 'package.json'), lock: at(sha, 'package-lock.json') }, baseCi: 'success' });
    check(`skip-ci: the repo's own latest release commit (${version}, ${sha.slice(0, 8)}) is recognised as skippable`, real.skip === true, JSON.stringify(real));
  } else console.log('SKIP  skip-ci: no release commit with history here (shallow clone)');
}

// ---- the build preflight and its artifacts
{
  const SHA = 'a'.repeat(40);
  const t0 = Date.parse('2026-10-18T12:00:00Z');
  const run = (id, headSha, createdAt, extra = {}) => ({ databaseId: id, headSha, createdAt, status: 'in_progress', conclusion: '', url: `https://example.test/${id}`, ...extra });
  const picked = lib.pickPreflightRun([run(1, SHA, '2026-10-18T11:00:00Z'), run(2, 'b'.repeat(40), '2026-10-18T12:00:05Z'), run(3, SHA, '2026-10-18T12:00:10Z'), run(4, SHA, '2026-10-18T12:00:30Z')], { sha: SHA, notBeforeMs: t0 });
  check('preflight: the newest run on the release commit created since the dispatch is the one', picked && picked.databaseId === 4, JSON.stringify(picked));
  check('preflight: a run on another commit, or from before the dispatch, is not it', lib.pickPreflightRun([run(2, 'b'.repeat(40), '2026-10-18T12:00:05Z'), run(1, SHA, '2026-10-18T10:00:00Z')], { sha: SHA, notBeforeMs: t0 }) === null);
  check('preflight: verdicts', lib.runVerdict(run(1, SHA, 'x')) === 'pending' && lib.runVerdict(run(1, SHA, 'x', { status: 'completed', conclusion: 'success' })) === 'passed' && ['failure', 'cancelled', 'timed_out'].every((c) => lib.runVerdict(run(1, SHA, 'x', { status: 'completed', conclusion: c })) === 'failed') && lib.runVerdict(null) === 'pending');
  const files = [{ name: 'Lumen-Setup.exe', platform: 'win', sha256: 'aa', size: 1 }, { name: 'latest.yml', platform: 'win', sha256: 'bb', size: 2 }, { name: 'Lumen.dmg', platform: 'mac', sha256: 'cc', size: 3 }];
  const manifest = lib.buildManifest({ version: '0.5.47', sha: SHA, tree: 'T'.repeat(40), files });
  check('manifest: records version, tree, both platforms and every file', manifest.platforms.join() === 'mac,win' && manifest.files.length === 3 && manifest.tree === 'T'.repeat(40) && manifest.version === '0.5.47');
  const reusable = (over) => lib.artifactsReusable({ manifest, tree: 'T'.repeat(40), version: '0.5.47', ...over });
  check('reuse: the same tree and version is reusable', reusable().ok === true, JSON.stringify(reusable()));
  check('reuse: a different tree (main moved before the squash) is not', !reusable({ tree: 'U'.repeat(40) }).ok && /tree/.test(reusable({ tree: 'U'.repeat(40) }).reason));
  check('reuse: the same tree under a different commit SHA is fine (that is what a squash merge makes)', reusable().ok === true && manifest.sha === SHA);
  check('reuse: a different version is not', !reusable({ version: '0.5.48' }).ok);
  check('reuse: a manifest missing a platform is not', !lib.artifactsReusable({ manifest: lib.buildManifest({ version: '0.5.47', sha: SHA, tree: 'T'.repeat(40), files: files.filter((f) => f.platform === 'win') }), tree: 'T'.repeat(40), version: '0.5.47' }).ok);
  check('reuse: no manifest, an empty tree or a foreign schema is not', !lib.artifactsReusable({ manifest: null, tree: 'T', version: '1' }).ok && !reusable({ tree: '' }).ok && !lib.artifactsReusable({ manifest: { ...manifest, schema: 2 }, tree: 'T'.repeat(40), version: '0.5.47' }).ok);
  const good = { 'Lumen-Setup.exe': 'aa', 'latest.yml': 'bb', 'Lumen.dmg': 'cc' };
  check('checksums: every file matching its recorded SHA-256 passes', lib.verifyChecksums(manifest, good).ok);
  check('checksums: a changed file, a missing file and an extra file are each caught', lib.verifyChecksums(manifest, { ...good, 'latest.yml': 'xx' }).problems.length === 1 && lib.verifyChecksums(manifest, { 'Lumen-Setup.exe': 'aa', 'latest.yml': 'bb' }).problems.some((p) => /missing/.test(p)) && lib.verifyChecksums(manifest, { ...good, 'evil.exe': 'zz' }).problems.some((p) => /not in the manifest/.test(p)));

  // scripts/release-reuse.js end to end in a temp git repo: the manifest it writes, and the run it picks
  const rr = require('../scripts/release-reuse');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reuse-test-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.test'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
  git('add', '.'); git('commit', '-qm', 'one');
  const treeNow = rr.treeOf(repo);
  const win = path.join(repo, 'built-win'); const mac = path.join(repo, 'built-mac');
  fs.mkdirSync(win); fs.mkdirSync(mac);
  fs.writeFileSync(path.join(win, 'Lumen.exe'), 'win bytes'); fs.writeFileSync(path.join(mac, 'Lumen.dmg'), 'mac bytes');
  const out = path.join(repo, 'm.json');
  const written = rr.writeManifest({ dirs: { win, mac }, cwd: repo, sha: SHA, out });
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  check('release-reuse: the manifest holds the commit tree, the version and each file\'s real SHA-256', onDisk.tree === treeNow && onDisk.version === '1.2.3' && onDisk.files.find((f) => f.name === 'Lumen.exe').sha256 === sha256('win bytes') && onDisk.files.find((f) => f.name === 'Lumen.dmg').platform === 'mac' && written.files.length === 2, JSON.stringify(onDisk));
  // an empty commit has the same tree but another SHA: still reusable; a content change is not
  git('commit', '-q', '--allow-empty', '-m', 'same tree, new sha');
  const found = rr.findReusableRun({ cwd: repo, list: () => [{ databaseId: 30 }, { databaseId: 20 }, { databaseId: 10 }], fetchManifest: (id) => (id === 30 ? null : id === 20 ? { ...onDisk, tree: 'f'.repeat(40) } : onDisk) });
  check('release-reuse: the newest run whose manifest tree equals the tagged tree wins; expired and other-tree runs are skipped', found === 10, found);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3', extra: true }));
  git('commit', '-qam', 'changed');
  check('release-reuse: once the tagged tree differs from every preflight, nothing is reused', rr.findReusableRun({ cwd: repo, list: () => [{ databaseId: 10 }], fetchManifest: () => onDisk }) === null);
  try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the temp cleanup gets it */ }
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');
  const jobBlock = (name) => { const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\s*$)`).exec(wf); return m ? m[1] : ''; };
  check('workflow: only the publish job can write, and it only runs on a tag', (wf.match(/contents: write/g) || []).length === 1 && /contents: write/.test(jobBlock('publish')) && /startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(jobBlock('publish')) && /workflow_dispatch:/.test(wf));
  check('workflow: the dispatched build writes the manifest only from a successful units + build, and the tag run builds when there is nothing to reuse', /needs: \[units, build\]/.test(jobBlock('manifest')) && /reuse_run == ''/.test(jobBlock('build')) && /reuse_run == ''/.test(jobBlock('units')) && /release-reuse\.js fetch/.test(jobBlock('publish')) && /merge-multiple: true/.test(jobBlock('publish')));
  check('workflow: finding a preflight can never fail the run, and the tag is checked against package.json before anything else', /find >> "\$GITHUB_OUTPUT" \|\| echo "reuse_run=" >> "\$GITHUB_OUTPUT"/.test(jobBlock('plan')) && /does not match package\.json version/.test(jobBlock('plan')));
  check('workflow: the Electron and electron-builder downloads are cached by lockfile hash', /actions\/cache@/.test(jobBlock('build')) && /hashFiles\('package-lock\.json'\)/.test(jobBlock('build')) && /cache: npm/.test(jobBlock('build')) && /cache: npm/.test(jobBlock('units')));
}

// ---- parallel checks: the lanes, and what runs alone
{
  const mk = (kind, ...names) => names.map((name) => ({ name, kind }));
  const stages = [...mk('plain', 'units', 'acceptance', 'lint'), ...mk('electron', 'basics', 'perf-budget', 'settings', 'step-labels', 'igpu-perf', 'hardening', 'page-load-stall', 'tab-switch-perf')];
  const names = (phases) => phases.map((lanes) => lanes.map((l) => l.stages.map((s) => s.name)));
  const par = names(lib.planLanes(stages));
  check('lanes: one Electron job = [pure-node lane | other Electron suites], then the perf-sensitive suites alone', JSON.stringify(par) === JSON.stringify([[['units', 'acceptance', 'lint'], ['basics', 'settings', 'hardening']], [['perf-budget', 'step-labels', 'page-load-stall', 'igpu-perf', 'tab-switch-perf']]]), JSON.stringify(par));
  const ser = names(lib.planLanes(stages, { serial: true }));
  check('lanes: serial = one lane in the old order, perf-sensitive last', JSON.stringify(ser) === JSON.stringify([[['units', 'acceptance', 'lint', 'basics', 'settings', 'hardening']], [['perf-budget', 'step-labels', 'page-load-stall', 'igpu-perf', 'tab-switch-perf']]]), JSON.stringify(ser));
  check('lanes: perf-budget, step-labels, tab-switch-perf and page-load-stall are all perf-sensitive; ordinary suites are not', ['perf-budget', 'step-labels', 'tab-switch-perf', 'page-load-stall'].every(lib.isPerfSensitive) && !['basics', 'settings', 'units', 'files'].some(lib.isPerfSensitive));
  check('lanes: no perf-sensitive stage ever shares a phase with another lane', lib.planLanes(stages, { electronJobs: 3 }).every((lanes) => lanes.length === 1 || lanes.every((l) => l.stages.every((s) => !lib.isPerfSensitive(s.name)))));
  check('lanes: with no Electron suites there is just the pure lane; with only perf suites, one alone', lib.planLanes(mk('plain', 'units', 'lint')).length === 1 && lib.planLanes(mk('electron', 'perf-budget')).length === 1);
  check('lanes: every stage appears exactly once', [1, 3].every((n) => lib.planLanes(stages, { electronJobs: n }).flatMap((p) => p.flatMap((l) => l.stages)).length === stages.length));
  // electron lane concurrency (--electron-jobs): the ordinary suites N at a time, the shared-resource ones alone and one by one, perf last and alone
  const big = [...mk('plain', 'units', 'lint'), ...mk('electron', 'a', 'cdp', 'b', 'clip', 'c', 'perf-budget', 'd', 'video-frames')];
  const ex = (n) => ['cdp', 'clip'].includes(n);
  const three = lib.planLanes(big, { electronJobs: 3, exclusive: ex });
  check('lanes: 3 jobs = [pure | ordinary suites, 3 at a time], then shared-resource suites alone, then perf-sensitive alone', JSON.stringify(names(three)) === JSON.stringify([[['units', 'lint'], ['a', 'b', 'c', 'd']], [['cdp', 'clip']], [['perf-budget', 'video-frames']]]) && three[0][1].jobs === 3 && three[0][0].jobs === 1 && three[1][0].jobs === 1 && three[2][0].jobs === 1, JSON.stringify(three));
  check('lanes: with 1 job (or serial) shared-resource suites stay in the ordinary lane: nothing overlaps, so nothing has to run alone', JSON.stringify(names(lib.planLanes(big, { electronJobs: 1, exclusive: ex }))) === JSON.stringify([[['units', 'lint'], ['a', 'cdp', 'b', 'clip', 'c', 'd']], [['perf-budget', 'video-frames']]]) && lib.planLanes(big, { serial: true, electronJobs: 3, exclusive: ex }).every((p) => p.every((l) => l.jobs === 1)));
  check('lanes: jobs below 1 or not a number count as 1; a lane never has more workers than a suite list needs (the pool caps itself)', lib.planLanes(big, { electronJobs: 0 })[0][1].jobs === 1 && lib.planLanes(big, { electronJobs: 'x' })[0][1].jobs === 1);
  check('lanes: only the exclusive suites move to the alone phase; the ordinary ones stay in the pool', JSON.stringify(names(lib.planLanes(big, { electronJobs: 2, exclusive: (n) => n.length === 1 }))) === JSON.stringify([[['units', 'lint'], ['cdp', 'clip']], [['a', 'b', 'c', 'd']], [['perf-budget', 'video-frames']]]));
  check('jobs: default Electron concurrency is min(3, one per 4 cores, one per 10 GB), never below 1', lib.electronJobs({ cpus: 16, ramGb: 64 }) === 3 && lib.electronJobs({ cpus: 8, ramGb: 64 }) === 2 && lib.electronJobs({ cpus: 16, ramGb: 16 }) === 1 && lib.electronJobs({ cpus: 2, ramGb: 4 }) === 1 && lib.electronJobs({ cpus: 64, ramGb: 512 }) === 3);
  check('jobs: units leave room for the Electron jobs beside them (16 cores: 4 beside 1 job, 3 beside 3 jobs)', lib.unitJobs({ cpus: 16, withElectron: true, electronJobs: 1 }) === 4 && lib.unitJobs({ cpus: 16, withElectron: true, electronJobs: 3 }) === 3 && lib.unitJobs({ cpus: 16, withElectron: false, electronJobs: 3 }) === 8);
  // which suites must run alone: patterns over the source, plus a known list
  check('shared: a fixed port, the real clipboard, process/window lists and screen capture are detected; a stubbed clipboard and port 0 are not', lib.sharedResources('x', 'const PORT = 9339;').length === 1 && lib.sharedResources('x', 'server.listen(8123, "127.0.0.1")').length === 1 && lib.sharedResources('x', 'clipboard.readText()').length === 1 && lib.sharedResources('x', "execFile('tasklist')").length === 1 && lib.sharedResources('x', 'desktopCapturer.getSources').length === 1 && lib.sharedResources('x', 'clipboard.writeText = (t) => {}; server.listen(0, "127.0.0.1"); const freePort = 5').length === 0 && lib.sharedResources('y', '', { y: 'because' }).join() === 'because');
  {
    // every Electron suite in test-all.js that binds a fixed port, uses the real clipboard or lists the machine's processes is marked, and the
    // known suites are among them: a new suite like that is caught here (and run alone by release.js) rather than flaking a release
    const d = lib.deriveChecks({ suites: lib.readSuites(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'test-all.js'), 'utf8')), files: fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)) });
    const marked = d.electron.filter((s) => lib.sharedResources(s, fs.readFileSync(path.join(__dirname, s + '.js'), 'utf8')).length);
    check('shared: the suites known to bind fixed ports (cdp, cdp-inproc, spotify-reconnect-ui) or use the real clipboard (images) are detected in the real tree', ['cdp', 'cdp-inproc', 'spotify-reconnect-ui', 'images', 'passkeys'].every((s) => marked.includes(s)) && marked.length < 40, marked.join());
    check('shared: shared-resource suites and perf-sensitive ones are different groups only by timing; every perf-sensitive name is a real suite or is simply absent', lib.PERF_SENSITIVE.every((s) => d.electron.includes(s)), lib.PERF_SENSITIVE.filter((s) => !d.electron.includes(s)).join());
  }
  // the default selection: core + suites related to the changed files
  {
    const electron = ['smoke', 'perf-budget', 'spotify-ui', 'spotify-reconnect-ui', 'settings', 'settings-open-perf', 'notes', 'mcp', 'files'];
    const sources = { notes: "require('../src/features/notes')", mcp: '', files: 'x', 'spotify-ui': '', 'spotify-reconnect-ui': '', settings: '', 'settings-open-perf': '', smoke: '', 'perf-budget': '' };
    const core = ['smoke', 'perf-budget'];
    const pick = (changed) => lib.selectSuites({ changed, electron, sources, core });
    check('select: nothing changed = just the core set', JSON.stringify(pick([]).names) === JSON.stringify(['smoke', 'perf-budget']) && !pick([]).full);
    check('select: a changed module brings the suites named like it and the ones that load it', JSON.stringify(pick(['src/features/spotify.js']).names) === JSON.stringify(['smoke', 'perf-budget', 'spotify-ui', 'spotify-reconnect-ui']) && pick(['src/features/notes.js']).names.includes('notes') && pick(['src/renderer/settings.js']).names.includes('settings-open-perf'), JSON.stringify(pick(['src/features/spotify.js'])));
    check('select: a changed test file selects that suite; CHANGELOG, docs and locale text select nothing', pick(['test/mcp.js']).names.includes('mcp') && JSON.stringify(pick(['CHANGELOG.md', 'docs/releasing.md', 'src/locales/en.json']).names) === JSON.stringify(['smoke', 'perf-budget']));
    check('select: a build, dependency or workflow file means everything', pick(['package-lock.json']).full && pick(['.github/workflows/ci.yml']).full && pick(['scripts/build.js']).full && !pick(['scripts/release.js']).full);
    check('select: names too short to be a stem are not matched by prefix; each suite has one reason', !pick(['src/main.js']).names.includes('mcp') && Object.keys(pick(['src/features/spotify.js']).reasons).length === pick(['src/features/spotify.js']).names.length);
  }
  // test-units.js --jobs: two real unit suites, one at a time and two at a time, give the same verdict and the same sorted summary
  const tu = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'test-units.js'), ...a], { encoding: 'utf8', timeout: 120000 });
  const one = tu('zoom-steps-units', 'write-dedupe-units');
  const two = tu('--jobs', '2', 'zoom-steps-units', 'write-dedupe-units');
  const sum = (o) => o.stdout.split('=== summary')[1].replace(/\(\d+(\.\d+)?s\)/g, '').trim();
  check('test-units: --jobs 2 passes the same suites with the same summary as one at a time', one.status === 0 && two.status === 0 && sum(one) === sum(two) && /=== zoom-steps-units/.test(two.stdout) && /=== write-dedupe-units/.test(two.stdout), `${one.status} ${two.status}`);
  check('test-units: an unknown suite is still refused with --jobs', tu('--jobs', '2', 'no-such-units').status === 2);
}

// ---- node_modules reuse
{
  const lock = { packages: { '': { name: 'x' }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0', optional: true }, 'node_modules/c': { version: '3.0.0', link: true } } };
  const hidden = (over) => ({ packages: { 'node_modules/a': { version: '1.0.0' }, ...over } });
  check('node_modules: installed versions equal to the lockfile\'s can be shared (an optional package may be absent)', lib.nodeModulesMatch(hidden(), lock).ok);
  check('node_modules: a package at another version, or a required one missing, cannot', !lib.nodeModulesMatch(hidden({ 'node_modules/a': { version: '1.0.1' } }), lock).ok && !lib.nodeModulesMatch({ packages: {} }, lock).ok && /not installed/.test(lib.nodeModulesMatch({ packages: {} }, lock).reason));
  check('node_modules: an unreadable lockfile cannot', !lib.nodeModulesMatch(null, lock).ok && !lib.nodeModulesMatch(hidden(), null).ok);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-junction-test-'));
  try {
    const real = path.join(dir, 'real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'keep.txt'), 'x');
    const link = path.join(dir, 'link'); fs.symlinkSync(real, link, 'junction');
    fs.unlinkSync(link);
    check('node_modules: unlinking a junction removes the link and never what it points at', !fs.existsSync(link) && fs.existsSync(path.join(real, 'keep.txt')));
  } catch (err) { check('node_modules: unlinking a junction removes the link and never what it points at', false, err.message); }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the temp cleanup gets it */ }
}

// ---- the stage plan, and --resume through it
{
  const base = { holdLock: true, assets: 13, suiteMinutes: 15 };
  const ids = (opts, counts = { stages: 12 }) => lib.releasePlan({ version: '0.5.47', date: '2026-10-18', opts: { ...base, ...opts }, counts });
  const p = ids({});
  const order = p.map((s) => s.id);
  check('plan: worktree, install, prepare, preflight, checks, pr, ci, merge, tag, publish', order.join() === 'worktree,install,prepare,preflight,checks,pr,ci,merge,tag,publish', order.join());
  check('plan: the build preflight starts before the checks and runs alongside them', p.find((s) => s.id === 'checks').parallel === true && order.indexOf('preflight') < order.indexOf('checks') && !p.find((s) => s.id === 'preflight').parallel);
  check('plan: the PR\'s CI is skipped only when verified, and the preflight is awaited at the same gate', /skip the wait/.test(p.find((s) => s.id === 'ci').text) && /preflight run to pass/.test(p.find((s) => s.id === 'ci').text));
  check('plan: the tag publishes the preflight\'s artifacts only on a tree and checksum match, else builds', /same tree|tree equals/.test(p.find((s) => s.id === 'publish').text) && /checksum/.test(p.find((s) => s.id === 'publish').text) && /else build at the tag/.test(p.find((s) => s.id === 'publish').text));
  check('plan: --checks-only stops after the checks and pushes nothing (no preflight, no PR)', ids({ checksOnly: true }).map((s) => s.id).join() === 'worktree,install,prepare,checks,stop');
  const late = ids({ noPreflight: true }).map((s) => s.id).join();
  check('plan: --no-preflight plans no dispatch at all and does not wait for one', late === 'worktree,install,prepare,checks,pr,ci,merge,tag,publish' && !/preflight run/.test(ids({ noPreflight: true }).find((s) => s.id === 'ci').text), late);
  check('plan: --serial-checks names the serial order; --no-skip-ci says CI is always awaited', /one after another/.test(ids({ serialChecks: true }).find((s) => s.id === 'checks').text) && /wait for CI on the PR head/.test(ids({ noSkipCi: true }).find((s) => s.id === 'ci').text));
  check('plan: --fresh-install says npm ci, the default says the junction', /npm ci/.test(ids({ freshInstall: true }).find((s) => s.id === 'install').text) && /junction/.test(p.find((s) => s.id === 'install').text));
  check('plan: the prepare step names the burned-version fold', /burned version/.test(p.find((s) => s.id === 'prepare').text));
  // --resume: what is left from every recorded stage
  const left = (stage, o) => lib.stagesLeft({ stage }, o);
  check('resume: stage order is the plan order', lib.STAGES.join() === 'worktree,install,prepare,preflight,checks,pr,ci,merge,tag,publish');
  check('resume: from "prepare" the preflight, checks and everything after remain', left('prepare').join() === 'preflight,checks,pr,ci,merge,tag,publish', left('prepare').join());
  check('resume: from "preflight" (checks failed, run cancelled) the checks remain and the preflight is re-verified before the PR', left('preflight').join() === 'checks,preflight,pr,ci,merge,tag,publish', left('preflight').join());
  check('resume: a release whose checks passed with --checks-only has no preflight yet, so it is started before the PR', left('checks').join() === 'preflight,pr,ci,merge,tag,publish', left('checks').join());
  check('resume: from "pr" the CI/preflight gate, merge, tag and publish remain, the preflight re-verified first', left('pr').join() === 'preflight,ci,merge,tag,publish', left('pr').join());
  check('resume: once the gate passed the preflight is never started again, nor anything before it', left('ci').join() === 'merge,tag,publish' && left('merge').join() === 'tag,publish' && left('tag').join() === 'publish' && left('publish').length === 0);
  check('resume: --no-preflight never adds it, --checks-only stops at the checks', !left('prepare', { noPreflight: true }).includes('preflight') && left('prepare', { checksOnly: true }).join() === 'checks' && left('none').join() === lib.STAGES.join());
  check('resume: every finished stage is skipped (a stage is done once the recorded one is at or past it)', lib.STAGES.every((s, i) => lib.STAGES.every((t, j) => lib.stageDone({ stage: s }, t) === (i >= j))));
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.js'), 'utf8');
  check('resume: release.js starts the preflight right after prepare and again (idempotently) before the PR, and cancels it when the checks fail', /if \(!done\(st, 'preflight'\) && !opts\.noPreflight && !opts\.checksOnly\) \{ await startPreflight/.test(src) && /if \(!opts\.noPreflight && !done\(st, 'ci'\)\) await startPreflight/.test(src) && /await cancelPreflight\(wt, st\); throw err;/.test(src));
  check('resume: --only and --dry-run are still options of release.js', /a === '--only'/.test(src) && /a === '--dry-run'/.test(src) && /--resume/.test(src));
  // the dry run itself, when origin/main is here
  const root = path.join(__dirname, '..');
  const have = spawnSync('git', ['rev-parse', '-q', '--verify', 'origin/main'], { cwd: root, encoding: 'utf8' }).status === 0;
  if (have) {
    const dry = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts', 'release.js'), 'patch', '--dry-run', ...a], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const d = dry();
    const at = (re) => d.stdout.search(re);
    check('dry-run: prints the new plan (preflight before checks, the lanes, the retry policy) and changes nothing', d.status === 0 && at(/preflight: push release/) > 0 && at(/preflight: push release/) < at(/\| checks:/) && /checks lanes:/.test(d.stdout) && /retry up to 5 times/.test(d.stdout) && /nothing was fetched, created, stopped, pushed, dispatched or tagged/.test(d.stdout), d.stdout.slice(-600) + d.stderr);
    const dc = dry('--checks-only', '--serial-checks');
    check('dry-run: --checks-only --serial-checks plans no push and one lane', dc.status === 0 && !/pr: push/.test(dc.stdout) && /one after another/.test(dc.stdout) && /stop here/.test(dc.stdout), dc.stdout.slice(-400));
    const dr = spawnSync(process.execPath, [path.join(root, 'scripts', 'release.js'), '--resume', '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 60000 });
    check('dry-run: --resume --dry-run runs and says what it would do', dr.status === 0 && /--resume/.test(dr.stdout), dr.stdout.slice(-300) + dr.stderr);
  } else console.log('SKIP  dry-run: no origin/main here');
}

(async () => {
  const naps = [];
  const o = (extra) => ({ nap: async (ms) => { naps.push(ms); }, ...extra });
  let n = 0;
  let r = await sc.ghRetry('.', ['x'], o({ runner: () => (++n < 3 ? rr(1, 'HTTP 502') : rr(0)) }));
  check('retry: a transient failure is retried; the third try can succeed, with growing backoff', r.status === 0 && n === 3 && naps.length === 2 && naps[1] > naps[0], n + ' ' + naps);
  n = 0;
  r = await sc.ghRetry('.', ['x'], o({ runner: () => { n++; return rr(1, 'HTTP 503'); } }));
  check('retry: gives up after 3 attempts and returns the failure', r.status !== 0 && n === 3, n);
  n = 0;
  r = await sc.ghRetry('.', ['x'], o({ runner: () => { n++; return rr(1, 'not mergeable'); } }));
  check('retry: a real (non-transient) failure is not retried', r.status !== 0 && n === 1, n);
  n = 0;
  r = await sc.ghRetry('.', ['merge'], o({ runner: () => { n++; return rr(1, 'GraphQL: Something went wrong'); }, recheck: () => ({ status: 0, stdout: '' }) }));
  check('retry: a merge that already landed (recheck says so) counts as success, with no second merge', r.status === 0 && n === 1, n);
  n = 0;
  r = await sc.ghRetry('.', ['merge'], o({ runner: () => { n++; return n < 2 ? rr(1, 'HTTP 504') : rr(0); }, recheck: () => null }));
  check('retry: a recheck that finds nothing leads to the retry', r.status === 0 && n === 2, n);
  // ---- the network retry policy (git and gh, release.js and land.js)
  check('net-retry: the backoff doubles from 2 s and stops growing at 30 s', [1, 2, 3, 4, 5, 6, 9].map((i) => sc.backoffMs(i)).join() === '2000,4000,8000,16000,30000,30000,30000' && sc.backoffMs(1, { baseMs: 500 }) === 500 && sc.backoffMs(0) === 2000);
  check('net-retry: five attempts is the network default; gh calls keep their three unless asked for more', sc.NET_TRIES === 5);
  const gitErr = (msg) => rr(128, msg);
  const transientGit = ['fatal: unable to access \'https://github.com/emah-maker/lumen.git/\': Could not resolve host: github.com', 'fatal: unable to access \'https://github.com/x/y.git/\': Failed to connect to github.com port 443 after 21040 ms: Could not connect to server', 'error: RPC failed; curl 55 Recv failure: Connection was reset', 'fatal: the remote end hung up unexpectedly', 'fatal: early EOF', 'fatal: unable to access \'https://github.com/x/y.git/\': schannel: failed to receive handshake, SSL/TLS connection failed', 'fatal: unable to access \'https://github.com/x/y.git/\': OpenSSL SSL_read: Connection was reset, errno 10054', 'fatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 503', 'ssh: connect to host github.com port 22: Network is unreachable', 'fatal: Could not read from remote repository.', 'error: HTTP 429 rate limit'];
  check('net-retry: git network failures (DNS, connect, TLS, RPC, hung up, 5xx) are transient', transientGit.every((m) => sc.isTransient(gitErr(m))), transientGit.filter((m) => !sc.isTransient(gitErr(m))).join(' | '));
  const permanentGit = ['fatal: Authentication failed for \'https://github.com/x/y.git/\'', ' ! [rejected]        main -> main (non-fast-forward)', 'remote: Permission to x/y.git denied to z. fatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 403', 'fatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 404', 'fatal: repository \'https://github.com/x/y.git/\' not found', 'fatal: tag \'v1\' already exists', 'GraphQL: Pull request is not mergeable (mergePullRequest)', 'HTTP 404: Not Found', 'HTTP 422: Validation Failed'];
  check('net-retry: a real refusal (auth, rejected push, 403/404/422, not found, not mergeable) is never retried, even with "unable to access" in it', permanentGit.every((m) => !sc.isTransient(gitErr(m))), permanentGit.filter((m) => sc.isTransient(gitErr(m))).join(' | '));
  const waits = [];
  const nap5 = async (ms) => { waits.push(ms); };
  let calls = 0;
  let gr = await sc.gitRetry('.', ['fetch'], { runner: () => (++calls < 5 ? gitErr('fatal: unable to access x: Could not resolve host: github.com') : rr(0)), nap: nap5 });
  check('net-retry: git retries up to five times with 2, 4, 8 and 16 s waits and can succeed on the fifth', gr.status === 0 && calls === 5 && waits.join() === '2000,4000,8000,16000', `${calls} ${waits}`);
  calls = 0; waits.length = 0;
  gr = await sc.gitRetry('.', ['push'], { runner: () => { calls++; return gitErr('fatal: early EOF'); }, nap: nap5 });
  check('net-retry: after five failures git gives the failure back (the caller stops with it)', gr.status !== 0 && calls === 5 && waits.length === 4, `${calls} ${waits}`);
  calls = 0;
  gr = await sc.gitRetry('.', ['push'], { runner: () => { calls++; return gitErr('! [rejected] main -> main (non-fast-forward)'); }, nap: nap5 });
  check('net-retry: a rejected push is tried once', gr.status !== 0 && calls === 1, calls);
  calls = 0;
  gr = await sc.gitRetry('.', ['push'], { runner: () => { calls++; return gitErr('fatal: the remote end hung up unexpectedly'); }, recheck: () => ({ status: 0, stdout: '' }), nap: nap5 });
  check('net-retry: a push that dropped after it arrived (recheck finds the remote at HEAD) counts as done, with no second push', gr.status === 0 && calls === 1, calls);
  calls = 0;
  gr = await sc.ghRetry('.', ['x'], { tries: sc.NET_TRIES, runner: () => { calls++; return calls < 4 ? rr(1, 'HTTP 502') : rr(0); }, nap: nap5 });
  check('net-retry: gh takes the same five tries when a caller asks (release.js and land.js do for every call)', gr.status === 0 && calls === 4);
  const logs = [];
  calls = 0;
  await sc.gitRetry('.', ['fetch'], { runner: () => (++calls < 2 ? gitErr('fatal: early EOF') : rr(0)), nap: nap5, log: (m) => logs.push(m) });
  check('net-retry: each retry says so (what, which attempt, how long)', logs.length === 1 && /git fetch/.test(logs[0]) && /attempt 1 of 5/.test(logs[0]) && /2s/.test(logs[0]), logs.join());
  // a long outage inside a poll: CI state reads ride out failures
  let polls = 0;
  const fakeGh = () => { polls++; return polls < 3 ? rr(1, 'dial tcp: i/o timeout') : { status: 0, stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', workflowName: 'CI', url: 'u', databaseId: 1 }]), stderr: '' }; };
  const state = await sc.ciState('.', 'sha', { runner: fakeGh, nap: nap5 });
  check('net-retry: ciState rides out transient gh failures and reads the run', state.state === 'success' && polls === 3, JSON.stringify(state));
  const land = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'land.js'), 'utf8');
  check('net-retry: land.js fetches, pushes, views the PR and merges through the retry helpers, with the merged-already recheck', /gitRetry\(main, \['fetch'/.test(land) && /gitRetry\(wt, \['push'/.test(land) && /ghJsonRetry\(main, \['pr', 'view'/.test(land) && /ghRetry\(wt, \['pr', 'merge'/.test(land) && /recheck: merged/.test(land) && !/\bghJson\(/.test(land) && !/must\(git\([a-z]+, 'fetch'/.test(land) && !/must\(git\(wt, 'push'/.test(land));
  check('net-retry: release.js fetches, pushes the branch and the tag, lists remote tags and dispatches through the retry helpers', /gitRetry\(main, \['fetch'/.test(relSrc) && /gitRetry\(wt, \['push', '-q', '-u'/.test(relSrc) && /gitRetry\(wt, \['push', '-q', 'origin', tag\]/.test(relSrc) && /gitRetry\(main, \['ls-remote'/.test(relSrc) && /ghRetry\(wt, \['workflow', 'run'/.test(relSrc) && !/must\(git\((main|wt), '(fetch|push)'/.test(relSrc));
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

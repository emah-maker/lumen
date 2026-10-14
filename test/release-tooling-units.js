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

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

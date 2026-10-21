// Pure helpers behind scripts/release/land.js, scripts/release/release.js and the git merge drivers (scripts/release/merge-driver.js): the CHANGELOG and
// test-all.js merges, the CHANGELOG section cut, the version bump, and deriving the release-check suites. No I/O, so
// test/release-tooling-units.js covers them all in plain node.

const toLf = (s) => s.replace(/\r\n/g, '\n');
const nlOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const fromLf = (s, nl) => (nl === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

// ---------------------------------------------------------------------------------------------------------------- CHANGELOG

// { endsNL, sections: [{ key, body }] }: key is the "## ..." heading line ('' for the text before the first one), body the lines under it.
function parseChangelog(text) {
  const lines = toLf(text).split('\n');
  const endsNL = lines[lines.length - 1] === '';
  if (endsNL) lines.pop();
  const sections = [{ key: '', body: [] }];
  for (const line of lines) {
    if (/^## /.test(line)) sections.push({ key: line.trimEnd(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }
  return { endsNL, sections };
}

function serializeChangelog({ endsNL, sections }) {
  const lines = [];
  for (const s of sections) { if (s.key) lines.push(s.key); lines.push(...s.body); }
  return lines.join('\n') + (endsNL ? '\n' : '');
}

const isUnreleased = (key) => /^## Unreleased\b/i.test(key);

// A section body as { head, items }: head is the text before the first "- " bullet, each item a bullet with its continuation lines and the blank lines after it.
function parseItems(body) {
  const head = [];
  const items = [];
  for (const line of body) {
    if (/^- /.test(line)) items.push({ lines: [line], gap: 0 });
    else if (!items.length) head.push(line);
    else if (line.trim() === '') items[items.length - 1].gap++;
    else if (items[items.length - 1].gap) { items.push({ lines: [line], gap: 0, loose: true }); } // text after a blank line: its own block
    else items[items.length - 1].lines.push(line);
  }
  return { head, items };
}

const itemKey = (it) => it.lines.join('\n').trim();
const sameLines = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Three-way merge of the Unreleased bullets: the result is what the base had that neither side removed, plus what each side added.
function mergeBullets(baseBody, oursBody, theirsBody) {
  const b = parseItems(baseBody || []);
  const o = parseItems(oursBody);
  const t = parseItems(theirsBody);
  let head;
  if (sameLines(o.head, t.head)) head = o.head;
  else if (sameLines(o.head, b.head)) head = t.head;
  else if (sameLines(t.head, b.head)) head = o.head;
  else return null;
  if ([...o.items, ...t.items, ...b.items].some((it) => it.loose)) return null; // not a plain bullet list: leave it to a person
  const inBase = new Set(b.items.map(itemKey));
  const inTheirs = new Set(t.items.map(itemKey));
  const inOurs = new Set(o.items.map(itemKey));
  const out = o.items.filter((it) => !(inBase.has(itemKey(it)) && !inTheirs.has(itemKey(it))));
  const have = new Set(out.map(itemKey));
  let anchor = -1; // index in `out` after which theirs' next new bullet goes
  for (const it of t.items) {
    const k = itemKey(it);
    if (have.has(k)) { anchor = out.findIndex((x) => itemKey(x) === k); continue; }
    if (inBase.has(k) || inOurs.has(k)) continue; // ours removed it
    out.splice(++anchor, 0, { lines: it.lines, gap: 0 });
    have.add(k);
  }
  if (out.length && !out[out.length - 1].gap) out[out.length - 1].gap = 1; // a blank line before the next heading
  const body = [...head];
  for (const it of out) { body.push(...it.lines); for (let i = 0; i < it.gap; i++) body.push(''); }
  if (!out.length && !body.length) body.push('');
  return body;
}

// mergeChangelog(base, ours, theirs) -> { ok, text, conflicts: [section keys] }. Sections only one side touched come through as they are,
// both sides adding bullets under "## Unreleased" gives the union, and any other section both sides changed is a conflict.
function mergeChangelog(baseText, oursText, theirsText) {
  const nl = nlOf(oursText);
  const base = parseChangelog(baseText || '');
  const ours = parseChangelog(oursText);
  const theirs = parseChangelog(theirsText);
  const bodyOf = (p) => new Map(p.sections.map((s) => [s.key, s.body]));
  const B = bodyOf(base);
  const O = bodyOf(ours);
  const T = bodyOf(theirs);
  // Section order: ours', with sections only theirs has placed after the one that precedes them in theirs.
  const order = ours.sections.map((s) => s.key);
  const tKeys = theirs.sections.map((s) => s.key);
  tKeys.forEach((k, i) => {
    if (order.includes(k) || B.has(k)) return; // ours dropped a base section on purpose
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = order.indexOf(tKeys[j]); if (p >= 0) { at = p + 1; break; } }
    order.splice(at, 0, k);
  });
  const conflicts = [];
  const sections = [];
  for (const key of order) {
    const b = B.get(key);
    const o = O.get(key);
    const t = T.get(key);
    const eq = (x, y) => (x === undefined || y === undefined ? x === y : sameLines(x, y));
    let body;
    let resolved = true;
    if (eq(o, t)) body = o;
    else if (eq(o, b)) body = t;
    else if (eq(t, b)) body = o;
    else if (isUnreleased(key) && o && t) { body = mergeBullets(b, o, t); resolved = body !== null; }
    else resolved = false;
    if (!resolved) { conflicts.push(key || '(top of file)'); continue; }
    if (body !== undefined) sections.push({ key, body });
  }
  if (conflicts.length) return { ok: false, conflicts, text: null };
  if (sections.length && sections[0].key !== '') sections.unshift({ key: '', body: [] });
  const text = serializeChangelog({ endsNL: ours.endsNL || theirs.endsNL, sections });
  return { ok: true, conflicts: [], text: fromLf(text, nl) };
}

// Turns "## Unreleased" into "## Unreleased" (empty) followed by "## X.Y.Z (date)" holding what was in it. Throws when there is nothing to release.
function cutChangelog(text, version, date) {
  const nl = nlOf(text);
  const parsed = parseChangelog(text);
  const at = parsed.sections.findIndex((s) => isUnreleased(s.key));
  if (at < 0) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  if (parsed.sections.some((s) => s.key.startsWith(`## ${version} `) || s.key === `## ${version}`)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  if (!parseItems(parsed.sections[at].body).items.length) throw new Error('"## Unreleased" has no entries to release');
  const body = parsed.sections[at].body;
  parsed.sections.splice(at, 1, { key: '## Unreleased', body: [''] }, { key: `## ${version} (${date})`, body });
  return fromLf(serializeChangelog(parsed), nl);
}

// The lines of one section (heading excluded), for showing in the release log.
function changelogSection(text, version) {
  const s = parseChangelog(text).sections.find((x) => x.key.startsWith(`## ${version} `) || x.key === `## ${version}`);
  return s ? s.body.join('\n').trim() : '';
}

// ------------------------------------------------------------------------------------------------------ scripts/test/test-all.js

const SUITES_RE = /const SUITES = \[\n([\s\S]*?)\n\];/;

// { before, inner, after } around the SUITES array literal (LF text), or null when the file doesn't look as expected.
function splitSuiteFile(lfText) {
  const m = SUITES_RE.exec(lfText);
  if (!m) return null;
  const start = m.index + m[0].indexOf('\n') + 1;
  const inner = m[1];
  if (inner.replace(/'[^'\n]+'/g, '').replace(/[,\s]/g, '')) return null; // something besides quoted names (a comment, say): not ours to rewrite
  return { before: lfText.slice(0, start), inner, after: lfText.slice(start + inner.length) };
}

const suiteNames = (inner) => [...inner.matchAll(/'([^']+)'/g)].map((m) => m[1]);

// The suite names in scripts/test/test-all.js, in order.
function readSuites(testAllText) {
  const parts = splitSuiteFile(toLf(testAllText));
  return parts ? suiteNames(parts.inner) : [];
}

// Layout-preserving three-way merge of two edited suite lists: start from ours' lines, drop what theirs removed, and put each name only theirs has after its predecessor.
function mergeInner(baseInner, oursInner, theirsInner) {
  const b = suiteNames(baseInner);
  const t = suiteNames(theirsInner);
  const oNames = suiteNames(oursInner);
  const lines = oursInner.split('\n').map((line) => ({
    indent: line.match(/^\s*/)[0],
    comma: line.trimEnd().endsWith(','),
    names: suiteNames(line),
  }));
  for (const l of lines) l.names = l.names.filter((n) => !(b.includes(n) && !t.includes(n)));
  const where = (n) => lines.findIndex((l) => l.names.includes(n));
  let anchor = null;
  for (const n of t) {
    if (where(n) >= 0) { anchor = n; continue; }
    if (b.includes(n) || oNames.includes(n)) continue; // ours removed it
    if (anchor === null) { lines[0].names.unshift(n); } else { const li = where(anchor); lines[li].names.splice(lines[li].names.indexOf(anchor) + 1, 0, n); }
    anchor = n;
  }
  return lines.filter((l) => l.names.length).map((l) => `${l.indent}${l.names.map((n) => `'${n}'`).join(', ')}${l.comma ? ',' : ''}`).join('\n');
}

// mergeSuiteList(base, ours, theirs) -> { ok, text } or { ok: false, reason } for scripts/test/test-all.js. Only the SUITES array is merged by name; the rest of the file must have changed on one side only.
function mergeSuiteList(baseText, oursText, theirsText) {
  const nl = nlOf(oursText);
  const B = splitSuiteFile(toLf(baseText || ''));
  const O = splitSuiteFile(toLf(oursText));
  const T = splitSuiteFile(toLf(theirsText));
  if (!B || !O || !T) return { ok: false, reason: 'no plain SUITES array to merge' };
  const pick = (b, o, t) => (o === t ? o : o === b ? t : t === b ? o : null);
  const before = pick(B.before, O.before, T.before);
  const after = pick(B.after, O.after, T.after);
  if (before === null || after === null) return { ok: false, reason: 'the file changed outside the SUITES list on both sides' };
  const inner = pick(B.inner, O.inner, T.inner) ?? mergeInner(B.inner, O.inner, T.inner);
  const names = suiteNames(inner);
  if (new Set(names).size !== names.length) return { ok: false, reason: 'the merged list has a suite twice' };
  return { ok: true, text: fromLf(before + inner + after, nl) };
}

// ------------------------------------------------------------------------------------------------------------- the version

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parseVersion = (v) => { const m = SEMVER.exec(String(v).trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// bumpVersion('0.5.33', 'patch') -> '0.5.34'; also 'minor', 'major', or an explicit X.Y.Z that must be newer.
function bumpVersion(current, spec) {
  const cur = parseVersion(current);
  if (!cur) throw new Error(`current version "${current}" is not X.Y.Z`);
  if (spec === 'patch') return `${cur[0]}.${cur[1]}.${cur[2] + 1}`;
  if (spec === 'minor') return `${cur[0]}.${cur[1] + 1}.0`;
  if (spec === 'major') return `${cur[0] + 1}.0.0`;
  if (!parseVersion(spec)) throw new Error(`"${spec}" is not patch, minor, major or X.Y.Z`);
  if (compareVersions(spec, current) <= 0) throw new Error(`${spec} is not newer than the current ${current}`);
  return spec.trim();
}

// ----------------------------------------------------------------------------------------------------- release-check suites

// Suites that need no window: scripts/test/test-units.js runs them (every *-units.js plus these).
const isPlainSuite = (name) => name === 'units' || name === 'cli-json' || name.endsWith('-units');

// deriveChecks({ suites, files }): suites is the list from scripts/test/test-all.js, files the names in test/ (without .js).
//  electron: the core suites that launch Lumen, in test-all order with perf-budget last (it measures a warm disk cache);
//  units: true when the pure-node suites exist (they all run through `npm run test:units`, which finds them in test/);
//  missing: named in test-all.js but with no file; manual: test files outside test-all.js that need a window, the network or a key.
function deriveChecks({ suites, files }) {
  const have = new Set(files);
  const missing = suites.filter((s) => !have.has(s));
  const present = suites.filter((s) => have.has(s));
  const electron = present.filter((s) => !isPlainSuite(s) && s !== 'perf-budget');
  if (present.includes('perf-budget')) electron.push('perf-budget');
  const inAll = new Set(suites);
  const manual = files.filter((f) => !f.startsWith('_') && !isPlainSuite(f) && !inAll.has(f)).sort();
  const plainCount = new Set([...files.filter(isPlainSuite)]).size;
  return { electron, manual, missing, plainCount, units: plainCount > 0 };
}

// ---------------------------------------------------------------------------------------------------------- processes

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

// procs: [{ pid, exe, cmd }]. The ones whose executable or command line sits under one of `roots` (the repo and its worktrees).
function procsUnder(procs, roots) {
  const rs = roots.map((r) => norm(r).replace(/\/+$/, '') + '/');
  return procs.filter((p) => { const e = norm(p.exe) + ' ' + norm(p.cmd); return rs.some((r) => e.includes(r)); });
}

// ------------------------------------------------------------------------------------------------------- landing safety

// Why a PR must not be merged right now, or null: it has to be open and its head still the commit CI passed on.
function mergeBlocker(info, sha) {
  if (info.state !== 'OPEN') return `the PR is ${info.state}`;
  if (info.headRefOid !== sha) return `the PR head moved to ${String(info.headRefOid).slice(0, 8)} since CI passed on ${sha.slice(0, 8)}`;
  return null;
}

// What to do about an existing per-PR lock file's content: 'take' (unreadable, or its owner is gone) or 'busy'.
function lockDecision(content, isAlive) {
  let held;
  try { held = JSON.parse(content); } catch { return { action: 'take' }; }
  return held && Number.isInteger(held.pid) && isAlive(held.pid) ? { action: 'busy', pid: held.pid } : { action: 'take' };
}

// ------------------------------------------------------------------------------------------ a version burned by a failed build

const sectionVersion = (key) => { const m = /^## v?(\d+\.\d+\.\d+)\b/.exec(key); return m ? m[1] : null; };

// The CHANGELOG versions that were cut but never shipped: a "## X.Y.Z" section whose tag exists but whose GitHub release was never published
// (release.yml failed after the tag), and which is newer than the newest published release (old sections without tags are history, not burned).
// { changelogText, tags: ['v0.5.38', ...], published: ['0.5.37', ...] } -> versions, oldest first.
function findBurned({ changelogText, tags, published }) {
  const tagged = new Set(tags.map((t) => String(t).replace(/^v/, '')));
  const pub = new Set(published.map((v) => String(v).replace(/^v/, '')));
  const newest = [...pub].filter((v) => parseVersion(v)).sort(compareVersions).pop();
  return parseChangelog(changelogText).sections.map((s) => sectionVersion(s.key)).filter(Boolean)
    .filter((v) => tagged.has(v) && !pub.has(v) && (!newest || compareVersions(v, newest) > 0))
    .sort(compareVersions);
}

// Moves the notes of the burned versions into "## Unreleased" (older notes first) and drops their sections, so that cutChangelog then files them
// under the new version: a release that never shipped has no notes of its own. Returns { text, folded: [versions found in the file] }.
function foldBurned(text, versions) {
  const nl = nlOf(text);
  const parsed = parseChangelog(text);
  if (!parsed.sections.some((s) => isUnreleased(s.key))) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  const folded = [];
  const moved = [];
  for (const v of [...versions].sort(compareVersions)) {
    const i = parsed.sections.findIndex((s) => sectionVersion(s.key) === v);
    if (i < 0) continue;
    moved.push(...parseItems(parsed.sections[i].body).items);
    parsed.sections.splice(i, 1);
    folded.push(v);
  }
  if (!folded.length) return { text, folded };
  const at = parsed.sections.findIndex((s) => isUnreleased(s.key));
  const cur = parseItems(parsed.sections[at].body);
  if (moved.length) moved[moved.length - 1].gap = cur.items.length ? cur.items[0].gap : 1;
  const items = [...moved, ...cur.items];
  if (items.length && !items[items.length - 1].gap) items[items.length - 1].gap = 1;
  const body = [...(cur.head.every((l) => l.trim() === '') ? [''] : cur.head)]; // an empty head is one blank line, so the cut leaves the usual gap
  for (const it of items) { body.push(...it.lines); for (let i = 0; i < it.gap; i++) body.push(''); }
  parsed.sections[at] = { key: parsed.sections[at].key, body };
  return { text: fromLf(serializeChangelog(parsed), nl), folded };
}

// ----------------------------------------------------------------------------------------------- when the PR's CI can be skipped

const RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json'];

// The two package files differ only in the version being released.
function versionOnly(baseText, headText, version, isLock) {
  let b; let h;
  try { b = JSON.parse(baseText); h = JSON.parse(headText); } catch { return false; }
  if (!h || h.version !== version || !b || b.version === version) return false;
  b.version = version;
  if (isLock) {
    if (!b.packages || !h.packages || !b.packages[''] || !h.packages[''] || h.packages[''].version !== version) return false;
    b.packages[''].version = version;
  }
  return require('util').isDeepStrictEqual(b, h);
}

// Can the wait for CI on a release PR be skipped? Only when the release commit is mechanically nothing but the release:
//  files: the paths the commit changes against the base commit; base/head: { changelog, package, lock } texts (lock may be null when unchanged and absent);
//  baseCi: 'success' when CI already passed on the base commit (origin/main as the release was cut from it).
// -> { skip, reasons } (reasons: what blocks the skip, or what was verified).
function ciSkipVerdict({ files, version, base, head, baseCi }) {
  const blocks = [];
  const extra = files.filter((f) => !RELEASE_FILES.includes(f));
  if (!files.length) blocks.push('the release commit changes nothing');
  if (extra.length) blocks.push(`it also changes ${extra.slice(0, 4).join(', ')}${extra.length > 4 ? ` and ${extra.length - 4} more` : ''}`);
  if (!files.includes('package.json')) blocks.push('package.json is not bumped');
  else if (!versionOnly(base.package, head.package, version, false)) blocks.push(`package.json changes more than "version": "${version}"`);
  if (files.includes('package-lock.json') && !versionOnly(base.lock, head.lock, version, true)) blocks.push(`package-lock.json changes more than the version ${version}`);
  if (files.includes('CHANGELOG.md')) {
    const date = new RegExp(`^## ${version.replace(/\./g, '\\.')} \\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm').exec(toLf(head.changelog));
    let want;
    try { want = date ? cutChangelog(base.changelog, version, date[1]) : null; } catch { want = null; }
    if (want === null || toLf(want) !== toLf(head.changelog)) blocks.push('CHANGELOG.md is not exactly "Unreleased" cut into the new version section');
  }
  if (baseCi !== 'success') blocks.push(`CI has not passed on the base commit (${baseCi || 'no run'})`);
  return blocks.length ? { skip: false, reasons: blocks } : { skip: true, reasons: [`only ${files.join(', ')} change, the version fields and the CHANGELOG cut verified line by line`, 'CI passed on the base commit'] };
}

// ------------------------------------------------------------------------------------------------- the build preflight and its artifacts

// The dispatched preflight run for a commit, from `gh run list --json databaseId,headSha,createdAt,status,conclusion,url`: the newest run on that SHA
// created no earlier than the dispatch (a minute of clock skew allowed), or null.
function pickPreflightRun(runs, { sha, notBeforeMs }) {
  const mine = (runs || []).filter((r) => r.headSha === sha && Date.parse(r.createdAt) >= notBeforeMs - 60000);
  return mine.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

// 'pending' | 'passed' | 'failed' for a run's status and conclusion.
function runVerdict(run) {
  if (!run || run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'passed' : 'failed';
}

// The manifest the preflight run records next to its artifacts: what was built, from which tree, and the SHA-256 of every file.
function buildManifest({ version, sha, tree, files }) {
  return { schema: 1, version, sha, tree, platforms: [...new Set(files.map((f) => f.platform))].sort(), files: files.map((f) => ({ name: f.name, platform: f.platform, sha256: f.sha256, size: f.size })).sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

// May the tag run publish this preflight's artifacts instead of building again? The tree of the tagged commit must equal the tree the preflight built
// (a squash merge gets a new commit SHA but the same tree when main did not move), the version must match, and both platforms must be there.
function artifactsReusable({ manifest, tree, version, platforms = ['mac', 'win'] }) {
  if (!manifest || manifest.schema !== 1) return { ok: false, reason: 'no usable manifest' };
  if (!tree || manifest.tree !== tree) return { ok: false, reason: `the preflight built tree ${String(manifest.tree).slice(0, 8)}, the tag is tree ${String(tree).slice(0, 8)}` };
  if (manifest.version !== version) return { ok: false, reason: `the preflight built ${manifest.version}, the tag is ${version}` };
  const missing = platforms.filter((p) => !(manifest.platforms || []).includes(p));
  if (missing.length) return { ok: false, reason: `the preflight has no ${missing.join(', ')} build` };
  if (!manifest.files || !manifest.files.length) return { ok: false, reason: 'the manifest lists no files' };
  return { ok: true, reason: 'same tree and version' };
}

// The downloaded files against the manifest: { ok, problems }. actual: { name: sha256 }.
function verifyChecksums(manifest, actual) {
  const problems = [];
  for (const f of manifest.files) {
    if (!(f.name in actual)) problems.push(`${f.name} is missing`);
    else if (actual[f.name] !== f.sha256) problems.push(`${f.name} does not match its recorded checksum`);
  }
  const listed = new Set(manifest.files.map((f) => f.name));
  for (const n of Object.keys(actual)) if (!listed.has(n)) problems.push(`${n} is not in the manifest`);
  return { ok: !problems.length, problems };
}

// ------------------------------------------------------------------------------------------------------------ parallel checks

// Suites whose numbers depend on a quiet machine: they run alone, after everything else. The first group is what release.js has always
// held back; the second is every other suite with a wall-clock budget (a latency, a frame rate, "no main-process task over N ms").
const PERF_SENSITIVE = [
  'perf-budget', 'step-labels', 'overlay-first-perf', 'page-load-stall', 'igpu-perf',
  'tab-switch-perf', 'chat-tab-speed', 'chat-save-stall', 'desktop-apps', 'music-react', 'project-folders', 'pptx-shapes', 'tools', 'files-ai', 'gpu-health', 'video-frames',
];
const isPerfSensitive = (name) => PERF_SENSITIVE.includes(name);

// What makes an Electron suite unsafe to run beside another one: it binds a fixed port, uses the one OS clipboard, or looks at the whole machine
// (every window, every process, every screen). [reason, pattern over the suite's source].
const SHARED_RESOURCE_PATTERNS = [
  ['a fixed port', /\bPORT\s*=\s*\d{3,5}\b|\.listen\(\s*\d{3,5}\b|remote-debugging-port=\d|\b(?:43917|47821|9222)\b|REDIRECT_PORT|REDIRECT_URI/],
  ['the OS clipboard', /\bclipboard\.(?:write|read)\w*\(|Set-Clipboard|Get-Clipboard/],
  ['machine-wide window or process lists', /\btasklist\b|Get-CimInstance|Get-Process\b|\bnetstat\b|EnumWindows|\bps -/],
  ['screen capture', /desktopCapturer|getDisplayMedia/],
];

// Why a suite must run alone (a list of reasons, [] when it may share the machine): the patterns above over its source, plus anything named in
// `known` ({ name: reason }) that a pattern cannot see.
const KNOWN_EXCLUSIVE = {};
function sharedResources(name, source, known = KNOWN_EXCLUSIVE) {
  const why = SHARED_RESOURCE_PATTERNS.filter(([, re]) => re.test(source || '')).map(([r]) => r);
  if (known[name]) why.push(known[name]);
  return why;
}

// Stages ([{ name, kind: 'plain' | 'electron' }]) into phases of lanes: lanes of one phase run at the same time, phases one after another.
// A lane is { stages, jobs, kind }: `jobs` stages of it run at once (the Electron lane's concurrency; always 1 for the pure-node lane).
//   Parallel: [pure-node stages | the other Electron suites, `electronJobs` at a time], then the shared-resource suites one at a time and alone,
//   then the perf-sensitive ones alone. Serial, or electronJobs 1: one lane in the old order (no overlap, so nothing needs to run alone), perf last.
// `exclusive` is a predicate over a suite name (see sharedResources).
function planLanes(stages, { serial = false, electronJobs = 1, exclusive = () => false } = {}) {
  const pure = stages.filter((s) => s.kind === 'plain');
  const isPerf = (s) => isPerfSensitive(s.name);
  const perf = stages.filter((s) => s.kind === 'electron' && isPerf(s)).sort((a, b) => PERF_SENSITIVE.indexOf(a.name) - PERF_SENSITIVE.indexOf(b.name));
  const rest = stages.filter((s) => s.kind === 'electron' && !isPerf(s));
  const jobs = Math.max(1, Math.floor(electronJobs) || 1);
  const lane = (list, n, kind) => ({ stages: list, jobs: n, kind });
  let phases;
  if (serial) phases = [[lane([...pure, ...rest], 1, 'pure')], [lane(perf, 1, 'electron')]];
  else if (jobs === 1) phases = [[lane(pure, 1, 'pure'), lane(rest, 1, 'electron')], [lane(perf, 1, 'electron')]];
  else {
    const alone = rest.filter((s) => exclusive(s.name));
    phases = [[lane(pure, 1, 'pure'), lane(rest.filter((s) => !exclusive(s.name)), jobs, 'electron')], [lane(alone, 1, 'electron')], [lane(perf, 1, 'electron')]];
  }
  return phases.map((lanes) => lanes.filter((l) => l.stages.length)).filter((lanes) => lanes.length);
}

// How many Electron suites run at once by default: min(3, one per 4 cores, one per 10 GB of RAM), at least 1.
function electronJobs({ cpus, ramGb }) {
  return Math.max(1, Math.min(3, Math.floor(cpus / 4), Math.floor(ramGb / 10)));
}

// How many unit suites test-units.js runs at once: leave cores for a concurrent Electron lane, never fewer than 2 or more than 8.
function unitJobs({ cpus, withElectron, electronJobs: ej = 1 }) {
  return Math.max(2, Math.min(8, Math.floor(cpus / (withElectron ? Math.max(4, ej + 2) : 2))));
}

// ----------------------------------------------------------------------------------------------------------- which suites a release runs

// The suites every default release runs: the app starts, its main surfaces draw, nothing logs an error, the budgets hold.
const CORE_SUITES = ['smoke', 'basics', 'no-errors', 'ui', 'settings', 'tabstrip', 'browser', 'first-run', 'relaunch', 'perf-budget'];

const stemOf = (file) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/-units$/, '');

// A default release's Electron suites: the core set plus the suites related to the files changed since the last release tag.
// changed: repo paths; electron: the candidate suite names; sources: { name: the suite's source }. Related when the suite is itself a changed
// test file, its source mentions a changed module by path ("features/spotify-view") or by file name ("spotify-view.js"), or its name starts
// with the changed file's name or the other way round (src/renderer/settings.js -> settings, settings-open-perf; at least 4 letters).
// Returns { names, reasons: { name: why }, full }: `full` is true when a build, dependency or workflow file changed, because then nothing
// narrows the choice.
function selectSuites({ changed, electron, sources, core = CORE_SUITES }) {
  const reasons = {};
  const add = (name, why) => { if (electron.includes(name) && !reasons[name]) reasons[name] = why; };
  for (const c of core) add(c, 'core');
  const files = changed.filter((f) => !/^(CHANGELOG\.md|docs\/|README)/.test(f));
  const full = files.some((f) => /^(package(-lock)?\.json|scripts\/(build|bundle)|electron-builder|\.github\/)/.test(f));
  for (const f of files) {
    const stem = stemOf(f);
    if (/^test\/[^/]+\.js$/.test(f)) add(f.slice(5, -3), `changed: ${f}`);
    if (!/^src\//.test(f) || /bundle|\.html$|\.json$/.test(f)) continue;
    const mod = f.replace(/^src\//, '').replace(/\.[^.]+$/, '');
    for (const name of electron) {
      if (reasons[name]) continue;
      const src = sources[name] || '';
      if (stem.length >= 4 && (name === stem || name.startsWith(`${stem}-`) || (stem.startsWith(`${name}-`) && name.length >= 4))) add(name, `named like ${f}`);
      else if (src.includes(mod) || (stem.length >= 5 && src.includes(`${stem}.js`))) add(name, `uses ${f}`);
    }
  }
  const names = electron.filter((n) => reasons[n]);
  return { names, reasons, full };
}

// ----------------------------------------------------------------------------------------------------------------- node_modules

// Can a worktree reuse the main checkout's node_modules? hidden: node_modules/.package-lock.json of the main checkout (what npm installed),
// lock: the worktree's package-lock.json. Every non-optional package must be installed at the locked version.
function nodeModulesMatch(hidden, lock) {
  if (!hidden || !hidden.packages || !lock || !lock.packages) return { ok: false, reason: 'no lockfile to compare' };
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || entry.link) continue;
    const have = hidden.packages[name];
    if (!have) { if (entry.optional || entry.peer) continue; return { ok: false, reason: `${name} is not installed` }; }
    if (have.version !== entry.version) return { ok: false, reason: `${name} is ${have.version} there, ${entry.version} in the lockfile` };
  }
  return { ok: true, reason: 'every locked package is installed at its locked version' };
}

// ---------------------------------------------------------------------------------------------------------------------- the plan

// The stages in order; a state file records the last one finished ('none' before the first).
const STAGES = ['worktree', 'install', 'prepare', 'preflight', 'checks', 'pr', 'ci', 'merge', 'tag', 'publish'];
const stageDone = (st, stage) => STAGES.indexOf(st.stage) >= STAGES.indexOf(stage);

// What --resume still has to do for a recorded state: the stages after the last finished one. The build preflight is skipped by --no-preflight and
// --checks-only (nothing is pushed then); and while the CI gate is still ahead it is always checked again before the PR (a release whose checks ran with
// --checks-only has none yet, and one whose run was cancelled or failed gets a new dispatch), so a resume never trusts a stale run.
function stagesLeft(st, { checksOnly = false, noPreflight = false } = {}) {
  let left = STAGES.filter((s) => !stageDone(st, s));
  if (noPreflight || checksOnly) left = left.filter((s) => s !== 'preflight');
  if (checksOnly) return left.filter((s) => STAGES.indexOf(s) <= STAGES.indexOf('checks'));
  if (!noPreflight && !stageDone(st, 'ci') && !left.includes('preflight')) { const at = left.indexOf('pr'); left.splice(at >= 0 ? at : 0, 0, 'preflight'); }
  return left;
}

// The release stages as printed by --dry-run: [{ id, text, parallel }]; `parallel` stages run at the same time as the stage before them.
function releasePlan({ version, date, opts, counts = {} }) {
  const p = [];
  const add = (id, text, parallel = false) => p.push({ id, text, parallel });
  add('worktree', `git fetch (retried on network errors), worktree add release-${version} from origin/main`);
  add('install', opts.freshInstall ? 'npm ci --ignore-scripts, copy node_modules/electron/dist and path.txt from the main checkout' : 'reuse the main checkout\'s node_modules through a junction when its installed versions match this lockfile (else npm ci --ignore-scripts and copy electron/dist)');
  add('prepare', `fold the notes of any burned version (tag pushed, release never published) into Unreleased; CHANGELOG "## Unreleased" -> "## ${version} (${date})"; npm version ${version} --no-git-tag-version; node --check src/main.js; commit "Release ${version}"`);
  const early = !opts.noPreflight && !opts.checksOnly;
  if (early) add('preflight', `push release-${version} and dispatch release.yml on it (workflow_dispatch: builds win + mac and runs their tests, publishes nothing)`);
  add('checks', `${counts.stages || '?'} stages: ${opts.serialChecks ? 'one after another' : 'pure-node lane (units in parallel, acceptance, lint) alongside the Electron lane (' + (counts.electronJobs || 1) + ' suite(s) at a time; suites sharing a port, the clipboard or the machine run alone); perf-sensitive suites (' + PERF_SENSITIVE.join(', ') + ') alone at the end'}; the Electron lock is ${opts.holdLock ? 'held while Electron runs' : 'taken per suite'}`, early);
  if (opts.checksOnly) { add('stop', 'stop here (--checks-only): nothing pushed; --resume ships it'); return p; }
  add('pr', `push release-${version} (retried), gh pr create "Release ${version}"`);
  add('ci', (opts.noSkipCi ? 'wait for CI on the PR head' : 'skip the wait for the PR\'s CI when the commit is verified to be only the CHANGELOG cut and the version fields and CI passed on its base commit; otherwise wait for CI') + (opts.noPreflight ? '' : '. Wait for the preflight run to pass'));
  add('merge', 'gh pr merge --squash --match-head-commit');
  add('tag', `annotated v${version} on the merge commit, pushed (retried)`);
  add('publish', `release.yml on the tag: publish the preflight's artifacts when the tagged tree equals the preflight's tree and every checksum matches, else build at the tag; expect ${opts.assets} assets`);
  return p;
}

module.exports = {
  mergeBlocker, lockDecision,
  sectionVersion, findBurned, foldBurned,
  RELEASE_FILES, ciSkipVerdict,
  pickPreflightRun, runVerdict, buildManifest, artifactsReusable, verifyChecksums,
  PERF_SENSITIVE, isPerfSensitive, planLanes, unitJobs, electronJobs, sharedResources, SHARED_RESOURCE_PATTERNS, KNOWN_EXCLUSIVE, CORE_SUITES, selectSuites,
  STAGES, stageDone, stagesLeft, nodeModulesMatch, releasePlan,
  parseChangelog, mergeChangelog, cutChangelog, changelogSection,
  readSuites, mergeSuiteList, splitSuiteFile,
  parseVersion, compareVersions, bumpVersion,
  isPlainSuite, deriveChecks, procsUnder,
};

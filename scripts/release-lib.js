// Pure helpers behind scripts/land.js, scripts/release.js and the git merge drivers (scripts/merge-driver.js): the CHANGELOG and
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

// ------------------------------------------------------------------------------------------------------ scripts/test-all.js

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

// The suite names in scripts/test-all.js, in order.
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

// mergeSuiteList(base, ours, theirs) -> { ok, text } or { ok: false, reason } for scripts/test-all.js. Only the SUITES array is merged by name; the rest of the file must have changed on one side only.
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

// Suites that need no window: scripts/test-units.js runs them (every *-units.js plus these).
const isPlainSuite = (name) => name === 'units' || name === 'cli-json' || name.endsWith('-units');

// deriveChecks({ suites, files }): suites is the list from scripts/test-all.js, files the names in test/ (without .js).
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

module.exports = {
  mergeBlocker, lockDecision,
  parseChangelog, mergeChangelog, cutChangelog, changelogSection,
  readSuites, mergeSuiteList, splitSuiteFile,
  parseVersion, compareVersions, bumpVersion,
  isPlainSuite, deriveChecks, procsUnder,
};

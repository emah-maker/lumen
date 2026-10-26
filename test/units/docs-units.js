// [docs] The documentation keeps up with the code (CLAUDE.md, "Docs"; scripts/build/check-docs.js is the same check for a
// branch). Plain Node: every setting in DEFAULTS has a row in docs/settings.md (bar the internal ones) and every documented key exists; no
// retired "Settings → …" path survives in the code or docs; and every docs page the site lists exists, and every site page is linked.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

// Keys in DEFAULTS that have no row in docs/settings.md on purpose: state Lumen keeps itself, with no control to describe (audit #39).
// Anything else added to DEFAULTS needs a row. Names here must exist in DEFAULTS.
const INTERNAL = new Set([
  'newTabImage', // when the wallpaper file was last set
  'homeWidgets', 'homeWidgetSizes', 'weatherPlaces', 'weatherHere', // widget state, changed through the widget UI
  'tabSleepFreePercent', // legacy: replaced by the tabSleepPressure choices
  'featureOffersSeen', 'featureCardNever', // offer flags Lumen records itself
]);

const backend = read('src/settings/settings-backend.js');
const start = backend.indexOf('const DEFAULTS = {');
const keys = [...backend.slice(start, backend.indexOf('\n};', start)).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
const settingsDoc = read('docs/settings.md');
const documented = (k) => settingsDoc.includes('`' + k + '`');
check('DEFAULTS was found', keys.length > 50, keys.length);
const missing = keys.filter((k) => !documented(k) && !INTERNAL.has(k));
check('every setting in DEFAULTS has a row in docs/settings.md (or is listed as internal)', !missing.length, `add a row for: ${missing.join(', ')}`);
const staleInternal = [...INTERNAL].filter((k) => !keys.includes(k));
check('every name in the internal list still exists in DEFAULTS', !staleInternal.length, staleInternal.join(', '));

// The other direction: a Key cell in a settings table names a setting the code really has. A setting is real when it is in DEFAULTS or
// its name appears in the app's own code (some are only ever written with writeSettings, never listed in DEFAULTS).
const listFiles = (dir, keep, skipDirs = []) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (!skipDirs.includes(name)) out.push(...listFiles(p, keep, skipDirs)); } else if (keep.test(name)) out.push(p);
  }
  return out;
};
const code = listFiles(path.join(root, 'src'), /^(?!.*\.bundle\.js$).*\.js$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const docKeys = []; // [key, setting name]
{
  let keyed = false;
  for (const line of settingsDoc.split(/\r?\n/)) {
    if (!line.startsWith('|')) { keyed = false; continue; }
    const cells = line.split('|').map((c) => c.trim());
    if (/^-+$/.test(cells[1] || '')) continue;
    if (cells[1] === 'Setting' && cells[2] === 'Key') { keyed = true; continue; }
    if (!keyed) continue;
    for (const m of (cells[2] || '').matchAll(/`(\w+)`/g)) docKeys.push([m[1], cells[1]]);
  }
}
check('the settings tables were found', docKeys.length > 100, docKeys.length);
const ghosts = docKeys.filter(([k]) => !keys.includes(k) && !new RegExp(`\\b${k}\\b`).test(code));
check('every key documented in docs/settings.md exists in the code', !ghosts.length, `no such setting: ${ghosts.map(([k, row]) => `${k} (${row})`).join(', ')}`);
const rowsOf = new Map();
for (const [k, row] of docKeys) rowsOf.set(k, [...(rowsOf.get(k) || []), row]);
const twice = [...rowsOf].filter(([, rows]) => rows.length > 1);
check('no key has two rows in docs/settings.md', !twice.length, twice.map(([k, rows]) => `${k}: ${rows.join(' / ')}`).join('; '));

// Settings paths in strings, comments and docs name the page as it is now. The categories come from the settings page itself, so a
// rename there fails this test until the docs follow.
const categoryTitles = [...read('src/renderer/settings.js').match(/const CATEGORIES = \[[\s\S]*?\n\];/)[0].matchAll(/\{ id: '[\w-]+', title: '([^']+)'/g)].map((m) => m[1]);
check('the settings page has the categories the docs name', ['General', 'Appearance', 'Accessibility', 'AI', 'Apps and connections', 'New tab page', 'Tabs and browsing', 'Privacy and security', 'Downloads and files', 'Updates and about', 'Advanced'].every((t) => categoryTitles.includes(t)), categoryTitles.join(', '));
const ARROW = '\\s*(?:→|>)\\s*';
const OWN = '(?<!System |Windows |macOS )'; // the operating system's own Settings app is another thing
const RETIRED = [
  [new RegExp(`Settings${ARROW}You and AI`), 'Settings → AI'],
  [/(?<![\w ])You and AI\s*→/, 'AI → …'],
  [new RegExp(`Settings${ARROW}AI and agents`), 'Settings → AI'],
  [new RegExp(`About Lumen${ARROW}Updates`), 'Settings → Updates and about'],
  [new RegExp(`${OWN}Settings${ARROW}About\\b`), 'Settings → Updates and about'],
  [new RegExp(`${OWN}Settings${ARROW}Updates(?! and about)`), 'Settings → Updates and about'],
  [new RegExp(`${OWN}Settings${ARROW}Privacy(?! and security| &)`), 'Settings → Privacy and security'],
  [new RegExp(`${OWN}Settings${ARROW}Downloads(?! and files)`), 'Settings → Downloads and files'],
  [new RegExp(`${OWN}Settings${ARROW}System\\b`), 'Settings → Advanced'],
  [new RegExp(`${OWN}Settings${ARROW}Languages\\b`), 'Settings → General → Language and spelling'],
  [new RegExp(`${OWN}Settings${ARROW}Translation\\b`), 'Settings → General → Language and spelling'],
  [new RegExp(`${OWN}Settings${ARROW}Appearance${ARROW}Accessibility\\b`), 'Settings → Accessibility'],
  [new RegExp(`${OWN}Settings${ARROW}Home\\b`), 'Settings → New tab page'],
  [new RegExp(`${OWN}Settings${ARROW}Tabs(?! and browsing)\\b`), 'Settings → Tabs and browsing'],
  [new RegExp(`${OWN}Settings${ARROW}(?:Connectors|Widgets)\\b`), 'Settings → Apps and connections'],
];
// (docs/ux-audit is a dated record of what the pages said then)
const scanned = [
  ...listFiles(path.join(root, 'src'), /\.(js|json|html|css)$/),
  ...listFiles(path.join(root, 'docs'), /\.md$/, ['ux-audit']),
  ...['README.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md', 'mcp.js', 'site/index.html'].map((f) => path.join(root, f)),
];
const retiredHits = [];
for (const file of scanned) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [re, now] of RETIRED) {
    const all = new RegExp(re.source, 'g');
    let hit;
    while ((hit = all.exec(text))) retiredHits.push(`${path.relative(root, file).replace(/\\/g, '/')}:${text.slice(0, hit.index).split('\n').length} "${hit[0]}" -> ${now}`);
  }
}
check('no retired Settings path appears in src/, README, PRIVACY or docs', !retiredHits.length, retiredHits.slice(0, 8).join('\n   '));

const site = read('site/docs.js');
const listed = [...site.matchAll(/file: '([^']+\.md)'/g)].map((m) => m[1]);
const absent = listed.filter((f) => !fs.existsSync(path.join(root, f)));
check('every page the docs site lists exists', listed.length > 3 && !absent.length, absent.join(', '));
const index = read('site/index.html');
const ids = [...site.matchAll(/^ {2}'?([\w-]+)'?: \{ title:/gm)].map((m) => m[1]);
const unlinked = ids.filter((id) => !['readme', 'changelog'].includes(id) && !index.includes(`docs.html?p=${id}`) && !read('README.md').includes(`docs/${id}.md`));
check('every docs-site page is linked from the site or the README', !unlinked.length, unlinked.join(', '));

const claude = read('CLAUDE.md');
check('CLAUDE.md carries the docs rule and names the checker', /## Docs/.test(claude) && claude.includes('scripts/build/check-docs.js'));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

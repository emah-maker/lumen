// [docs] The documentation keeps up with the code (CLAUDE.md, "Docs"; scripts/check-docs.js is the same check for a
// branch). Plain Node: every setting in DEFAULTS has a row in docs/settings.md, except the older ones listed below that
// were undocumented when this test was added; and every docs page the site lists exists, and every site page is linked.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

// Undocumented when this test was written (2026-10-10). Only ever remove names from this list: document one, then delete it here.
const KNOWN_UNDOCUMENTED = new Set([
  'accentColor', 'newTabBackground', 'newTabEffect', 'newTabEffectColor', 'newTabEffectAmount', 'newTabEffectSpeed', 'newTabEffectSize', 'newTabEffectInteract',
  'newTabImage', 'newTabClock', 'newTabClockSize', 'newTabClockStyle', 'newTabClockHours', 'newTabClockSeconds', 'newTabClockDate', 'newTabClockCard',
  'newTabClockShadow', 'newTabGreetingFont', 'newTabSearchWidth', 'newTabName', 'newTabHeader', 'newTabFavorites', 'newTabFrequent', 'newTabPrivacy',
  'newTabWidgetsPacked', 'homeWidgetSizes', 'weatherPlaces', 'weatherHere', 'weatherLocation', 'homeWidgets', 'pdfViewer', 'tabSleepMode', 'tabSleepMinutes',
  'tabSleepHow', 'tabSleepFreePercent', 'tabSleepLumenGb', 'tabSleepMaxAwake', 'tabSleepKeepPinned', 'tabSleepKeepRecent', 'tabSleepNever',
  'tabSleepFreezeFirstMinutes', 'tabPreload', 'performanceMode', 'organizeOnlyMixed', 'organizeDelaySeconds', 'maxSteps', 'aiSubagents', 'aiSubagentModel',
  'maxChatRuns', 'autoModel', 'usageBars', 'aiSignedInSites', 'pinchZoom', 'featureOffersSeen', 'aiDeviceAccess', 'grokTerminal', 'grokKeepConnected',
  'codexKeepConnected', 'grokKeepIdleMinutes', 'researchTabs', 'sidebarNewChat',
]);

const backend = read('src/settings/settings-backend.js');
const start = backend.indexOf('const DEFAULTS = {');
const keys = [...backend.slice(start, backend.indexOf('\n};', start)).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
const settingsDoc = read('docs/settings.md');
const documented = (k) => settingsDoc.includes(`\`${k}\``);
check('DEFAULTS was found', keys.length > 50, keys.length);
const missing = keys.filter((k) => !documented(k) && !KNOWN_UNDOCUMENTED.has(k));
check('every new setting has a row in docs/settings.md', !missing.length, `add a row for: ${missing.join(', ')}`);
const stale = [...KNOWN_UNDOCUMENTED].filter((k) => documented(k) || !keys.includes(k));
check('the list of older undocumented settings only shrinks (remove names that are now documented or gone)', !stale.length, stale.join(', '));

const site = read('site/docs.js');
const listed = [...site.matchAll(/file: '([^']+\.md)'/g)].map((m) => m[1]);
const absent = listed.filter((f) => !fs.existsSync(path.join(root, f)));
check('every page the docs site lists exists', listed.length > 3 && !absent.length, absent.join(', '));
const index = read('site/index.html');
const ids = [...site.matchAll(/^ {2}'?([\w-]+)'?: \{ title:/gm)].map((m) => m[1]);
const unlinked = ids.filter((id) => !['readme', 'changelog'].includes(id) && !index.includes(`docs.html?p=${id}`) && !read('README.md').includes(`docs/${id}.md`));
check('every docs-site page is linked from the site or the README', !unlinked.length, unlinked.join(', '));

const claude = read('CLAUDE.md');
check('CLAUDE.md carries the docs rule and names the checker', /## Docs/.test(claude) && claude.includes('scripts/check-docs.js'));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

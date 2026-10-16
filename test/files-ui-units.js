// The Files feature's UI wiring, pure node (no window): the widget is a registered kind with sizes, a picker entry and a settings form; the
// Ctrl+Shift+F picker is in the UI bundle, its key is in the menu, the shortcuts sheet and the page-first list, and every string it shows
// has a locale key; the page code never puts a file name into markup. The real-window checks are files-widget.js, files-picker.js and
// files-perf.js.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

module.exports = async function filesUiUnits(check) {
  const { CONNECTORS, INLINE } = require('../src/features/widgets');
  const WL = require('../src/features/widget-layout');
  const WE = require('../src/features/widget-edit');
  const WS = require('../src/renderer/widget-summary');
  const PF = require('../src/features/page-first-keys');
  const en = JSON.parse(read('src', 'locales', 'en.json'));

  // ---- the widget kind ----
  check('files widget: a connector with nothing to fetch, a default size, and a minimum of 2 by 2', Boolean(CONNECTORS.files) && WL.limitsOf('files').minW === 2 && WL.limitsOf('files').minH === 2 && WL.defaultSize('files').w >= 2 && WL.defaultSize('files').h >= 3, '');
  check('files widget: the page can add and edit it itself', typeof INLINE.files === 'function', '');
  const cleaned = CONNECTORS.files.clean({ colors: 'accent', junk: 1 });
  check('files widget: its stored settings are checked (colours only), and it has a title and a summary', cleaned && Object.keys(cleaned).join() === 'colors' && CONNECTORS.files.title({}) === 'Files' && /file/i.test(CONNECTORS.files.summary({})), JSON.stringify(cleaned));
  check('files widget: the Add widget picker lists it, with a hint, among the work widgets', WE.pickerEntries({ types: ['files'], hidden: [], table: null, stack: false }).some((e) => e.type === 'files' && e.label === 'Files' && e.hint && e.group === 'work'), JSON.stringify(WE.pickerEntries({ types: ['files'], hidden: [], table: null, stack: false })));
  check('files widget: Settings names it and lists it in the picker order', WS.kindName('files') === 'Files' && WS.ORDER.includes('files') && WS.widgetSummary({ type: 'files' }, {}) === 'Pinned and recent files', '');
  check('files widget: the picker strings are in locales/en.json', ['newtab.edit.type.files', 'newtab.edit.type.files.hint'].every((k) => en[k]), '');

  // ---- the new-tab page code ----
  const page = read('src', 'renderer', 'newtab-widgets.js');
  check('files card: a renderer, drawn through the page bridge and nothing from a name goes in markup', /^ {2}files\(w, card\) \{/m.test(page) && !/innerHTML\s*=\s*[^;]*\be\.(name|path)\b/.test(page) && !/innerHTML[^;\n]*(\.name|\.path|candidate)/i.test(page.slice(page.indexOf('the Files card'), page.indexOf('const WIDGET_RENDERERS'))), '');
  check('files card: the page never opens a path, it hands back the id main gave it', /lumenFiles\.open\(e\.id\)/.test(page) && /lumenFiles\.show\(e\.id\)/.test(page) && !/lumenFiles\.open\(e\.path\)/.test(page), '');
  check('files card: it is keyboard-reachable (buttons, a menu with arrows and Esc, a visible focus ring) and respects reduced motion', /className.*fl-main|el\('button', 'fl-main'\)/.test(page) && /role', 'menuitem'/.test(page) && /ArrowDown/.test(page) && /\.fl-main:focus-visible/.test(read('src', 'renderer', 'newtab.html')) && /prefers-reduced-motion[^}]*\.fl-row/.test(read('src', 'renderer', 'newtab.html')), '');
  check('files card: the empty state says what to do', /Pin a folder or open a file to see it here/.test(page), '');
  check('files card: a missing file says "moved or deleted" and offers Find it', /moved or deleted/.test(page) && /'Find it'/.test(page) && /lumenFiles\.find\(e\.id\)/.test(page) && /lumenFiles\.relocate\(e\.id, c\.path\)/.test(page), '');

  // ---- the picker ----
  const picker = read('src', 'renderer', 'files-picker.js');
  check('files picker: it is not in the UI bundle (19 KB it need not parse at start): app.js loads files-picker.js and .css when asked or in an idle moment', !read('src', 'renderer', 'index.src.html').includes('files-picker') && !read('src', 'renderer', 'ui.bundle.js').includes('const filesPicker') && /files-picker.css/.test(read('src', 'renderer', 'app.js')) && /files-picker.js/.test(read('src', 'renderer', 'app.js')) && read('src', 'renderer', 'files-picker.css').includes('.files-picker-box'), '');
  check('files picker: searches 60 ms after the last key, draws at most 30 rows, drops a late answer', /DEBOUNCE_MS = 60/.test(picker) && /MAX_ROWS = 30/.test(picker) && /mine !== asked/.test(picker), '');
  check('files picker: Enter opens, Ctrl+Enter shows in the folder, Alt+Enter attaches, Esc closes', /e\.ctrlKey \|\| e\.metaKey/.test(picker) && /attach: e\.altKey/.test(picker) && /files\.attach\(id\)/.test(picker) && /files\.show\(id\)/.test(picker) && /files\.open\(id\)/.test(picker) && /'Escape'/.test(picker), '');
  check('files picker: a file name is only ever set as text, never as markup', !/innerHTML[^;\n]*(\.name|\.path|entry)/.test(picker), '');
  check('files picker: the UI bridge announces the key', /onOpenFilesPicker: on\('files:picker'\)/.test(read('src', 'preload', 'preload.js')) && read('src', 'preload', 'preload.bundle.js').includes("files:picker"), '');
  const strings = [...picker.matchAll(/tr\('(filesPicker\.[A-Za-z]+)'/g)].map((m) => m[1]);
  check('files picker: every string it asks for has a locale key', strings.length >= 10 && strings.every((k) => en[k]), strings.filter((k) => !en[k]).join());

  // ---- the key ----
  const main = read('src', 'main.js');
  check('files picker: Ctrl+Shift+F is handled before Find in page, and is in both menus', main.indexOf("key === 'f') openFilesPicker()") > 0 && main.indexOf("key === 'f') openFilesPicker()") < main.indexOf("else if (mod && key === 'f') openFindBar()") && (main.match(/menu\.findFiles/g) || []).length === 2 && /ui\(\)\?\.send\('files:picker'\)/.test(main), '');
  check('files picker: the page can claim Ctrl+Shift+F first, like tab search', PF.PAGE_FIRST.some((k) => k.combo === 'mod+shift+f'), '');
  const help = read('src', 'features', 'shortcuts-help.js');
  check('files picker: the shortcuts sheet lists it', help.includes("['shortcuts.findFiles', ['mod+shift+f']]") && en['shortcuts.findFiles'] && en['menu.findFiles'], '');

  // ---- the words ----
  const cardKeys = [...new Set([...page.matchAll(/\bft\('(files\.card\.[A-Za-z]+)'/g)].map((m) => m[1]))];
  check('files card: every string it shows goes through ft() and has a locale key (files.card.*)', cardKeys.length >= 30 && cardKeys.every((k) => en[k]), cardKeys.filter((k) => !en[k]).join());
  const cardWords = page.slice(page.indexOf('the Files card (features/files.js)'), page.indexOf('const WIDGET_RENDERERS'));
  check('files card: the old labels are gone from the card code, and the times are not hand-made', !/'Remove from list'/.test(cardWords) && !/min ago`/.test(cardWords) && /Intl\.RelativeTimeFormat/.test(page), '');
  check('files card: the words are Remove from Files, Unpin and Clear Files list', en['files.card.remove'] === 'Remove from Files' && en['files.card.unpin'] === 'Unpin' && en['settings.files.clear'] === 'Clear Files list', '');
  check('files card: a missing row is Find it from a click anywhere on it, and the first match takes the focus', /fl-find, \.fl-more/.test(page) && /fileFocusAfter/.test(page) && /data-role="cand"/.test(page), '');
  check('files card: Unpin and Remove from Files offer Undo through lumenFiles.restore, and Remember-off offers Turn on', /lumenFiles\.restore\(id\)/.test(page) && /files\.card\.undo/.test(page) && /lumenFiles\.remember\(\)/.test(page) && /files\.card\.turnOn/.test(page), '');
  check('the new wording: "Open a recent file" in the menus, the sheet and the picker', en['menu.findFiles'] === 'Open a recent file…' && en['shortcuts.findFiles'] === 'Open a recent or pinned file' && en['filesPicker.label'] === 'Open a recent file' && /Open a recent file/.test(picker), '');
  check('files picker: no match offers "Search Documents, Desktop and Downloads" (scan), with Searching… and a "Found on this computer" group', /files\.scan\(q\)/.test(picker) && /action: 'scan'/.test(picker) && ['filesPicker.scan', 'filesPicker.searching', 'filesPicker.found', 'filesPicker.scanNone'].every((k) => en[k]) && /Search Documents, Desktop and Downloads/.test(en['filesPicker.scan']), '');

  // ---- the ops: scan and restore on every bridge, in main's list and the UI-only gate ----
  const files = require('../src/features/files');
  const ops = ['scan', 'restore'];
  check('files: scan and restore are ops of files.js and have a channel on all three bridges', ops.every((o) => files.OPS.includes(o) && files.channelFor.ui(o) === `files:${o}` && files.channelFor.newtab(o) === `newtab-files:${o}` && files.channelFor.settings(o) === `settings:files-${o}`), '');
  check('files: main lists the same ops and gates files:scan and files:restore to the UI', ops.every((o) => main.includes(`'files:${o}'`)) && /const OPS = \['list'[^\]]*'scan', 'restore'\]/.test(main), '');
  const bridges = [['preload.js', /'list [a-z ]*\bscan\b[a-z ]*'\.split/, /'list [a-z ]*\brestore\b[a-z ]*'\.split/], ['files-newtab-preload.js', /scan: call\('newtab-files:scan'\)/, /restore: call\('newtab-files:restore'\)/], ['settings-preload.js', /scan: call\('settings:files-scan'\)/, /restore: call\('settings:files-restore'\)/]];
  check('files: the three preload bridges carry scan and restore', bridges.every(([f, a, b]) => a.test(read('src', 'preload', f)) && b.test(read('src', 'preload', f))), '');
  check('files: a new profile (and only a new one) gets the Files card on its new-tab page', /seedFirstRunWidgets/.test(main) && /settingsFileExisted !== false/.test(main) && /!TEST\) seedFirstRunWidgets/.test(main), '');

  // ---- Settings > General > Files ----
  const settings = read('src', 'renderer', 'settings.js');
  const buildFiles = settings.slice(settings.indexOf('async function buildFiles'), settings.indexOf('async function buildDownloads'));
  const buildPrivacy = settings.slice(settings.indexOf('async function buildPrivacy'), settings.indexOf('async function buildPasswords') > 0 ? settings.indexOf('async function buildPasswords') : undefined);
  check('settings: General > Files has "Remember files I open" (filesRemember) and a confirmed "Clear Files list" (files-clear)', /toggle\('filesRemember'/.test(buildFiles) && /S\.files\.clear\(\)/.test(buildFiles) && /armedButton\(tr\('settings\.files\.clearGo'/.test(buildFiles) && /'files-clear'/.test(buildFiles) && /\['files', 'Files'\]/.test(settings) && /\['files', buildFiles\]/.test(settings), '');
  check('settings: Privacy keeps only a pointer row (Recent files: General > Files) and "files" is a settings link', !/toggle\('filesRemember'/.test(buildPrivacy) && /settings\.files\.privacyRef/.test(buildPrivacy) && /files: \{ cat: 'general', focus: 'files' \}/.test(settings) && require('../src/settings/settings-backend').SECTION_LINKS.includes('files'), '');
  check('settings: the short Files description and the widget description are locale strings', en['settings.files.rememberDesc'] === 'Lumen remembers names and places of files you open, on this computer only. Never their contents.' && /widgets\.files\.desc/.test(settings) && Boolean(en['widgets.files.desc']), '');
  check('docs/settings.md: the Files rows are under General, not Privacy', (() => { const d = read('docs', 'settings.md'); const gen = d.indexOf('## General'); const next = d.indexOf('\n## ', gen + 5); const row = d.indexOf('| Remember files I open |'); return row > gen && row < next && d.includes('| Clear Files list |') && !d.includes('| Clear file list |'); })(), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}

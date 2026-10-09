// The downloads panel, Downloads, History, Bookmarks and error pages take their wording from
// locales/en.json (renderer/i18n.js), plain Node: every key the pages use exists, each page loads
// i18n.js and has a preload that hands it the table, and a translation reaches the error page's text.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createI18n } = require('../src/features/i18n');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const EN = JSON.parse(read('src/locales/en.json'));

const PAGES = {
  'downloads-panel': { html: 'downloads-panel.html', js: 'downloads-panel.js', preload: 'src/preload/downloads-preload.js' },
  downloads: { html: 'downloads.html', js: 'downloads.js', preload: 'src/features/managers-preload.js' },
  history: { html: 'history.html', js: 'history.js', preload: 'src/preload/history-preload.js' },
  bookmarks: { html: 'bookmarks.html', js: 'bookmarks.js', preload: 'src/features/managers-preload.js' },
  error: { html: 'error.html', js: 'error.js', preload: 'src/preload/error-preload.js' },
};

// ---- keys
const used = new Set();
for (const p of Object.values(PAGES)) {
  const html = read(`src/renderer/${p.html}`);
  const js = read(`src/renderer/${p.js}`);
  for (const m of html.matchAll(/data-i18n[a-z-]*="([^"]+)"/g)) used.add(m[1]);
  for (const m of js.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
  for (const m of js.matchAll(/window\.t\('([^']+)'/g)) used.add(m[1]);
}
for (const m of read('src/renderer/error-kinds.js').matchAll(/t\('([^']+)'/g)) used.add(m[1]);
// keys built from an action name
for (const a of ['pause', 'resume', 'cancel', 'retry', 'show', 'remove']) used.add(`dlpanel.action.${a}`);
for (const a of ['open', 'show', 'remove', 'pause', 'resume', 'cancel', 'retry']) used.add(`dlpage.action.${a}`);
const missing = [...used].filter((k) => typeof EN[k] !== 'string');
check('every key the pages use is in locales/en.json', used.size > 50 && missing.length === 0, missing.join(', '));

const EK = require('../src/renderer/error-kinds');
const kindKeys = [];
for (const [name, kind] of Object.entries(EK.KINDS)) {
  if (kind.same) { if (!EK.KINDS[kind.same] || EK.KINDS[kind.same].same) kindKeys.push(`alias ${name}`); continue; }
  kindKeys.push(`errorPage.kind.${name}.title`, `errorPage.kind.${name}.message`);
  if (!kind.noHint) kindKeys.push(`errorPage.kind.${name}.hint`);
}
check('every error kind has its wording in en.json', kindKeys.every((k) => typeof EN[k] === 'string'), kindKeys.filter((k) => typeof EN[k] !== 'string').join(', '));
check('no error wording is left in error-kinds.js itself', !/’|can’t|refused to/.test(read('src/renderer/error-kinds.js').replace(/\/\/.*$/gm, '')));

// ---- no English left in the pages' scripts
const literal = {
  'downloads-panel.js': ['Waiting for your OK', 'Show in folder', 'Remove from list', 'Clear list', ' left`'],
  'downloads.js': ['Waiting for your OK', 'No downloads yet', 'Starting…', "'Show in folder'"],
  'history.js': ["'Today'", "'Yesterday'", 'No history yet', 'Remove from history'],
  'bookmarks.js': ['No bookmarks yet', 'Bookmark saved', 'Could not save', "'Cancel'"],
  'error.js': ['This page crashed', 'Something went wrong', "'Reload'"],
};
for (const [file, strings] of Object.entries(literal)) {
  const src = read(`src/renderer/${file}`);
  const left = strings.filter((s) => src.includes(s));
  check(`${file}: no hard-coded English left`, left.length === 0, left.join(' | '));
}

// ---- wiring
for (const [name, p] of Object.entries(PAGES)) {
  const html = read(`src/renderer/${p.html}`);
  check(`${name}: loads i18n.js before its own script`, html.includes('<script src="i18n.js">') && html.indexOf('i18n.js') < html.indexOf(`src="${p.js}"`) && (name !== 'error' || html.indexOf('i18n.js') < html.indexOf('error-kinds.js')), '');
  check(`${name}: its preload hands over the string table`, /exposeInMainWorld\('lumenI18n', ipcRenderer\.sendSync\('pages:strings'\)/.test(read(p.preload)), p.preload);
}
const main = read('src/main.js');
check('main answers pages:strings, only to Lumen\'s own renderer pages', /ipcMain\.on\('pages:strings'[\s\S]{0,200}startsWith\(RENDERER_PAGES\)/.test(main));
check('the error page preload is registered for tab sessions (normal, private, research)', (main.match(/lumen-error-page/g) || []).length === 3);
check('the error page preload does nothing on other pages', /location\.protocol === 'file:' && \/\\\/renderer\\\/error\\\.html\$\//.test(read('src/preload/error-preload.js')));

// ---- a translation reaches the error page's text
{
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lumen-page-i18n-'));
  try {
    fs.copyFileSync(path.join(root, 'src/locales/en.json'), path.join(dir, 'en.json'));
    fs.writeFileSync(path.join(dir, 'xx.json'), JSON.stringify({ 'errorPage.kind.ERR_NAME_NOT_RESOLVED.title': 'Introuvable', 'errorPage.kind.ERR_NAME_NOT_RESOLVED.message': 'Aucun serveur pour {site}.', 'errorPage.theSite': 'le site', 'errorPage.retry': 'Réessayer', 'errorPage.crashed.message': 'Problème avec {site}.' }));
    const xx = createI18n({ locale: 'xx', dir });
    const d = EK.describe('ERR_NAME_NOT_RESOLVED', 'a.example', xx.t);
    check('a translated error title and message come through, with the host in place', d.title === 'Introuvable' && d.message === 'Aucun serveur pour “a.example”.' && /typo/.test(d.hint), JSON.stringify(d));
    check('without a host the translated "the site" stands in', EK.describe('ERR_NAME_NOT_RESOLVED', '', xx.t).message === 'Aucun serveur pour le site.');
    check('a missing translation falls back to English', EK.describe('ERR_CONNECTION_REFUSED', 'b.example', xx.t).title === '“b.example” refused to connect');

    // error.js end to end against stand-in elements: the crashed wording and the retry button.
    const els = { retry: { textContent: '', hidden: false }, message: { textContent: '' }, hint: { textContent: '', hidden: true }, code: { textContent: '' } };
    const h1 = { textContent: '' };
    const sandbox = {
      URLSearchParams, URL, location: { search: '?kind=crashed&url=https%3A%2F%2Fa.example%2F', replace() {} },
      document: { title: '', getElementById: (id) => els[id], querySelector: () => h1 },
      window: { t: xx.t, errorKinds: EK },
    };
    vm.runInNewContext(read('src/renderer/error.js'), sandbox);
    check('error.js: the crashed page uses the translated message and the Reload button', els.message.textContent === 'Problème avec “a.example”.' && h1.textContent === 'This page crashed' && els.retry.textContent === 'Reload', JSON.stringify({ m: els.message.textContent, h: h1.textContent, r: els.retry.textContent }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(failures ? 1 : 0);

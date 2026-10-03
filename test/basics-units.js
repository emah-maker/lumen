// Browser basics, pure Node (no Electron window): the Keyboard Shortcuts sheet (features/shortcuts-help.js),
// crash recovery's decision and marker (features/crash-recovery.js), page info's menu
// (features/page-info.js), the link and image menu items and "Save … As" marks (features/link-menu.js),
// per-site zoom (features/site-zoom.js), and that every string these use is in locales/en.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const SH = require('../src/features/shortcuts-help');
const CR = require('../src/features/crash-recovery');
const PI = require('../src/features/page-info');
const LM = require('../src/features/link-menu');
const SZ = require('../src/features/site-zoom');
const SD = require('../src/features/site-data');
const { registrableDomain } = require('../src/browser/tab-groups');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
const t = (key, vars) => String(en[key] ?? key).replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w));

(async () => {
  // ---- Keyboard Shortcuts
  check('shortcuts: a chord on macOS uses Apple\'s symbols and order', SH.formatChord('mod+shift+t', 'darwin') === '⇧⌘T' && SH.formatChord('mod+alt+l', 'darwin') === '⌥⌘L', SH.formatChord('mod+shift+t', 'darwin'));
  check('shortcuts: elsewhere it is Ctrl+Shift+T', SH.formatChord('mod+shift+t', 'win32') === 'Ctrl+Shift+T' && SH.formatChord('alt+left', 'linux') === 'Alt+←', SH.formatChord('mod+shift+t', 'win32'));
  check('shortcuts: named keys read as words', SH.formatChord('escape', 'win32') === 'Esc' && SH.formatChord('mod+pagedown', 'win32') === 'Ctrl+Page Down' && SH.formatChord('f12', 'win32') === 'F12', SH.formatChord('escape', 'win32'));
  const mac = SH.sheet('darwin');
  const win = SH.sheet('win32');
  const labels = (s) => s.flatMap((x) => x.entries.map((e) => e.label));
  const entry = (s, label) => s.flatMap((x) => x.entries).find((e) => e.label === label);
  check('shortcuts: History is ⌘Y on macOS and Ctrl+H elsewhere', entry(mac, 'shortcuts.history').keys.join() === '⌘Y' && entry(win, 'shortcuts.history').keys.join() === 'Ctrl+H', JSON.stringify([entry(mac, 'shortcuts.history'), entry(win, 'shortcuts.history')]));
  check('shortcuts: Hide Lumen is only on macOS', labels(mac).includes('shortcuts.hide') && !labels(win).includes('shortcuts.hide'), '');
  check('shortcuts: New Window and Close Window are listed', entry(win, 'shortcuts.newWindow').keys.join() === 'Ctrl+N' && entry(mac, 'shortcuts.closeWindow').keys.join() === '⇧⌘W', '');
  const missingLabels = SH.labelKeys().filter((k) => !(k in en));
  check('shortcuts: every section and label is in en.json', missingLabels.length === 0, missingLabels.join(', '));
  // Every simple Ctrl/Cmd chord on the sheet is one handleShortcut() in main.js really handles.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf('function handleShortcut('), main.indexOf('function newSidebarChat('));
  const chords = SH.SECTIONS.flatMap((s) => s.entries.flatMap(([, keys]) => keys.flatMap((k) => (typeof k === 'string' ? [k] : [k.mac, k.other].filter(Boolean)))));
  const unhandled = chords.filter((c) => /^mod\+(shift\+)?[a-z,]$/.test(c)).filter((c) => {
    const key = c.slice(-1);
    return !handler.includes(`key === '${key}'`);
  });
  check('shortcuts: every Ctrl/Cmd+letter on the sheet is handled in handleShortcut', handler.length > 1000 && unhandled.length === 0, unhandled.join(', '));
  let shown = null;
  const help = SH.createShortcutsHelp({ t, platform: 'win32', showNotes: async (opts) => { shown = opts; return { response: 0 }; } });
  check('shortcuts: open() shows the sheet in the notes dialog', (await help.open()) === true && shown.message === 'Keyboard Shortcuts' && shown.notes.length === win.length && shown.buttons[0] === 'Done', JSON.stringify(shown).slice(0, 200));
  check('shortcuts: a row reads "New tab: `Ctrl+T`" (keys drawn as code)', shown.notes[0].blocks[0].text === 'New tab: `Ctrl+T`', shown.notes[0].blocks[0].text);
  check('shortcuts: two chords are joined with "or"', shown.notes.flatMap((n) => n.blocks).some((b) => b.text === 'Reload: `Ctrl+R` or `F5`'), '');

  // ---- crash recovery
  const session = { urls: ['https://a.example/', 'https://b.example/'], more: [{ urls: ['https://c.example/'] }] };
  check('recovery: counts the tabs of every window', CR.tabCount(session) === 3 && CR.tabCount(null) === 0 && CR.tabCount({ urls: ['', 5] }) === 0, CR.tabCount(session));
  check('recovery: offers after a crash when startup opens a new tab or pages', CR.decide({ crashed: true, mode: 'newtab', saved: session }).offer && CR.decide({ crashed: true, mode: 'pages', saved: session }).offer, '');
  check('recovery: never when startup restores anyway, after a clean quit, or with nothing saved',
    !CR.decide({ crashed: true, mode: 'restore', saved: session }).offer && !CR.decide({ crashed: false, mode: 'newtab', saved: session }).offer && !CR.decide({ crashed: true, mode: 'newtab', saved: { urls: [] } }).offer, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-basics-units-'));
  try {
    const file = path.join(dir, 'running');
    let settings = { session };
    const cr = () => CR.createCrashRecovery({ file: () => file, readSettings: () => settings });
    const first = cr();
    check('recovery: a first start is not a crash, and writes the marker', !first.begin({ mode: 'newtab' }).crashed && fs.existsSync(file), '');
    first.end();
    check('recovery: a normal quit removes the marker', !fs.existsSync(file), '');
    const second = cr();
    check('recovery: after a clean quit nothing is offered', !second.begin({ mode: 'newtab' }).offer && second.take() === null, '');
    // second never called end(): a crash.
    const third = cr();
    const began = third.begin({ mode: 'newtab' });
    settings = { session: { urls: ['https://new.example/'] } }; // the new run saves over it
    const kept = third.take();
    check('recovery: after a crash the old session is kept aside and offered once', began.crashed && began.offer && kept.tabs === 3 && kept.saved.urls[0] === 'https://a.example/' && third.take() === null, JSON.stringify(kept));
    const fourth = cr();
    check('recovery: with startup set to restore, a crash offers nothing (the tabs come back anyway)', !fourth.begin({ mode: 'restore' }).offer && fourth.crashed(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  // ---- page info
  check('page info: only http(s) pages are sites', PI.siteOf('https://a.example:8443/x?y').host === 'a.example:8443' && PI.siteOf('file:///etc/hosts') === null && PI.siteOf('lumen://settings') === null, '');
  check('page info: the connection line follows the scheme and the lock', PI.connectionOf('https', null) === 'secure' && PI.connectionOf('http', null) === 'insecure' && PI.connectionOf('https', 'mixed') === 'mixed' && PI.connectionOf('https', 'broken') === 'broken', '');
  const decisions = new Map([['https://a.example|geolocation', true], ['https://a.example|notifications', false], ['https://other.example|media', true]]);
  const acts = [];
  const act = { set: (p, v) => acts.push(['set', p, v]), clear: () => acts.push(['clear']), settings: () => acts.push(['settings']), resetZoom: () => acts.push(['zoom']) };
  const piDeps = { t, decisions, permissionDefault: (p) => (p === 'clipboard-read' ? 'block' : 'ask') };
  const tpl = PI.buildTemplate({ url: 'https://a.example/page', security: null, cookies: 3, zoom: 125 }, piDeps, act);
  const byLabel = (re) => tpl.find((i) => re.test(i.label || ''));
  check('page info: the site and a secure connection head the menu', tpl[0].label === 'a.example' && tpl[1].label === 'Connection is secure' && tpl[0].enabled === false, JSON.stringify(tpl.slice(0, 2)));
  check('page info: each permission shows its state', /Location: Allow/.test(byLabel(/^Location/).label) && /Notifications: Block/.test(byLabel(/^Notifications/).label) && /Camera and microphone: Ask/.test(byLabel(/^Camera/).label), tpl.map((i) => i.label).join(' | '));
  check('page info: a permission blocked by default reads "Block (default)"', /Clipboard: Block \(default\)/.test(byLabel(/^Clipboard/).label), byLabel(/^Clipboard/).label);
  check('page info: another site\'s decision does not leak in', /Camera and microphone: Ask/.test(byLabel(/^Camera/).label), '');
  const loc = byLabel(/^Location/).submenu;
  check('page info: the submenu checks the current choice', loc.find((i) => i.checked).label === 'Allow' && loc.length === 3 && loc.every((i) => i.type === 'radio'), JSON.stringify(loc));
  loc[0].click(); loc[2].click();
  check('page info: Ask forgets, Block blocks', JSON.stringify(acts.slice(-2)) === JSON.stringify([['set', 'geolocation', null], ['set', 'geolocation', false]]), JSON.stringify(acts));
  check('page info: cookies are counted', Boolean(byLabel(/^3 cookies in use$/)), '');
  check('page info: the remembered zoom is shown with a reset', Boolean(byLabel(/^Zoom: 125%/)) && (byLabel(/^Reset Zoom/).click(), acts.at(-1)[0] === 'zoom'), '');
  byLabel(/^Clear Cookies/).click(); byLabel(/^Site Settings/).click();
  check('page info: Clear and Site Settings call their actions', acts.slice(-2).map((a) => a[0]).join() === 'clear,settings', JSON.stringify(acts));
  const plain = PI.buildTemplate({ url: 'http://b.example/', cookies: 1 }, piDeps, act);
  check('page info: an http page says not secure, one cookie is singular, no zoom row without one', plain[1].label === 'Connection is not secure' && plain.some((i) => i.label === '1 cookie in use') && !plain.some((i) => /^Zoom/.test(i.label || '')), plain.map((i) => i.label).join(' | '));
  check('page info: Lumen\'s own pages get one disabled line', PI.buildTemplate({ url: 'file:///x/settings.html' }, piDeps, act).length === 1, '');
  const live = new Map();
  check('page info: setDecision sets, reports a change, and forgets', PI.setDecision(live, 'https://a', 'media', true) && !PI.setDecision(live, 'https://a', 'media', true) && live.get('https://a|media') === true && PI.setDecision(live, 'https://a', 'media', null) && !live.size, '');
  // open() reads the cookies of the tab's session and saves a changed decision.
  let saved = 0;
  let popped = null;
  const fakeSes = { cookies: { get: async ({ url }) => (url === 'https://a.example' ? [{ name: 'x' }, { name: 'y' }] : []) } };
  const pi = PI.createPageInfo({ ...piDeps, decisions: () => decisions, savePermissions: () => { saved++; }, popup: (template) => { popped = template; }, zoomOf: () => null, openSiteSettings: () => {}, confirm: async () => false });
  await pi.open({ url: 'https://a.example/', ses: fakeSes, security: null });
  check('page info: open() counts the site\'s cookies and pops the menu', popped && popped.some((i) => i.label === '2 cookies in use'), popped && popped.map((i) => i.label).join(' | '));
  popped.find((i) => /^Camera/.test(i.label || '')).submenu[1].click();
  check('page info: choosing Allow saves the decision', saved === 1 && decisions.get('https://a.example|media') === true, saved);
  check('page info: Clear asks first, and a refusal clears nothing', (await pi.clearSite(fakeSes, 'https://a.example/')) === null, '');

  // ---- link and image items, Save … As marks
  const deps = { t, openInNewWindow: () => {}, openInPrivateWindow: () => {}, saveAs: () => {}, copy: () => {} };
  const link = LM.linkItems({ linkURL: 'https://a.example/x' }, deps);
  check('link menu: New Window and Private Window, then Save Link As', link.open.map((i) => i.label).join() === 'Open Link in New Window,Open Link in Private Window' && link.save[0].label === 'Save Link As…', JSON.stringify(link));
  check('link menu: no private item where private windows are not offered', LM.linkItems({ linkURL: 'https://a.example/x' }, { ...deps, openInPrivateWindow: null }).open.length === 1, '');
  check('link menu: nothing for a javascript: link', LM.linkItems({ linkURL: 'javascript:alert(1)' }, deps).open.length === 0, '');
  const img = LM.imageItems({ mediaType: 'image', srcURL: 'https://a.example/i.png' }, deps);
  check('image menu: Save Image As and Copy Image Address', img.save[0].label === 'Save Image As…' && img.copy[0].label === 'Copy Image Address', JSON.stringify(img));
  const dataImg = LM.imageItems({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, deps);
  check('image menu: a data: image can be saved but has no address to copy', dataImg.save.length === 1 && dataImg.copy.length === 0, JSON.stringify(dataImg));
  check('image menu: never a file: image', LM.imageItems({ mediaType: 'image', srcURL: 'file:///etc/x.png' }, deps).save.length === 0, '');
  let clock = 0;
  const marks = LM.createSaveAsMarks({ ttl: 1000, now: () => clock });
  marks.mark('https://a.example/f.zip');
  check('save as: a marked download asks once, by any address in its chain', marks.take(['https://other/', 'https://a.example/f.zip']) && !marks.take(['https://a.example/f.zip']), '');
  marks.mark('https://a.example/g.zip');
  clock = 2000;
  check('save as: a mark expires', !marks.take('https://a.example/g.zip') && marks.size() === 0, '');

  // ---- per-site zoom
  check('site zoom: bad entries are dropped', JSON.stringify(SZ.clean({ 'a.example': 1, 'b.example': 'x', 'c d': 1, 'e.example': 99 })) === '{"a.example":1}', JSON.stringify(SZ.clean({ 'a.example': 1, 'b.example': 'x' })));
  check('site zoom: the percentage of a level', SZ.percentOf(0) === 100 && SZ.percentOf(1) === 120 && SZ.percentOf(-1) === 83, SZ.percentOf(1));
  let store = {};
  const zoom = SZ.createSiteZoom({ readSettings: () => store, writeSettings: (s) => { store = s; } });
  check('site zoom: set, read back, forget', zoom.set('a.example', 1.5) && zoom.levelFor('a.example') === 1.5 && zoom.forget('a.example') && zoom.levelFor('a.example') === null, JSON.stringify(store));
  check('site zoom: refuses a bad host or level', !zoom.set('', 1) && !zoom.set('a.example', NaN) && !zoom.set('a.example', 40), '');
  store = { siteZoom: Object.fromEntries(Array.from({ length: SZ.MAX }, (_, i) => [`h${i}.example`, 1])) };
  zoom.set('newest.example', 2);
  check('site zoom: keeps at most MAX hosts, dropping the oldest', Object.keys(store.siteZoom).length === SZ.MAX && !('h0.example' in store.siteZoom) && store.siteZoom['newest.example'] === 2, Object.keys(store.siteZoom).length);
  zoom.set('h5.example', 3);
  check('site zoom: zooming a site again makes it the newest', Object.keys(store.siteZoom).at(-1) === 'h5.example', Object.keys(store.siteZoom).at(-1));

  // ---- Settings → Site data
  const jar = [
    { domain: '.bbc.co.uk', name: 'a', path: '/', secure: true }, { domain: 'news.bbc.co.uk', name: 'b', path: '/', secure: true },
    { domain: 'www.example.com', name: 'c', path: '/x', secure: false }, { domain: '.example.com', name: 'd', path: '/', secure: true },
    { domain: '.example.com', name: 'e', path: '/', secure: true }, { domain: '127.0.0.1', name: 'f', path: '/', secure: false }, { domain: '', name: 'g' },
  ];
  const grouped = SD.groupCookies(jar, registrableDomain);
  check('site data: cookies group by site, most first, subdomains folded in', JSON.stringify(grouped.map((g) => [g.site, g.cookies])) === '[["example.com",3],["bbc.co.uk",2],["127.0.0.1",1]]', JSON.stringify(grouped));
  check('site data: each site lists the hosts its cookies came from', grouped[1].hosts.join() === 'bbc.co.uk,news.bbc.co.uk', grouped[1].hosts.join());
  check('site data: a cookie belongs to its site and subdomains only', SD.belongsTo('news.bbc.co.uk', 'bbc.co.uk') && !SD.belongsTo('notbbc.co.uk', 'bbc.co.uk'), '');
  check('site data: storage is cleared for the site, www and the cookie hosts, both schemes', ['https://example.com', 'http://example.com', 'https://www.example.com', 'https://shop.example.com'].every((o) => SD.originsFor('example.com', ['shop.example.com']).includes(o)), SD.originsFor('example.com', ['shop.example.com']).join());
  const removedCookies = [];
  const cleared = [];
  const fakeJar = { cookies: { get: async () => jar, remove: async (url, name) => { removedCookies.push(`${url}|${name}`); } }, clearStorageData: async ({ origin }) => { cleared.push(origin); } };
  const n = await SD.clearSite(fakeJar, 'example.com');
  check('site data: clearSite removes only that site\'s cookies, at their own address', n === 3 && removedCookies.join() === 'http://www.example.com/x|c,https://example.com/|d,https://example.com/|e', removedCookies.join());
  check('site data: and clears its storage', cleared.includes('https://example.com') && cleared.includes('https://www.example.com') && !cleared.some((o) => o.includes('bbc')), cleared.join());
  check('site data: a bad site name clears nothing', (await SD.clearSite(fakeJar, 'a b/c')) === 0 && (await SD.clearSite(fakeJar, '')) === 0, '');

  // ---- the error page's wording per network error (renderer/error-kinds.js)
  const EK = require('../src/renderer/error-kinds');
  const dns = EK.describe('ERR_NAME_NOT_RESOLVED', 'nope.example');
  check('error page: a DNS failure says the site can\'t be found, names it, and hints at a typo', dns.title === 'This site can’t be found' && dns.message.includes('“nope.example”') && /typo/.test(dns.hint), JSON.stringify(dns));
  check('error page: offline says so', EK.describe('net::ERR_INTERNET_DISCONNECTED', 'a.example').title === 'You’re offline', '');
  check('error page: aliases share a wording', EK.describe('ERR_TIMED_OUT', 'a.example').title === EK.describe('ERR_CONNECTION_TIMED_OUT', 'a.example').title, '');
  check('error page: an unknown error gets the general wording with the host', EK.describe('ERR_SOMETHING_NEW', 'a.example').title === 'Can’t open this page' && EK.describe('ERR_SOMETHING_NEW', 'a.example').message.includes('“a.example”') && EK.describe('', '').hint === '', '');
  check('error page: every wording has a title and a message', Object.keys(EK.KINDS).every((k) => { const d = EK.describe(k, 'h.example'); return d.title && d.message; }), '');
  const errorHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'error.html'), 'utf8');
  check('error page: error.html loads the wordings before its own script', errorHtml.indexOf('error-kinds.js') !== -1 && errorHtml.indexOf('error-kinds.js') < errorHtml.indexOf('error.js"'), '');

  // ---- shortcut hints in the UI's strings read the Mac way on macOS (renderer/i18n.js)
  const vm = require('vm');
  const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const uiT = (platform) => {
    const window = { lumenI18n: { strings: { a: 'New tab (Ctrl+T)', b: 'Search tabs (Ctrl+Shift+A)', c: 'Ctrl+Tab switches tabs', d: 'Ctrl+click opens it' } } };
    vm.runInNewContext(i18nSrc, { window, navigator: { platform }, document: { querySelectorAll: () => [], documentElement: {} } });
    return window.t;
  };
  const macT = uiT('MacIntel');
  const winT = uiT('Win32');
  check('ui strings: on macOS Ctrl+T reads ⌘T and Ctrl+Shift+A reads ⇧⌘A', macT('a') === 'New tab (⌘T)' && macT('b') === 'Search tabs (⇧⌘A)', `${macT('a')} / ${macT('b')}`);
  check('ui strings: Ctrl+Tab and Ctrl+click stay (Control on a Mac too)', macT('c') === 'Ctrl+Tab switches tabs' && macT('d') === 'Ctrl+click opens it', `${macT('c')} / ${macT('d')}`);
  check('ui strings: elsewhere nothing changes', winT('a') === 'New tab (Ctrl+T)' && winT('b') === 'Search tabs (Ctrl+Shift+A)', winT('a'));

  // ---- every key these features (and the strings moved into en.json) use exists
  const files = ['src/features/page-info.js', 'src/features/link-menu.js', 'src/features/shortcuts-help.js', 'src/features/downloads.js', 'src/features/page-tools.js', 'src/settings/settings-backend.js', 'src/main.js', 'src/renderer/app.js'];
  const keys = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const m of src.matchAll(/\bt\('((?:pageInfo|recovery|shortcuts|pip|spelling|menu|dialog|downloads|about)\.[\w.-]+)'/g)) keys.add(m[1]);
  }
  for (const p of PI.PERMISSIONS) keys.add(`pageInfo.permission.${p}`);
  for (const c of ['secure', 'insecure', 'mixed', 'broken']) keys.add(`pageInfo.connection.${c}`);
  const missing = [...keys].filter((k) => !(k in en));
  check(`locale keys: the ${keys.size} keys used are all in en.json`, keys.size > 80 && missing.length === 0, missing.join(', '));
  // The strings that used to be written in English in the code go through t() now.
  const mainSrc = main;
  check('strings: the page menu\'s Save Page As and View Page Source are localized', !/label: 'Save Page As…'|label: 'View Page Source'/.test(mainSrc), '');
  check('strings: the video menu and spelling items are localized', !/'Picture in Picture'|'Open Video in New Tab'/.test(fs.readFileSync(path.join(__dirname, '..', 'src/features/page-tools.js'), 'utf8')) && !/'No spelling suggestions'|'Add to Dictionary'/.test(fs.readFileSync(path.join(__dirname, '..', 'src/settings/settings-backend.js'), 'utf8')), '');

  console.log(failures ? `\n${failures} failed` : '\nall basics-units passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

// Everyday browsing, pure Node (no window): address bar input (intranet host:port, impossible IPs), the browser keys Chrome has
// (F6, Alt+D, F3 / Ctrl+G, Ctrl+F4, the mouse's back / forward buttons), reload while loading, the text-field context menu
// with Paste and Go, downloads progress throttling, and the error and certificate pages' wording.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const path = require('path');
const { resolveInput } = require('../src/browser/search');
const { shortcutMod, extraShortcut, appCommandAction } = require('../src/browser/shortcut-mod');
const { reloadAction } = require('../src/browser/reload-action');
const { editMenuTemplate, oneLine } = require('../src/browser/edit-menu');
const { trailingThrottle } = require('../src/browser/trailing-throttle');
const EK = require('../src/renderer/error-kinds');
const CR = require('../src/renderer/cert-reasons');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
const searched = (text) => resolveInput(text, 'google').startsWith('https://www.google.com/search?q=');

// ---- address bar
for (const [input, want] of [
  ['intranet:8080', 'http://intranet:8080'],
  ['nas:5000/admin', 'http://nas:5000/admin'],
  ['devbox:3000?x=1', 'http://devbox:3000?x=1'],
  ['255.255.255.255', 'http://255.255.255.255'],
  ['10.0.0.1:8080/a', 'http://10.0.0.1:8080/a'],
]) check(`address: "${input}" opens ${want}`, resolveInput(input, 'google') === want, resolveInput(input, 'google'));
for (const input of ['999.1.1.1', '1.2.3.400', '256.0.0.1/path', 'hello:world', 'note:5', 'intranet', 'a:b:80']) {
  check(`address: "${input}" is searched`, searched(input), resolveInput(input, 'google'));
}
check('address: a real dotted name that starts like an address still opens', resolveInput('1.2.3.4.example.com', 'google') === 'https://1.2.3.4.example.com', resolveInput('1.2.3.4.example.com', 'google'));

// ---- browser keys
const press = (key, mods = {}) => ({ type: 'keyDown', key, control: false, meta: false, alt: false, shift: false, ...mods });
check('keys: F6 focuses the address bar', extraShortcut(press('F6'), 'win32') === 'focus-address' && extraShortcut(press('F6'), 'darwin') === 'focus-address', '');
check('keys: Alt+D focuses the address bar on Windows and Linux, not on macOS', extraShortcut(press('d', { alt: true }), 'win32') === 'focus-address' && extraShortcut(press('d', { alt: true }), 'linux') === 'focus-address' && extraShortcut(press('d', { alt: true }), 'darwin') === null, '');
check('keys: F3 and Shift+F3 find next and previous', extraShortcut(press('F3'), 'win32') === 'find-next' && extraShortcut(press('F3', { shift: true }), 'win32') === 'find-prev', '');
check('keys: Ctrl+G / Ctrl+Shift+G find next and previous', extraShortcut(press('g', { control: true }), 'win32') === 'find-next' && extraShortcut(press('G', { control: true, shift: true }), 'win32') === 'find-prev', '');
check('keys: Cmd+G on macOS finds; Ctrl+G there is the text field\'s', extraShortcut(press('g', { meta: true }), 'darwin') === 'find-next' && extraShortcut(press('g', { control: true }), 'darwin') === null, '');
check('keys: Ctrl+F4 closes the tab on Windows and Linux', extraShortcut(press('F4', { control: true }), 'win32') === 'close-tab' && extraShortcut(press('F4', { control: true }), 'darwin') === null && extraShortcut(press('F4', { alt: true }), 'win32') === null, '');
check('keys: plain letters, other F keys and key-up events are not shortcuts', extraShortcut(press('g'), 'win32') === null && extraShortcut(press('F5'), 'win32') === null && extraShortcut({ ...press('F6'), type: 'keyUp' }, 'win32') === null && extraShortcut(null) === null, '');
check('keys: the existing modifier rule is unchanged', shortcutMod(press('t', { control: true }), 'win32') && !shortcutMod(press('t', { control: true }), 'darwin'), '');
check('mouse: back / forward buttons and the browser keys map to navigation', appCommandAction('browser-backward') === 'back' && appCommandAction('browser-forward') === 'forward' && appCommandAction('browser-refresh') === 'reload' && appCommandAction('browser-stop') === 'stop', '');
check('mouse: other app commands (volume, media keys) are left alone', appCommandAction('media-play-pause') === null && appCommandAction('volume-up') === null && appCommandAction(undefined) === null, '');

// ---- reload while loading
check('reload: the button stops a loading page', reloadAction({ loading: true }) === 'stop', '');
check('reload: F5 / Ctrl+R and the menus reload a loading page instead of stopping it', reloadAction({ loading: true, always: true }) === 'reload', '');
check('reload: an idle page reloads; Shift reloads past the cache', reloadAction({}) === 'reload' && reloadAction({ ignoreCache: true }) === 'reload-hard' && reloadAction({ loading: true, ignoreCache: true }) === 'reload-hard', '');
check('reload: an error page loads the failed address again', reloadAction({ errorPage: true }) === 'reload-failed' && reloadAction({ loading: true, errorPage: true, always: true }) === 'reload-failed', '');

// ---- the text-field context menu
{
  const roles = (items) => items.filter((i) => i.role).map((i) => `${i.role}${i.enabled === false ? '-' : ''}`).join();
  check('edit menu: Cut, Copy, Paste and Select All; the ones that do not apply are disabled', roles(editMenuTemplate({ cut: false, copy: false, paste: true })) === 'cut-,copy-,paste,selectAll', roles(editMenuTemplate({ cut: false, copy: false, paste: true })));
  const went = [];
  const addressOf = (text, isSearch) => ({ text, isSearch, t: (k) => en[k], go: (v) => went.push(v) });
  const go = editMenuTemplate({ cut: true, copy: true, paste: true }, addressOf('example.com', false)).find((i) => i.label);
  check('edit menu: the address bar offers Paste and Go for an address', go && go.label === 'Paste and Go', JSON.stringify(go));
  go.click();
  check('edit menu: Paste and Go opens the clipboard text', went.join() === 'example.com', went.join());
  const search = editMenuTemplate({ cut: false, copy: false, paste: true }, addressOf('best pizza\nnear me', true)).find((i) => i.label);
  search.click();
  check('edit menu: Paste and Search for words, on one line', search.label === 'Paste and Search' && went[1] === 'best pizza near me', `${search.label} ${went[1]}`);
  check('edit menu: an empty or blank clipboard offers no Paste and Go', !editMenuTemplate({ paste: false }, addressOf('  \n ', false)).some((i) => i.label), '');
  check('edit menu: oneLine trims and joins lines', oneLine('  a\r\n  b \n') === 'a b' && oneLine(null) === '', oneLine('  a\r\n  b \n'));
  check('edit menu: its labels are in en.json', Boolean(en['menu.pasteAndGo'] && en['menu.pasteAndSearch'] && en['toolbar.reader.leave']), '');
}

// ---- downloads progress throttle
{
  let now = 0;
  const timers = [];
  const clock = () => now;
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; };
  const clearTimer = (t) => { t.live = false; };
  const advance = (ms) => { now += ms; for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); } };
  let runs = 0;
  const send = trailingThrottle(() => { runs++; }, 250, { clock, setTimer, clearTimer });
  now = 1000;
  send(); // first goes out at once
  check('throttle: the first call runs at once', runs === 1, runs);
  for (let i = 0; i < 20; i++) { now += 10; send(); } // a burst
  check('throttle: a burst inside the window waits', runs === 1, runs);
  advance(100);
  check('throttle: and goes out once, after the window', runs === 2, runs);
  advance(1000);
  check('throttle: nothing more runs by itself', runs === 2, runs);
  send();
  send();
  check('throttle: a later call after a quiet spell runs at once', runs === 3, runs);
  now += 10; send(); // waiting
  send.now();
  advance(1000);
  check('throttle: now() runs at once and drops the waiting call', runs === 4, runs);
  send(); now += 10; send(); send.cancel(); advance(1000); // (the first runs at once: a quiet spell; the second waits)
  check('throttle: cancel() drops a waiting call', runs === 5, runs);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'downloads.js'), 'utf8');
  check('downloads: a running download\'s progress goes through the throttle, an interruption does not', /sendProgress\(\);/.test(src) && /entry\.state === 'interrupted'\) sendDownloads\(\)/.test(src), '');
}

// ---- error pages
{
  const dns = EK.describe('ERR_DNS_TIMED_OUT', 'a.example');
  check('error page: a DNS timeout is not "can\'t be found"', dns.title === 'The DNS server isn’t answering' && dns.message.includes('“a.example”'), JSON.stringify(dns));
  check('error page: a failed tunnel reads as a proxy problem', EK.describe('ERR_TUNNEL_CONNECTION_FAILED', 'a.example').title === 'The proxy isn’t answering', '');
  check('error page: an unknown scheme and a malformed address say so', EK.describe('ERR_UNKNOWN_URL_SCHEME', '').title === 'Lumen can’t open this kind of address' && EK.describe('ERR_INVALID_URL', '').title === 'This address isn’t valid', '');
  check('error page: a plain connect failure has its own wording', EK.describe('net::ERR_CONNECTION_FAILED', 'a.example').title === 'Can’t connect to the site', '');
  check('error page: every wording (aliases too) resolves to a title and message', Object.keys(EK.KINDS).every((k) => { const d = EK.describe(k, 'h.example'); return d.title && d.message && !/undefined/.test(JSON.stringify(d)); }), '');
  check('error page: aliases point at kinds that exist and are not aliases themselves', Object.values(EK.KINDS).every((k) => !k.same || (EK.KINDS[k.same] && !EK.KINDS[k.same].same)), '');
}

// ---- certificate warning page
{
  check('cert page: a wrong name says whose certificate it is', CR.reasonFor('ERR_CERT_COMMON_NAME_INVALID', 'a.example') === 'Its certificate is for a different site, not a.example.', '');
  check('cert page: the original reasons are unchanged', /self-signed/.test(CR.reasonFor('ERR_CERT_AUTHORITY_INVALID', 'a')) && /clock/.test(CR.reasonFor('ERR_CERT_DATE_INVALID', 'a')) && /revoked/.test(CR.reasonFor('net::ERR_CERT_REVOKED', 'a')), '');
  check('cert page: errors that used to get the general line now say what is wrong', ['ERR_CERT_NAME_CONSTRAINT_VIOLATION', 'ERR_CERT_VALIDITY_TOO_LONG', 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION', 'ERR_CERT_NON_UNIQUE_NAME', 'ERR_CERT_INVALID', 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED'].every((d) => CR.reasonFor(d, 'a.example') !== 'Its certificate couldn’t be verified.'), '');
  check('cert page: an unknown error gets the general line', CR.reasonFor('ERR_CERT_SOMETHING_NEW', 'a.example') === 'Its certificate couldn’t be verified.' && CR.reasonFor('', '') === 'Its certificate couldn’t be verified.', '');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'cert-error.html'), 'utf8');
  check('cert page: cert-error.html loads the reasons before its own script', html.indexOf('cert-reasons.js') !== -1 && html.indexOf('cert-reasons.js') < html.indexOf('cert-error.js"'), '');
}

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');

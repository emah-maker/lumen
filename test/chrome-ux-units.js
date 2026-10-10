// Browser-chrome UX helpers that need no window: the loopback check behind the address bar's "Not secure" label, the
// Back / Forward history list, and the strings the chrome fixes added.
const fs = require('fs');
const path = require('path');
const { isLoopbackUrl } = require('../src/renderer/chrome-helpers');
const navHistory = require('../src/browser/nav-history');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

// ---- loopback addresses are not "Not secure"
for (const url of ['http://localhost:3000/', 'http://localhost', 'http://127.0.0.1:8080/x', 'http://127.1.2.3/', 'http://[::1]:5173/', 'http://app.localhost/', 'http://LOCALHOST/']) {
  check(`loopback: ${url} is this computer`, isLoopbackUrl(url) === true, url);
}
for (const url of ['http://example.com/', 'http://localhost.example.com/', 'http://127.0.0.1.example.com/', 'http://128.0.0.1/', 'http://192.168.1.5/', 'http://10.0.0.2/', 'http://notlocalhost/', 'not a url', '', undefined]) {
  check(`loopback: ${String(url)} is not`, isLoopbackUrl(url) === false, String(url));
}

// ---- the Back / Forward list
const entries = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ url: `https://${n}.example/page`, title: `Page ${n}` }));
const back = navHistory.items(entries, 3, 'back');
check('history: Back lists the pages behind, nearest first', JSON.stringify(back.map((i) => i.index)) === '[2,1,0]' && back[0].label === 'Page c', JSON.stringify(back));
const fwd = navHistory.items(entries, 1, 'forward');
check('history: Forward lists the pages ahead, nearest first', JSON.stringify(fwd.map((i) => i.index)) === '[2,3,4]' && fwd[0].label === 'Page c', JSON.stringify(fwd));
check('history: nothing behind the first page, nothing ahead of the last', navHistory.items(entries, 0, 'back').length === 0 && navHistory.items(entries, 4, 'forward').length === 0, '');
const long = Array.from({ length: 40 }, (_, i) => ({ url: `https://x.example/${i}`, title: `T${i}` }));
check('history: at most 15 entries (Chrome\'s count)', navHistory.items(long, 39, 'back').length === 15 && navHistory.items(long, 0, 'forward').length === 15, '');
check('history: a page with no title is named by its host', navHistory.items([{ url: 'https://h.example/x', title: '' }, { url: 'https://i.example/', title: 'I' }], 1, 'back')[0].label === 'h.example', '');
check('history: a very long title is clipped', navHistory.items([{ url: 'https://h.example/', title: 'W'.repeat(200) }, { url: 'https://i.example/', title: 'I' }], 1, 'back')[0].label.length <= 60, '');
check('history: bad input gives an empty list', navHistory.items(null, 0, 'back').length === 0 && navHistory.items(entries, -1, 'back').length === 0 && navHistory.items(entries, 9, 'back').length === 0 && navHistory.items(entries, 2, 'sideways').length === 0, '');

// ---- strings
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
for (const key of ['menu.linkCopied', 'menu.newTabPage', 'bookmark.addedNote', 'bookmark.removedNote', 'security.local']) check(`string: ${key}`, typeof EN[key] === 'string' && EN[key].length > 0, key);
check('string: the selection item no longer names one assistant', !/claude/i.test(EN['menu.askAboutSelection']), EN['menu.askAboutSelection']);

process.exit(failures ? 1 : 0);

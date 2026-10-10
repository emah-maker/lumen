// Browser-chrome UX helpers that need no window: the loopback check behind the address bar's "Not secure" label, the
// Back / Forward history list, and the strings the chrome fixes added.
const fs = require('fs');
const path = require('path');
const { isLoopbackUrl, looksLikeAddress, defaultSuggestion } = require('../src/renderer/chrome-helpers');
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

// ---- the omnibox's default match (Chrome: the top row is pre-selected, Enter goes to it)
const hist = (n) => ({ kind: 'history', title: 'Page ' + n, detail: n + '.example', go: 'https://' + n + '.example/' });
const searchRow = { kind: 'search', title: 'alp', detail: 'Search', go: 'https://s/?q=alp' };
check('default match: plain words with a page from history first select that page', defaultSuggestion('alp', [hist('alpha'), searchRow]) === 0, '');
check('default match: an inline completion already in the field is what Enter takes (-1)', defaultSuggestion('alp', [hist('alpha'), searchRow], { completed: true }) === -1, '');
check('default match: a search row first needs no pre-selection (Enter searches the typed text anyway)', defaultSuggestion('two words', [searchRow, hist('a')]) === -1, '');
check('default match: no rows, no selection', defaultSuggestion('x', []) === -1 && defaultSuggestion('x', null) === -1, '');
for (const typed of ['localhost:3000', 'localhost', 'example.com', 'example.com/path?q=1', 'https://a.example/x', 'http://127.0.0.1:8080', '192.168.1.5', '[::1]:5173', 'intranet:8080', 'lumen://settings', 'about:blank', 'file:///c:/x.html', 'sub.domain.co.uk']) {
  check('default match: typing ' + typed + ' keeps what was typed (an exact URL is never replaced)', looksLikeAddress(typed) && defaultSuggestion(typed, [hist('alpha'), searchRow]) === -1, typed);
}
for (const typed of ['alp', 'github', 'weather today', 'what is 3.5', 'c++', 'node.js tips', '']) {
  check('default match: ' + (typed || '(empty)') + ' is not an address', !looksLikeAddress(typed), typed);
}

// ---- menu labels are sentence case (one convention: first word capitalized, proper nouns as they are)
const PROPER = new Set(['AI', 'Lumen', 'GitHub', 'QR', 'Google', 'Settings', 'Translate', 'OpenRouter', 'PNG']);
const menuKeys = Object.keys(EN).filter((k) => /^(menu\.|private\.menu\.|private\.download\.(show|cancel|clear|folder|open|none)$|macros\.menu\.|spelling\.)/.test(k));
const titleCased = menuKeys.filter((k) => EN[k].split(/\s+/).slice(1).some((w, i, all) => /^[A-Z][a-z’']+$/.test(w) && !PROPER.has(w) && !(all[i - 1] === 'Google' && w === 'Translate') && !/^[“{(]/.test(w)));
check('menus: no Title Case labels left (' + menuKeys.length + ' checked)', titleCased.length === 0, titleCased.map((k) => k + ': ' + EN[k]).join(' | '));
check('menus: a few labels in the chosen case', EN['menu.newTab'] === 'New tab' && EN['menu.closeOtherTabs'] === 'Close other tabs' && EN['menu.keepAiOffTab'] === 'Keep the AI from acting on this tab' && EN['menu.translate.google'] === 'Translate with Google Translate…' && EN['menu.github'] === 'Lumen on GitHub', '');

// ---- tab state in the accessible name, the AI control, the set-up button
for (const key of ['tabs.state.pinned', 'tabs.state.sleeping', 'tabs.state.muted', 'tabs.state.playing', 'toolbar.aiOffTab.chip', 'toolbar.aiSetup', 'private.security.local']) check('string: ' + key, typeof EN[key] === 'string' && EN[key].length > 0, key);
check('the AI control is not called a shield any more', !/shield/i.test(EN['toolbar.aiOffTab.off']) && /read-only/.test(EN['toolbar.aiOffTab.off']) && /AI/.test(EN['toolbar.aiOffTab.off']), EN['toolbar.aiOffTab.off']);
const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const mainSrc = read('main.js');
const htmlSrc = read('renderer/index.src.html');
const appSrc = read('renderer/app.js');
check('tab menu: the merge rows are left out, not shown dead, when there is nothing to merge', /items\.push\(\.\.\.mergeWindowItems\(src, \{ hideDisabled: true \}\)\)/.test(mainSrc) && /if \(hideDisabled && !a\.enabled\) return \[\]/.test(mainSrc), '');
check('the ⋯ menu still explains a disabled merge (no hideDisabled there)', /\.\.\.mergeWindowItems\(curRec\),/.test(mainSrc), '');
check('address bar: the AI button is a sparkle (not a shield path) with a text chip', /id="ai-off-tab"[\s\S]*?M8 2\.2l1\.4 4\.1/.test(htmlSrc) && /class="ai-off-label"/.test(htmlSrc) && !/M8 1\.8 3 3\.6v3\.7/.test(htmlSrc), '');
check('address bar: the AI button shows only while the AI is in play or the tab is kept off', /function syncAiOffTab/.test(appSrc) && /aiOffTabCtx\.kept \|\| inPlay/.test(appSrc), '');
check('tab strip: state notes join the accessible name; no-favicon pages get a monogram', /tabs\.state\.pinned/.test(appSrc) && /monogramIcon\(monoHost\)/.test(appSrc), '');
check('toolbar: the AI button says "Set up AI" until a model is connected', /who\.setup \? t\('toolbar\.aiSetup'\)/.test(appSrc) && /setup: true/.test(read('renderer/chat-core.js')), '');
check('private window: a loopback http page is "local", not "Not secure"', /isLoopbackUrl\(state\.url\)/.test(read('renderer/private.js')) && /chrome-helpers\.js/.test(read('renderer/private.html')), '');

process.exit(failures ? 1 : 0);

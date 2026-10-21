// Browser-chrome UX helpers that need no window: the loopback check behind the address bar's "Not secure" label, the
// Back / Forward history list, and the strings the chrome fixes added.
const fs = require('fs');
const path = require('path');
const { isLoopbackUrl, looksLikeAddress, defaultSuggestion } = require('../../src/renderer/chrome-helpers');
const navHistory = require('../../src/browser/nav-history');

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
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
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
const PROPER = new Set(['AI', 'Lumen', 'GitHub', 'QR', 'Google', 'Settings', 'Files', 'Translate', 'OpenRouter', 'PNG']);
const menuKeys = Object.keys(EN).filter((k) => /^(menu\.|private\.menu\.|private\.download\.(show|cancel|clear|folder|open|none)$|macros\.menu\.|spelling\.)/.test(k));
const titleCased = menuKeys.filter((k) => EN[k].split(/\s+/).slice(1).some((w, i, all) => /^[A-Z][a-z’']+$/.test(w) && !PROPER.has(w) && !(all[i - 1] === 'Google' && w === 'Translate') && !/^[“{(]/.test(w)));
check('menus: no Title Case labels left (' + menuKeys.length + ' checked)', titleCased.length === 0, titleCased.map((k) => k + ': ' + EN[k]).join(' | '));
check('menus: a few labels in the chosen case', EN['menu.newTab'] === 'New tab' && EN['menu.closeOtherTabs'] === 'Close other tabs' && EN['menu.keepAiOffTab'] === 'Keep the AI from acting on this tab' && EN['menu.translate.google'] === 'Translate with Google Translate…' && EN['menu.github'] === 'Lumen on GitHub', '');

// ---- tab state in the accessible name, the AI control, the set-up button
for (const key of ['tabs.state.pinned', 'tabs.state.sleeping', 'tabs.state.muted', 'tabs.state.playing', 'toolbar.aiOffTab.hint', 'toolbar.aiSetup', 'private.security.local']) check('string: ' + key, typeof EN[key] === 'string' && EN[key].length > 0, key);
check('the AI control: tooltip and aria-label strings, off and on', EN['toolbar.aiOffTab.off'] === 'Keep the AI from acting on this tab' && EN['toolbar.aiOffTab.on'] === 'AI is read-only on this tab. Click to allow actions' && /can read.*click, type or navigate/.test(EN['toolbar.aiOffTab.hint']), EN['toolbar.aiOffTab.off'] + ' | ' + EN['toolbar.aiOffTab.on']);
const SRC = path.join(__dirname, '..', '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const mainSrc = read('main.js');
const htmlSrc = read('renderer/index.src.html');
const appSrc = read('renderer/app.js');
check('tab menu: the merge rows are left out, not shown dead, when there is nothing to merge', /items\.push\(\.\.\.mergeWindowItems\(src, \{ hideDisabled: true \}\)\)/.test(mainSrc) && /if \(hideDisabled && !a\.enabled\) return \[\]/.test(mainSrc), '');
check('the ⋯ menu still explains a disabled merge (no hideDisabled there)', /\.\.\.mergeWindowItems\(curRec\),/.test(mainSrc), '');
check('address bar: the AI button is a shield with a sparkle inside, and no text chip', /id="ai-off-tab"[\s\S]*?class="ai-off-shield"[\s\S]*?class="ai-off-spark"/.test(htmlSrc) && !/ai-off-label/.test(htmlSrc), '');
const syncFn = appSrc.slice(appSrc.indexOf('function syncAiOffTab'), appSrc.indexOf('function syncAiOffTab') + 400);
check('address bar: the AI button is always visible on a web page (not tied to the AI panel or a working agent)', /function syncAiOffTab/.test(appSrc) && /\.hidden = !aiOffTabCtx\.page;/.test(syncFn) && !/inPlay/.test(syncFn), syncFn);
check('address bar: the setting hides it (class on <html>, default on, a settings row, a docs row); a tab already kept off keeps it', /showAiOffButton: true/.test(read('settings/settings-backend.js')) && /pref-no-ai-off-button', p\.showAiOffButton === false/.test(read('renderer/ui-prefs.js')) && /\.pref-no-ai-off-button #ai-off-tab:not\(\[aria-pressed="true"\]\)/.test(read('renderer/prefs.css')) && /toggle\('showAiOffButton'/.test(read('renderer/settings.js')) && /`showAiOffButton`/.test(fs.readFileSync(path.join(SRC, '..', 'docs', 'settings.md'), 'utf8')), '');
check('the first turn-on shows a note once; the tab strip mark is a shield', /aiOffHintSeen/.test(appSrc) && /toolbar\.aiOffTab\.hint/.test(appSrc) && /offMark\.innerHTML = '<svg[^']*M6 1 10 2\.4/.test(appSrc), '');
check('tab strip: state notes join the accessible name; no-favicon pages get a monogram', /tabs\.state\.pinned/.test(appSrc) && /monogramIcon\(monoHost\)/.test(appSrc), '');
check('toolbar: the AI button says "Set up AI" until a model is connected', /who\.setup \? t\('toolbar\.aiSetup'\)/.test(appSrc) && /setup: true/.test(read('renderer/chat-core.js')), '');
check('private window: a loopback http page is "local", not "Not secure"', /isLoopbackUrl\(state\.url\)/.test(read('renderer/private.js')) && /chrome-helpers\.js/.test(read('renderer/private.html')), '');

// ---- polish pass: the suggestion list's selected row keeps its icon, History's time doesn't wrap, History reuses its tab, the Chrome DevTools key
const suggestSrc = read('renderer/suggest.html');
check("suggestions: --accent is defined in the list's own page (the selected row's icon uses it)", (suggestSrc.match(/--accent: #/g) || []).length === 2 && /li\.selected svg \{ stroke: var\(--accent\)/.test(suggestSrc), '');
check('History: the time column fits "12:49 AM" on one line', /\.time \{[^}]*width: 68px;[^}]*white-space: nowrap/.test(read('renderer/history.html')), '');
check('History: Ctrl+H goes back to the open History tab instead of opening another', /function openHistoryPage\(\) \{[\s\S]*?existing[\s\S]*?switchTab\(existing\.id\)/.test(mainSrc), '');
check('DevTools: Ctrl+Shift+I opens them on Windows / Linux, and the shortcuts sheet lists it', /key === 'i'\) wc\?\.toggleDevTools\(\)/.test(mainSrc) && /\{ other: 'mod\+shift\+i' \}/.test(read('features/shortcuts-help.js')), '');
check('tab strip: an address of numbers keeps the globe (no "1" tile)', /!\/\^\[\\d\.\]\+\$\/\.test\(host\)/.test(appSrc) && /!host\.startsWith\('\['\)/.test(appSrc), '');
check('error hints name the menu the way the menu says it', !/Ad Blocker|Clear Cookies and Site Data/.test(EN['errorPage.kind.ERR_BLOCKED_BY_CLIENT.hint'] + EN['errorPage.kind.ERR_TOO_MANY_REDIRECTS.hint']), '');

// ---- round 2: lumen:// addresses, Undo on removals, a longer Downloads list, camera / microphone wording
const SP = require('../../src/browser/site-permissions');
check('permission prompt: a camera-only request says camera, a microphone-only one microphone, both say both', EN[SP.promptKey('media', { mediaTypes: ['video'] })] === 'use your camera' && EN[SP.promptKey('media', { mediaTypes: ['audio'] })] === 'use your microphone' && EN[SP.promptKey('media', { mediaTypes: ['audio', 'video'] })] === 'use your camera and microphone' && EN[SP.promptKey('media', {})] === 'use your camera and microphone' && SP.promptKey('geolocation', {}) === 'permission.geolocation', '');
const askedLikeThis = (src) => src.includes("SITE_PERMISSIONS.promptKey(permission, { mediaTypes: ask");
check("permission prompt: the private window and the main one ask the same way (promptKey for the undecided devices)", askedLikeThis(read("features/private-window.js")) && askedLikeThis(mainSrc), "");
check('address bar: History, Bookmarks and Downloads show lumen:// addresses; Lumen pages get no star', /url\.startsWith\(HISTORY_URL\) \? 'lumen:\/\/history' : managerPageOf\(url\) \? `lumen:\/\/\$\{managerPageOf\(url\)\}`/.test(mainSrc) && /const lumenPage = Boolean\(active\?\.page\)/.test(appSrc), '');
const { menuLabel } = require('../../src/browser/menu-label');
check('menus: a title keeps its & (written &&) and a long one is cut with an ellipsis', menuLabel('Q&A: Tom & Jerry') === 'Q&&A: Tom && Jerry' && menuLabel('x'.repeat(100)).length === 60 && menuLabel('x'.repeat(100)).endsWith('…') && menuLabel('  a \n b ') === 'a b' && menuLabel(undefined) === '', '');
const dlSrc = read('features/downloads.js');
check('Downloads: remembers up to 1000, the toolbar panel only its latest 50', /const KEEP = 1000;/.test(dlSrc) && /const PANEL_ROWS = 50;/.test(dlSrc) && !/downloads\.map\(panelEntry\)/.test(dlSrc), '');
check('Downloads: a removed row can be restored (the page offers Undo)', /action === 'restore'\) return restore\(id\)/.test(dlSrc) && /managersToast/.test(read('renderer/downloads.js')) && /managersToast/.test(read('renderer/bookmarks.js')) && /bookmarks:restore/.test(read('features/managers.js')), '');
check('warning pages: certificate, HTTPS-only and Safe Browsing wording is in en.json', ['certError.heading', 'certError.reason.authorityInvalid', 'httpsOnly.heading', 'httpsOnly.lead', 'safeBrowsing.malware.summary', 'safeBrowsing.lead'].every((k) => typeof EN[k] === 'string'), '');

process.exit(failures ? 1 : 0);

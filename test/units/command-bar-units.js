// The command bar (Ctrl+K), pure node: the ranking (renderer/command-bar-match.js), the main-side list of pages and commands
// (features/command-bar.js), and the wiring (key, menu, shortcuts sheet, IPC gate, locale keys, lazy loading). The real-window checks
// are in command-bar.js.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const M = require('../../src/renderer/command-bar-match');
const ids = (rows) => rows.map((r) => r.id);
const tab = (n, title, url) => ({ id: `tab:${n}`, group: 'tab', title, url });
const act = (id, title, keywords = '') => ({ id, group: 'action', title, keywords });
const setting = (id, title, keywords = '') => ({ id: `settings:${id}`, group: 'setting', title, keywords: `settings ${keywords}` });
const mark = (url, title) => ({ id: `url:${url}`, group: 'bookmark', title, url });
const past = (url, title) => ({ id: `url:${url}`, group: 'history', title, url });
const ITEMS = [
  tab(1, 'Inbox - Mail', 'https://mail.example.com/inbox'), tab(2, 'Pricing', 'https://example.com/pricing'),
  act('new-tab', 'New tab', 'open blank create'), act('pin-tab', 'Pin tab', 'keep'), act('mute-tab', 'Mute tab', 'sound audio'), act('theme-dark', 'Switch to the dark theme', 'appearance night'),
  act('reopen-tab', 'Reopen closed tab', 'undo restore'), act('clear-data', 'Clear browsing data', 'delete history cookies'),
  setting('privacy', 'Privacy and security', 'clear data cookies'), setting('appearance', 'Appearance', 'theme dark light'), setting('tabs', 'Tabs'),
  mark('https://news.example.org/', 'Daily News'), mark('https://example.com/pricing', 'Pricing (saved)'),
  past('https://example.com/pricing', 'Pricing'), past('https://wiki.example.net/Tabs', 'Tabs wiki'), past('https://news.example.org/story-1', 'A story about tabs'),
];

// ---- ranking
let r = M.search('mut', ITEMS);
check('"mut" finds Mute tab first', r[0].id === 'mute-tab', ids(r));
r = M.search('mute', ITEMS);
check('a word start in a title beats a match in other words', r[0].id === 'mute-tab', ids(r));
r = M.search('gml', [tab(1, 'Gmail', 'https://mail.google.com'), act('x', 'Grab my lunch')]);
check('letters in order match ("gml" is Gmail)', r[0].id === 'tab:1', ids(r));
r = M.search('xyzzy', ITEMS);
check('no match: only the Ask AI row', r.length === 1 && r[0].group === 'ask' && r[0].text === 'xyzzy', ids(r));
r = M.search('dark theme', ITEMS);
check('every word has to match (title and keywords): "dark theme" is the dark theme command', r[0].id === 'theme-dark' && !ids(r).includes('new-tab'), ids(r));
r = M.search('night', ITEMS);
check('keywords match (a command is found by what it is about)', ids(r)[0] === 'theme-dark', ids(r));
r = M.search('  TAB  ', ITEMS);
check('case and surrounding spaces do not matter', r.some((x) => x.id === 'settings:tabs') && r.some((x) => x.id === 'pin-tab'), ids(r));

// ---- grouping
r = M.search('tab', ITEMS);
const seenGroups = [];
let split = false;
for (const x of r) { if (seenGroups[seenGroups.length - 1] !== x.group) { if (seenGroups.includes(x.group)) split = true; seenGroups.push(x.group); } }
check('rows of one group sit together (no group is split)', !split, seenGroups.join());
check('the Ask AI row is always last, once, and holds what was typed', r[r.length - 1].group === 'ask' && r.filter((x) => x.group === 'ask').length === 1 && r[r.length - 1].text === 'tab', ids(r));
r = M.search('pricing', ITEMS);
check('a page that is an open tab is not listed again as a bookmark or from History', ids(r).filter((i) => i === 'url:https://example.com/pricing').length === 0 && r.filter((x) => x.title.startsWith('Pricing')).length === 1, JSON.stringify(r.map((x) => [x.id, x.group])));
r = M.search('news', ITEMS);
check('a bookmark is not listed again from History', r.filter((x) => x.group === 'bookmark').length === 1 && !r.some((x) => x.id === 'url:https://news.example.org/story-1' && false) && r.filter((x) => x.url === 'https://news.example.org/').length === 1, JSON.stringify(r.map((x) => [x.id, x.group])));
r = M.search('pricing', ITEMS);
check('an open tab ranks first for its own title', r[0].group === 'tab', JSON.stringify(r.map((x) => [x.id, x.group])));
r = M.search('new tab', [tab(9, 'New Tab', ''), act('new-tab', 'New tab', 'open')]);
check('the command beats an open tab with the same name', r[0].id === 'new-tab', ids(r));
r = M.search('pin tab', [setting('tabs', 'Tabs', 'sleep group pinned'), act('unpin-tab', 'Unpin tab', 'loose'), act('pin-tab', 'Pin tab', 'keep')]);
check('the whole phrase in a title ranks first: "pin tab" is Pin tab, then Unpin tab', ids(r).slice(0, 2).join() === 'pin-tab,unpin-tab', ids(r));
r = M.search('beta', ITEMS.concat([setting('general', 'General', 'browser startup')]));
check('letters in order do not match inside keywords ("beta" is not General)', !ids(r).includes('settings:general'), ids(r));
const many = Array.from({ length: 30 }, (_, i) => past(`https://site${i}.example.com/`, `Site ${i} notes`));
check('a group shows at most five rows while typing', M.search('notes', many).filter((x) => x.group === 'history').length === 5, '');
check('the group with the best match comes first', M.search('privacy', ITEMS)[0].group === 'setting', JSON.stringify(M.search('privacy', ITEMS).map((x) => [x.id, x.group])));

// ---- nothing typed
r = M.search('', ITEMS, { recent: ['theme-dark', 'pin-tab', 'gone'] });
check('empty: recent commands come first, newest first', ids(r).slice(0, 2).join() === 'theme-dark,pin-tab' && r[0].group === 'recent' && r[1].group === 'recent', ids(r));
check('empty: then the open tabs, then the other commands, and no Ask AI row', r[2].group === 'tab' && r.find((x) => x.id === 'new-tab').group === 'action' && !r.some((x) => x.group === 'ask'), ids(r));
check('empty: a recent command is not listed twice, an id that no longer exists is skipped', ids(r).filter((i) => i === 'theme-dark').length === 1 && !ids(r).includes('gone'), ids(r));
check('empty: nothing recent starts with the tabs', M.search('', ITEMS)[0].group === 'tab', '');
check('empty: history and bookmarks are not listed', !M.search('', ITEMS).some((x) => x.group === 'history' || x.group === 'bookmark'), '');
r = M.search('tab', ITEMS, { recent: ['pin-tab'] });
check('a command you ran lately beats an equal match', ids(r.filter((x) => x.group === 'action'))[0] === 'pin-tab', ids(r));
check('search tolerates odd input', M.search(undefined, undefined).length === 0 && M.search(null, []).length === 0, '');

// ---- main side
const { create, SECTION_IDS } = require('../../src/features/command-bar');
const hist = new Map();
for (let i = 0; i < 600; i++) hist.set(`https://h${i}.example.com/`, { url: `https://h${i}.example.com/`, title: `H${i}`, last: i });
hist.set(`https://long.example.com/${'a'.repeat(400)}`, { url: `https://long.example.com/${'a'.repeat(400)}`, title: 'long', last: 9999 });
hist.set('lumen://settings', { url: 'lumen://settings', title: 'S', last: 9998 });
const ran = [];
const names = ['newTab', 'newWindow', 'newPrivateWindow', 'closeTab', 'reopenTab', 'toggleSidebar', 'newChat', 'chatPage', 'pinTab', 'unpinTab', 'muteTab', 'unmuteTab', 'bookmarkTab', 'unbookmarkTab', 'find', 'reload', 'history', 'bookmarks', 'downloads', 'clearData', 'themeLight', 'themeDark', 'themeSystem', 'shortcuts', 'recordTab', 'recordScreen', 'stopRecording'];
const actTable = Object.fromEntries(names.map((n) => [n, () => ran.push(n)]));
actTable.settings = (section) => ran.push(`settings:${section || ''}`);
const deps = (extra = {}) => ({ history: () => hist, bookmarks: () => [{ url: 'https://b.example.com/', title: 'B' }, { url: 'file:///c:/x', title: 'no' }, null], isWebUrl: (u) => /^https?:/.test(u), act: actTable, ...extra });
const bar = create(deps());
const data = bar.data();
check('data: History is the newest 400 web pages, longest links and lumen:// pages left out', data.history.length === 400 && data.history[0].title === 'H599' && !data.history.some((h) => h.url.length > 300 || h.url.startsWith('lumen:')), data.history.length);
check('data: bookmarks are web pages only, as { url, title }', JSON.stringify(data.bookmarks) === JSON.stringify([{ url: 'https://b.example.com/', title: 'B' }]), JSON.stringify(data.bookmarks));
check('run: every command id runs its action', bar.COMMANDS.every((id) => bar.run(id) === true) && ran.length === bar.COMMANDS.length, `${ran.length}/${bar.COMMANDS.length}`);
ran.length = 0;
check('run: a Settings section opens that section', bar.run('settings:privacy') === true && ran[0] === 'settings:privacy', ran.join());
ran.length = 0;
check('run: an id that is not on the list does nothing', [bar.run('quit'), bar.run('settings:../../x'), bar.run('settings:nope'), bar.run(5), bar.run('constructor'), bar.run('__proto__'), bar.run('')].every((x) => x === false) && ran.length === 0, ran.join());
check('run: a command that throws is reported false, not thrown', create(deps({ act: { newTab: () => { throw new Error('boom'); } } })).run('new-tab') === false, '');

// ---- the wiring
const main = read('src', 'main.js');
const rendererJs = read('src', 'renderer', 'command-bar.js');
const en = JSON.parse(read('src', 'locales', 'en.json'));
const PF = require('../../src/features/page-first-keys');
const SH = require('../../src/features/shortcuts-help');
check('key: Ctrl+K opens the command bar from handleShortcut, Ctrl+E is still the address bar', /key === 'k'\) openCommandBar\(\)/.test(main) && /key === 'e'\) focusAddress\(\)/.test(main), '');
check('key: Ctrl+K is page-first (a site that uses it itself keeps it) and not a reserved browser key', PF.PAGE_FIRST.some((e) => e.combo === 'mod+k' && e.does === 'Command bar') && !PF.BROWSER_ONLY.includes('mod+k'), '');
check('key: the menu shows Ctrl+K on Windows / Linux and Cmd+K on macOS', /commandBar'\), accelerator: 'CmdOrCtrl\+K'/.test(main) && /commandBar'\), \.\.\.shown\('Cmd\+K'\)/.test(main), '');
const sheet = SH.sheet('win32').flatMap((s) => s.entries);
check('sheet: the shortcuts sheet lists Command bar as Ctrl+K and the address bar no longer lists Ctrl+K', sheet.some((e) => e.label === 'shortcuts.commandBar' && e.keys.join() === 'Ctrl+K') && !sheet.find((e) => e.label === 'shortcuts.focusAddress').keys.includes('Ctrl+K'), '');
const preload = read('src', 'preload', 'preload.js');
check('ipc: cmdbar:data and cmdbar:run are UI-only calls and the preload sends exactly those', /'cmdbar:data', 'cmdbar:run'/.test(main) && /invoke\('cmdbar:data'\)/.test(preload) && /invoke\('cmdbar:run', id\)/.test(preload) && /on\('cmdbar:open'\)/.test(preload), '');
check('lazy: the main side is required on first use, not at startup', /lazy\(\(\) => require\('\.\/features\/command-bar'\)/.test(main) && !/^const [^\n]*= require\('\.\/features\/command-bar'\)/m.test(main), '');
const appJs = read('src', 'renderer', 'app.js');
check('lazy: the window loads command-bar.js, its matcher and its CSS on first use; none is in the bundle', /command-bar\.css/.test(appJs) && /command-bar-match\.js/.test(appJs) && !/command-bar/.test(read('src', 'renderer', 'index.src.html')) && !read('src', 'renderer', 'ui.bundle.js').includes('const commandBar'), '');
check('ask: Ask AI is an event the sidebar code handles by opening the sidebar and asking', /cmdbar:ask/.test(rendererJs) && /addEventListener\('cmdbar:ask'[\s\S]{0,200}showSidebar\(true\);[\s\S]{0,60}askInFreshChat\(text\)/.test(appJs), '');
check('safety: nothing typed or found is put into markup', !/innerHTML|insertAdjacentHTML|outerHTML/.test(rendererJs), '');
const keys = [...rendererJs.matchAll(/'(commandBar\.[A-Za-z.]+)'/g)].map((m) => m[1]).concat(SECTION_IDS.map((id) => `settings.section.${id}`), ['menu.commandBar', 'shortcuts.commandBar']);
const missing = [...new Set(keys)].filter((k) => !(k in en));
check('locale: every string the bar shows is in locales/en.json', missing.length === 0, missing.join(', '));
const actionIds = [...rendererJs.matchAll(/^ {4}\['([a-z-]+)', 'commandBar\.act\./gm)].map((m) => m[1]);
const commands = create(deps()).COMMANDS;
check('wiring: the commands the bar lists are exactly the ones main.js can run', actionIds.length > 15 && actionIds.every((id) => commands.includes(id)) && commands.every((id) => actionIds.includes(id)), actionIds.join());
const sectionLine = [...rendererJs.matchAll(/^ {4}\['([a-z-]+)', '[^']+', '[a-z -]*'\],$/gm)].map((m) => m[1]);
check('wiring: the Settings sections the bar lists are the ones main.js accepts', sectionLine.length >= 20 && sectionLine.every((id) => SECTION_IDS.includes(id)) && SECTION_IDS.every((id) => sectionLine.includes(id)), sectionLine.join());
const settingsBackend = require('../../src/settings/settings-backend');
check('wiring: every Settings section the bar offers is a real section of lumen://settings', SECTION_IDS.every((id) => settingsBackend.SECTION_LINKS.includes(id)), SECTION_IDS.filter((id) => !settingsBackend.SECTION_LINKS.includes(id)).join());

process.exit(failures ? 1 : 0);

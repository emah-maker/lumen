// The Keyboard Shortcuts sheet is complete and honest (features/shortcuts-help.js), plain Node, no window:
//   - every accelerator on a menu in main.js, and every key handleShortcut handles, is on the sheet;
//   - every page-first key (features/page-first-keys.js) is on the sheet, and the sheet says in one line what page-first means;
//   - no "Mod+" or "CmdOrCtrl" in text the user reads (locale strings, HTML, the renderer's string literals);
//   - the sheet reads right on Windows and on a Mac, and Ctrl+Enter / Ctrl+Shift+E are the decided keys.
const fs = require('fs');
const path = require('path');
const SH = require('../src/features/shortcuts-help');
const PF = require('../src/features/page-first-keys');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 'CmdOrCtrl+Shift+T', 'Shift+Cmd+T', 'Alt+Cmd+L', 'mod+shift+t' -> 'mod+shift+t' (modifiers in one order).
const ORDER = ['ctrl', 'alt', 'shift', 'mod'];
function norm(chord) {
  const parts = String(chord).toLowerCase().split('+');
  const key = parts.pop() || '+'; // ('Ctrl++' is the zoom key)
  const mods = new Set(parts.map((m) => (m === 'cmdorctrl' || m === 'cmd' || m === 'command' || m === 'ctrl' || m === 'control' ? 'mod' : m)));
  return [...ORDER.filter((m) => mods.has(m)), key].join('+');
}
// Both platforms' chords, normalised ('ctrl' on the sheet is the real Control key; as 'mod' it matches a menu's "Ctrl+").
const sheetChords = new Set();
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const s of SH.SECTIONS) for (const [, keys] of s.entries) for (const c of SH.chordsFor(keys, platform)) sheetChords.add(norm(c));
}
const onSheet = (chord) => {
  const n = norm(chord);
  if (sheetChords.has(n)) return true;
  const range = /^(.*)\+(\d)$/.exec(n); // Ctrl+1 to 8 is one row
  return Boolean(range && [...sheetChords].some((c) => { const m = /^(.*)\+(\d)–(\d)$/.exec(c); return m && m[1] === range[1] && +range[2] >= +m[2] && +range[2] <= +m[3]; }));
};

const main = read('src/main.js');

// ---- menus: every accelerator main.js puts on an item
const accels = new Set();
for (const m of main.matchAll(/(?:accelerator:\s*|shortcutHint\(|shown\()'([^']+)'/g)) accels.add(m[1]);
for (const m of main.matchAll(/const \w*ACCELERATOR = '([^']+)'/g)) accels.add(m[1]);
// (the ternary forms: process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H')
for (const m of main.matchAll(/accelerator:\s*process\.platform === 'darwin' \? '([^']+)' : '([^']+)'/g)) { accels.add(m[1]); accels.add(m[2]); }
const NOT_SHORTCUTS = new Set(); // (nothing is exempt: an accelerator a menu shows must be on the sheet)
const missingMenu = [...accels].filter((a) => !NOT_SHORTCUTS.has(a) && !onSheet(a));
check('menus: found the accelerators in main.js', accels.size > 30, accels.size);
check('menus: every accelerator on a menu is on the sheet', missingMenu.length === 0, missingMenu.join(', '));

// ---- handlers: every `mod && ... key === 'x'` branch of handleShortcut, and the extra shortcuts
const handler = main.slice(main.indexOf('function handleShortcut('), main.indexOf('// Ctrl+F / Edit > Find'));
const handled = [];
for (const line of handler.split('\n')) {
  const m = /^\s*(?:else )?if \(mod && (input\.shift && )?(!input\.alt && )?(!input\.shift && )?(?:key === '([^']+)'|\(key === '([^']+)' \|\| key === '[^']+'\))/.exec(line);
  if (!m) continue;
  const key = m[4] || m[5];
  if (/pdfViewer|\.settings\)|chatPageRt|activeTabIsChatPage/.test(line) && key === 'f') continue; // (Ctrl+F in the PDF viewer and Settings: the same Find)
  handled.push(`mod+${m[1] ? 'shift+' : ''}${key}`);
}
const HANDLED_EXEMPT = new Set([
  'mod+shift+delete', // (the sheet writes it per platform: Delete / Backspace)
]);
const missingHandled = [...new Set(handled)].filter((c) => !HANDLED_EXEMPT.has(c) && !onSheet(c));
check('handlers: found handleShortcut\'s Ctrl/Cmd branches', handled.length > 20, handled.length);
check('handlers: every key handleShortcut handles is on the sheet', missingHandled.length === 0, missingHandled.join(', '));
const extras = [['f6', 'f6'], ['alt+d', 'alt+d'], ['f3', 'f3'], ['mod+g', 'mod+g'], ['ctrl+f4', 'ctrl+f4'], ['alt+home', 'alt+home'], ['mod+shift+o', 'mod+shift+o'], ['mod+shift+s', 'mod+shift+s'], ['mod+shift+e', 'mod+shift+e']];
check('handlers: the extra keys (F6, Alt+D, F3, Ctrl+G, Ctrl+F4, chat page keys, Meeting helper) are on the sheet', extras.every(([, c]) => onSheet(c)), extras.filter(([, c]) => !onSheet(c)).join(' '));
check('handlers: Ctrl+Shift+K, Ctrl+Shift+L, Ctrl+Shift+A are on the sheet', ['mod+shift+k', 'mod+shift+l', 'mod+shift+a'].every(onSheet), '');
check('handlers: the Ctrl+Shift+E branch exists and Ctrl+Enter has none', /key === 'e'\) toggleMeetingHelper\(\)/.test(handler) && !/key === 'enter'/.test(handler), '');

// ---- page-first keys: on the sheet, and the sheet says what page-first means
const PREVIOUS_MATCH = ['mod+shift+g', 'shift+f3']; // (the sheet's Find next row says "add Shift for previous")
// Spellings of a key the sheet already lists under another name: the numpad / shifted zoom keys are the zoom rows', Ctrl+F5 is Force reload's.
const SPELLINGS = ['mod++', 'mod+shift++', 'mod+shift+_', 'mod+f5', 'mod+shift+?', 'mod+shift+backspace'];
const missingPF = PF.PAGE_FIRST.filter((e) => !PREVIOUS_MATCH.includes(e.combo) && !SPELLINGS.includes(e.combo) && !onSheet(e.combo.replace('arrow', ''))).map((e) => e.combo);
check('page-first: every page-first key is on the sheet', missingPF.length === 0, missingPF.join(', '));
const en = JSON.parse(read('src/locales/en.json'));
const win = SH.sheet('win32');
check('page-first: the sheet opens with one line about it', win[0].id === 'pagefirst' && win[0].note === 'shortcuts.pageFirst' && !/\n/.test(en['shortcuts.pageFirst']) && /first/.test(en['shortcuts.pageFirst']) && /menu/.test(en['shortcuts.pageFirst']), en['shortcuts.pageFirst']);
// every page-first key's action also has a menu item showing its accelerator (the way to reach it on a site that takes the key)
const menuAccels = new Set([...accels].map(norm));
// (the second line: another key for an action whose menu item shows its main key, as Reload shows Ctrl+R for F5; Back and Forward show theirs by a hint the scan can't read)
const noMenu = PF.PAGE_FIRST.filter((e) => !['mod+g', 'mod+shift+g', 'f3', 'shift+f3', 'mod+shift+e'].includes(e.combo)
  && !['mod+k', 'mod+e', 'alt+d', 'f6', 'f5', 'shift+f5', 'mod+f5', 'mod++', 'mod+shift++', 'mod+shift+_', 'alt+arrowleft', 'alt+arrowright', 'mod+shift+i', 'mod+shift+delete', 'mod+shift+backspace', 'mod+shift+?'].includes(e.combo)
  && !menuAccels.has(norm(e.combo))).map((e) => e.combo);
check('page-first: each one has a menu item that shows its accelerator (Find next and the Meeting helper button aside)', noMenu.length === 0, noMenu.join(', '));
check('page-first: the Meeting helper key is page-first (Ctrl+Shift+E is Centre in Google Docs)', PF.PAGE_FIRST.some((e) => e.combo === 'mod+shift+e'), '');
check('page-first: Ctrl+Enter is never a browser key, so main.js has no branch for it', !PF.BROWSER_ONLY.includes('mod+enter') && !PF.PAGE_FIRST.some((e) => e.combo === 'mod+enter'), '');

// ---- every label key is in en.json; sections are grouped and none is empty
const missingLabels = SH.labelKeys().filter((k) => !(k in en));
check('sheet: every section, note and label is in en.json', missingLabels.length === 0, missingLabels.join(', '));
check('sheet: sections in order (page-first note, tabs ... Lumen), each with a title', win.map((s) => s.id).join() === 'pagefirst,tabs,navigation,page,ai,newtab,chatpage,lumen' && win.every((s) => en[`shortcuts.section.${s.id}`]), win.map((s) => s.id).join());
const mac = SH.sheet('darwin');
const keysOf = (sheet, label) => sheet.flatMap((s) => s.entries).filter((e) => e.label === label).flatMap((e) => e.keys);
check('sheet: Ctrl+Enter reads Ctrl+Enter on Windows and ⌘↩ on a Mac, in both places it is used', ['shortcuts.sendNow', 'shortcuts.newtab.ask'].every((l) => keysOf(win, l).join() === 'Ctrl+Enter' && keysOf(mac, l).join() === '⌘↩'), JSON.stringify([keysOf(win, 'shortcuts.sendNow'), keysOf(mac, 'shortcuts.newtab.ask')]));
check('sheet: Meeting helper is Ctrl+Shift+E / ⇧⌘E', keysOf(win, 'shortcuts.meetingHelper').join() === 'Ctrl+Shift+E' && keysOf(mac, 'shortcuts.meetingHelper').join() === '⇧⌘E', keysOf(mac, 'shortcuts.meetingHelper'));
check('sheet: Ctrl+Shift+K / L / A', keysOf(win, 'shortcuts.newChat').join() === 'Ctrl+Shift+K' && keysOf(win, 'shortcuts.chatPage').join() === 'Ctrl+Shift+L' && keysOf(win, 'shortcuts.searchTabs').join() === 'Ctrl+Shift+A', '');
check('sheet: new-tab keys (/, Ctrl+/ or Alt+A) and chat-page keys (Ctrl+Shift+O, Ctrl+Shift+S, Alt+Home)', keysOf(win, 'shortcuts.newtab.focus').join() === '/' && keysOf(win, 'shortcuts.newtab.switch').join() === 'Ctrl+/,Alt+A' && keysOf(win, 'shortcuts.chatpage.newChat').join() === 'Ctrl+Shift+O' && keysOf(win, 'shortcuts.chatpage.rail').join() === 'Ctrl+Shift+S' && keysOf(win, 'shortcuts.chatpage.home').join() === 'Alt+Home', '');
const noDup = (sheet) => { const seen = new Map(); const dup = []; for (const s of sheet) for (const e of s.entries) for (const k of e.keys) { const id = `${s.id}|${k}`; if (seen.has(id)) dup.push(`${s.id}: ${k}`); seen.set(id, 1); } return dup; };
check('sheet: no chord is listed twice in one section', noDup(win).length === 0 && noDup(mac).length === 0, noDup(win).concat(noDup(mac)).join(', '));
// Ctrl+Shift+F (Find files) belongs to the Files feature: listed only once the shortcut exists in main.js.
const hasFindFiles = /openFilesPicker|findFiles/.test(main);
check('sheet: Ctrl+Shift+F is listed exactly when main.js has the Find files shortcut', hasFindFiles === onSheet('mod+shift+f'), `main has it: ${hasFindFiles}`);
let shown = null;
SH.createShortcutsHelp({ t: (k) => en[k] || k, platform: 'win32', showNotes: async (o) => { shown = o; } }).open().then(() => {
  const first = shown.notes[0];
  check('sheet: open() shows the page-first line as a paragraph first', first.blocks.length === 1 && first.blocks[0].type === 'p' && first.blocks[0].text === en['shortcuts.pageFirst'], JSON.stringify(first));
  check('sheet: later sections are rows', shown.notes.slice(1).every((n) => n.blocks.length && n.blocks.every((b) => b.type === 'li')), '');
  finish();
});

// ---- no "Mod+" / "CmdOrCtrl" text the user can read
function finish() {
  const bad = Object.entries(en).filter(([, v]) => /\bMod\+|CmdOrCtrl/.test(String(v))).map(([k]) => k);
  check('strings: no "Mod+" or "CmdOrCtrl" in en.json', bad.length === 0, bad.join(', '));
  const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(html|js)$/.test(f.name) && !/\.bundle\./.test(f.name)) files.push(p); } };
  walk(path.join(__dirname, '..', 'src', 'renderer'));
  const hits = [];
  for (const f of files) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\b(?:Mod|CmdOrCtrl)\+/.test(text.replace(/['"`]\s*(?:Cmd|Ctrl|CmdOrCtrl)\+[^'"`]*['"`]\s*,?\s*(?=\)|\]|,)/g, ''))) hits.push(path.relative(path.join(__dirname, '..'), f));
  }
  check('strings: no "Mod+" or "CmdOrCtrl" in the renderer\'s HTML or scripts (comments aside)', hits.length === 0, hits.join(', '));
  const html = read('src/renderer/index.html') + read('src/renderer/newtab.html');
  check('strings: the Meeting helper button and the new-tab hint name real keys', !/Mod\+Enter/.test(html + read('src/renderer/meeting.js')) && /Meeting helper \(Ctrl\+Shift\+E\)/.test(html), '');
  process.exit(failures ? 1 : 0);
}

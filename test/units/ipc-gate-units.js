// Pure unit test for browser/ipc-gate.js, the rule table main.js checks every ipcMain message against:
//  - a sender the rule names passes (the UI, a renderer/ page by its own address, the chat page, any frame for 'web')
//  - a web page's frame, a frame with the wrong address, a subframe, and a channel with no rule are refused
//  - every channel src/ registers, and every channel a preload calls, has a rule, and that rule lets the preload's own page call it
// No Electron.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const gateLib = require('../../src/browser/ipc-gate');
const chatPage = require('../../src/features/chat-page');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const RENDERER = path.join(SRC, 'renderer');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const runnerChannels = [...read('src/features/background-runner.js').match(/const CHANNELS = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
// main.js's own lists, as main.js hands them to the gate: UI_ONLY_IPC (with background-runner's CHANNELS) and PRIVILEGED_IPC
const mainSrc = read('src/main.js');
const uiOnlyBlock = mainSrc.split('const UI_ONLY_IPC = new Set([')[1].split('\n]);')[0];
const UI_ONLY = new Set([...uiOnlyBlock.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(/background-runner'\)\.CHANNELS/.test(uiOnlyBlock) ? runnerChannels : []));
const PRIVILEGED = new RegExp(mainSrc.match(/const PRIVILEGED_IPC = \/(.+)\/;/)[1]);

// ---------- senders ----------
const page = (name) => `${pathToFileURL(path.join(RENDERER, `${name}.html`)).href}`;
function event({ url, top = true, wc = {} } = {}) {
  const mainFrame = { url };
  const sender = Object.assign(wc, { mainFrame });
  return { sender, senderFrame: top ? mainFrame : { url } };
}
const uiWc = {};
const chatWc = {};
const gate = gateLib.create({
  rendererDir: RENDERER,
  uiOnly: UI_ONLY, privileged: PRIVILEGED, chatIpc: chatPage.CHAT_IPC, spareIpc: chatPage.SPARE_IPC,
  surfaces: {
    ui: (e) => e.sender === uiWc && e.senderFrame === e.sender.mainFrame && e.senderFrame.url === page('index'),
    settings: (e) => e.senderFrame === e.sender.mainFrame && e.senderFrame.url === page('settings'),
    chat: (e, channel) => chatPage.CHAT_IPC.has(channel) && e.sender === chatWc && e.senderFrame === e.sender.mainFrame,
  },
});
const ok = (e, c) => gate.allows(e, c).ok;

const uiEvent = event({ url: page('index'), wc: uiWc });
check('the UI may call a UI channel', ok(uiEvent, 'tab:new'));
check('the UI may call a privileged channel', ok(uiEvent, 'settings:set-key'));
check('the UI may call a background-task channel', ok(uiEvent, 'tasks:state'));
check('the Settings page may call a privileged channel', ok(event({ url: page('settings') }), 'prefs:set'));
check('the chat page may call a chat channel', ok(event({ url: page('chat-page'), wc: chatWc }), 'agent:ask'));
check('the History page may list history', ok(event({ url: page('history') }), 'history:list'));
check('the History page with a query and hash still passes', ok(event({ url: `${page('history')}?q=x#y` }), 'history:list'));
check('the new-tab page may ask the AI', ok(event({ url: page('newtab') }), 'newtab-ai:ask'));
check('Lumen pages may read the page strings', ok(event({ url: page('error') }), 'pages:strings') && ok(event({ url: page('bookmarks') }), 'pages:strings'));
check('a web page may use the page-dialog bridge', ok(event({ url: 'https://example.com/' }), 'page-dialog'));
check('the Chrome Web Store may use its install calls', ok(event({ url: 'https://chromewebstore.google.com/detail/x/abc' }), 'chromeWebstore.beginInstall'));
check('another site may not use the web store calls', !ok(event({ url: 'https://chromewebstore.google.com.evil.example/' }), 'chromeWebstore.beginInstall') && !ok(event({ url: 'https://evil.example/' }), 'chrome.management.setEnabled'));

const web = event({ url: 'https://evil.example/' });
check('a web page frame is refused a UI channel', !ok(web, 'tab:new') && gate.allows(web, 'tab:new').reason === 'sender');
check('a web page frame is refused a privileged channel', !ok(web, 'settings:set-key'));
check('a web page frame is refused a Lumen page channel', !ok(web, 'history:list'));
check('a web page frame is refused a chat channel', !ok(web, 'agent:ask'));
check('an extension frame is refused a privileged channel', !ok(event({ url: 'chrome-extension://abcdefghijklmnop/popup.html' }), 'mcp:servers'));
check('a page in the UI webContents with the wrong address is refused', !ok(event({ url: 'https://evil.example/', wc: uiWc }), 'tab:new'));
check('the wrong Lumen page is refused (the new-tab page asking for history)', !ok(event({ url: page('newtab') }), 'history:list'));
check('a subframe showing the right page is refused', !ok(event({ url: page('history'), top: false }), 'history:list'));
check('a subframe of the UI is refused', !ok(event({ url: page('index'), top: false, wc: uiWc }), 'tab:new'));
check('a file outside renderer/ named like the page is refused', !ok(event({ url: pathToFileURL(path.join(ROOT, 'evil', 'renderer', 'history.html')).href }), 'history:list'));
check('a lookalike path below renderer/ is refused', !ok(event({ url: pathToFileURL(path.join(RENDERER, 'x', 'history.html')).href }), 'history:list'));
check('a web address claiming renderer/ is refused', !ok(event({ url: `https://evil.example/${RENDERER.replace(/\\/g, '/')}/history.html` }), 'history:list'));
check('a channel with no rule is refused, even for the UI', !ok(uiEvent, 'nothing:here') && gate.allows(uiEvent, 'nothing:here').reason === 'unmapped');
check('a surface main.js has not wired is refused (pdf)', !ok(event({ url: 'lumen-pdf://app/viewer.html' }), 'pdf:print'));
check('the chat page is refused a UI-only channel that is not in CHAT_IPC', !ok(event({ url: page('chat-page'), wc: chatWc }), 'tab:close'));

// ---------- every channel has a rule ----------
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (p.endsWith('.js') && !p.endsWith('.bundle.js')) files.push(p);
  }
})(SRC);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

const registered = new Map(); // channel -> file
const add = (c, f) => { if (!registered.has(c)) registered.set(c, f); };
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  if (!/ipcMain/.test(s)) continue;
  for (const m of s.matchAll(/ipcMain\.(?:handle|on|once|handleOnce)\(\s*'([^']+)'/g)) add(m[1], rel(f));
  // local helpers that register (settings-backend's handle, managers' on, updates' handle ...): a namespaced first argument
  for (const m of s.matchAll(/\b(?:handle|on)\(\s*'([a-z][a-z0-9-]*:[a-z0-9:-]+)'\s*,/g)) add(m[1], rel(f));
  // for (const name of ['a', 'b']) ipcMain.handle(`ns:x-${name}`, ...)
  for (const m of s.matchAll(/for \(const (\w+) of \[([^\]]+)\]\) ipcMain\.(?:handle|on)\(`([^`$]*)\$\{\1\}([^`]*)`/g)) {
    for (const n of m[2].matchAll(/'([^']+)'/g)) add(`${m[3]}${n[1]}${m[4]}`, rel(f));
  }
  // for (const channel of ['ns:a', 'ns:b']) { ... ipcMain.handle(channel, ...)
  for (const m of s.matchAll(/for \(const channel of \[([^\]]+)\]\)/g)) for (const n of m[1].matchAll(/'([^']+)'/g)) add(n[1], rel(f));
}
for (const c of runnerChannels) add(c, 'src/features/background-runner.js');
// Libraries Lumen loads register on the same ipcMain, so main.js gates them too: each of their channels needs a rule as well.
const LIBRARIES = ['node_modules/electron-chrome-extensions/dist/cjs/index.js', 'node_modules/electron-chrome-web-store/dist/cjs/browser/index.js', 'node_modules/@ghostery/adblocker-electron/dist/commonjs/index.js'];
let libraryChannels = 0;
for (const lib of LIBRARIES) {
  if (!fs.existsSync(path.join(ROOT, lib))) continue; // (no node_modules: the src/ checks still run)
  const s = read(lib);
  for (const m of s.matchAll(/ipcMain\.(?:handle|on|once)\(\s*["']([^"']+)["']/g)) { add(m[1], lib); libraryChannels++; }
  if (/ipcMain\.handle\(channel/.test(s)) for (const m of s.matchAll(/\bhandle\("([a-zA-Z.]+)"/g)) { add(m[1], lib); libraryChannels++; } // the web store's handle(name, fn) helper
}
check(`the libraries' own channels are seen (${libraryChannels})`, libraryChannels >= 20 || !fs.existsSync(path.join(ROOT, 'node_modules')), String(libraryChannels));
for (const m of read('src/features/private-window.js').matchAll(/^\s*'(private:[a-z-]+)': \(/gm)) add(m[1], 'src/features/private-window.js');

// Not ipcMain channels: wired before the gate exists, or carried by a library.
const NOT_GATED = new Set(['ui-preload:loaded']);
const unmapped = [...registered].filter(([c]) => !NOT_GATED.has(c) && !gate.policyFor(c)).map(([c, f]) => `${c} (${f})`);
check(`every registered channel has a rule (${registered.size} found)`, registered.size > 400 && unmapped.length === 0, unmapped.join(', ') || `only ${registered.size} found`);

// The preloads, and which senders each one's calls come from.
const PRELOADS = {
  'src/preload/preload.js': ['ui'],
  'src/features/chat-preload.js': ['chat'],
  'src/preload/settings-preload.js': ['settings'],
  'src/features/managers-preload.js': ['page:bookmarks', 'page:readinglist', 'page:downloads', 'page:mission', 'page:automations'],
  'src/preload/history-preload.js': ['page:history'],
  'src/preload/downloads-preload.js': ['page:downloads-panel'],
  'src/preload/error-preload.js': ['page:error', 'page:cert-error', 'page:https-only', 'page:safe-browsing', 'page:unloaded', 'page:focus-block'],
  'src/preload/newtab-preload.js': ['page:newtab'],
  'src/preload/files-newtab-preload.js': ['page:newtab'],
  'src/preload/dialog-preload.js': ['page:dialog'],
  'src/preload/print-preview-preload.js': ['page:print-preview'],
  'src/preload/recorder-preload.js': ['page:recorder'],
  'src/preload/suggest-preload.js': ['page:suggest'],
  'src/preload/tool-overlay-preload.js': ['page:tool-overlay'],
  'src/preload/link-status-preload.js': ['page:link-status'],
  'src/features/private-preload.js': ['page:private'],
  'src/desktop/banner-preload.js': ['banner'],
  'src/preload/music-engine-preload.js': ['player'],
  'src/preload/permissions-preload.js': ['web', 'pdf', 'page:eml'],
  'src/preload/page-dialogs-preload.js': ['web'],
  'src/preload/page-first-keys-preload.js': ['web'],
  'src/preload/webauthn-preload.js': ['web'],
  'src/preload/activity-preload.js': ['web'],
  'src/features/adblock-preload.js': ['web'],
  'src/preload/extension-css-preload.js': ['web'],
  'src/preload/extensions-mv2-preload.js': ['extension'], // crx-msg: electron-chrome-extensions' own channel, not ipcMain's
};
const LIBRARY = new Set(['crx-msg']);
const preloadFiles = files.map(rel).filter((f) => /ipcRenderer/.test(read(f)));
const unknownPreloads = preloadFiles.filter((f) => !(f in PRELOADS));
check('every file using ipcRenderer is listed here with its senders', unknownPreloads.length === 0, unknownPreloads.join(', '));

const fits = (policy, senders) => policy.some((p) => p === 'web' || senders.includes(p) || (p === 'page:*' && senders.some((s) => s.startsWith('page:'))));
const bad = [];
let calls = 0;
for (const f of preloadFiles) {
  const s = read(f);
  const used = new Set();
  for (const m of s.matchAll(/(?:invoke|send|sendSync|call|postMessage)\(\s*['"`]([^'"`$]+)['"`]/g)) used.add(m[1]);
  for (const m of s.matchAll(/new Set\(\[([^\]]+)\]\)/g)) for (const n of m[1].matchAll(/'([a-z-]+:[a-z-]+)'/g)) if (/\bSEND\b/.test(m.input.slice(Math.max(0, m.index - 12), m.index))) used.add(n[1]);
  for (const c of used) {
    if (LIBRARY.has(c) || NOT_GATED.has(c)) continue;
    calls++;
    const policy = gate.policyFor(c);
    if (!policy) bad.push(`${c} (${f}: no rule)`);
    else if (!fits(policy, PRELOADS[f] || [])) bad.push(`${c} (${f}: rule ${policy.join('/')} leaves out ${PRELOADS[f]})`);
  }
}
check(`every channel a preload calls is allowed for that preload's page (${calls} calls)`, calls > 500 && bad.length === 0, bad.join(', ') || `only ${calls}`);

// ---------- the rules themselves ----------
const surfaces = new Set(['ui', 'settings', 'chat', 'web', 'webstore', 'pdf', 'player', 'banner']);
const pages = new Set(fs.readdirSync(RENDERER).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)));
const badRules = gateLib.RULES.flatMap(([m, list]) => list.filter((s) => !(surfaces.has(s) || s === 'page:*' || (s.startsWith('page:') && pages.has(s.slice(5))))).map((s) => `${m} -> ${s}`));
check('every rule names a known sender or an existing renderer/ page', badRules.length === 0, badRules.join(', '));
const webRules = gateLib.RULES.filter(([, list]) => list.includes('web')).map(([m]) => m);
check(`main.js's lists were read (${UI_ONLY.size} UI channels)`, UI_ONLY.size > 200 && UI_ONLY.has('tab:new') && UI_ONLY.has('tasks:state') && PRIVILEGED.test('settings:set-key'), String(UI_ONLY.size));
check('no privileged or UI channel is open to any frame', webRules.every((m) => !PRIVILEGED.test(m) && !UI_ONLY.has(m)), webRules.join(', '));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

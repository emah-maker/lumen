// [ipc gate] Who may call each ipcMain channel. main.js wraps ipcMain.handle / ipcMain.on so that every
// message is checked here before its handler runs: the sender's webContents and the address of the frame
// that sent it (Lumen's own UI, the Settings tab, a chat page, a page in renderer/, a known view), never
// anything the page says about itself. A channel with no rule is refused (deny by default), and main.js
// logs it in development; test/units/ipc-gate-units.js fails when a channel some code registers or some
// preload calls has no rule here, or when a preload's own page is not among those its rule allows.
// Pure (no Electron).
const path = require('path');
const { pathToFileURL } = require('url');

// The browser UI's channels (UI_ONLY_IPC) and the privileged prefixes (PRIVILEGED_IPC: keys, sign-ins, MCP, imports ...) stay in
// main.js, where the tests and the features that add to them read them; main.js hands them to create().
//
// Every other channel, by who calls it. Surfaces:
//   'page:<name>'  the top frame of Lumen's own renderer/<name>.html (a tab's page or one of Lumen's own views), by its file address
//   'page:*'       the top frame of any page in renderer/
//   'pdf'          the top frame of Lumen's PDF viewer (lumen-pdf://app)
//   'player'       the hidden Spotify / Apple Music player view, by webContents (main.js engineSender)
//   'banner'       the desktop-control banner window, by webContents (desktop/banner.js isBanner)
//   'webstore'     a frame of the Chrome Web Store (https://chromewebstore.google.com), by its own address
//   'web'          any frame at all, web pages and extension frames included. Only for the calls the in-page
//                  preloads make (page dialogs, passkeys, ad blocking, extensions ...): their handlers take
//                  nothing from the page on trust and look up the sender's own tab themselves.
// An exact channel wins over a 'prefix*' one (the longest prefix first).
const RULES = [
  ['prefs:*', ['settings']], // the Settings page's own calls (settings/settings-backend.js checks the page too; prefs:ui is the UI's)
  // Bookmarks, Reading list, Downloads, Tasks, Automations pages (features/managers-preload.js; managers.js checks the page too)
  ['bookmarks:*', ['page:bookmarks']],
  ['readinglist:*', ['page:readinglist']],
  ['mission:*', ['page:mission']],
  ['automations:*', ['page:automations']],
  ['downloads:list', ['page:downloads']],
  ['downloads:act', ['page:downloads', 'page:downloads-panel']], // (one handle for the page, one on for the panel)
  ['downloads:folder', ['page:downloads', 'page:downloads-panel']],
  ['downloads:*', ['page:downloads-panel']], // the downloads bubble (preload/downloads-preload.js)
  ['history:*', ['page:history']], // preload/history-preload.js
  ['pages:strings', ['page:*']], // the string table for Lumen's own pages
  // the error page family (preload/error-preload.js)
  ['crashed:reload', ['page:error']],
  ['missingfile:*', ['page:error']],
  ['focus-page:*', ['page:focus-block']],
  // the new-tab page (preload/newtab-preload.js, files-newtab-preload.js)
  ['newtab-ai:*', ['page:newtab']],
  ['newtab-files:*', ['page:newtab']],
  ['newtab-tiles:*', ['page:newtab']],
  // Lumen's own views
  ['dialog:*', ['page:dialog']],
  ['print:*', ['page:print-preview']],
  ['screen-rec:*', ['page:recorder']],
  ['suggest:pick', ['page:suggest']],
  ['tool-overlay:*', ['page:tool-overlay']],
  ['linkstatus:*', ['page:link-status']],
  ['private:strings', ['page:private', 'page:private-newtab']],
  ['private:*', ['page:private']], // the private window's own UI (features/private-window.js checks the window too)
  ['eml:*', ['page:eml']],
  ['pdf:*', ['pdf']],
  ['desktop-banner:*', ['banner']],
  ['musicengine:*', ['player']],
  // in-page preloads that run in every frame
  ['page-dialog', ['web']], // alert / confirm / prompt (preload/page-dialogs-preload.js)
  ['page-notification:click', ['web']],
  ['page-first-keys:*', ['web']], // preload/page-first-keys-preload.js
  ['site-permissions:states', ['web']], // preload/permissions-preload.js
  ['hide-activity:config', ['web']], // preload/activity-preload.js
  ['lumen-adblock:scriptlets', ['web']], // features/adblock-preload.js
  ['webauthn:*', ['web']], // preload/webauthn-preload.js (features/passkeys.js checks the frame's origin)
  // libraries' own channels (registered through the same ipcMain, so gated the same way)
  ['crx-msg', ['web']], // electron-chrome-extensions: the chrome.* API bridge of the UI's toolbar, extension pages and content scripts (the library checks the extension)
  ['crx-msg-remote', ['web']],
  ['crx-add-listener', ['web']],
  ['crx-remove-listener', ['web']],
  ['@ghostery/adblocker/*', ['web']], // the ad blocker's cosmetic filters, asked for by its preload in every frame
  ['chromeWebstore.*', ['webstore']], // electron-chrome-web-store: the store page's install buttons (the library checks the origin too)
  ['chrome.management.*', ['webstore']],
  ['chrome.runtime.getManifest', ['webstore']],
];

const exact = new Map();
const prefixes = [];
for (const [match, surfaces] of RULES) {
  if (match.endsWith('*')) prefixes.push([match.slice(0, -1), surfaces]);
  else exact.set(match, surfaces);
}
prefixes.sort((a, b) => b[0].length - a[0].length); // the longest prefix first

// opts: { uiOnly: Set (main.js UI_ONLY_IPC: the browser UI), privileged: RegExp (main.js PRIVILEGED_IPC: the UI and Settings),
//         chatIpc: Set, spareIpc: Set (features/chat-page.js: the chat page) }
const NONE = /(?!)/;
function makePolicy({ uiOnly = new Set(), privileged = NONE, chatIpc = new Set(), spareIpc = new Set() } = {}) {
  const cache = new Map();
  const policyFor = (channel) => {
    const c = String(channel);
    if (cache.has(c)) return cache.get(c);
    const out = new Set();
    if (uiOnly.has(c)) out.add('ui');
    if (privileged.test(c)) { out.add('ui'); out.add('settings'); }
    if (chatIpc.has(c) || spareIpc.has(c)) out.add('chat');
    for (const s of exact.get(c) || prefixes.find(([p]) => c.startsWith(p))?.[1] || []) out.add(s);
    const list = out.size ? [...out] : null;
    cache.set(c, list);
    return list;
  };
  return { uiOnly, privileged, policyFor };
}

// The file address of a page without its query and hash, lower-cased (Windows paths compare without case).
const bareFile = (url) => {
  try { const u = new URL(String(url)); if (u.protocol !== 'file:') return ''; u.search = ''; u.hash = ''; return u.href.toLowerCase(); } catch { return ''; }
};
const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';
const originOf = (url) => { try { return new URL(String(url)).origin; } catch { return ''; } };
const topFrame = (event) => Boolean(event?.sender && event.senderFrame && event.senderFrame === event.sender.mainFrame);

// deps: { rendererDir (src/renderer), surfaces: { ui, settings, chat, pdf, player, banner } each (event, channel) -> bool,
//         uiOnly, privileged, chatIpc, spareIpc (makePolicy) }
// allows(event, channel) -> { ok, reason }: reason 'unmapped' (no rule: refused by default) or 'sender'.
function create(deps = {}) {
  const policy = makePolicy(deps);
  const dir = `${pathToFileURL(path.resolve(deps.rendererDir || path.join(__dirname, '..', 'renderer'))).href}/`.toLowerCase();
  const isPage = (event, name) => {
    if (!topFrame(event)) return false;
    const url = bareFile(event.senderFrame.url);
    if (!url.startsWith(dir) || !url.endsWith('.html')) return false;
    const file = url.slice(dir.length, -5);
    return name === '*' ? /^[a-z0-9-]+$/.test(file) : file === name;
  };
  const surfaces = deps.surfaces || {};
  const matches = (surface, event, channel) => {
    if (surface === 'web') return true;
    if (surface === 'webstore') return Boolean(event?.senderFrame) && originOf(event.senderFrame.url) === WEBSTORE_ORIGIN; // (any frame of the store, as the library allows)
    if (surface.startsWith('page:')) return isPage(event, surface.slice(5));
    const test = surfaces[surface];
    return typeof test === 'function' && Boolean(test(event, channel));
  };
  const allows = (event, channel) => {
    const list = policy.policyFor(channel);
    if (!list) return { ok: false, reason: 'unmapped' };
    return list.some((s) => matches(s, event, channel)) ? { ok: true, reason: '' } : { ok: false, reason: 'sender' };
  };
  return { allows, policyFor: policy.policyFor, isPage };
}

module.exports = { create, makePolicy, RULES };

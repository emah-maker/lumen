// Page-first keyboard shortcuts: the page gets a key first and Lumen's own action runs only if the page left it alone, as in Chrome.
//
// Chrome gives a web page the keydown before its own Save page / Print / Find / Bookmark actions, and runs them only when the page
// did not call preventDefault(). MATLAB Online, Google Docs, VS Code for the Web, Figma and Overleaf depend on that for Ctrl+S, Ctrl+P,
// Ctrl+F and friends. Lumen used to take these keys in the tab's before-input-event (main.js handleShortcut), before the page saw them.
//
// Mechanism (no Electron API reports "the page did not handle this key", and Lumen has no application menu on Windows / Linux whose
// accelerators would fire only for unhandled keys):
//   1. main.js's tab before-input-event asks hold(wc, input, run). For a key in PAGE_FIRST on an http(s) page whose focused frame runs
//      preload/page-first-keys-preload.js, it does NOT consume the key (the page gets it) and queues `run` for that exact key press.
//   2. That preload listens for keydown on the window in the capture phase, so it sees every press first, even one a page handler
//      stops. Once the event has finished dispatching (a macrotask later) it reports `event.defaultPrevented` ('page-first-keys:done').
//   3. done(): unprevented -> run Lumen's action (the same handleShortcut path as before); prevented -> nothing happens, as in Chrome.
// Only a press main queued can run (a page cannot forge one: synthetic events are not trusted, the preload is not reachable from page
// script, and a report with no queued press does nothing), and a press runs at most once. A frame without the preload (a cross-origin
// frame the preload does not reach, an error page) keeps the old behaviour: the key is Lumen's at once.
//
// PAGE_FIRST below is the whole list. Everything else that Lumen binds stays browser-first and no page can override it (BROWSER_ONLY).
const { shortcutMod, shortcutKey } = require('../browser/shortcut-mod');

// Combos are 'mod+shift+key' (Alt only on its own: Alt+Left, Alt+D; Ctrl+Alt is AltGr, a typed character, never a shortcut). mod is Ctrl
// (Cmd on macOS). `not` / `only`: the platform where the key is the browser's / the only one that has it.
const PAGE_FIRST = [
  { combo: 'mod+s', does: 'Save page' },
  { combo: 'mod+shift+s', does: 'Screenshot' },
  { combo: 'mod+o', does: 'Open file' },
  { combo: 'mod+shift+o', does: 'Bookmarks' },
  { combo: 'mod+shift+y', does: 'Save for later' },
  { combo: 'mod+p', does: 'Print' },
  { combo: 'mod+shift+p', does: 'Print with the system dialog' },
  { combo: 'mod+f', does: 'Find in page' },
  { combo: 'mod+g', does: 'Find next' },
  { combo: 'mod+shift+g', does: 'Find previous' },
  { combo: 'f3', does: 'Find next' },
  { combo: 'shift+f3', does: 'Find previous' },
  { combo: 'mod+d', does: 'Bookmark this page' },
  { combo: 'mod+shift+d', does: 'Bookmark all tabs' },
  { combo: 'mod+h', does: 'History', not: 'darwin' }, // (Cmd+H hides the app on macOS)
  { combo: 'mod+u', does: 'View source' },
  { combo: 'mod+j', does: 'Sidebar' },
  { combo: 'mod+shift+j', does: 'Downloads', not: 'darwin' },
  { combo: 'mod+shift+k', does: 'New sidebar chat' },
  { combo: 'mod+shift+a', does: 'Search tabs' },
  { combo: 'mod+shift+f', does: 'Open a recent file' },
  { combo: 'mod+shift+l', does: 'Chat as a page' },
  { combo: 'mod+shift+e', does: 'Meeting helper' },
  { combo: 'mod+shift+x', does: 'AI activity (lumen://tasks)' },
  { combo: 'mod+,', does: 'Settings' },
  // Address bar, reload, zoom, history and developer tools: Chrome gives the page these first too (a page that calls preventDefault on
  // Ctrl+L, Ctrl+R or Alt+Left keeps it). Only the tab and window keys in BROWSER_ONLY are reserved.
  { combo: 'mod+l', does: 'Address bar' },
  { combo: 'mod+k', does: 'Command bar' },
  { combo: 'mod+e', does: 'Search from the address bar' },
  { combo: 'alt+d', does: 'Address bar', not: 'darwin' },
  { combo: 'f6', does: 'Address bar' },
  { combo: 'mod+r', does: 'Reload' },
  { combo: 'mod+shift+r', does: 'Reload, past the cache' },
  { combo: 'f5', does: 'Reload' },
  { combo: 'shift+f5', does: 'Reload, past the cache' },
  { combo: 'mod+f5', does: 'Reload, past the cache' },
  { combo: 'mod+=', does: 'Zoom in' },
  { combo: 'mod++', does: 'Zoom in' },
  { combo: 'mod+shift++', does: 'Zoom in' },
  { combo: 'mod+shift+_', does: 'Zoom out' },
  { combo: 'mod+-', does: 'Zoom out' },
  { combo: 'mod+0', does: 'Actual size' },
  { combo: 'alt+arrowleft', does: 'Back' },
  { combo: 'alt+arrowright', does: 'Forward' },
  { combo: 'mod+[', does: 'Back', only: 'darwin' },
  { combo: 'mod+]', does: 'Forward', only: 'darwin' },
  { combo: 'f12', does: 'Developer tools' },
  { combo: 'mod+shift+i', does: 'Developer tools', not: 'darwin' },
  { combo: 'mod+shift+delete', does: 'Clear browsing data' },
  { combo: 'mod+shift+backspace', does: 'Clear browsing data' },
  { combo: 'mod+shift+m', does: 'Merge all windows' },
  { combo: 'mod+shift+/', does: 'Keyboard shortcuts' },
  { combo: 'mod+shift+?', does: 'Keyboard shortcuts' },
];

// Reserved, as in Chrome: the browser takes these before the page sees them and no page can block them. Tabs, windows, full screen.
// main.js's tab before-input-event handles them at once (handleShortcut), without asking the page. (Alt+F4 is the OS's.)
const BROWSER_ONLY = [
  'mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+n', 'mod+shift+n', 'mod+q',
  'mod+tab', 'mod+shift+tab', 'mod+pageup', 'mod+pagedown', 'mod+shift+pageup', 'mod+shift+pagedown',
  'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9',
  'f11', 'mod+f4',
];

// 'mod+shift+s' for a key press (Electron's before-input-event `input`). Ctrl+Alt (AltGr, how some layouts type @ { }  ...) is no shortcut: ''.
function comboOf(input, platform = process.platform) {
  if (!input) return '';
  const mod = shortcutMod(input, platform);
  if (input.alt && (mod || input.control || input.meta)) return '';
  const key = shortcutKey(input);
  if (!key) return '';
  return [mod && 'mod', input.alt && 'alt', input.shift && 'shift', key].filter(Boolean).join('+');
}

// The PAGE_FIRST entry a key press is, or null.
function classify(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return null;
  const combo = comboOf(input, platform);
  return PAGE_FIRST.find((e) => e.combo === combo && e.not !== platform && (!e.only || e.only === platform)) || null;
}

const MAX_AGE_MS = 3000; // a queued press older than this was never reported (a hung page, a navigation): dropped
const sigOf = (key, ctrl, meta, shift, alt) => `${String(key).toLowerCase()}|${ctrl ? 1 : 0}${meta ? 1 : 0}${shift ? 1 : 0}${alt ? 1 : 0}`;

// isReady(frame): did the preload run in this frame (main.js keeps the set).
function create({ isReady, platform = process.platform, now = Date.now } = {}) {
  const queued = new Map(); // webContents id -> [{ sig, run, at }]
  const wired = new WeakSet();

  // True: the key is left to the page and `run` is called if the page does not handle it. False: not a page-first key here,
  // the caller handles it now. `run` is called with no arguments, at most once.
  function hold(wc, input, run) {
    if (!classify(input, platform)) return false;
    try {
      if (!/^https?:\/\//i.test(wc.getURL())) return false; // Lumen's own pages (new tab, Settings, the PDF viewer, chat) keep their keys
      const frame = wc.focusedFrame || wc.mainFrame;
      if (!frame || !isReady(frame)) return false;
    } catch { return false; }
    if (input.isAutoRepeat) return true; // a key held down: the page sees every repeat, Lumen acts on the first press only
    const t = now();
    const fresh = (queued.get(wc.id) || []).filter((q) => t - q.at < MAX_AGE_MS).slice(-7);
    fresh.push({ sig: sigOf(input.key, input.control, input.meta, input.shift, input.alt), run, at: t });
    queued.set(wc.id, fresh);
    if (!wired.has(wc)) { wired.add(wc); const id = wc.id; wc.once('destroyed', () => queued.delete(id)); }
    return true;
  }

  // The preload's report for one key press: { key, ctrl, meta, shift, alt, prevented }.
  function done(wc, report) {
    if (!wc || !report || typeof report !== 'object') return false;
    const list = queued.get(wc.id);
    if (!list || !list.length) return false;
    const t = now();
    const sig = sigOf(report.key, report.ctrl, report.meta, report.shift, report.alt);
    const i = list.findIndex((q) => q.sig === sig && t - q.at < MAX_AGE_MS);
    if (i === -1) return false;
    const [item] = list.splice(i, 1);
    if (report.prevented === true) return false; // the page handled it: Lumen does not
    try { item.run(); } catch (err) { console.error('[lumen] page-first key:', err.message); }
    return true;
  }

  return { hold, done, pending: (wc) => (queued.get(wc.id) || []).length };
}

module.exports = { PAGE_FIRST, BROWSER_ONLY, comboOf, classify, create, sigOf };

// Audit findings 8 and 4: less main-process work per page event and per page load. Plain Node.
// Covers: the tab strip is not sent (nor its hooks run) when a coalesced burst changed nothing it shows, while any
// visible change or a forced send (move, open, close, activation, reloaded UI) always goes; each window has its own
// baseline; a page load's language probe is one small injection (not the 9 KB translator script); the translator
// and reader-mode probe send their big source once per document and only the call after that, and again after a
// new document; the ad blocker's per-page decisions are remembered.
require('./_tmp-cleanup');
const vm = require('vm');
const gates = require('../src/features/save-gates');
const T = require('../src/features/translate');
const { createPageTools } = require('../src/features/page-tools');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the tab strip's send gate (main.js sendTabs) ----
// A stand-in sendTabs with the same shape as main.js's: build the state, ask the gate, then send + run the hooks.
function strip() {
  const gate = gates.tabsSendGate();
  const tabs = [{ id: 1, title: 'A', url: 'https://a.test/', loading: false, favicon: null }, { id: 2, title: 'B', url: 'https://b.test/', loading: false, favicon: null }];
  const out = { sent: 0, hooks: 0, tabs, win: {} };
  out.send = (coalesced = false, key = out.win) => {
    const state = { tabs: tabs.map((t) => ({ ...t })), activeId: out.active || 1 };
    if (!gate.shouldSend(key, state, coalesced !== true)) return;
    out.sent++;
    out.hooks++; // agentTargetHook, chatPageRt.pushTarget, the session timer
  };
  return out;
}
{
  const s = strip();
  s.send();
  check('a forced send goes out and runs the hooks', s.sent === 1 && s.hooks === 1);
  s.send(true);
  s.send(true);
  check('identical coalesced sends are skipped (no IPC, no hooks)', s.sent === 1 && s.hooks === 1, `${s.sent}/${s.hooks}`);
  s.tabs[0].loading = true;
  s.send(true);
  check('a loading flag changing is sent', s.sent === 2);
  s.tabs[0].loading = false;
  s.send(true);
  check('loading finishing is sent', s.sent === 3);
  s.tabs[1].title = 'B (2)';
  s.send(true);
  check('a title change is sent', s.sent === 4);
  s.tabs[1].favicon = 'https://b.test/f.ico';
  s.send(true);
  check('a favicon change is sent', s.sent === 5);
  s.send(false);
  check('a forced send with nothing changed still goes (moves, opens, closes, reloaded UI)', s.sent === 6);
  s.send(true);
  check('and it becomes the baseline for the next burst', s.sent === 6);
  s.active = 2;
  s.send(true);
  check('activation changes are sent', s.sent === 7);
  const other = {};
  s.send(true, other);
  check('another window has its own baseline', s.sent === 8);
  s.send(true, other);
  check('...and dedupes against it', s.sent === 8);
}

// ---- a fake isolated world: one vm context per document, counting every injection ----
function fakeWc(url = 'https://example.fr/') {
  let ctx = null;
  const wc = {
    calls: [], bytes: 0, url, newDocument() { ctx = null; },
    isDestroyed: () => false, getURL: () => wc.url, session: { isPersistent: () => true }, on() {}, once() {},
    executeJavaScriptInIsolatedWorld(world, [{ code }]) {
      wc.calls.push({ world, size: code.length });
      wc.bytes += code.length;
      ctx ??= vm.createContext({
        document: {
          documentElement: { lang: 'fr' }, title: 'Bonjour', body: { innerText: 'Bonjour tout le monde, ceci est une page en francais.' },
          querySelectorAll: () => [], querySelector: () => null, createTreeWalker: () => ({ nextNode: () => null }),
        },
        MutationObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
        NodeFilter: { SHOW_TEXT: 4 }, Node: { TEXT_NODE: 3 }, WeakSet, WeakMap, Map, Set, Promise, JSON, Date, Symbol,
        getComputedStyle: () => ({}),
      });
      try { return Promise.resolve(vm.runInContext(code, ctx)); } catch (err) { return Promise.reject(err); }
    },
  };
  return wc;
}

(async () => {
  // ---- translate: one small probe per load ----
  const tr = T.createTranslate({ readSettings: () => ({ translate: { offer: true, target: 'en' } }), writeSettings() {}, t: (k) => k, uiLocale: () => 'en', engine: () => null, aiAllowed: () => true, sendTabs() {}, popupMenu() {}, openUrl() {}, local: null });
  tr.setTestLocal(false);
  const wc = fakeWc();
  const tab = { id: 1, view: { webContents: wc } };
  await tr.detect(tab);
  check('a load\'s language probe is one injection', wc.calls.length === 1, wc.calls.length);
  check('...and a small one, not the whole translator script', wc.calls[0].size < 600 && wc.calls[0].size * 10 < T.PAGE_SRC.length, `${wc.calls[0].size} vs ${T.PAGE_SRC.length}`);
  check('...that still finds the page language and offers to translate', tr.stateOf(tab)?.lang === 'fr' && tr.stateOf(tab)?.phase === 'offer', JSON.stringify(tr.stateOf(tab)));

  // ---- translate: the page script goes in once per document ----
  const w2 = fakeWc();
  const tab2 = { id: 2, view: { webContents: w2 } };
  const first = await tr.script(tab2, 'sample');
  check('the first call in a document sends the page script and works', first?.lang === 'fr' && w2.calls.length === 2 && w2.calls[1].size > T.PAGE_SRC.length, JSON.stringify(first));
  const before = w2.bytes;
  for (let i = 0; i < 5; i++) await tr.script(tab2, 'sample');
  check('later calls in the same document send only the call', w2.calls.length === 7 && (w2.bytes - before) / 5 < 200, `${w2.calls.length} calls, ${(w2.bytes - before) / 5} bytes each`);
  w2.newDocument();
  const again = await tr.script(tab2, 'sample');
  check('a new document gets the page script again', again?.lang === 'fr' && w2.calls.slice(-2)[1].size > T.PAGE_SRC.length);

  // ---- reader mode probe ----
  const handlers = {};
  const w3 = fakeWc('https://example.com/post');
  w3.on = (ev, fn) => { handlers[ev] = fn; };
  let sends = 0;
  const pt = createPageTools({ sendTabs: () => { sends++; }, openTab() {}, t: (k) => k });
  const tab3 = { id: 3, view: { webContents: w3 } };
  pt.attach(tab3);
  handlers['did-finish-load']();
  await sleep(30);
  check('a load probes reader mode with its source (first in the document)', w3.calls.length === 2 && w3.calls[0].size < 200 && w3.calls[1].size > 1000, JSON.stringify(w3.calls));
  const n = w3.calls.length;
  handlers['did-navigate-in-page'](null, 'https://example.com/post2', true);
  await sleep(900);
  check('an in-page navigation re-probes with just the call', w3.calls.length === n + 1 && w3.calls[n].size < 200, JSON.stringify(w3.calls.slice(n)));
  void sends;
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main.js sends the strip through the gate, and bursts ask for the coalesced path', /tabStripGate\.shouldSend\(/.test(main) && /sendTabs\(true\)/.test(main));

  // ---- the ad blocker's per-page decisions are remembered ----
  const adblock = require('../src/features/adblock');
  if (typeof adblock.pageMemo === 'function') {
    let built = 0;
    const memo = adblock.pageMemo((page) => { built++; return { page }; });
    const a = memo('https://x.test/a');
    memo('https://x.test/a');
    memo('https://x.test/a');
    check('a page URL is worked out once for all its requests', built === 1 && a.page === 'https://x.test/a');
    memo('https://y.test/');
    memo('https://x.test/a');
    check('another page is worked out on its own', built === 2);
  } else check('adblock exports pageMemo', false);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

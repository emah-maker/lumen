// navigate to a same-document URL (#fragment only, identical, pushState): plain Node, mocked webContents.
// Chromium fires did-navigate-in-page (never did-finish-load) for these, so the load waiter must not sit out its cap.
const { EventEmitter } = require('events');
const { sameDocument } = require('../src/ai/load-wait');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const mockWc = (url, onLoad) => {
  const wc = new EventEmitter();
  wc.calls = [];
  wc.url = url;
  wc.getURL = () => wc.url;
  wc.isDestroyed = () => false;
  wc.isLoading = () => false;
  wc.loadURL = (u) => { wc.calls.push(['loadURL', u]); return new Promise((resolve) => onLoad(wc, u, resolve)); };
  wc.reload = () => { wc.calls.push(['reload']); setTimeout(() => wc.emit('did-stop-loading'), 10); };
  return wc;
};

(async () => {
  check('hash-only differs', sameDocument('https://a.com/p#x', 'https://a.com/p#y') === 'hash' && sameDocument('https://a.com/p', 'https://a.com/p#y') === 'hash');
  check('identical', sameDocument('https://a.com/p#x', 'https://a.com/p#x') === 'identical' && sameDocument('https://a.com/', 'https://a.com/') === 'identical');
  check('normal navigations', sameDocument('https://a.com/p#x', 'https://a.com/q#x') === null && sameDocument('https://a.com/p?a=1', 'https://a.com/p?a=2#h') === null && sameDocument('https://a.com/p#x', 'https://a.com/p') === null && sameDocument('', 'https://a.com/') === null);

  const { loadPage } = require('../src/ai/agent');
  let t = Date.now();
  let wc = mockWc('https://a.com/p', (w, u) => setTimeout(() => { w.url = u; w.emit('did-navigate-in-page', {}, u, true); }, 20)); // loadURL never settles
  let kind = await loadPage(wc, 'https://a.com/p#sec', 'interactive', 15000);
  check('hash-only: returns at did-navigate-in-page, fast', kind === 'hash' && Date.now() - t < 1000 && wc.calls[0][0] === 'loadURL', `${kind} ${Date.now() - t}ms`);
  t = Date.now();
  wc = mockWc('https://a.com/p#a', () => {}); // no event at all: capped at ~2 s, never the 15 s cap
  kind = await loadPage(wc, 'https://a.com/p#b', 'load', 15000);
  check('hash-only: silent page still ends within 2.5 s', kind === 'hash' && Date.now() - t < 2500, `${Date.now() - t}ms`);
  t = Date.now();
  wc = mockWc('https://a.com/p#a', (w, u, resolve) => setTimeout(() => { w.emit('did-navigate-in-page', {}, u, true); }, 10));
  await loadPage(wc, 'https://a.com/p#a', 'load', 15000);
  check('identical URL: real reload, no loadURL', wc.calls.length === 1 && wc.calls[0][0] === 'reload' && Date.now() - t < 1000);
  wc = mockWc('https://a.com/p', (w, u, resolve) => setTimeout(() => { w.url = u; w.emit('did-finish-load'); resolve(); }, 20));
  t = Date.now();
  kind = await loadPage(wc, 'https://a.com/q', 'load', 15000);
  check('normal navigation: loadURL, resolves at load', kind === undefined && wc.calls[0][0] === 'loadURL' && Date.now() - t < 1000);
  t = Date.now();
  wc = mockWc('https://a.com/p', (w, u) => setTimeout(() => { w.emit('did-navigate-in-page', {}, 'https://a.com/q/2', true); }, 20)); // SPA route: loadURL never resolves
  await loadPage(wc, 'https://a.com/q', 'load', 15000);
  check('pushState-style in-page event ends a normal wait early', Date.now() - t < 1000, `${Date.now() - t}ms`);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

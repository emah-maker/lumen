// features/stuck-load.js: when a Lumen page that never commits is loaded again, and when it is left alone. Pure Node: a fake
// webContents and fake timers. (test/stuck-load.js does it in a real window.)
const { EventEmitter } = require('events');
const { guard, isStuck, GRACE_MS, MAX_TRIES } = require('../src/features/stuck-load');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const NEW_TAB = 'file:///C:/Lumen/resources/app/src/renderer/newtab.html';

// A webContents whose state the test sets, and timers it fires by hand.
function setup(over = {}) {
  const wc = Object.assign(new EventEmitter(), { loading: true, waiting: true, url: '', destroyed: false, stops: 0, loads: [] });
  wc.isDestroyed = () => wc.destroyed;
  wc.isLoading = () => wc.loading;
  wc.isWaitingForResponse = () => wc.waiting;
  wc.getURL = () => wc.url;
  wc.stop = () => { wc.stops++; };
  wc.loadURL = (u) => { wc.loads.push(u); return Promise.resolve(); };
  const pending = new Map();
  let nextId = 1;
  const timers = {
    set: (fn, ms) => { const id = { n: nextId++, ms, unref() {} }; pending.set(id, fn); return id; },
    clear: (id) => { pending.delete(id); },
  };
  const fire = () => { const all = [...pending.entries()]; pending.clear(); all.forEach(([, fn]) => fn()); return all.length; };
  const logs = [];
  const g = guard(wc, { url: NEW_TAB, timers, log: (m) => logs.push(m), fresh: (u) => `${u}#fresh`, ...over });
  const start = (url = NEW_TAB) => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
  return { wc, g, pending, fire, logs, start };
}

// ---- the decision
check('stuck: a local page, loading, no first response, nothing shown', isStuck({ loading: true, waiting: true, shown: false, url: NEW_TAB }));
check('not stuck: a web page, however slow', !isStuck({ loading: true, waiting: true, shown: false, url: 'https://example.com/' }));
check('not stuck: it has its response (the page is parsing)', !isStuck({ loading: true, waiting: false, shown: false, url: NEW_TAB }));
check('not stuck: it is done loading', !isStuck({ loading: false, waiting: false, shown: false, url: NEW_TAB }));
check('not stuck: the tab already shows a page', !isStuck({ loading: true, waiting: true, shown: true, url: NEW_TAB }));
check('not stuck: the tab is gone', !isStuck({ destroyed: true, loading: true, waiting: true, url: NEW_TAB }));
check('defaults: ten seconds, twice', GRACE_MS === 10000 && MAX_TRIES === 2);

// ---- a stuck load is asked for again, with the address `fresh` gives
{
  const t = setup();
  t.start();
  check('navigation start arms one timer', t.pending.size === 1);
  t.wc.url = '';
  t.fire();
  check('stuck at the deadline: stopped and asked for again, once', t.wc.stops === 1 && t.wc.loads.length === 1 && t.wc.loads[0] === `${NEW_TAB}#fresh`, JSON.stringify(t.wc.loads));
  check('it says so in the log', t.logs.length === 1 && /loading it again \(1 of 2\)/.test(t.logs[0]), t.logs.join('|'));
  t.start(); // the second request starts, and is stuck too
  t.fire();
  check('a second stuck attempt is asked for again too', t.wc.loads.length === 2, t.wc.loads.length);
  t.start();
  t.fire();
  check('and no more than that: the third deadline does nothing', t.wc.loads.length === 2 && t.wc.stops === 2, `${t.wc.loads.length} ${t.wc.stops}`);
}

// ---- a page that comes up ends the watch and resets the count
{
  const t = setup();
  t.start();
  t.wc.loading = false;
  t.wc.emit('did-navigate');
  check('did-navigate cancels the timer', t.pending.size === 0);
  t.wc.url = NEW_TAB;
  t.start();
  t.fire();
  check('a tab that shows a page is not reloaded by a later stuck navigation', t.wc.loads.length === 0);
}
{
  const t = setup();
  t.start();
  t.wc.emit('did-stop-loading');
  check('did-stop-loading (finished, failed or stopped by the user) cancels the timer', t.pending.size === 0);
}

// ---- left alone
{
  const t = setup({ url: 'https://example.com/' });
  t.start('https://example.com/');
  check('a web page never arms the timer, however slow', t.pending.size === 0);
}
{
  const t = setup();
  t.start();
  t.start('https://example.com/'); // the user typed an address while the new-tab page was pending
  check('navigating on to a web page drops the watch', t.pending.size === 0 && t.wc.loads.length === 0);
}
{
  const t = setup();
  t.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: NEW_TAB });
  t.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: NEW_TAB });
  check('a frame or an in-page navigation is not a page load', t.pending.size === 1 /* only the initial arm (loading at start) */);
}
{
  const t = setup({ alive: () => false });
  t.start();
  t.fire();
  check('a tab that no longer holds this webContents is left alone', t.wc.loads.length === 0);
}
{
  const t = setup();
  t.start();
  t.wc.destroyed = true;
  t.fire();
  check('a destroyed webContents is left alone', t.wc.loads.length === 0);
  const u = setup();
  u.start();
  u.wc.emit('destroyed');
  check('destroyed ends the timer', u.pending.size === 0);
}
{
  const t = setup();
  t.start();
  t.wc.loading = false;
  t.fire();
  check('a load that finished by the deadline is left alone', t.wc.loads.length === 0);
}
{
  const t = setup();
  t.start();
  t.wc.waiting = false;
  t.fire();
  check('a page that has its response (slow to parse) is left alone', t.wc.loads.length === 0);
}
{
  const t = setup();
  t.start();
  t.g.stop();
  check('stop() cancels the timer', t.pending.size === 0);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

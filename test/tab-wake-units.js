// Pure unit test for features/tab-wake.js: hover intent timing and cancel, preload selection order and caps, the
// preload gate (memory pressure stops it), the hover gate, and freeze-first vs unload.
const W = require('../src/features/tab-wake');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) { failed++; console.error(`FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}

// A fake clock: timers fire when advance() passes them.
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    set: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

// ---- hover intent ----
{
  const c = clock();
  const fired = [];
  const previews = [];
  const h = W.createHoverIntent({ onIntent: (id, why) => fired.push([id, why]), onPreview: (id) => previews.push(id), setTimer: c.set, clearTimer: c.clear });
  h.enter(1); c.advance(W.HOVER_MS - 1);
  check('hover: not before the hover time (100 ms)', fired.length === 0);
  c.advance(1);
  check('hover: fires at 100 ms', JSON.stringify(fired) === '[[1,"hover"]]', JSON.stringify(fired));
  c.advance(1000);
  check('hover: fires once per visit', fired.length === 1);
  check('hover: preview on enter', JSON.stringify(previews) === '[1]');
  h.leave(1); h.enter(1); c.advance(W.HOVER_MS);
  check('hover: a new visit fires again', fired.length === 2);
}
{
  const c = clock();
  const fired = [];
  const h = W.createHoverIntent({ onIntent: (id, why) => fired.push([id, why]), setTimer: c.set, clearTimer: c.clear });
  h.enter(2); c.advance(60); h.leave(2); c.advance(500);
  check('hover: leaving quickly cancels', fired.length === 0 && c.pending() === 0);
  h.enter(3); c.advance(60); h.enter(4); c.advance(60);
  check('hover: moving to another tab restarts the clock', fired.length === 0);
  c.advance(50);
  check('hover: the second tab fires, not the first', JSON.stringify(fired) === '[[4,"hover"]]', JSON.stringify(fired));
  h.leave(99); c.advance(1000);
  check('hover: leave of another tab changes nothing', fired.length === 1);
  h.cancel(); h.enter(5); h.cancel(); c.advance(500);
  check('hover: cancel stops everything', fired.length === 1 && h.pending() === null);
}
{
  const c = clock();
  const fired = [];
  const h = W.createHoverIntent({ onIntent: (id, why) => fired.push([id, why]), setTimer: c.set, clearTimer: c.clear });
  h.enter(7); c.advance(40); h.down(7);
  check('down: fires at once, as down', JSON.stringify(fired) === '[[7,"down"]]');
  c.advance(500);
  check('down: the pending hover does not fire again', fired.length === 1);
  h.down(8);
  check('down: on a tab never hovered', fired.length === 2 && fired[1][0] === 8 && fired[1][1] === 'down');
}

// ---- preload selection ----
const tab = (id, extra = {}) => ({ id, sleeping: true, frozen: false, web: true, isolated: false, internal: false, sensitive: false, lastActive: id, ...extra });
const strip = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => tab(i + 1, extra(i + 1)));
{
  const tabs = strip(10);
  const pick = (o) => W.pickPreloads({ tabs, activeId: 5, cap: 5, max: 5, ...o });
  check('preload: right, left, then the next ones', JSON.stringify(pick({})) === '[6,4,7,3,10]', JSON.stringify(pick({}))); // 6,4,7,3 then the most recently used: 10
  check('preload: cap 2 gives 2', JSON.stringify(pick({ cap: 2 })) === '[6,4]');
  check('preload: cap 0 gives none', pick({ cap: 0 }).length === 0);
  check('preload: waiting counts against the cap', JSON.stringify(pick({ cap: 3, waiting: 2 })) === '[6]');
  check('preload: waiting at the cap gives none', pick({ cap: 2, waiting: 2 }).length === 0);
  check('preload: one at a time with max 1', JSON.stringify(pick({ max: 1 })) === '[6]');
  check('preload: the sleep cap room limits it', JSON.stringify(pick({ room: 1 })) === '[6]' && pick({ room: 0 }).length === 0);
}
{
  const tabs = strip(8, (id) => ({ sleeping: id !== 5, frozen: id === 6, sensitive: id === 4, isolated: id === 7, internal: id === 3, web: id !== 2 }));
  const got = W.pickPreloads({ tabs, activeId: 5, cap: 5, max: 5 });
  check('preload: skips awake, frozen, sensitive, isolated, internal and non-web tabs', JSON.stringify(got) === '[8,1]', JSON.stringify(got));
  const mru = strip(9, (id) => ({ lastActive: { 1: 50, 9: 10, 8: 90 }[id] || 0 }));
  check('preload: after the neighbours, most recently used first', JSON.stringify(W.pickPreloads({ tabs: mru, activeId: 5, cap: 5, max: 5 })) === '[6,4,7,3,8]', JSON.stringify(W.pickPreloads({ tabs: mru, activeId: 5, cap: 5, max: 5 })));
  check('preload: no active tab in the list falls back to most recently used', JSON.stringify(W.pickPreloads({ tabs: mru, activeId: 99, cap: 2, max: 2 })) === '[8,1]');
  check('preload: empty strip', W.pickPreloads({ tabs: [], activeId: 1, cap: 5, max: 5 }).length === 0);
}

// ---- preload gate ----
{
  const ready = { cap: 2, waiting: 0, frontLoaded: true, cpu: 5, onBattery: false, perfMode: false, memoryLow: false, quitting: false };
  check('gate: go when idle', W.preloadGate(ready).go === true);
  check('gate: off at 0', W.preloadGate({ ...ready, cap: 0 }).why === 'off');
  check('gate: waits for the front tab', W.preloadGate({ ...ready, frontLoaded: false }).why === 'front-loading');
  check('gate: memory pressure stops it', W.preloadGate({ ...ready, memoryLow: true }).why === 'memory');
  check('gate: Performance mode stops it', W.preloadGate({ ...ready, perfMode: true }).why === 'performance-mode');
  check('gate: a busy machine waits', W.preloadGate({ ...ready, cpu: 60 }).why === 'busy');
  check('gate: unknown CPU does not block', W.preloadGate({ ...ready, cpu: null }).go === true);
  check('gate: at the cap', W.preloadGate({ ...ready, waiting: 2 }).why === 'cap');
  check('gate: on battery, one at most', W.preloadGate({ ...ready, onBattery: true, waiting: 1 }).why === 'cap' && W.preloadGate({ ...ready, onBattery: true, waiting: 0 }).go);
  check('gate: quitting', W.preloadGate({ ...ready, quitting: true }).why === 'quitting');
}

// ---- hover gate ----
{
  const t = tab(1);
  check('hover gate: a sleeping web tab wakes', W.hoverGate(t).go === true);
  check('hover gate: not under memory pressure', W.hoverGate(t, { memoryLow: true }).why === 'memory');
  check('hover gate: not when the sleep cap is full', W.hoverGate(t, { room: 0 }).why === 'cap' && W.hoverGate(t, { room: 1 }).go);
  check('hover gate: not a frozen tab, an awake one, a sign-in address', !W.hoverGate(tab(1, { frozen: true })).go && !W.hoverGate(tab(1, { sleeping: false })).go && !W.hoverGate(tab(1, { sensitive: true })).go);
  check('hover gate: no tab', W.hoverGate(null).go === false);
}

// ---- settings values ----
check('preload default is 1', W.cleanPreload(undefined) === 1 && W.cleanPreload('x') === 1 && W.cleanPreload(7) === 1);
check('preload choices', [0, 1, 2, 3, 5].every((n) => W.cleanPreload(n) === n));
check('freeze-first default is 10 minutes; 0 (off) is still a choice', W.cleanFreezeFirst(undefined) === 10 && W.cleanFreezeFirst(11) === 10 && W.cleanFreezeFirst(30) === 30 && W.cleanFreezeFirst(0) === 0);
check('hover time is 100 ms', W.HOVER_MS === 100);
// ---- addresses never woken ahead (kept from the old picture rules)
for (const u of ['https://login.example.com/', 'https://www.paypal.com/myaccount', 'https://example.com/checkout/step2', 'https://example.com/?token=abc', 'https://user:pw@example.com/', 'lumen://newtab']) check(`not woken ahead: ${u}`, Boolean(W.sensitiveAddress(u)), String(W.sensitiveAddress(u)));
for (const u of ['https://example.com/article/1', 'http://example.com/', 'https://example.com/blog/accounting-tips']) check(`woken ahead: ${u}`, W.sensitiveAddress(u) === null);

// ---- freeze first, then unload ----
{
  check('sleepHow: user chose freeze', W.sleepHow({ how: 'freeze', freezeFirstMin: 30 }) === 'freeze');
  check('sleepHow: default unloads', W.sleepHow({ how: 'unload', why: 'idle', freezeFirstMin: 0 }) === 'unload');
  check('sleepHow: idle with freeze-first set freezes first', W.sleepHow({ how: 'unload', why: 'idle', freezeFirstMin: 10 }) === 'freeze-first');
  check('sleepHow: memory pressure unloads', W.sleepHow({ how: 'unload', why: 'idle', freezeFirstMin: 10, low: true }) === 'unload' && W.sleepHow({ how: 'unload', why: 'memory', freezeFirstMin: 10 }) === 'unload');
  check('sleepHow: the awake cap unloads', W.sleepHow({ how: 'unload', why: 'cap', freezeFirstMin: 10 }) === 'unload');
  const frozen = [{ id: 1, frozenAt: 0, first: true }, { id: 2, frozenAt: 5 * 60e3, first: true }, { id: 3, frozenAt: 0, first: false }];
  check('due: after the time', JSON.stringify(W.dueToUnload({ frozen, now: 10 * 60e3, freezeFirstMin: 10 })) === '[1]');
  check('due: a frozen tab the user chose to freeze is never unloaded', !W.dueToUnload({ frozen, now: 1e9, freezeFirstMin: 10, low: true }).includes(3));
  check('due: memory low unloads them all at once', JSON.stringify(W.dueToUnload({ frozen, now: 1000, freezeFirstMin: 10, low: true })) === '[1,2]');
  check('due: setting turned off unloads them', JSON.stringify(W.dueToUnload({ frozen, now: 1000, freezeFirstMin: 0 })) === '[1,2]');
  check('due: nothing yet', W.dueToUnload({ frozen, now: 1000, freezeFirstMin: 10 }).length === 0);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('tab-wake units OK');

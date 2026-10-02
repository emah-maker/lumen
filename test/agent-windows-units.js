// Plain Node: which window an outside agent's session gets, and what happens to it (features/agent-windows.js).
const { createAgentWindows, needsWindow, GRACE_MS } = require('../src/features/agent-windows');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

function harness(over = {}) {
  const h = { made: [], closed: [], kept: [], timers: [], used: new Set(), pinned: new Set(), dead: new Set(), next: 1 };
  h.deps = {
    open: async (label) => { const rec = { id: h.next++, label }; h.made.push(rec); return rec; },
    alive: (rec) => !h.dead.has(rec),
    close: (rec) => { h.closed.push(rec); h.dead.add(rec); },
    keep: (rec) => h.kept.push(rec),
    userUsed: (rec) => h.used.has(rec),
    hasPinned: (rec) => h.pinned.has(rec),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; h.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    ...over,
  };
  h.fire = () => { for (const t of h.timers) if (t.live) { t.live = false; t.fn(); } };
  h.windows = createAgentWindows(h.deps);
  return h;
}

(async () => {
  // lazily made, reused for the session's later calls
  {
    const h = harness();
    const a = {};
    check('no window until the session asks', h.made.length === 0 && h.windows.get(a) === null, h.made.length);
    const first = await h.windows.ensure(a, 'Claude Code');
    const again = await h.windows.ensure(a, 'Claude Code');
    check('a session gets one window and keeps it', first === again && h.made.length === 1 && h.made[0].label === 'Claude Code', h.made.length);
    check('get() finds it without making another', h.windows.get(a) === first && h.made.length === 1, '');
    check('it is an agent window', h.windows.isAgentWindow(first), '');
  }
  // calls arriving together share one window
  {
    const h = harness();
    const a = {};
    const [x, y, z] = await Promise.all([h.windows.ensure(a, 'X'), h.windows.ensure(a, 'X'), h.windows.ensure(a, 'X')]);
    check('simultaneous first calls make one window', x === y && y === z && h.made.length === 1, h.made.length);
  }
  // two clients, two windows
  {
    const h = harness();
    const a = {};
    const b = {};
    const wa = await h.windows.ensure(a, 'Claude Code');
    const wb = await h.windows.ensure(b, 'Codex');
    check('separate sessions get separate windows', wa !== wb && h.made.length === 2, '');
    check('each is the other\'s no more than its own', h.windows.get(a) === wa && h.windows.get(b) === wb, '');
    h.windows.release(a);
    h.fire();
    check('one session ending closes only its window', h.closed.length === 1 && h.closed[0] === wa && h.windows.get(b) === wb, JSON.stringify(h.closed));
  }
  // closed by the user: the next call makes a new one
  {
    const h = harness();
    const a = {};
    const first = await h.windows.ensure(a, 'Claude Code');
    h.dead.add(first);
    check('a closed window is no longer the session\'s', h.windows.get(a) === null && h.windows.windows().length === 0, '');
    const second = await h.windows.ensure(a, 'Claude Code');
    check('the next call makes a new window', second !== first && h.made.length === 2 && h.windows.get(a) === second, h.made.length);
  }
  // end of session: grace, then close
  {
    const h = harness();
    const a = {};
    const w = await h.windows.ensure(a, 'Claude Code');
    h.windows.release(a);
    check('closing waits for a grace period', h.closed.length === 0 && h.timers.at(-1).ms === GRACE_MS, JSON.stringify(h.timers.at(-1)?.ms));
    h.fire();
    check('an unused window closes after the grace', h.closed[0] === w && h.kept.length === 0, JSON.stringify(h.closed));
    check('the session is forgotten afterwards', h.windows.size() === 0 && !h.windows.isAgentWindow(w), '');
  }
  // a window the user used or pinned in is kept (and is an ordinary window then)
  {
    const h = harness();
    const a = {};
    const w = await h.windows.ensure(a, 'Claude Code');
    h.used.add(w);
    h.windows.release(a);
    h.fire();
    check('a window the user used is never closed', h.closed.length === 0 && h.kept[0] === w, JSON.stringify([h.closed, h.kept]));
    check('...and stops being an agent window', !h.windows.isAgentWindow(w), '');
  }
  {
    const h = harness();
    const a = {};
    const w = await h.windows.ensure(a, 'Claude Code');
    h.pinned.add(w);
    h.windows.release(a);
    h.fire();
    check('a window with a pinned tab is kept', h.closed.length === 0 && h.kept[0] === w, '');
  }
  // ending twice, and a call during the grace
  {
    const h = harness();
    const a = {};
    const w = await h.windows.ensure(a, 'Claude Code');
    h.windows.release(a);
    check('ending twice starts one timer', h.windows.release(a) === false && h.timers.length === 1, h.timers.length);
    const back = await h.windows.ensure(a, 'Claude Code');
    h.fire();
    check('a call during the grace cancels the close', back === w && h.closed.length === 0, JSON.stringify(h.closed));
  }
  // the session ends while its window is being made
  {
    let finish;
    const h = harness({ open: (label) => new Promise((resolve) => { finish = () => resolve({ id: 99, label }); }) });
    const a = {};
    const pending = h.windows.ensure(a, 'Claude Code');
    await new Promise((r) => setImmediate(r));
    h.windows.release(a);
    h.fire();
    finish();
    let failed = false;
    await pending.catch(() => { failed = true; });
    check('a window finished after its session ended is closed at once', failed && h.closed.length === 1, JSON.stringify(h.closed));
  }
  // releaseAll
  {
    const h = harness();
    const a = {};
    const b = {};
    const wa = await h.windows.ensure(a, 'A');
    await h.windows.ensure(b, 'B');
    h.used.add(wa);
    h.windows.releaseAll();
    check('releaseAll settles every window (kept or closed)', h.kept.length === 1 && h.closed.length === 1 && h.windows.size() === 0, JSON.stringify([h.kept, h.closed]));
  }
  // which tools make a window
  check('list_tabs and wait do not make a window', !needsWindow('list_tabs') && !needsWindow('wait'), '');
  check('navigate, open_tab, screenshot, web_search, read_tabs do', ['navigate', 'open_tab', 'screenshot', 'web_search', 'read_tabs', 'read_page'].every(needsWindow), '');

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();

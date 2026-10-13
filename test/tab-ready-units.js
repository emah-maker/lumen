// Pure logic of keeping tabs ready (src/features/tab-ready.js), and the shape of main.js's use of it: which tabs, how many, when they are
// let go, and that the Electron call is setBackgroundThrottling. test/tab-ready.js runs the real thing in a hidden window.
const fs = require('fs');
const path = require('path');
const TR = require('../src/features/tab-ready');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const tab = (id, lastActive, extra = {}) => ({ id, lastActive, ready: true, token: `wc${id}`, ...extra });
const keys = (m) => JSON.stringify([...m.entries()]);

// ---- which tabs
const tabs = [tab(1, 100), tab(2, 500), tab(3, 400), tab(4, 300), tab(5, 200), tab(6, 0)];
check('the 3 latest background tabs are ready by default (never the one in front, never one never visited)', keys(TR.wanted(tabs, { activeId: 2 })) === '[[3,"recent"],[4,"recent"],[5,"recent"]]', keys(TR.wanted(tabs, { activeId: 2 })));
check('the default is 3 and the choices are 0, 1, 2, 3, 5', TR.RECENT_DEFAULT === 3 && JSON.stringify(TR.RECENT_CHOICES) === '[0,1,2,3,5]' && TR.cleanRecent(undefined) === 3 && TR.cleanRecent('4') === 3 && TR.cleanRecent('5') === 5 && TR.cleanRecent(0) === 0);
check('0 keeps only the tab under the pointer', keys(TR.wanted(tabs, { activeId: 2, recent: 0, hoverId: 5 })) === '[[5,"hover"]]');
check('the hovered tab is ready and does not use up a place of the recent ones', keys(TR.wanted(tabs, { activeId: 2, hoverId: 1 })) === '[[1,"hover"],[3,"recent"],[4,"recent"],[5,"recent"]]', keys(TR.wanted(tabs, { activeId: 2, hoverId: 1 })));
check('a hovered tab that is also a recent one stays "hover" and the budget is not spent twice', keys(TR.wanted(tabs, { activeId: 2, hoverId: 3 })) === '[[3,"hover"],[4,"recent"],[5,"recent"]]', keys(TR.wanted(tabs, { activeId: 2, hoverId: 3 })));
check('the tab in front is never wanted, even when hovered', !TR.wanted(tabs, { activeId: 2, hoverId: 2 }).has(2));
check('a sleeping, frozen or Reload-page tab (not ready) is not kept, and takes no place', keys(TR.wanted([tab(1, 900, { ready: false }), tab(2, 800), tab(3, 700), tab(4, 600), tab(5, 500)], { activeId: 9 })) === '[[2,"recent"],[3,"recent"],[4,"recent"]]');

// ---- how many, when
check('on battery: one', TR.recentBudget({ onBattery: true }) === 1 && TR.recentBudget({ onBattery: true, recent: 0 }) === 0);
check('low memory, Performance mode, a hidden or minimised window: none', TR.recentBudget({ memoryLow: true }) === 0 && TR.recentBudget({ perfMode: true }) === 0 && TR.recentBudget({ windowActive: false }) === 0);
check('a hidden window keeps nothing ready, not even the hovered tab', TR.wanted(tabs, { activeId: 2, hoverId: 1, windowActive: false }).size === 0);
check('under memory pressure the tab under the pointer is still ready (one tab, for the click on its way)', keys(TR.wanted(tabs, { activeId: 2, hoverId: 1, memoryLow: true })) === '[[1,"hover"]]');

// ---- keeping them: the Electron call, once, and let go
{
  const calls = [];
  let wc = { 1: 'a1', 3: 'a3', 4: 'a4', 5: 'a5', 7: 'a7' };
  const timers = [];
  const ctl = TR.create({
    apply: (id, on, token) => { calls.push([id, on]); if (token && token !== wc[id]) return null; return on ? wc[id] : null; },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; },
    graceMs: 1500,
  });
  const facts = () => [1, 3, 4, 5].map((id) => tab(id, 100 + id, { token: wc[id] }));
  ctl.sync(TR.wanted(facts(), { activeId: 9 }), facts());
  check('first sync boosts the 3 latest, once each (apply(id, true))', JSON.stringify(calls) === '[[5,true],[4,true],[3,true]]', JSON.stringify(calls));
  calls.length = 0;
  ctl.sync(TR.wanted(facts(), { activeId: 9 }), facts());
  check('a second sync with nothing changed makes no call', calls.length === 0, JSON.stringify(calls));
  // the user goes to tab 5: it is in front now; 1 is the new third latest
  ctl.sync(TR.wanted(facts(), { activeId: 5 }), facts());
  check('switching to a kept tab releases it (apply(id, false)); the next latest is boosted', JSON.stringify(calls) === '[[5,false],[1,true]]', JSON.stringify(calls));
  calls.length = 0;
  // hover on 4 -> already recent: nothing; hover on a tab that is not: boosted, then released after the grace
  ctl.sync(TR.wanted(facts(), { activeId: 5, hoverId: 3 }), facts());
  check('hovering a tab that is already kept makes no call', calls.length === 0, JSON.stringify(calls));
  const more = [...facts(), tab(7, 1, { token: 'a7' })];
  ctl.sync(TR.wanted(more, { activeId: 5, hoverId: 7, recent: 0 }), more);
  check('recent: 0 releases the recent ones at once (the one hovered a moment ago waits its grace) and keeps the hovered one', !ctl.has(1) && !ctl.has(4) && ctl.has(7) && ctl.why(7) === 'hover', JSON.stringify(ctl.ids()));
  ctl.sync(TR.wanted(more, { activeId: 5, hoverId: 7, recent: 0 }), more);
  ctl.sync(TR.wanted(more, { activeId: 5, recent: 0 }), more);
  const leave = timers.filter((t) => !t.cleared).at(-1);
  check('the pointer leaving does not release at once: it waits the grace (1.5 s)', ctl.has(7) && leave.ms === 1500);
  ctl.sync(TR.wanted(more, { activeId: 5, hoverId: 7, recent: 0 }), more);
  check('...and the pointer coming back cancels the release', leave.cleared === true && ctl.has(7));
  ctl.sync(TR.wanted(more, { activeId: 5, recent: 0 }), more);
  calls.length = 0;
  timers.filter((t) => !t.cleared).forEach((t) => t.fn());
  check('after the grace the hovered tab is released (apply(id, false))', !ctl.has(7) && calls.some(([id, on]) => id === 7 && on === false), JSON.stringify(calls));
  // a woken tab (new page) is boosted again, with nothing released for the old page
  calls.length = 0;
  ctl.sync(TR.wanted(facts(), { activeId: 9 }), facts());
  const before = calls.length;
  wc = { ...wc, 3: 'b3' }; // tab 3 slept and woke: a new page
  calls.length = 0;
  ctl.sync(TR.wanted(facts(), { activeId: 9 }), facts());
  check('a tab woken into a new page is boosted again, and nothing is released for the page that is gone', JSON.stringify(calls) === '[[3,true]]' && before >= 0, JSON.stringify(calls));
  // a tab that closed: forgotten, no release call
  calls.length = 0;
  const fewer = facts().filter((t) => t.id !== 4);
  ctl.sync(TR.wanted(fewer, { activeId: 9 }), fewer);
  check('a closed tab is forgotten without a call (its page is gone)', !calls.some(([id]) => id === 4) && !ctl.has(4), JSON.stringify(calls));
  calls.length = 0;
  ctl.releaseAll();
  check('releaseAll lets every one go', ctl.size() === 0 && calls.every(([, on]) => on === false) && calls.length > 0);
  check('an apply that returns null (another feature keeps the tab unthrottled) is not tracked', (() => { const c = TR.create({ apply: () => null }); c.sync(new Map([[1, 'recent']]), [tab(1, 1)]); return c.size() === 0; })());
}

// ---- main.js uses it the way the module says
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main applies it with setBackgroundThrottling(!on): false keeps the renderer out of the background state', /wc\.setBackgroundThrottling\(!on\);\s*\r?\n\s*return on \? wc : null;/.test(main));
  check('a tab a run or an agent window keeps unthrottled is never touched', /agentContents\.has\(wc\) \|\| unthrottled\.has\(id\)\) return null/.test(main));
  check('the strip\'s hover and press messages drive it (tab:hover, tab:down), 60 ms rest', /readyPointer\(event, id, on \? 'enter' : 'leave'\)/.test(main) && /readyPointer\(event, id, 'down'\)/.test(main) && TR.HOVER_MS === 60);
  check('a switch schedules one sync after it settles, not one per switch', /scheduleReadySync\(curRec\);/.test(main) && TR.SYNC_MS >= 100 && /if \(r\.timer\) return;/.test(main));
  check('the window hiding or minimising releases them (events re-sync)', /\['minimize', 'restore', 'show', 'hide'\]/.test(main));
  check('layout() calls setVisible only when the visibility changes (two calls for a switch, not one per tab)', /if \(tab\.view\.getVisible\(\) !== show\) \{ tab\.view\.setVisible\(show\); viewVisibleCalls\+\+; \}/.test(main));
  check('a burst lays out once per frame, for the latest tab only', /if \(rapid\) frameLayout\(tab, timing\);/.test(main) && /const FRAME_MS = 16;/.test(main));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  check('the strip reports hover and press on every tab but the one in front, not only sleeping ones', /el && !el\.classList\.contains\('active'\) \? Number\(el\.dataset\.id\)/.test(ui));
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui.bundle.js'), 'utf8');
  check('the committed UI bundle has the same (run node scripts/bundle-renderer.js)', /el && !el\.classList\.contains\('active'\) \? Number\(el\.dataset\.id\)/.test(bundle));
  const backend = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
  check('the setting is tabReadyRecent, default 3', /\n {2}tabReadyRecent: 3,/.test(backend));
  const mod = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'tab-ready.js'), 'utf8');
  check('the module is pure (no electron, no timers of its own at load)', !/require\('electron'\)/.test(mod));
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);

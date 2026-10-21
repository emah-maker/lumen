// Which tab a clicked chat notification opens, and the notification being kept alive (features/notify-target.js), plain Node.
const { pickTab, createKeeper } = require('../../src/features/notify-target');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const open = (...ids) => (id) => ids.includes(id);

// ---- the pick order
check('order: the tab the run last acted in comes first (the AI\'s own tab, not the tab the chat started on)', pickTab({ kind: 'done', runTab: 7, aiNavTab: 7, homeTab: 1, bound: [1, 2] }, open(1, 2, 7)) === 7);
check('order: the AI\'s navigation tab beats the home tab when the run has no tab of its own noted', pickTab({ kind: 'done', runTab: null, aiNavTab: 7, homeTab: 1, bound: [1] }, open(1, 7)) === 7);
check('order: the run\'s tab beats the AI\'s navigation tab (it moved on to another tab on purpose)', pickTab({ kind: 'done', runTab: 4, aiNavTab: 7, homeTab: 1 }, open(1, 4, 7)) === 4);
check('order: an approval opens the tab the approval is about, even over where the run is now', pickTab({ kind: 'approval', approvalTab: 5, runTab: 7, aiNavTab: 7, homeTab: 1 }, open(1, 5, 7)) === 5);
check('order: an approval notification\'s tab is ignored for a finished-reply notification', pickTab({ kind: 'done', approvalTab: 5, runTab: 7, homeTab: 1 }, open(1, 5, 7)) === 7);
check('fallback: the AI\'s tab was closed -> the tab the chat started on', pickTab({ kind: 'done', runTab: 7, aiNavTab: 7, homeTab: 1, bound: [2] }, open(1, 2)) === 1);
check('fallback: the home tab is gone too -> a tab bound to the chat, in the order given', pickTab({ kind: 'done', runTab: 7, aiNavTab: 7, homeTab: 1, bound: [1, 3, 2] }, open(2, 3)) === 3);
check('fallback: an approval\'s tab was closed -> where the run worked, then the rest', pickTab({ kind: 'approval', approvalTab: 5, runTab: 7, homeTab: 1 }, open(7, 1)) === 7);
check('fallback: nothing is open -> null (the run\'s window is raised instead)', pickTab({ kind: 'done', runTab: 7, aiNavTab: 8, homeTab: 1, bound: [2] }, open()) === null);
check('order: tab id 0 is a tab (not "none")', pickTab({ kind: 'done', runTab: 0, homeTab: 1 }, open(0, 1)) === 0);
check('order: nothing known -> null', pickTab({}, open(1)) === null && pickTab(undefined, open(1)) === null);
let asked = 0;
pickTab({ kind: 'done', runTab: 7, aiNavTab: 7, homeTab: 7, bound: [7, 7] }, () => { asked++; return false; });
check('order: a tab named twice is looked up once', asked === 1, String(asked));

// ---- keeping the notification (an unreferenced Electron Notification loses its click handler when collected)
{
  let t = 1000;
  const k = createKeeper({ now: () => t, keepMs: 10000, activationMs: 3000, max: 3 });
  const a = {}, b = {}, c = {}, d = {};
  const ia = k.keep(a, 'A');
  check('keeper: a notification is held after it is shown (nothing else references it)', k.has(a) && k.size() === 1);
  t += 5000;
  check('keeper: still held while it may be clicked', k.has(a));
  k.clicked(ia);
  check('keeper: let go once clicked', !k.has(a) && k.size() === 0);
  const ib = k.keep(b, 'B');
  t += 11000;
  check('keeper: let go when too old', !k.has(b) && k.size() === 0);
  k.keep(a, 'A'); k.keep(b, 'B'); k.keep(c, 'C'); k.keep(d, 'D');
  check('keeper: never holds more than the cap (the oldest goes)', k.size() === 3 && !k.has(a) && k.has(d));
  void ib;
}
{
  let t = 1000;
  const k = createKeeper({ now: () => t, keepMs: 600000, activationMs: 3000 });
  check('activation: nothing shown -> nothing to open', k.takeActivation() === null);
  k.keep({}, 'old'); t += 1000; k.keep({}, 'new');
  t += 500;
  check('activation: the newest fresh notification is the one meant', k.takeActivation() === 'new');
  check('activation: taken once; the earlier one is next while still fresh', k.takeActivation() === 'old' && k.takeActivation() === null);
  k.keep({}, 'stale'); t += 5000;
  check('activation: an old notification is not hijacked into a plain relaunch', k.takeActivation() === null);
  const it = k.keep({}, 'clicked'); k.clicked(it);
  check('activation: a clicked notification is not opened again', k.takeActivation() === null);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall notify-target checks passed');
process.exit(failures ? 1 : 0);

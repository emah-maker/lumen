// A timer that exists only while something visible needs it (renderer/newtab-widgets.js clocks, countdowns and timers, renderer/newtab-stacks.js
// auto-rotate, renderer/newtab-music.js progress). A new-tab page used to run several setIntervals for its whole life, each waking the renderer
// every second to find nothing to do (also the resident spare page, and pages in the background). This one:
//   - does not run while the page is hidden (or not visible to the user) or while needed() is false: no timer exists then, 0 wakeups;
//   - is re-armed by poke() when something that needs it appears, and by onVisibility() when the page comes back;
//   - lands on wall-clock boundaries (the next whole second, or minute for a clock without seconds) instead of drifting.
// Pure, no DOM: the page loads it as a script (globalThis.VisibleTicker) and the unit tests require it with fake timers.
//
//   createTicker({ run, needed, period?, visible?, align?, now?, setTimeout?, clearTimeout? })
//     run()      called on each tick
//     needed()   is anything on screen that needs ticks?
//     period     ms, or a function giving the current one (re-read each time the timer is armed; poke() re-arms sooner if it got shorter)
//     visible()  default: !document.hidden
//     align      land on multiples of `period` of the wall clock (default true)
//   -> { poke(), onVisibility(), stop(), active() }
/* global document */
(function () {
'use strict';

function createTicker(o) {
  const run = o.run;
  const needed = o.needed || (() => true);
  const visible = o.visible || (() => typeof document === 'undefined' || !document.hidden);
  const now = o.now || Date.now;
  const set = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clear = o.clearTimeout || ((t) => clearTimeout(t));
  const align = o.align !== false;
  let timer = null;
  let due = 0;
  const periodNow = () => Math.max(50, Number(typeof o.period === 'function' ? o.period() : o.period) || 1000);
  function wait(p) { return align ? p - (now() % p) + 2 : p; } // (+2 ms: a timer that fires a hair early must not tick in the same second twice)
  function arm() {
    if (!visible() || !needed()) { stop(); return; }
    const w = wait(periodNow());
    const at = now() + w;
    if (timer !== null && due <= at) return; // already due sooner (or as soon)
    if (timer !== null) clear(timer);
    due = at;
    timer = set(fire, w);
  }
  function fire() {
    timer = null;
    if (!visible() || !needed()) return;
    try { run(); } finally { arm(); }
  }
  function stop() { if (timer !== null) { clear(timer); timer = null; } }
  return {
    poke: arm,
    // The page was hidden or shown: a hidden page has no timer at all; a shown one catches up at once.
    onVisibility() {
      if (!visible()) { stop(); return; }
      if (needed()) { try { run(); } finally { arm(); } }
    },
    stop,
    active: () => timer !== null,
  };
}

const api = { createTicker };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.VisibleTicker = api;
})();

// Keeping tabs "ready": the page you are about to switch to has a renderer that is not parked in the background.
//
// Why: Chromium lowers the operating-system priority of a hidden tab's renderer process, and on Windows 11 also puts it in efficiency mode
// (EcoQoS: base::Process::SetPriority, the UseEcoQoSForBackgroundProcess feature, on by default). A tab left alone for a while is in that state, so
// when it is shown its first frame is slow: the process has to be scheduled up again before it can draw. A hidden test window cannot show this
// (every tab of a test window counts as visible); Settings > Advanced > Diagnostics > "Record tab-switch timings" records it on a real machine.
//
// What this does: `webContents.setBackgroundThrottling(false)` makes Chromium treat the page as visible-but-hidden ("hidden but painting"): the
// renderer keeps its foreground priority, its timers are not throttled and its last frame is not evicted. So that a tab is not kept like that
// for nothing, only these tabs are kept ready, and only while the window is in use:
//   - the tab under the pointer (a 60 ms rest, or the moment the button goes down), released 1.5 s after the pointer leaves;
//   - the most recently used background tabs (Settings → Tabs and browsing > Page unloading > "Keep recent tabs ready", 3 by default, 0 turns this part off).
// Fewer on battery (one), none under memory pressure, in Performance mode, or while the window is hidden or minimised.
// Pure logic (test/units/tab-ready-units.js); main.js does the Electron parts.
'use strict';

const RECENT_CHOICES = [0, 1, 2, 3, 5]; // Settings → Tabs and browsing > Page unloading: "Keep recent tabs ready"
const RECENT_DEFAULT = 3;
const HOVER_MS = 60; // a pointer resting on a tab this long means to go there (main hands this to the hover intent)
const LEAVE_GRACE_MS = 1500; // a hover boost is released this long after the pointer leaves (a move to the next tab, a click, keeps it)
const SYNC_MS = 120; // after a switch, the set of ready tabs is recomputed once things have settled (a burst of switches does it once)

const cleanRecent = (v) => (v != null && v !== '' && RECENT_CHOICES.includes(Number(v)) ? Number(v) : RECENT_DEFAULT);

// How many recent tabs to keep ready now.
function recentBudget({ recent = RECENT_DEFAULT, onBattery = false, memoryLow = false, perfMode = false, windowActive = true } = {}) {
  const n = cleanRecent(recent);
  if (!windowActive || memoryLow || perfMode) return 0;
  return onBattery ? Math.min(n, 1) : n;
}

// Which tabs should be ready. tabs: [{ id, lastActive (ms), ready (a live page that may be kept: not asleep, frozen, a Reload page or
// another feature's), token }] in any order; opts: recentBudget's, plus activeId and hoverId.
// -> Map id -> 'hover' | 'recent' (the tab in front is never in it: it is visible).
function wanted(tabs, { activeId = null, hoverId = null, ...opts } = {}) {
  const out = new Map();
  const ok = (t) => t && t.ready && t.id !== activeId;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  if (opts.windowActive !== false && hoverId != null && ok(byId.get(hoverId))) out.set(hoverId, 'hover');
  const n = recentBudget(opts);
  if (n > 0) {
    const recent = tabs.filter((t) => ok(t) && t.lastActive > 0).sort((a, b) => b.lastActive - a.lastActive);
    for (const t of recent.slice(0, n)) if (!out.has(t.id)) out.set(t.id, 'recent'); // (the hovered tab is one of them: it stays 'hover' and the budget is not spent twice)
  }
  return out;
}

// The tabs now kept ready. apply(id, on) does the Electron call and returns a token for the page it applied to (or null: not applied);
// `token` in the facts tells a woken tab (a new page) from the one boosted.
function create({ apply, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, graceMs = LEAVE_GRACE_MS } = {}) {
  const held = new Map(); // id -> { why, token, releaseAt, timer }
  const drop = (id, release) => {
    const h = held.get(id);
    if (!h) return;
    if (h.timer != null) clearTimer(h.timer);
    held.delete(id);
    if (release) { try { apply(id, false, h.token); } catch { /* the page is gone */ } }
  };
  return {
    // want: the Map from wanted(); facts: the same tabs (for tokens). Boosts what is new (and what was woken since), releases what is not wanted:
    // at once, except a hover boost, which waits `graceMs` unless the tab is wanted again.
    sync(want, facts = []) {
      const tokenOf = new Map(facts.map((t) => [t.id, t.token]));
      const inFront = new Set(facts.filter((t) => t.active).map((t) => t.id)); // (shown now: nothing left to keep ready, a hover boost does not wait its grace)
      for (const [id, h] of [...held]) {
        if (!tokenOf.has(id) || tokenOf.get(id) !== h.token) { drop(id, false); continue; } // (closed, or woken into a new page: nothing to release)
        if (want.has(id)) { if (h.timer != null) { clearTimer(h.timer); h.timer = null; } h.why = want.get(id); continue; }
        if (h.why === 'hover' && !inFront.has(id)) {
          if (h.timer == null) { h.timer = setTimer(() => { h.timer = null; drop(id, true); }, graceMs); h.timer?.unref?.(); }
        } else drop(id, true);
      }
      for (const [id, why] of want) {
        if (held.has(id)) continue;
        let token = null;
        try { token = apply(id, true); } catch { token = null; }
        if (token != null) held.set(id, { why, token, timer: null });
      }
      return this.ids();
    },
    release(id) { drop(id, true); },
    releaseAll() { for (const id of [...held.keys()]) drop(id, true); },
    forget(id) { drop(id, false); },
    has: (id) => held.has(id),
    why: (id) => held.get(id)?.why || null,
    ids: () => [...held.keys()],
    size: () => held.size,
  };
}

module.exports = { RECENT_CHOICES, RECENT_DEFAULT, HOVER_MS, LEAVE_GRACE_MS, SYNC_MS, cleanRecent, recentBudget, wanted, create };

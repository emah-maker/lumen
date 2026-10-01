// New-tab Smart Stack: the parts of cycling that are plain logic, so they can be tested without a page.
// renderer/newtab-stacks.js (the wheel, swipe, keys, dots, auto-rotate and the panel) calls these.
//
//   autoPlan(o)         when a stack that rotates by itself should advance next (or never, for now)
//   smartPick(o)        the widget in a stack that deserves to be shown right now, and why
//   settleTarget(...)   where a released swipe lands: back, or the next/previous card
//   springStep(...)     one step of a critically damped spring (Apple's damping ratio + response)
//   project(v)          where a flick with velocity v would coast to (UIScrollView deceleration)
//
// No DOM, no Electron, no clock of its own: every function is given the time.
(function () {
'use strict';

const AUTO_MS = 20000; // a stack that rotates by itself advances this long after the last move or touch (15 to 30 s)
const SOON_MS = 30 * 60 * 1000; // a calendar event this close is worth showing
const DAY_MS = 24 * 60 * 60 * 1000; // a countdown this close is worth showing
const MORNING = [5, 10]; // hours (local) that the weather is the first thing to see: 05:00 to 09:59
const GRACE_MS = 2 * 60 * 1000; // an event that began a moment ago still counts

// When should a stack advance by itself? o = { rotate (the stack's option), count (members), hidden (page not
// visible), hovered, focused, reduced (prefers-reduced-motion), calm (Performance mode), editing, busy (a
// swipe or switch is in progress), now, last (ms of the last move, switch or touch) }.
// -> { run: false } when it must not (a pause, not a delay), or { run: true, wait } with the ms until it is
// due (0 = now).
function autoPlan(o) {
  const blocked = o.rotate === false || !(o.count >= 2) || o.hidden || o.hovered || o.focused || o.reduced || o.calm || o.editing || o.busy;
  if (blocked) return { run: false, wait: null };
  const last = Number.isFinite(o.last) ? o.last : o.now;
  return { run: true, wait: Math.max(0, last + AUTO_MS - o.now) };
}

// Which widget does the time say to show? o = { items: [{ id, type, data }], now (ms), hour (0-23, local),
// day ("2026-10-01", local) }. Rules, in this order:
//   1. a calendar event (not all-day) starting within 30 minutes
//   2. a countdown that ends within a day
//   3. the weather, in the morning (05:00 to 09:59)
// -> { id, reason: 'event' | 'countdown' | 'morning', key } or null. `key` names this particular moment
// (this event, this countdown, this day's morning) so a person's own choice is not overridden again for
// the same one.
function smartPick(o) {
  const items = Array.isArray(o?.items) ? o.items : [];
  const now = Number(o?.now);
  if (!Number.isFinite(now)) return null;
  let event = null;
  for (const it of items) {
    if (it?.type !== 'calendar' || !Array.isArray(it.data?.events)) continue;
    for (const ev of it.data.events) {
      if (!ev || ev.allDay || !Number.isFinite(ev.start)) continue;
      const until = ev.start - now;
      if (until < -GRACE_MS || until > SOON_MS) continue;
      if (!event || ev.start < event.start) event = { id: it.id, start: ev.start };
    }
  }
  if (event) return { id: event.id, reason: 'event', key: `event:${event.id}:${event.start}` };
  let count = null;
  for (const it of items) {
    const target = it?.type === 'countdown' ? it.data?.target : null;
    if (!Number.isFinite(target)) continue;
    const until = target - now;
    if (until < 0 || until > DAY_MS) continue;
    if (!count || target < count.target) count = { id: it.id, target };
  }
  if (count) return { id: count.id, reason: 'countdown', key: `countdown:${count.id}:${count.target}` };
  if (Number.isFinite(o.hour) && o.hour >= MORNING[0] && o.hour < MORNING[1]) {
    const wx = items.find((it) => it?.type === 'weather');
    if (wx) return { id: wx.id, reason: 'morning', key: `morning:${wx.id}:${o.day || ''}` };
  }
  return null;
}
// Whether to act on a pick: it names a member other than the shown one, this moment has not been acted on
// yet (`seen`: the last key), and nothing is holding the stack still (hover, focus, a person's own recent touch).
function smartAction(pick, { top, seen, paused }) {
  if (!pick) return { move: false, mark: false };
  if (pick.id === top) return { move: false, mark: pick.key !== seen };
  if (pick.key === seen || paused) return { move: false, mark: false };
  return { move: true, mark: true };
}

// ---- motion ----
const DECEL = 0.998; // UIScrollView's normal deceleration rate
// How far a flick that leaves at `v` (px/s) coasts (px): (v / 1000) * d / (1 - d), Apple's projection.
const project = (v, d = DECEL) => (v / 1000) * d / (1 - d);
// A swipe is released at progress `p` (-1..1, in cards: positive is toward the next one) with velocity
// `v` (px/s); `px` is how many px of swipe make one card. -> -1 (the previous), 0 (back) or 1 (the next).
function settleTarget(p, v, px = 120) {
  const landing = p + project(v) / px;
  if (landing >= 0.5) return 1;
  if (landing <= -0.5) return -1;
  return 0;
}
// One step of a spring toward `target`: s = { x, v } (x in the same units as target, v per second), dt in
// seconds, response = how fast it arrives (s, not a duration), damping = ratio (1 settles without overshoot).
// Sub-stepped so a slow frame can not blow it up. -> { x, v }
function springStep(s, target, dt, { response = 0.34, damping = 1 } = {}) {
  const w = (2 * Math.PI) / Math.max(0.05, response);
  const k = w * w;
  const c = 2 * damping * w;
  let { x, v } = s;
  let left = Math.min(Math.max(dt, 0), 0.1);
  while (left > 0) {
    const h = Math.min(left, 1 / 240);
    v += (k * (target - x) - c * v) * h;
    x += v * h;
    left -= h;
  }
  return { x, v };
}
const settled = (s, target, eps = 0.002) => Math.abs(s.x - target) < eps && Math.abs(s.v) < 0.02;
// The wheel's deltaY in px, whatever the unit (0 pixels, 1 lines, 2 pages).
const wheelPx = (e, page = 400) => (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * page : e.deltaY);
// The release velocity (px/s) from the last few wheel or pointer samples [{ t (ms), d (px) }]: the
// distance moved in the last `window` ms over that time.
function velocityOf(samples, now, window = 90) {
  const recent = samples.filter((s) => now - s.t <= window);
  if (recent.length < 2) return 0;
  const span = Math.max(16, recent[recent.length - 1].t - recent[0].t);
  const sum = recent.slice(1).reduce((a, s) => a + s.d, 0);
  return (sum / span) * 1000;
}

const api = { AUTO_MS, SOON_MS, DAY_MS, MORNING, autoPlan, smartPick, smartAction, project, settleTarget, springStep, settled, wheelPx, velocityOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetStackMotion = api;
})();

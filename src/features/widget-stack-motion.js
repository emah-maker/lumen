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
// `edge`: the swipe is at the end of the stack and wrapping needs a firmer push (EDGE_AT instead of half a card).
function settleTarget(p, v, px = 120, edge = false) {
  const landing = p + project(v) / px;
  const need = edge ? EDGE_AT : 0.5;
  if (landing >= need) return 1;
  if (landing <= -need) return -1;
  return 0;
}
// ---- the end of the stack: wrap-around with resistance ----
// The last card is followed by the first (and the first preceded by the last), like iOS's stack. But a swipe
// that starts at an end meets resistance first, so the end is felt: the card follows the hand at a fraction
// (a rubber band, Apple's curve) and wrapping needs a firmer push (EDGE_AT of a card of raw swipe, or a flick).
// Keys, dots, arrows and the auto-rotate wrap without any resistance.
const EDGE_AT = 0.8; // raw swipe (in cards) that wraps at an end
const EDGE_C = 0.55; // Apple's rubber-band constant
// How far the card is drawn for `x` cards of raw swipe past an end (0..1 in, 0..EDGE_C/(1+EDGE_C) out).
const elastic = (x) => { const a = Math.min(1, Math.abs(x)); return Math.sign(x) * ((a * EDGE_C) / (1 + EDGE_C * a)); };
// The raw swipe that is drawn as `y` (the inverse of elastic), for taking over a card that is mid-flight.
const unelastic = (y) => { const b = Math.min(Math.abs(y), EDGE_C / (1 + EDGE_C) - 1e-6); return Math.sign(y) * (b / (EDGE_C - EDGE_C * b)); };
// The progress to draw for a raw swipe: itself, or elastic at an end.
const resist = (raw, edge) => (edge ? elastic(raw) : raw);
// Whether a swipe in direction `sign` (+1 next, -1 previous) starts at an end: the shown card is the last
// one going forward, or the first going back, of a stack of 2 or more.
const atEnd = (index, count, sign) => count >= 2 && ((sign > 0 && index === count - 1) || (sign < 0 && index === 0));

// ---- the slide: a full card, inside the stack's own frame ----
// Progress k (0..1, in cards) toward the card in direction `sign` (+1: the next, which comes up from below;
// -1: the previous, which comes down from above). `h` is the card's height in px. The shown card moves out
// (up for next) while the other comes in behind it, edge to edge, and both are clipped to the stack's frame:
// a vertical page of two cards sliding through a window. Opacity overlaps (neither drops below HOLD) and the
// outgoing card recedes a little (scale), so the stack is never empty. With Reduce motion nothing moves, the two
// crossfade. -> { out, in } each { ty (px), scale, opacity, clip: [top, bottom] (px inset, in the card's own space) }
const HOLD = 0.5; // the lowest opacity a card has while it is sliding
const RECEDE = 0.04; // how much smaller the outgoing card gets by the time it is gone (and the incoming starts)
const ease = (k) => k * k * (3 - 2 * k); // smoothstep: the opacity and the scale settle at both ends
function clipFor(ty, scale, h) {
  // The stack's frame is screen rows 0..h; the card is drawn scaled about its centre and moved by ty.
  const c = h / 2;
  const top = c - (c + ty) / scale; // the card's own row at the frame's top
  const bottom = c + (c - ty) / scale; // and at the frame's bottom
  return [Math.max(0, top), Math.max(0, h - bottom)];
}
function slide(k, sign, h, reduced = false) {
  const t = Math.min(1, Math.max(0, Math.abs(k)));
  const s = sign < 0 ? -1 : 1;
  if (reduced) return { out: { ty: 0, scale: 1, opacity: 1 - t, clip: [0, 0] }, in: { ty: 0, scale: 1, opacity: Math.min(1, t * 1.5), clip: [0, 0] } };
  const e = ease(t);
  const out = { ty: -s * t * h, scale: 1 - RECEDE * e, opacity: 1 - (1 - HOLD) * e };
  const inn = { ty: s * (1 - t) * h, scale: 1 - RECEDE * (1 - e), opacity: HOLD + (1 - HOLD) * e };
  out.clip = clipFor(out.ty, out.scale, h);
  inn.clip = clipFor(inn.ty, inn.scale, h);
  return { out, in: inn };
}
// How much of the stack's frame shows something, 0..1: each card's on-screen share of the frame (scaled about
// its centre, moved by ty, cut at the frame) times its opacity, the two added (they sit edge to edge). With
// Reduce motion the two layers sit on top of each other. The tests keep it high all the way through.
function coverage(k, h = 200, reduced = false) {
  const f = slide(k, 1, h, reduced);
  if (reduced) return 1 - (1 - f.out.opacity) * (1 - f.in.opacity);
  const part = (c) => {
    const lo = Math.max(0, h / 2 + c.ty - (c.scale * h) / 2);
    const hi = Math.min(h, h / 2 + c.ty + (c.scale * h) / 2);
    return (Math.max(0, hi - lo) / h) * c.opacity;
  };
  return part(f.out) + part(f.in);
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

const api = { AUTO_MS, SOON_MS, DAY_MS, MORNING, EDGE_AT, HOLD, autoPlan, smartPick, smartAction, project, settleTarget, springStep, settled, wheelPx, velocityOf, elastic, unelastic, resist, atEnd, slide, clipFor, coverage };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetStackMotion = api;
})();

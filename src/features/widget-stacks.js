// New-tab widget stacks: one place on the grid holding several widgets of the same size, shown one at
// a time; a small arrow in the card's corner switches to the next (like Google's and iOS's Smart Stack).
// Pure functions, no DOM, no Electron: used by features/widgets.js (stores and checks them),
// renderer/newtab-stacks.js (the arrow, the dots and the switch) and the unit tests.
//
// The model is two optional fields on the widgets in the `homeWidgets` list:
//   stack  a stack id ("s" + letters and digits): every member of one stack has the same one
//   top    true on the member that is shown (exactly one per stack)
// Members keep their place in the list, and the order they are in there is the order the arrow goes
// through. Only the shown member is a card on the grid: the others take its x, y, w, h and snap (they
// move and resize with it), so a stack never overlaps anything. A widget without `stack` is a place of
// its own, exactly as before: a list from before stacks loads unchanged. An older Lumen ignores the two
// fields and shows every member (its layout pushes the ones on the same cells apart).
// Only widgets of the same size (w by h cells) can be stacked; a stack is resized as a whole, and a
// member whose kind can't take the new size (a Muse card is at least 3 by 3) leaves the stack.
(function () {
'use strict';

const MAX_STACK = 6; // widgets in one stack (the dots stay readable)
const STACK_RE = /^s[0-9a-z]{4,24}$/;
const isSys = (w) => typeof w?.type === 'string' && w.type.startsWith('sys-');
const cleanId = (v) => (typeof v === 'string' && STACK_RE.test(v) ? v : undefined);

// A stored widget's stack fields, checked: {} or { stack } or { stack, top: true }.
function cleanFields(w) {
  if (!w || isSys(w)) return {};
  const stack = cleanId(w.stack);
  if (!stack) return {};
  return w.top === true ? { stack, top: true } : { stack };
}
const isHidden = (w) => Boolean(w && w.stack && !w.top);
const without = (w) => { const { stack, top, ...rest } = w; return rest; };

// The members of a stack, in the order the arrow goes through them.
const membersOf = (list, sid) => (sid ? list.filter((w) => w.stack === sid).map((w) => w.id) : []);
// The member `step` places after `id` (wrapping): +1 is the arrow, -1 goes back.
function neighbour(members, id, step = 1) {
  const n = members.length;
  const i = members.indexOf(id);
  if (n < 2 || i < 0) return null;
  return members[(((i + Math.trunc(step || 1)) % n) + n) % n];
}

// Every stack made consistent: a stack of one is no stack, each stack has exactly one top (the first
// marked, else its first member), and no more than MAX_STACK members (the rest are their own place again).
function normalize(list) {
  const groups = new Map();
  for (const w of list) if (w.stack && !isSys(w)) { if (!groups.has(w.stack)) groups.set(w.stack, []); groups.get(w.stack).push(w.id); }
  const keep = new Map(); // id -> { stack, top }
  for (const [sid, ids] of groups) {
    const members = ids.slice(0, MAX_STACK);
    if (members.length < 2) continue;
    const marked = members.find((id) => list.find((w) => w.id === id).top === true);
    const top = marked || members[0];
    for (const id of members) keep.set(id, { stack: sid, top: id === top });
  }
  return list.map((w) => {
    const k = keep.get(w.id);
    if (!k) return w.stack || w.top ? without(w) : w;
    const out = { ...without(w), stack: k.stack };
    if (k.top) out.top = true;
    return out;
  });
}

// After the grid laid out the shown cards (`laid`, by id): the hidden members take their top's rect.
// WL is features/widget-layout.js. A member whose kind can't take that size is ejected: it keeps its
// own size and goes in the first free spot. -> { list (in reading order), ejected (ids) }
function settle(norm, laid, WL) {
  const byId = new Map(laid.map((w) => [w.id, w]));
  const tops = new Map();
  for (const w of laid) if (w.stack && w.top) tops.set(w.stack, w);
  const taken = laid.map(WL.rectOf);
  const ejected = [];
  const out = norm.map((w) => {
    if (!isHidden(w)) return byId.get(w.id) || w;
    const top = tops.get(w.stack);
    const want = top ? WL.rectOf(top) : null;
    const rect = want && WL.cleanRect(w.type, want);
    if (rect && WL.same(rect, want)) {
      const next = { ...w, ...rect, ...WL.mirror(w.type, rect) };
      if (top.snap) next.snap = top.snap; else delete next.snap;
      return next;
    }
    ejected.push(w.id);
    const own = WL.cleanRect(w.type, { x: 0, y: 0, w: w.w, h: w.h }) || WL.defaultSize(w.type);
    const size = { w: own.w, h: own.h };
    const r = { ...WL.firstFit(taken, size), ...size };
    taken.push(r);
    const next = { ...without(w), ...r, ...WL.mirror(w.type, r) };
    delete next.snap;
    return next;
  });
  return { list: WL.flowOrder(out), ejected };
}

const shapeOf = (w) => (w && Number.isInteger(w.w) && Number.isInteger(w.h) ? `${w.w}x${w.h}` : '');
const sameShape = (a, b) => Boolean(shapeOf(a)) && shapeOf(a) === shapeOf(b);
// The ids that move when `id` is stacked onto another: the whole stack it is in, or just itself.
const groupOf = (list, w) => (w.stack ? membersOf(list, w.stack) : [w.id]);

// Whether the widget `id` (with its stack, if it is in one) can be stacked onto `onto`'s place.
function canStack(list, id, onto) {
  const a = list.find((w) => w.id === id);
  const b = list.find((w) => w.id === onto);
  if (!a || !b || a === b || isSys(a) || isSys(b)) return false;
  if (a.stack && a.stack === b.stack) return false;
  if (!sameShape(a, b)) return false;
  return groupOf(list, a).length + groupOf(list, b).length <= MAX_STACK;
}
function freshId(list, from) {
  const used = new Set(list.map((w) => w.stack).filter(Boolean));
  const base = `s${String(from).replace(/^w/, '').slice(0, 20)}`;
  let sid = cleanId(base) || 's0000';
  for (let n = 2; used.has(sid); n++) sid = `${base.slice(0, 20)}${n.toString(36)}`;
  return sid;
}
// Stack `id` onto `onto`: it (and its stack) joins `onto`'s stack, or the two start one. What was dropped
// is shown, at `onto`'s place. -> the new list, or null when they can't stack.
function join(list, id, onto) {
  if (!canStack(list, id, onto)) return null;
  const target = list.find((w) => w.id === onto);
  const src = list.find((w) => w.id === id);
  const sid = target.stack || freshId(list, target.id);
  const moving = new Set(groupOf(list, src));
  const rect = { x: target.x, y: target.y, w: target.w, h: target.h };
  const shown = src.stack ? list.find((w) => w.stack === src.stack && w.top)?.id || id : id;
  return list.map((w) => {
    if (w.stack !== sid && w.id !== onto && !moving.has(w.id)) return w;
    const next = { ...without(w), stack: sid };
    if (moving.has(w.id)) Object.assign(next, rect, target.snap ? { snap: target.snap } : {});
    if (moving.has(w.id) && !target.snap) delete next.snap;
    if (w.id === shown) next.top = true;
    return next;
  });
}
// Show `id` in its stack. -> the new list, or null when it isn't in one (or is already shown).
function select(list, id) {
  const w = list.find((x) => x.id === id);
  if (!w || !w.stack || w.top) return null;
  return list.map((x) => {
    if (x.stack !== w.stack) return x;
    const next = without(x);
    next.stack = w.stack;
    if (x.id === id) next.top = true;
    return next;
  });
}
// Take `id` out of its stack: it becomes its own place again, same size, in the first free spot (WL:
// features/widget-layout.js); if it was shown, the next member is. -> the new list, or null.
function leave(list, id, WL) {
  const w = list.find((x) => x.id === id);
  if (!w || !w.stack) return null;
  const members = membersOf(list, w.stack);
  const nextTop = w.top ? neighbour(members, id, 1) : null;
  const taken = list.filter((x) => x.id !== id && !isHidden(x) && Number.isInteger(x.x)).map(WL.rectOf);
  const spot = WL.firstFit(taken, { w: w.w, h: w.h });
  return list.map((x) => {
    if (x.id === id) { const n = { ...without(x), x: spot.x, y: spot.y }; delete n.snap; return n; }
    if (x.id === nextTop) return { ...x, top: true };
    return x;
  });
}
// Remove `id` from the list; if it was a stack's shown member, the next one is shown instead.
function drop(list, id) {
  const w = list.find((x) => x.id === id);
  if (!w) return list;
  const nextTop = w.stack && w.top ? neighbour(membersOf(list, w.stack), id, 1) : null;
  return list.filter((x) => x.id !== id).map((x) => (x.id === nextTop ? { ...x, top: true } : x));
}

const api = { MAX_STACK, STACK_RE, cleanFields, isHidden, membersOf, neighbour, normalize, settle, sameShape, canStack, join, select, leave, drop };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetStacks = api;
})();

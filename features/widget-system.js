// New-tab "system cards": the page's own sections (clock and greeting, the search box, Favorites,
// Frequently visited, Privacy) as cards on the same 12-column grid as widgets. Pure functions, no DOM,
// no Electron: used by features/widgets.js (validates and stores them), renderer/newtab-system.js
// (draws them) and the unit tests.
//
// A system card is an entry in the `homeWidgets` list like any widget: { id, type, x, y, w, h, snap? }
// with a reserved id (SYSTEM below) and a type that starts with "sys-". One layout list, one set of
// rules (features/widget-layout.js): they collide with, push and snap to widgets exactly like widgets.
//
// Docked and free. Until you move or resize one, a system card has NO entry: it stays where it always
// was, in the centre column (the layout's obstacle), and nothing moves for someone who never edits.
// Moving or resizing one stores its rect, and it becomes a free card. Whether a section is shown at
// all is still its Settings toggle (newTabFavorites, ...), not the layout; hiding one keeps its rect.
// An older Lumen drops these entries when it reads the list (it doesn't know the types), and shows the
// sections in the centre column as before.
(function () {
'use strict';

const WL = typeof module !== 'undefined' && module.exports ? require('./widget-layout') : globalThis.WidgetLayout;

// id -> { type, label, pref (the Settings toggle that shows it, or null: always shown), size (cells, for a
// card that has to be given a rect from nothing), min (smallest size) }
const SYSTEM = {
  wsyshead: { type: 'sys-header', label: 'Clock and greeting', pref: 'newTabHeader', size: { w: 6, h: 3 }, min: { w: 3, h: 2 } },
  wsyssearch: { type: 'sys-search', label: 'Search', pref: null, size: { w: 6, h: 3 }, min: { w: 3, h: 2 } },
  wsysfavs: { type: 'sys-favorites', label: 'Favorites', pref: 'newTabFavorites', size: { w: 6, h: 4 }, min: { w: 2, h: 2 } },
  wsysfreq: { type: 'sys-frequent', label: 'Frequently visited', pref: 'newTabFrequent', size: { w: 6, h: 3 }, min: { w: 2, h: 2 } },
  wsyspriv: { type: 'sys-privacy', label: 'Privacy', pref: 'newTabPrivacy', size: { w: 4, h: 2 }, min: { w: 2, h: 2 } },
};
const IDS = Object.keys(SYSTEM);
// The same limits as any card, except where a card needs more room to be usable.
if (WL && WL.LIMITS) {
  for (const id of IDS) {
    const { type, min } = SYSTEM[id];
    WL.LIMITS[type] = { minW: min.w, minH: min.h, maxW: 12, maxH: 20 };
  }
}

const has = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SYSTEM, id);
const isSystemId = has;
const isSystem = (w) => Boolean(w) && typeof w === 'object' && has(w.id);
const typeOf = (id) => (has(id) ? SYSTEM[id].type : null);
const labelOf = (id) => (has(id) ? SYSTEM[id].label : '');
const prefOf = (id) => (has(id) ? SYSTEM[id].pref : null);
// Is it shown? prefs: the Settings values (a missing one counts as on).
const visible = (id, prefs) => has(id) && (!SYSTEM[id].pref || !prefs || prefs[SYSTEM[id].pref] !== false);

// A stored or received entry -> { id, type, x, y, w, h, snap? } checked, or null (no valid rect: docked).
function clean(w) {
  if (!isSystem(w)) return null;
  const type = SYSTEM[w.id].type;
  const rect = WL.cleanRect(type, w);
  if (!rect) return null;
  const out = { id: w.id, type, ...rect };
  const snap = WL.cleanSnap(w.snap);
  if (snap) out.snap = snap;
  return out;
}
// The system cards in a list, checked, one per id.
function cleanAll(list) {
  const seen = new Set();
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    const c = clean(w);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}
// A list with at most `max` widgets; system cards are not counted.
function capReal(list, max) {
  let n = 0;
  return list.filter((w) => isSystem(w) || n++ < max);
}
const split = (list) => ({ system: list.filter(isSystem), real: list.filter((w) => !isSystem(w)) });

// The stored system cards after a page action: `items` are rects the page sent (do=layout); `dock` are
// ids that go back to the centre column (their entry is dropped, even when `items` has one). Ids that are not system cards, and
// rects that don't check out, are ignored.
function applyLayout(stored, items, dock) {
  const by = new Map(stored.map((s) => [s.id, s]));
  for (const r of Array.isArray(items) ? items : []) {
    const c = clean(r);
    if (c) by.set(c.id, c);
  }
  for (const id of Array.isArray(dock) ? dock : []) if (has(id)) by.delete(id); // last: a card in both lists is docked
  return IDS.filter((id) => by.has(id)).map((id) => by.get(id));
}
// What the page is given for stored system cards (features/widgets.js forPage).
function forPage(stored) {
  return stored.map((s) => {
    const layout = WL.rectOf(s);
    if (s.snap) layout.snap = s.snap;
    return { id: s.id, type: s.type, title: labelOf(s.id), system: true, layout };
  });
}
// A card's box on the page (px, from the page's top-left) -> the cells it covers, for turning a docked
// card into a free one exactly where it is. m: WL.metrics().
function cellsFromBox(id, box, m) {
  if (!has(id) || !box || ![box.left, box.top, box.width, box.height].every(Number.isFinite) || !m || m.cols === 1) return null;
  const x1 = Math.round((box.left - m.pad) / m.pitchX);
  const x2 = Math.round((box.left + box.width - m.pad + WL.GAP) / m.pitchX);
  const y1 = Math.round((box.top - m.top) / m.pitchY);
  const y2 = Math.round((box.top + box.height - m.top + WL.GAP) / m.pitchY);
  return WL.cleanRect(SYSTEM[id].type, { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) }, m.cols);
}

const api = { SYSTEM, IDS, isSystemId, isSystem, typeOf, labelOf, prefOf, visible, clean, cleanAll, capReal, split, applyLayout, forPage, cellsFromBox };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetSystem = api;
})();

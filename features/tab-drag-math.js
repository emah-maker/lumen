// Pure geometry for dragging a tab (or a whole window) around the screen; main.js does the rest.
// All points and rectangles are in screen DIPs.

// Keeps a dragged window reachable: its top edge stays inside the display and at least `keep` px of
// its width stays over it, so the tab strip can always be grabbed again.
function clampToDisplay(bounds, area, keep = 160, strip = 40) {
  const x = Math.min(Math.max(bounds.x, area.x - bounds.width + keep), area.x + area.width - keep);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - strip);
  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

// A size that fits on the display: a window torn off onto a smaller screen shrinks to its work area.
const fitToDisplay = (size, area) => ({ width: Math.min(size.width, area.width), height: Math.min(size.height, area.height) });

// A window opened from the menu, not one the user is dragging: the whole of it stays on the work
// area when it fits. clampToDisplay is for a window under the cursor, which may slide mostly off
// as long as its tab strip can still be grabbed.
function placeOnWorkArea(bounds, area) {
  const width = Math.max(0, Math.min(bounds.width, area.width));
  const height = Math.max(0, Math.min(bounds.height, area.height));
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

// Where a window goes so the grabbed spot (`grab`, relative to the window's top-left) is under the cursor.
const windowBoundsFor = (cursor, grab, size) => ({ x: Math.round(cursor.x - grab.x), y: Math.round(cursor.y - grab.y), width: size.width, height: size.height });

// The client x of the grabbed point as it will sit in a new window's strip. `origin` is the strip's
// content start with no scroll (a scrolled strip's first tab is further left than that, and using
// it opened the window that far from the cursor). `items` are the tabs that will be in the new
// strip, pinned first, in the order they land; `index` is the one that was grabbed. Their widths
// are the ones they will have there (up to `prefer`, sharing `room`), not the squeezed widths of
// the strip they left. `into` is how far into that tab the pointer went down.
function grabPoint(spec) {
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const origin = n(spec?.origin);
  const into = Math.max(0, n(spec?.into));
  const gap = n(spec?.gap, 4);
  const prefer = n(spec?.prefer, 200) || 200;
  const min = n(spec?.min, 40);
  const pinnedWidth = n(spec?.pinnedWidth, 40);
  const labelInset = Math.max(0, n(spec?.labelInset));
  const items = Array.isArray(spec?.items) ? spec.items : [];
  // A group grabbed by its label: the label is the first thing in the new strip.
  if (!items.length) return origin + labelInset + into;
  const index = Math.max(0, Math.min(items.length - 1, Math.floor(n(spec?.index))));
  const pinned = items.reduce((k, it) => k + (it?.pinned ? 1 : 0), 0);
  const loose = items.length - pinned;
  const gaps = Math.max(0, items.length - 1) * gap;
  const room = n(spec?.room);
  const share = room - gaps - pinned * pinnedWidth;
  const looseW = loose === 0 ? 0 : room > 0 ? Math.min(prefer, Math.max(min, share / loose)) : prefer;
  let x = origin + labelInset;
  for (let i = 0; i < index; i++) x += (items[i]?.pinned ? pinnedWidth : looseW) + gap;
  const own = items[index]?.pinned ? pinnedWidth : looseW;
  return x + (own > 0 ? Math.min(into, own) : into);
}

// The tab strip under `point`, and the tab it would land before (null: at the end). `windows` is every
// window that could be in the way, front first: { key, bounds, bottom, tabs: [{ id, mid }] } with
// `bottom` and `mid` in that window's own client coordinates, or { bounds, occluder: true } for a window
// that takes no tabs (a private window). Only the front-most window under the point counts: over its page,
// or over a window that takes no tabs, there is no hit, even if a strip lies hidden behind it.
function stripHit(point, windows, slack = 6) {
  for (const s of windows) {
    const b = s.bounds;
    if (point.x < b.x || point.x >= b.x + b.width || point.y < b.y || point.y >= b.y + b.height) continue;
    if (s.occluder || point.y - b.y > s.bottom + slack) return null;
    const before = s.tabs.find((t) => point.x - b.x < t.mid);
    return { key: s.key, beforeId: before ? before.id : null, outside: Boolean(before?.outside) }; // outside: before a group's label
  }
  return null;
}

module.exports = { clampToDisplay, fitToDisplay, placeOnWorkArea, windowBoundsFor, grabPoint, stripHit };

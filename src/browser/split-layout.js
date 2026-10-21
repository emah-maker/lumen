// Split view's pure rules (main.js does the Electron parts; test/units/split-view-units.js runs this): where the two page views go inside the
// page area, how a divider position becomes a ratio, which side a tab dropped on the page's right edge goes to, and the pair bookkeeping.
'use strict';

const GAP = 12; // px between the two pages: the strip the divider is drawn in (the tab views are native, so the divider cannot be drawn over them)
const MIN_PANE = 240; // px: neither side gets narrower than this
const MIN_AREA = MIN_PANE * 2 + GAP; // a page area narrower than this shows only the tab in front (the pair stays)
const DROP_EDGE = 0.2; // a tab dropped in the right 20% of the page area (at most DROP_MAX px) opens beside the current one
const DROP_MAX = 280;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// A ratio (the left side's share of the room the two pages have) kept inside what leaves both sides at least MIN_PANE.
// `width` is the page area's width; a bad ratio is the middle.
function clampRatio(ratio, width) {
  const room = width - GAP;
  const r = Number.isFinite(ratio) ? ratio : 0.5;
  if (!(room >= MIN_PANE * 2)) return 0.5;
  return clamp(r, MIN_PANE / room, 1 - MIN_PANE / room);
}

// bounds: the page area { x, y, width, height }. Returns null when it is too narrow to split.
function compute(bounds, ratio) {
  if (!bounds || !(bounds.width >= MIN_AREA) || !(bounds.height > 0)) return null;
  const room = bounds.width - GAP;
  const left = Math.round(room * clampRatio(ratio, bounds.width));
  const right = room - left;
  return {
    left: { x: bounds.x, y: bounds.y, width: left, height: bounds.height },
    right: { x: bounds.x + left + GAP, y: bounds.y, width: right, height: bounds.height },
    divider: { x: bounds.x + left, y: bounds.y, width: GAP, height: bounds.height },
    ratio: left / room,
  };
}

// A pointer at `x` (in the same coordinates as bounds.x) dragging the divider: the ratio that puts the divider's middle there.
function ratioFromX(x, bounds) {
  const room = bounds.width - GAP;
  if (!(room > 0)) return 0.5;
  return clampRatio((x - bounds.x - GAP / 2) / room, bounds.width);
}

// Is a tab dropped at (x, y) on the right edge of the page area?
function inDropZone(point, bounds) {
  if (!point || !bounds || !(bounds.width >= MIN_AREA)) return false;
  const zone = Math.min(DROP_MAX, bounds.width * DROP_EDGE);
  return point.x >= bounds.x + bounds.width - zone && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

// ---- the pair: one object shared by both tabs ({ left, right, ratio }), as tab.split ----
// Joining takes both tabs out of any pair they were in (a tab is in at most one).
function link(tabs, leftId, rightId, ratio = 0.5) {
  if (leftId === rightId) return null;
  const a = tabs.find((t) => t.id === leftId), b = tabs.find((t) => t.id === rightId);
  if (!a || !b) return null;
  unlink(tabs, leftId); unlink(tabs, rightId);
  const pair = { left: leftId, right: rightId, ratio: Number.isFinite(ratio) ? ratio : 0.5 };
  a.split = pair; b.split = pair;
  return pair;
}
// Takes the tab's pair apart (both tabs). Returns the partner's id, or null when it was alone.
function unlink(tabs, id) {
  const tab = tabs.find((t) => t.id === id);
  const pair = tab?.split;
  if (!pair) return null;
  let partner = null;
  for (const t of tabs) if (t.split === pair) { if (t.id !== id) partner = t.id; delete t.split; }
  delete tab.split;
  return partner;
}
// The other tab of `tab`'s pair, when both are in `tabs`; a pair whose other half has gone is dropped on the way.
function partnerOf(tabs, tab) {
  const pair = tab?.split;
  if (!pair) return null;
  const other = tabs.find((t) => t !== tab && t.split === pair);
  if (!other) { delete tab.split; return null; }
  return other;
}
// 'left' | 'right' | null: which side of its pair the tab is.
const sideOf = (tab) => (tab?.split ? (tab.split.left === tab.id ? 'left' : 'right') : null);

module.exports = { GAP, MIN_PANE, MIN_AREA, DROP_EDGE, DROP_MAX, clampRatio, compute, ratioFromX, inDropZone, link, unlink, partnerOf, sideOf };

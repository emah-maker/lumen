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

// Where a window goes so the grabbed spot (`grab`, relative to the window's top-left) is under the cursor.
const windowBoundsFor = (cursor, grab, size) => ({ x: Math.round(cursor.x - grab.x), y: Math.round(cursor.y - grab.y), width: size.width, height: size.height });

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
    return { key: s.key, beforeId: before ? before.id : null };
  }
  return null;
}

module.exports = { clampToDisplay, fitToDisplay, windowBoundsFor, stripHit };

// Pure geometry for dragging a tab (or a whole window) around the screen; main.js does the rest.
// All points and rectangles are in screen DIPs.

// Keeps a dragged window reachable: its top edge stays inside the display and at least `keep` px of
// its width stays over it, so the tab strip can always be grabbed again.
function clampToDisplay(bounds, area, keep = 160, strip = 40) {
  const x = Math.min(Math.max(bounds.x, area.x - bounds.width + keep), area.x + area.width - keep);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - strip);
  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

// Where a window goes so the grabbed spot (`grab`, relative to the window's top-left) is under the cursor.
const windowBoundsFor = (cursor, grab, size) => ({ x: Math.round(cursor.x - grab.x), y: Math.round(cursor.y - grab.y), width: size.width, height: size.height });

// The first window in `strips` (front first) whose tab strip is under `point`, and the tab it would
// land before (null: at the end). A strip is { key, bounds, bottom, tabs: [{ id, mid }] } with `bottom`
// and `mid` in that window's own client coordinates.
function stripHit(point, strips, slack = 6) {
  for (const s of strips) {
    const b = s.bounds;
    if (point.x < b.x || point.x >= b.x + b.width || point.y < b.y || point.y >= b.y + b.height) continue;
    if (point.y - b.y > s.bottom + slack) continue;
    const before = s.tabs.find((t) => point.x - b.x < t.mid);
    return { key: s.key, beforeId: before ? before.id : null };
  }
  return null;
}

module.exports = { clampToDisplay, windowBoundsFor, stripHit };

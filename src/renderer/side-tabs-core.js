// The pure parts of the side tab list (Settings → Tabs → Tab layout: Side): the saved width and fold, and where a dragged tab would land.
// A plain script in the UI (renderer/side-tabs.js uses it); test/side-tabs-units.js loads it with require().
(function (root) {
  const MIN = 160;
  const MAX = 420;
  const DEFAULT = 240;
  const COLLAPSED = 52; // the icons-only width

  const clampWidth = (w) => {
    const n = Math.round(Number(w));
    return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, n)) : DEFAULT;
  };

  // The settings (prefs:ui) as the list wants them.
  const fromPrefs = (p) => ({ on: p?.tabLayout === 'side', width: clampWidth(p?.sideTabsWidth ?? DEFAULT), collapsed: p?.sideTabsCollapsed === true });

  // Where something dropped at (x, y) would land: the first item, in list order, that the pointer is before. `items` are the tabs and group
  // labels that can take it, { id, outside, r: { left, top, right, bottom } }. A full-width row is passed by the pointer's height; a pinned
  // tile (several share a row) by its middle. null: after the last one.
  function dropBefore(items, x, y, listWidth) {
    for (const it of items) {
      const r = it.r;
      if (y < r.top) return it;
      if (y > r.bottom) continue;
      const wide = r.right - r.left > listWidth / 2;
      if (wide ? y < (r.top + r.bottom) / 2 : x < (r.left + r.right) / 2) return it;
    }
    return null;
  }

  // The group a tab dropped before `hit` joins: the one `hit` is in (a drop between a group's tabs, or right under its label), else none.
  const joinGroup = (hit, tabs) => (hit && !hit.outside ? tabs.find((t) => t.id === hit.id)?.groupId || null : null);

  // The same drop as it is now: the first of `items` that is not one of the `moving` ones, from the item after the last of them.
  // A release where nothing would change is not a move.
  function homeBefore(items, moving) {
    const skip = new Set(moving);
    const last = items.map((it) => skip.has(it.id)).lastIndexOf(true);
    return items.slice(last + 1).find((it) => !skip.has(it.id)) || null;
  }

  const api = { MIN, MAX, DEFAULT, COLLAPSED, clampWidth, fromPrefs, dropBefore, joinGroup, homeBefore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.sideTabsCore = api;
})(this);

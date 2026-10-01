// Stacking of the native views that float over the page, bottom to top: Spotify card, suggestions,
// downloads panel, tool overlay (dialogs are raised last by features/dialogs.js). A tab view added
// later (a new tab, a woken one) lands above any of them; this says which views to re-add.
// Pure (no Electron): `children` is the window's contentView.children, `tabViews` the tab views,
// `overlays` the visible overlay views already in the fixed order. Returns [] when nothing is out of
// place, else ALL the overlays in order (re-adding only the low ones could swap two of them).
function overlaysToRaise(children, tabViews, overlays) {
  if (!overlays.length) return [];
  const topTab = Math.max(-1, ...tabViews.map((v) => children.indexOf(v)));
  const idx = overlays.map((v) => children.indexOf(v));
  const belowTab = idx.some((i) => i < topTab);
  const swapped = idx.some((i, n) => n && i < idx[n - 1]); // out of the fixed order among themselves
  return belowTab || swapped ? overlays : [];
}

module.exports = { overlaysToRaise };

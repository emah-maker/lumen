// Pure layout math for the ⋯ app menu (main.js showAppMenu builds the items and pops it up).
// The menu is a native Electron menu (Chromium's views menus on Windows and Linux, NSMenu on macOS),
// so it cannot be styled or measured before it opens. What main.js CAN choose is its shape and its
// anchor point, and that is what these functions do, from estimated sizes:
//  - fold(): the flat menu is ~35 rows, ~900px tall, which on a short screen (1280x720 at 150% is
//    853x480 DIPs, less the taskbar) or a short window would open with scroll arrows and run past
//    the window. Sections marked foldable collapse, least-used first, into one submenu each until the
//    estimate fits the space below the button. Every command stays reachable and keeps its
//    accelerator label; the keys themselves are handled by handleShortcut, not by the menu.
//  - anchorX(): the button sits at the toolbar's right end, and a menu opened from its left edge
//    hangs past the window's right side (the OS only keeps it on the display). Right-align it to the
//    button instead, as Chrome does, and keep it inside the window.
// Submenus need nothing here: the OS opens them to the left, or upwards, when there is no room.

// Conservative per-row estimates in DIPs (Windows 11 views menus run ~24-28 per row). Overestimating
// only folds a little early; underestimating would bring the scroll arrows back.
const METRICS = { row: 28, separator: 9, padding: 8, char: 7.2, sidePadding: 64, accelGap: 28, arrow: 20 };

// A menu is `groups`: arrays of chunks, drawn with a separator between groups. A chunk is
// { items, fold?: { id, label, order } }. Folding an id replaces its first chunk with one submenu row
// holding every chunk of that id (separated), and drops the rest. Lower `order` folds first.
function toTemplate(groups, folded = new Set()) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const rows = [];
    for (const chunk of group) {
      const items = (chunk.items || []).filter(Boolean);
      const id = chunk.fold?.id;
      if (!id || !folded.has(id)) { rows.push(...items); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      const parts = groups.flat().filter((c) => c.fold?.id === id).map((c) => (c.items || []).filter(Boolean)).filter((p) => p.length);
      const submenu = parts.flatMap((p, i) => (i ? [{ type: 'separator' }, ...p] : p));
      if (submenu.length === 1) rows.push(submenu[0]); // a submenu of one is just an extra click
      else if (submenu.length) rows.push({ label: chunk.fold.label, submenu });
    }
    if (rows.length) out.push(...(out.length ? [{ type: 'separator' }] : []), ...rows);
  }
  return out;
}

const estimateHeight = (template, m = METRICS) => m.padding
  + template.reduce((h, item) => h + (item.type === 'separator' ? m.separator : m.row), 0);

function estimateWidth(template, m = METRICS) {
  let label = 0;
  let accel = 0;
  let arrow = false;
  for (const item of template) {
    if (item.type === 'separator') continue;
    label = Math.max(label, String(item.label || '').length);
    accel = Math.max(accel, String(item.accelerator || '').replace('CmdOrCtrl', 'Ctrl').length); // shown as Ctrl (or ⌘)
    if (item.submenu) arrow = true;
  }
  return Math.round(m.sidePadding + label * m.char + (accel ? m.accelGap + accel * m.char : 0) + (arrow ? m.arrow : 0));
}

// Folds ids (by `order`) until the menu's estimated height fits `available` DIPs, or nothing is left
// to fold. Returns the template and which ids were folded (for the tests).
function fold(groups, available, m = METRICS) {
  const ids = [...new Map(groups.flat().filter((c) => c.fold).map((c) => [c.fold.id, c.fold.order ?? 0])).entries()]
    .sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const folded = new Set();
  let template = toTemplate(groups, folded);
  for (const id of ids) {
    if (!(available > 0) || estimateHeight(template, m) <= available) break;
    folded.add(id);
    template = toTemplate(groups, folded);
  }
  return { template, folded: [...folded] };
}

// The popup's x (window content coordinates). A button in the right half gets the menu's right edge
// under its own right edge; either way the menu is kept inside the window where it fits (and pinned
// to the left edge where it doesn't). A button in the left half (right-to-left layouts) opens from
// its left edge as before.
function anchorX({ left, right, contentWidth, menuWidth }) {
  const x = right > contentWidth / 2 ? right - menuWidth : left;
  return Math.round(Math.max(0, Math.min(x, contentWidth - menuWidth)));
}

// The space below the button that the menu may use: down to the window's bottom or the display's
// work area (above the taskbar), whichever comes first. `anchorY` is in screen DIPs.
const availableBelow = ({ anchorY, windowBottom, workAreaBottom, margin = 4 }) => Math.floor(Math.min(windowBottom, workAreaBottom) - anchorY - margin);

module.exports = { METRICS, toTemplate, estimateHeight, estimateWidth, fold, anchorX, availableBelow };

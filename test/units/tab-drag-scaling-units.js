// Tab drag geometry on scaled displays (features/tab-drag-math.js): Windows display scaling of 100/125/150/200%, and a two-monitor desktop
// whose displays have different scales. Everything the drag does is in DIPs (cursor, window bounds, work areas), so these tables check that
// the grabbed spot lands under the cursor to the physical pixel, that the right display is picked near the seam, and that a size changed by
// a move across scales is noticed. Plain Node.
const M = require('../../src/features/tab-drag-math');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

// A display of physical size pw x ph at `scale`, its DIP origin (x, y), and a taskbar of 48 physical px at the bottom.
const display = (id, scale, pw, ph, x = 0, y = 0) => {
  const width = Math.round(pw / scale);
  const height = Math.round(ph / scale);
  return { id, scaleFactor: scale, bounds: { x, y, width, height }, workArea: { x, y, width, height: height - Math.round(48 / scale) } };
};

// ---- one display at each Windows scale
for (const s of [1, 1.25, 1.5, 2]) {
  const d = display(1, s, 2560, 1600);
  const area = d.workArea;
  const size = { width: 1000, height: 700 };
  const grab = { x: 123, y: 17 };
  let worst = 0;
  let inside = true;
  for (const c of [{ x: 10, y: 10 }, { x: 640, y: 300 }, { x: d.bounds.width - 1, y: 5 }, { x: 333, y: area.height - 1 }, { x: d.bounds.width / 3, y: d.bounds.height / 7 }]) {
    const b = M.windowBoundsFor(c, grab, size);
    // The window's physical origin is its DIP origin times the scale, rounded; the grabbed spot is that plus grab times the scale.
    const physX = Math.round(b.x * s) + grab.x * s;
    const physY = Math.round(b.y * s) + grab.y * s;
    worst = Math.max(worst, Math.abs(physX - c.x * s), Math.abs(physY - c.y * s));
    const k = M.clampToDisplay(b, area);
    inside = inside && Number.isInteger(k.x) && Number.isInteger(k.y) && k.y >= area.y && k.y <= area.y + area.height - 40 && k.x + k.width >= area.x + 160 && k.x <= area.x + area.width - 160;
  }
  check(`scale ${s}: the grabbed spot lands under the cursor within one physical pixel (worst ${worst.toFixed(2)})`, worst <= Math.max(1, s / 2) + 1e-9, worst);
  check(`scale ${s}: a clamped window stays reachable on the ${area.width}x${area.height} DIP work area`, inside);
  const big = M.fitToDisplay({ width: 2700, height: 1700 }, area);
  check(`scale ${s}: a window bigger than the display shrinks to its DIP work area`, big.width === area.width && big.height === area.height, JSON.stringify(big));
  const placed = M.placeOnWorkArea({ x: area.width - 50, y: area.height - 20, width: 1000, height: 700 }, area);
  check(`scale ${s}: a menu tear-off near the corner is placed fully on the work area`, placed.x + placed.width <= area.x + area.width && placed.y + placed.height <= area.y + area.height && placed.x >= 0 && placed.y >= 0, JSON.stringify(placed));
}

// ---- the user's two monitors: primary 150% 2560x1600 at 0,0, secondary 100% to its right (DIP space: secondary starts at x 1707)
const primary = display(1, 1.5, 2560, 1600, 0, 0);
const secondary = display(2, 1, 1920, 1080, primary.bounds.width, 0);
const both = [primary, secondary];
const at = (x, y) => M.displayAtPoint(both, { x, y })?.id;
check('two monitors: a point on the primary is the primary', at(10, 10) === 1 && at(1706, 500) === 1 && at(800, 1066) === 1, [at(10, 10), at(1706, 500), at(800, 1066)]);
check('two monitors: a point on the secondary is the secondary, right at the seam too', at(1707, 500) === 2 && at(2000, 10) === 2 && at(3626, 1079) === 2, [at(1707, 500), at(2000, 10), at(3626, 1079)]);
check('two monitors: below the shorter display, the nearest one wins', at(100, 1075) === 1 && at(2000, 1100) === 2, [at(100, 1075), at(2000, 1100)]);
check('two monitors: far outside lands on the closest display', at(-500, 300) === 1 && at(9000, 300) === 2 && at(1000, -300) === 1 && at(2500, -300) === 2);
check('two monitors: no displays is no answer (the caller falls back)', M.displayAtPoint([], { x: 1, y: 1 }) === null && M.displayAtPoint(undefined, { x: 1, y: 1 }) === null);
// A torn-off window released on the secondary: sized to it, placed by the cursor, clamped to it.
{
  const cursor = { x: 1707 + 40, y: 20 };
  const d = M.displayAtPoint(both, cursor);
  const size = M.fitToDisplay({ width: 2200, height: 900 }, d.workArea);
  const b = M.clampToDisplay(M.windowBoundsFor(cursor, { x: 90, y: 14 }, size), d.workArea);
  check('two monitors: a window torn off onto the 100% display fits it', size.width === 1920 && size.height === 900, JSON.stringify(size));
  check('two monitors: ...opens with the tab under the cursor, on that display', b.x === 1707 - 50 && b.y === 6, JSON.stringify(b));
  const edge = M.clampToDisplay(M.windowBoundsFor({ x: 1707 + 1919, y: 1070 }, { x: 90, y: 14 }, size), d.workArea);
  check('two monitors: dropped in the far corner of the secondary it stays grabbable on it', edge.x === 1707 + 1920 - 160 && edge.y === secondary.workArea.height - 40, JSON.stringify(edge));
  // A strip of a window on the secondary is hit by DIP cursor and DIP bounds, whatever the primary's scale.
  const strip = { key: 'w', bounds: { x: 1807, y: 100, width: 800, height: 600 }, bottom: 40, tabs: [{ id: 1, mid: 100 }, { id: 2, mid: 300 }] };
  check('two monitors: a strip on the secondary is found by DIP position', M.stripHit({ x: 1807 + 250, y: 120 }, [strip])?.beforeId === 2 && M.stripHit({ x: 1807 + 50, y: 120 }, [strip])?.beforeId === 1);
}

// ---- a size changed by the move: Windows sizes setPosition/setBounds with the scale of the display the window is on now
check('drift: 1000x700 coming out as 667x467 (150% -> 100%) is noticed', M.sizeDrifted({ width: 667, height: 467 }, { width: 1000, height: 700 }));
check('drift: 1000x700 coming out as 1500x1050 (100% -> 150%) is noticed', M.sizeDrifted({ width: 1500, height: 1050 }, { width: 1000, height: 700 }));
check('drift: a rounding difference of a pixel or two is not drift', !M.sizeDrifted({ width: 1001, height: 699 }, { width: 1000, height: 700 }));
check('drift: a window at its minimum size is not drifted when the wanted size is smaller', !M.sizeDrifted({ width: 500, height: 400 }, { width: 300, height: 200 }, [500, 400]));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

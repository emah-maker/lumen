// New-tab widgets, pure logic (run from test/units.js): the layout algorithm (collision, push down and
// sideways, compaction, clamping, limits, the narrow-window fallback, migration from span/height,
// garbage input), snapping, Todoist's filter/group/sort/limits and config, weather's places, units,
// days and "My location" gating, and the colour palettes. No Electron, no network.
const WL = require('../features/widget-layout');
const TV = require('../features/todoist-view');
const WX = require('../features/weather-view');
const WC = require('../features/widget-colors');
const ics = require('../features/ics');
const { cleanList, cleanWidget } = require('../features/widgets');

module.exports = function widgetUnits(check) {
  const it = (id, type, x, y, w, h, extra) => ({ id, type, x, y, w, h, ...extra });
  const enc = WL.encode;
  const noOverlap = (items) => items.every((a, i) => items.every((b, j) => i === j || !WL.overlap(a, b)));
  const NO_OB = { packed: false };

  // ---- layout: placing ----
  let items = [it('waaaa1', 'weather', 0, 0, 4, 3), it('wbbbb1', 'calendar', 4, 0, 4, 3), it('wcccc1', 'todoist', 8, 0, 4, 3)];
  let r = WL.move(items, 'waaaa1', { x: 4, y: 0 }, NO_OB);
  check('widgets layout: dropping onto another pushes it down and nothing overlaps', noOverlap(r) && r[0].x === 4 && r[0].y === 0 && r[1].y === 3 && r[2].y === 0, enc(r));
  r = WL.move(items, 'waaaa1', { x: 3, y: 10 }, NO_OB);
  check('widgets layout: without packing a card stays where it is dropped (gaps allowed)', r[0].x === 3 && r[0].y === 10 && r[1].y === 0, enc(r));
  r = WL.move(items, 'waaaa1', { x: 3, y: 10 }, { packed: true });
  check('widgets layout: with packing it slides up into the gap', r[0].y === 3 && noOverlap(r), enc(r));
  r = WL.move(items, 'waaaa1', { x: 99, y: -5 }, NO_OB);
  check('widgets layout: a drop outside the grid is clamped in', r[0].x === 8 && r[0].y === 0 && noOverlap(r), enc(r));
  check('widgets layout: an unknown id or a garbage target changes nothing', enc(WL.move(items, 'nope', { x: 1, y: 1 })) === enc(items) && enc(WL.move(items, 'waaaa1', { x: NaN, y: 1 })) === enc(items), '');
  check('widgets layout: the input is never changed', enc(items) === 'waaaa1:0,0,4,3;wbbbb1:4,0,4,3;wcccc1:8,0,4,3', enc(items));
  // A push that has room beside goes sideways when that is shorter.
  const side = [it('waaaa1', 'weather', 0, 0, 3, 3), it('wbbbb1', 'weather', 3, 0, 3, 3)];
  r = WL.move(side, 'waaaa1', { x: 2, y: 0 }, NO_OB);
  check('widgets layout: a pushed card goes sideways when that is shorter than down', r[0].x === 2 && r[1].x === 5 && r[1].y === 0, enc(r));
  r = WL.resolve([it('waaaa1', 'weather', 0, 0, 6, 3), it('wbbbb1', 'weather', 3, 1, 6, 3)], NO_OB);
  check('widgets layout: resolve() separates overlapping cards, in reading order', noOverlap(r) && r[0].y === 0 && r[1].y === 3, enc(r));

  // ---- layout: compaction ----
  r = WL.compact([it('waaaa1', 'weather', 0, 5, 4, 3), it('wbbbb1', 'weather', 4, 9, 4, 3), it('wcccc1', 'weather', 0, 12, 4, 3)]);
  check('widgets layout: compaction pulls each card up until something is in the way', enc(r) === 'waaaa1:0,0,4,3;wbbbb1:4,0,4,3;wcccc1:0,3,4,3', enc(r));

  // ---- layout: the obstacle (the centre column) ----
  const ob = { x: 4, y: 0, w: 4, h: 10 };
  const O = { obstacle: ob, packed: true };
  r = WL.move(items, 'waaaa1', { x: 5, y: 2 }, O);
  check('widgets layout: a card dropped on the obstacle goes beside it or below, never over it', !WL.overlap(r[0], ob) && noOverlap(r) && (r[0].y >= 10 || r[0].x + r[0].w <= 4 || r[0].x >= 8), enc(r));
  r = WL.move(items, 'wcccc1', { x: 0, y: 0 }, O);
  check('widgets layout: a card dragged far to the side sits in the side area at any height', r.every((c) => !WL.overlap(c, ob)) && noOverlap(r), enc(r));
  r = WL.resolve([it('waaaa1', 'embed', 0, 0, 12, 4)], O);
  check('widgets layout: a full-width card below the obstacle rows is pushed under them', r[0].y === 10, enc(r));
  r = WL.resolve([it('waaaa1', 'weather', 8, 0, 4, 3), it('wbbbb1', 'weather', 8, 3, 4, 3)], O);
  check('widgets layout: cards in the right side area stack and pack to the top', enc(r) === 'waaaa1:8,0,4,3;wbbbb1:8,3,4,3', enc(r));

  // ---- layout: resize and limits ----
  r = WL.resize(items, 'waaaa1', { x: 0, y: 0, w: 5, h: 4 }, NO_OB);
  check('widgets layout: resizing pushes what is in the way, nothing overlaps', r[0].w === 5 && r[0].h === 4 && noOverlap(r), enc(r));
  r = WL.resize(items, 'waaaa1', { x: 0, y: 0, w: 1, h: 1 }, NO_OB);
  check('widgets layout: any size from 2x2 up (below that is clamped to 2x2)', r[0].w === 2 && r[0].h === 2, enc(r));
  r = WL.resize(items, 'waaaa1', { x: 0, y: 0, w: 40, h: 90 }, NO_OB);
  check('widgets layout: up to the whole grid width and 20 rows', r[0].w === 12 && r[0].h === 20 && noOverlap(r), enc(r));
  r = WL.resize([it('waaaa1', 'weather', 4, 0, 4, 3)], 'waaaa1', { x: 2, y: 0, w: 6, h: 3 }, NO_OB);
  check('widgets layout: dragging the left edge keeps the right edge where it was', r[0].x === 2 && r[0].x + r[0].w === 8, enc(r));
  r = WL.resize([it('waaaa1', 'weather', 0, 0, 3, 3)], 'waaaa1', { x: 0, y: 0, w: 9, h: 3 }, { obstacle: ob, packed: false });
  check('widgets layout: growing toward the obstacle stops at it', r[0].x + r[0].w === 4, enc(r));
  r = WL.resize([it('waaaa1', 'weather', 0, 12, 12, 3)], 'waaaa1', { x: 0, y: 8, w: 12, h: 7 }, { obstacle: ob, packed: false });
  check('widgets layout: growing upward under the obstacle stops at its bottom', r[0].y === 10 && r[0].y + r[0].h === 15, enc(r));

  // ---- layout: narrow windows ----
  const m = WL.metrics(1440);
  check('widgets layout: 12 columns from 900 px, one column below', m.cols === 12 && WL.metrics(900).cols === 12 && WL.metrics(899).cols === 1 && WL.metrics(600).cols === 1, '');
  const box = { left: 400, right: 1040, bottom: 800 };
  const obs = WL.obstacleFor(box, m);
  check('widgets layout: the centre column\'s box becomes the obstacle in cells', obs && obs.x >= 2 && obs.x + obs.w <= 10 && obs.h > 5 && obs.y === 0, JSON.stringify(obs));
  const narrow = WL.resolve([it('wbbbb1', 'weather', 6, 0, 4, 3), it('waaaa1', 'weather', 0, 0, 4, 3), it('wcccc1', 'weather', 0, 6, 4, 3)], { cols: 1, obstacle: { x: 0, y: 0, w: 1, h: 8 } });
  check('widgets layout: a narrow window stacks one column ordered by (y, x), below the centre column', narrow[1].y === 8 && narrow[0].y === 11 && narrow[2].y === 14 && narrow.every((c) => c.x === 0 && c.w === 1), enc(narrow));
  check('widgets layout: dragging in a stacked window does nothing (saved places stay)', enc(WL.move(narrow, 'waaaa1', { x: 5, y: 5 }, { cols: 1 })) === enc(narrow), '');
  const px = WL.cellToPx({ x: 1, y: 2, w: 2, h: 3 }, m);
  check('widgets layout: cells become pixels', Math.abs(px.left - (m.pad + m.pitchX)) < 1e-6 && Math.abs(px.width - (2 * m.cw + 12)) < 1e-6 && px.height === 3 * 56 + 2 * 12, JSON.stringify(px));

  // ---- layout: garbage and encoding ----
  check('widgets layout: a stored rect must be four integers', WL.cleanRect('weather', { x: 1.5, y: 0, w: 4, h: 3 }) === null && WL.cleanRect('weather', { x: '1', y: 0, w: 4, h: 3 }) === null && WL.cleanRect('weather', null) === null && WL.cleanRect('weather', { x: 0, y: 0, w: NaN, h: 3 }) === null, '');
  check('widgets layout: integers out of range are clamped', JSON.stringify(WL.cleanRect('weather', { x: 99, y: -4, w: 99, h: 0 })) === '{"x":0,"y":0,"w":12,"h":2}' && JSON.stringify(WL.cleanRect('embed', { x: 11, y: 9999, w: 2, h: 3 })) === '{"x":10,"y":200,"w":2,"h":3}', JSON.stringify(WL.cleanRect('weather', { x: 99, y: -4, w: 99, h: 0 })));
  const wire = [it('wabcde', 'weather', 0, 1, 4, 3, { snap: 'tl' }), it('wabcdf', 'embed', 4, 0, 8, 6)];
  const back = WL.decode(enc(wire));
  check('widgets layout: the layout survives the URL round trip, snap included', back.length === 2 && back[0].snap === 'tl' && back[1].w === 8 && !('snap' in back[1]), enc(wire));
  check('widgets layout: a bad layout parameter is refused whole', WL.decode('wabcde:1,2,3') === null && WL.decode('x:1,2,3,4') === null && WL.decode('wabcde:1,2,3,4,sideways') === null && WL.decode('') === null && WL.decode('a'.repeat(3000)) === null, '');

  // ---- migration from span and height ----
  const legacy = [{ type: 'weather', span: 3 }, { type: 'todoist', span: 3 }, { type: 'calendar', span: 2 }, { type: 'embed', span: 6, height: 'small' }, { type: 'weather', span: 4 }];
  const flow = WL.fromLegacy(legacy);
  check('widgets migration: the old flow (six columns, wrapping) becomes cells in the same order', flow.map((f) => `${f.x},${f.y},${f.w},${f.h}`).join(' ') === '0,0,6,3 6,0,6,5 0,5,4,5 0,10,12,4 0,14,8,3', flow.map((f) => `${f.x},${f.y},${f.w},${f.h}`).join(' '));
  const mirrored = WL.mirror('embed', { w: 12, h: 10 });
  check('widgets migration: span and height are mirrored back for an older Lumen', WL.mirror('weather', { w: 6, h: 3 }).span === 3 && WL.mirror('weather', { w: 12, h: 3 }).span === 6 && WL.mirror('weather', { w: 4, h: 3 }).span === 2 && WL.mirror('embed', { w: 12, h: 12 }).height === 'tall' && WL.mirror('embed', { w: 12, h: 4 }).height === 'small' && WL.mirror('embed', { w: 12, h: 6 }).height === 'medium' && WL.mirror('embed', { w: 12, h: 8 }).height === 'large', JSON.stringify(mirrored));
  const old = [
    { id: 'wweath1', type: 'weather', title: '', span: 3, place: 'Boston', lat: 42.3, lon: -71, units: 'f' },
    { id: 'wtodo01', type: 'todoist', span: 3 },
    { id: 'wemb001', type: 'embed', span: 6, height: 'small', url: 'https://example.com/', name: 'x', frameable: true },
    { id: 'wcal001', type: 'calendar', span: 2, url: 'https://example.com/a.ics' },
  ];
  const migrated = cleanList(old);
  check('widgets migration: an old list keeps its order and sizes, gains x/y/w/h, keeps span/height', migrated.map((w) => w.id).join() === 'wweath1,wtodo01,wemb001,wcal001' && migrated[0].w === 6 && migrated[1].x === 6 && migrated[2].w === 12 && migrated[2].height === 'small' && migrated[2].span === 6 && migrated[3].span === 2 && migrated.every((w) => Number.isInteger(w.x) && Number.isInteger(w.h)), JSON.stringify(migrated.map((w) => [w.id, w.x, w.y, w.w, w.h, w.span])));
  check('widgets migration: it is stable (cleaning twice changes nothing) and overlap-free', JSON.stringify(cleanList(migrated)) === JSON.stringify(migrated) && noOverlap(migrated), '');
  const mixed = cleanList([{ ...migrated[0] }, { id: 'wnew001', type: 'embed', url: 'https://example.com/', span: 6, height: 'medium' }]);
  check('widgets migration: a widget without a place goes into the first free spot', mixed[1].y >= 3 && noOverlap(mixed), JSON.stringify(mixed.map((w) => [w.x, w.y, w.w, w.h])));
  const junk = cleanList([{ id: 'wjunk01', type: 'weather', place: 'X', lat: 1, lon: 2, x: 'a', y: null, w: {}, h: [] }, { id: 'wjunk02', type: 'todoist', x: 3, y: 0, w: 4, h: 3, snap: 'sideways' }, null, 7, { id: 'bad id', type: 'weather' }]);
  check('widgets: garbage x/y/w/h is ignored (placed anew), a bad snap is dropped, junk entries vanish', junk.length === 2 && junk.find((z) => z.id === 'wjunk01').w > 0 && junk.find((z) => z.id === 'wjunk02').x === 3 && !('snap' in junk.find((z) => z.id === 'wjunk02')), JSON.stringify(junk.map((w) => [w.id, w.x, w.y, w.w, w.h, w.snap])));
  const overlapping = cleanList([{ id: 'wover001', type: 'todoist', x: 0, y: 0, w: 6, h: 4 }, { id: 'wover002', type: 'todoist', x: 2, y: 1, w: 6, h: 4 }]);
  check('widgets: overlapping stored places are pushed apart', noOverlap(overlapping), JSON.stringify(overlapping.map((w) => [w.x, w.y, w.w, w.h])));
  check('widgets: the list is kept in reading order (what an older Lumen shows)', cleanList([{ id: 'wlate01', type: 'todoist', x: 0, y: 8, w: 6, h: 3 }, { id: 'wearly1', type: 'todoist', x: 6, y: 0, w: 6, h: 3 }]).map((w) => w.id).join() === 'wearly1,wlate01', '');

  // ---- snapping ----
  const view = { width: 1440, height: 800 };
  const D = (x, y) => WL.detectSnap({ x, y }, view);
  check('widgets snap: the left and right edges (24 px) are side docks', D(10, 400) === 'left' && D(24, 400) === 'left' && D(25, 400) === null && D(1430, 400) === 'right' && D(1416, 400) === 'right' && D(1415, 400) === null, '');
  check('widgets snap: the top edge is a banner', D(700, 5) === 'top' && D(700, 24) === 'top' && D(700, 25) === null, '');
  check('widgets snap: near an edge and a corner is a quarter', D(5, 5) === 'tl' && D(1435, 5) === 'tr' && D(5, 795) === 'bl' && D(1435, 795) === 'br' && D(60, 8) === 'tl' && D(10, 60) === 'tl' && D(10, 300) === 'left', [D(5, 5), D(60, 8), D(10, 300)].join());
  check('widgets snap: nothing in the middle of the window or with a bad pointer', D(700, 400) === null && WL.detectSnap(null, view) === null && WL.detectSnap({ x: NaN, y: 1 }, view) === null && D(700, 795) === null, '');
  const m2 = WL.metrics(1440);
  const o2 = { obstacle: WL.obstacleFor({ left: 400, right: 1040, bottom: 800 }, m2), rows: WL.pageRows(800, m2), packed: true };
  const wx1 = it('waaaa1', 'weather', 0, 20, 4, 3);
  const left = WL.snapRectFor('left', wx1, o2);
  const right = WL.snapRectFor('right', wx1, o2);
  check('widgets snap: left/right dock in the side area beside the centre column (not half the page)', left.x === 0 && left.x + left.w === o2.obstacle.x && right.x === 12 - right.w && right.x >= o2.obstacle.x + o2.obstacle.w, JSON.stringify({ left, right, ob: o2.obstacle }));
  check('widgets snap: a dock is as tall as the window (up to 20 rows), a quarter is half', WL.snapRectFor('left', it('e', 'embed', 0, 0, 4, 3), o2).h === Math.min(20, o2.rows) && WL.snapRectFor('tl', it('e', 'embed', 0, 0, 4, 3), o2).h === Math.floor(o2.rows / 2) && WL.snapRectFor('bl', it('e', 'embed', 0, 0, 4, 3), o2).y === o2.rows - Math.floor(o2.rows / 2), JSON.stringify(WL.snapRectFor('bl', it('e', 'embed', 0, 0, 4, 3), o2)));
  check('widgets snap: the banner is full width above the centre column', JSON.stringify(WL.snapRectFor('top', it('e', 'embed', 0, 0, 4, 3), o2)) === '{"x":0,"y":0,"w":12,"h":2}', JSON.stringify(WL.snapRectFor('top', it('e', 'embed', 0, 0, 4, 3), o2)));
  for (const width of [1000, 1200, 1440, 1800, 2560]) {
    const mm = WL.metrics(width);
    const oo = { obstacle: WL.obstacleFor({ left: (width - 640) / 2, right: (width + 640) / 2, bottom: 700 }, mm), rows: 10, packed: true };
    const rect = WL.snapRectFor('left', wx1, oo);
    const rr = WL.snapRectFor('right', wx1, oo);
    check(`widgets snap: at ${width} px wide the docks fit the side areas (or are refused when the side is too narrow)`, (rect === null || (rect.x === 0 && rect.x + rect.w <= oo.obstacle.x)) && (rr === null || (rr.x >= oo.obstacle.x + oo.obstacle.w && rr.x + rr.w === 12)) && (width < 1400 || rect !== null), JSON.stringify({ rect, rr, ob: oo.obstacle }));
  }
  const a = it('waaaa1', 'embed', 0, 30, 4, 3);
  const b = it('wbbbb1', 'embed', 6, 30, 4, 3);
  const c = it('wcccc1', 'embed', 6, 40, 4, 3);
  let s1 = WL.snapMove([a, b, c], 'waaaa1', { snap: 'left' }, o2);
  check('widgets snap: a card docks left, beside the centre column', s1[0].snap === 'left' && s1[0].x === 0 && s1[0].y === 0 && noOverlap(s1) && s1.every((z) => !WL.overlap(z, o2.obstacle)), enc(s1));
  const s2 = WL.snapMove(s1, 'wbbbb1', { snap: 'left', frac: 0.9 }, o2);
  check('widgets snap: dropping on a taken dock splits it (the newcomer takes the half nearest the pointer)', s2[0].snap === 'tl' && s2[1].snap === 'bl' && s2[0].y === 0 && s2[1].y > s2[0].y && noOverlap(s2), enc(s2));
  const s3 = WL.snapMove(s2, 'wcccc1', { snap: 'tl' }, o2);
  check('widgets snap: a taken half sends its owner to the other half if free; never overlapping', noOverlap(s3) && s3[2].snap === 'tl', enc(s3));
  const s4 = WL.snapMove([a], 'waaaa1', { snap: 'top' }, { ...o2, obstacle: o2.obstacle });
  check('widgets snap: a banner pushes the centre column down (bannerRows)', s4[0].snap === 'top' && s4[0].y === 0 && s4[0].w === 12 && WL.bannerRows(s4, o2) === s4[0].h, enc(s4));
  const s5 = WL.resolve(s4, { ...o2, obstacle: { ...o2.obstacle } });
  check('widgets snap: the obstacle sits below the banner, so nothing overlaps', noOverlap(s5) && !WL.overlap(s5[0], { ...o2.obstacle, y: o2.obstacle.y + WL.bannerRows(s4, o2) }), enc(s5));
  const wide = { ...o2, obstacle: WL.obstacleFor({ left: 900, right: 1540, bottom: 800 }, WL.metrics(2440)), rows: 12 };
  const followed = WL.resolve([{ ...s1[0] }], { ...wide, cols: 12 });
  check('widgets snap: a snapped card keeps hugging its side when the window changes size', followed[0].snap === 'left' && followed[0].x === 0 && followed[0].w >= s1[0].w && followed[0].h !== s1[0].h, `${enc(s1)} -> ${enc(followed)}`);
  check('widgets snap: moving or resizing a snapped card by hand drops the snap', !('snap' in WL.move(s1, 'waaaa1', { x: 0, y: 20 }, o2)[0]) && !('snap' in WL.resize(s1, 'waaaa1', { x: 0, y: 0, w: 3, h: 6 }, o2)[0]), '');
  check('widgets snap: a snap that doesn\'t fit changes nothing', enc(WL.snapMove([a], 'waaaa1', { snap: 'left' }, { ...o2, obstacle: { x: 1, y: 0, w: 10, h: 5 } })) === enc([a]) && enc(WL.snapMove([a], 'waaaa1', { snap: 'left' }, { ...o2, cols: 1 })) === enc([a]) && enc(WL.snapMove([a], 'waaaa1', { snap: 'sideways' }, o2)) === enc([a]), '');
  check('widgets snap: Ctrl+Alt+arrows go left/right, then to a quarter or the banner', WL.keySnap('ArrowLeft', undefined) === 'left' && WL.keySnap('ArrowRight', 'left') === 'right' && WL.keySnap('ArrowUp', 'left') === 'tl' && WL.keySnap('ArrowDown', 'right') === 'br' && WL.keySnap('ArrowUp', undefined) === 'top' && WL.keySnap('ArrowDown', undefined) === null && WL.keySnap('x', 'left') === null, '');
  check('widgets snap: a doubly snapped layout stays overlap-free', noOverlap(WL.resolve(WL.snapMove(WL.snapMove(s2, 'wcccc1', { snap: 'right' }, o2), 'waaaa1', { snap: 'top' }, o2), o2)), '');

  // ---- Todoist ----
  const cfg = (o) => TV.cleanConfig(o);
  check('todoist config: an old widget (no settings) is "Today and overdue", comfortable, ten tasks', JSON.stringify([cfg().source, cfg().density, cfg().max, cfg().group, cfg().sort, cfg(null).quick]) === '["todayOverdue","comfortable",10,"none","due","off"]', JSON.stringify(cfg()));
  check('todoist config: values are checked (unknown choices fall back, numbers are limited)', cfg({ source: 'nope', days: 999, max: 7, group: 'x', sort: 'y', density: 'z', quick: 'w' }).source === 'todayOverdue' && cfg({ source: 'upcoming', days: 999 }).days === 7 && cfg({ max: 7 }).max === 10 && cfg({ max: 0 }).max === 0 && cfg({ source: 'upcoming', days: 3 }).days === 3, '');
  check('todoist config: a source that needs a value it lacks is the default', cfg({ source: 'project' }).source === 'todayOverdue' && cfg({ source: 'label', label: ' ' }).source === 'todayOverdue' && cfg({ source: 'custom', query: '' }).source === 'todayOverdue' && cfg({ source: 'project', projectId: '2203306141' }).source === 'project', '');
  check('todoist config: a custom filter is limited to 200 characters and control characters go', cfg({ source: 'custom', query: `today\n${'x'.repeat(400)}` }).query.length === 200 && !/\n/.test(cfg({ source: 'custom', query: 'a\nb' }).query) && cfg({ source: 'label', label: '@work stuff' }).label === 'work_stuff', '');
  check('todoist config: fields are booleans with the old look as the default', cfg({ fields: { project: true, due: 'yes' } }).fields.project === true && cfg({ fields: { due: 'yes' } }).fields.due === true && cfg().fields.project === false && cfg().fields.priority === true, JSON.stringify(cfg().fields));
  const Q = (o) => TV.questionFor(cfg(o));
  check('todoist filters: each source asks Todoist the right question', Q({}).query === 'today | overdue' && Q({ source: 'today' }).query === 'today' && Q({ source: 'upcoming', days: 5 }).query === '5 days' && Q({ source: 'inbox' }).query === '#Inbox' && Q({ source: 'label', label: 'home' }).query === '@home' && Q({ source: 'all' }).query === 'view all' && Q({ source: 'custom', query: 'p1 & today' }).query === 'p1 & today' && Q({ source: 'project', projectId: '77' }).projectId === '77', JSON.stringify(Q({ source: 'upcoming', days: 5 })));
  const TODAY = '2026-09-29';
  const P = new Map([['1', { name: 'Home', color: 'red' }], ['2', { name: 'Work', color: 'blue' }]]);
  const raw = (id, content, extra) => ({ id, content, project_id: '2', priority: 1, labels: [], ...extra });
  const tasks = [
    raw('10', 'Tax', { project_id: '1', priority: 4, due: { date: '2026-09-27' }, labels: ['money'] }),
    raw('11', 'Standup', { due: { date: '2026-09-29T09:30:00', is_recurring: true }, priority: 3 }),
    raw('12', 'Inbox zero', { priority: 2, due: null, child_order: 1 }),
    raw('13', 'Report', { due: { date: '2026-10-02' }, priority: 4, child_order: 0, labels: ['money', 'work'] }),
    raw('14', 'Subtask', { parent_id: '13', due: { date: '2026-09-30' } }),
    raw('15', 'Later', { due: { date: '2026-11-01' }, project_id: '1' }),
  ].map((t) => TV.normalizeTask(t, P, TODAY));
  check('todoist tasks: normalized (overdue, time, recurring, project colour from a fixed table)', tasks[0].overdue && !tasks[1].overdue && tasks[1].time && tasks[1].recurring && tasks[0].project.color === '#db4035' && tasks[3].project.color === '#4073ff' && tasks[2].due === null, JSON.stringify(tasks[1]));
  check('todoist tasks: junk is dropped and text is flattened', TV.normalizeTask({ id: '../x', content: 'a' }) === null && TV.normalizeTask(null) === null && TV.normalizeTask({ id: '5', content: 'a\n\nb' }).title === 'a b' && TV.colorOf('javascript:1') === null && TV.colorOf('#AABBCC') === '#aabbcc', '');
  const ids = (list) => list.map((t) => t.id).join();
  check('todoist sort: by due date (dated first, priority breaks ties)', ids(TV.sortTasks(tasks, 'due')) === '10,11,14,13,15,12', ids(TV.sortTasks(tasks, 'due')));
  check('todoist sort: by priority, then due', ids(TV.sortTasks(tasks, 'priority')) === '10,13,11,12,14,15', ids(TV.sortTasks(tasks, 'priority')));
  check('todoist sort: by project name, then due', ids(TV.sortTasks(tasks, 'project')) === '10,15,11,14,13,12', ids(TV.sortTasks(tasks, 'project')));
  check('todoist sort: Todoist\'s own order and date added', ids(TV.sortTasks(tasks, 'manual')) === '10,11,13,14,15,12' && ids(TV.sortTasks(tasks, 'created')) === '10,11,12,13,14,15', ids(TV.sortTasks(tasks, 'manual')));
  const g = (kind) => TV.groupTasks(TV.sortTasks(tasks, 'due'), kind, TODAY).map((x) => `${x.label}:${ids(x.tasks)}`).join(' | ');
  check('todoist group: by due date buckets in order', g('due') === 'Overdue:10 | Today:11 | Tomorrow:14 | This week:13 | Later:15 | No date:12', g('due'));
  check('todoist group: by priority (urgent first), project, label', g('priority') === 'Priority 1:10,13 | Priority 2:11 | Priority 3:12 | No priority:14,15' && g('project').includes('Home:10,15') && g('project').includes('Work:11,14,13,12') && g('label').includes('@money:10,13') && g('label').includes('No label') && g('label').endsWith('No label:11,14,15,12'), `${g('priority')} / ${g('project')} / ${g('label')}`);
  check('todoist group: none is one unlabelled group', TV.groupTasks(tasks, 'none').length === 1 && TV.groupTasks(tasks, 'none')[0].label === '', '');
  const lim = TV.limitTasks(TV.groupTasks(TV.sortTasks(tasks, 'due'), 'due', TODAY), 3);
  check('todoist limits: cut to N across groups, empty groups vanish, the rest is counted', lim.shown === 3 && lim.groups.length === 3 && lim.groups[2].more === 0 && TV.limitTasks([{ label: '', tasks }], 4).groups[0].more === 2 && TV.limitTasks([{ label: '', tasks }], 0).shown === 6, JSON.stringify(lim.groups.map((x) => x.tasks.length)));
  const shaped = TV.shape(tasks, cfg({ fields: { project: true, labels: true, subtasks: true, description: true }, max: 5, group: 'due' }), TODAY);
  check('todoist shape: total, shown, fields the config switches on, subtask counts', shaped.total === 6 && shaped.shown === 5 && shaped.groups[0].tasks[0].project.name === 'Home' && shaped.groups[0].tasks[0].labels[0] === 'money' && shaped.groups.flatMap((x) => x.tasks).find((t) => t.id === '13').subtasks === 1 && shaped.name === 'Today', JSON.stringify(shaped).slice(0, 200));
  const hidden = TV.shape(tasks, cfg({ fields: { due: false, priority: false, project: false, recurring: false } }), TODAY).groups[0].tasks[0];
  check('todoist shape: what the config hides never leaves the main process', !('due' in hidden) && !('priority' in hidden) && !('project' in hidden) && !('recurring' in hidden) && 'title' in hidden, JSON.stringify(hidden));

  // ---- weather ----
  const boston = { name: 'Boston, Massachusetts, United States', lat: 42.35843, lon: -71.05977 };
  check('weather places: validated (ranges, name, nickname length); My location has no coordinates', WX.cleanPlace({ ...boston }).lat === 42.3584 && WX.cleanPlace({ name: 'X', lat: 91, lon: 0 }) === null && WX.cleanPlace({ name: '', lat: 1, lon: 1 }) === null && WX.cleanPlace({ name: 'X', lat: '1', lon: 1 }) === null && WX.cleanPlace({ here: true }).name === 'My location' && !('lat' in WX.cleanPlace({ here: true })) && WX.cleanPlace({ ...boston, nick: 'n'.repeat(90) }).nick.length === 30 && !WX.cleanPlace({ name: '<b>x</b>', lat: 1, lon: 1 }).name.includes('<'), '');
  let pl = WX.addPlace([], boston);
  pl = WX.addPlace(pl, { name: 'Boston again', lat: 42.36, lon: -71.06 });
  check('weather places: a place near an existing one is not added twice', pl.length === 1, '');
  pl = WX.addPlace(pl, { name: 'Paris', lat: 48.85, lon: 2.35 });
  pl = WX.addPlace(pl, { here: true });
  pl = WX.addPlace(pl, { here: true });
  check('weather places: add, and only one My location', pl.length === 3 && pl.filter((p) => p.here).length === 1, JSON.stringify(pl.map((p) => p.name)));
  check('weather places: reorder, nickname and remove', WX.movePlace(pl, 1, -1)[0].name === 'Paris' && WX.movePlace(pl, 0, -1)[0].name === pl[0].name && WX.setNick(pl, 1, 'Home?')[1].nick === 'Home?' && WX.removePlace(pl, 0).length === 2 && WX.placeLabel(WX.setNick(pl, 0, 'Nick')[0]) === 'Nick' && WX.placeLabel(pl[0]) === 'Boston', '');
  const many = WX.cleanPlaces(Array.from({ length: 30 }, (_, i) => ({ name: `P${i}`, lat: i * 3, lon: i * 5 })));
  check('weather places: capped per widget (6) and in the saved list (12)', many.length === 6 && WX.cleanSaved(Array.from({ length: 30 }, (_, i) => ({ name: `P${i}`, lat: i * 3, lon: i * 5 }))).length === 12 && WX.cleanSaved([{ here: true }, boston]).length === 1, '');
  const legacyW = WX.cleanConfig(undefined, { place: 'Boston, Massachusetts', lat: 42.3, lon: -71, units: 'c' });
  check('weather config: an old widget\'s place becomes its first place, units kept, sections on', legacyW.places.length === 1 && legacyW.places[0].name === 'Boston, Massachusetts' && legacyW.units === 'c' && legacyW.show.hourly && legacyW.days === 7 && legacyW.hours === 12 && WX.cleanConfig(undefined, {}) === null, JSON.stringify(legacyW));
  check('weather config: options are checked', WX.cleanConfig({ places: [boston], wind: 'knots', clock: '99', days: 30, hours: 5, view: 'x', show: { hourly: false, now: 'no' } }).wind === 'auto' && WX.cleanConfig({ places: [boston], days: 10, hours: 24, wind: 'ms', clock: '24' }).days === 10 && WX.cleanConfig({ places: [boston], show: { hourly: false } }).show.hourly === false && WX.cleanConfig({ places: [boston], show: { now: 'no' } }).show.now === true, '');
  check('weather config: an older Lumen still reads a place (the first real one)', WX.mirrorPlace({ places: [{ here: true, name: 'My location' }, pl[0]] }, null).place === pl[0].name && WX.mirrorPlace({ places: [{ here: true }] }, { name: 'Salem, MA', lat: 42.5, lon: -70.9 }).lat === 42.5, '');
  check('weather units: wind and precipitation follow the units unless overridden', WX.windUnit({ wind: 'auto', units: 'f' }) === 'mph' && WX.windUnit({ wind: 'auto', units: 'c' }) === 'kmh' && WX.windUnit({ wind: 'ms', units: 'f' }) === 'ms' && WX.precipUnit({ units: 'f' }) === 'in' && WX.precipUnit({ units: 'c' }) === 'mm' && WX.WIND_LABELS.kmh === 'km/h', '');
  const fp = WX.forecastParams(boston, { units: 'c', wind: 'auto', days: 10, hours: 12 });
  check('weather request: the units and days go to the service, nothing else about the user', fp.temperature_unit === 'celsius' && fp.wind_speed_unit === 'kmh' && fp.precipitation_unit === 'mm' && fp.forecast_days === '10' && Object.keys(fp).every((k) => ['latitude', 'longitude', 'timezone', 'forecast_days', 'current', 'hourly', 'daily', 'temperature_unit', 'wind_speed_unit', 'precipitation_unit'].includes(k)), JSON.stringify(Object.keys(fp)));
  check('weather formatting: 12h and 24h hour labels, system when auto', WX.hourLabel(0, '12') === '12 AM' && WX.hourLabel(13, '12') === '1 PM' && WX.hourLabel(9, '24') === '09:00' && WX.hourLabel(9, 'auto') === null, '');
  const bars = WX.dayBars([{ hi: 70, lo: 50 }, { hi: 90, lo: 60 }, { hi: 50, lo: 30 }, { hi: null, lo: null }]);
  check('weather days: hi/lo bars share one scale (0 at the coldest low, 100 at the warmest high)', bars[1].to === 100 && bars[2].from === 0 && bars[0].from === 33 && bars[0].to === 67 && bars[3].from === 0 && bars[3].to === 100 && WX.dayBars([{ hi: 5, lo: 5 }])[0].to >= 4, JSON.stringify(bars));
  const dayTimes = (d) => [...Array(24).keys()].map((h) => `${d}T${String(h).padStart(2, '0')}:00`);
  const rawWx = {
    current: { time: '2026-09-29T10:30', temperature_2m: 61.4, apparent_temperature: 59.9, weather_code: 3, is_day: 1, wind_speed_10m: 8.2, wind_direction_10m: 200, relative_humidity_2m: 71 },
    hourly: { time: [...dayTimes('2026-09-29'), ...dayTimes('2026-09-30')], temperature_2m: [...Array(48).keys()].map((i) => 50 + (i % 24)), weather_code: Array(48).fill(2), is_day: Array(48).fill(1), precipitation_probability: [...Array(48).keys()].map((i) => (i % 24) * 4), precipitation: Array(48).fill(0.01) },
    daily: { time: ['2026-09-29', '2026-09-30'], weather_code: [3, 61], temperature_2m_max: [70.2, 64.8], temperature_2m_min: [52.1, 50.4], precipitation_probability_max: [40, 80], precipitation_sum: [0.1, 0.4], wind_speed_10m_max: [12.3, 18.9], sunrise: ['2026-09-29T06:31', '2026-09-30T06:32'], sunset: ['2026-09-29T18:12', '2026-09-30T18:10'], uv_index_max: [5.2, 3] },
  };
  const shapedWx = WX.shape(rawWx, { days: 7, hours: 12 });
  check('weather shape: now, feels like, wind, humidity, hi/lo, sunrise, UV, chance of rain now', shapedWx.temp === 61 && shapedWx.feels === 60 && shapedWx.wind === 8 && shapedWx.humidity === 71 && shapedWx.hi === 70 && shapedWx.lo === 52 && shapedWx.sunrise === '06:31' && shapedWx.uv === 5.2 && shapedWx.pop === 40, JSON.stringify({ ...shapedWx, hourly: 0, daily: 0 }));
  check('weather shape: the hourly strip starts after now and is as long as asked', shapedWx.hourly.length === 12 && shapedWx.hourly[0].hour === 11 && WX.shape(rawWx, { days: 7, hours: 24 }).hourly.length === 24, shapedWx.hourly.map((h) => h.hour).join());
  check('weather shape: days with hi/lo bars, rain, wind, sun and three-hourly detail', shapedWx.daily.length === 2 && shapedWx.daily[1].pop === 80 && shapedWx.daily[1].hours.length === 8 && shapedWx.daily[1].hours[1].hour === 3 && shapedWx.daily[1].sunset === '18:10' && shapedWx.daily[0].bar.from >= 0 && shapedWx.daily[1].bar.to <= 100, JSON.stringify(shapedWx.daily[1]).slice(0, 200));
  check('weather shape: an empty or broken answer is null, missing extras are just left out', WX.shape({}, { days: 7, hours: 12 }) === null && WX.shape(null, { days: 7, hours: 12 }) === null && WX.shape({ current: { temperature_2m: 50, time: 'x' } }, { days: 7, hours: 12 }).daily.length === 0, '');
  const NOW = 1e12;
  check('weather my location: nothing is asked before consent, and never after "no"', WX.locationDecision({ consent: 'unset', cached: null, now: NOW }) === 'consent' && WX.locationDecision({ consent: 'unset', cached: { at: NOW }, now: NOW }) === 'consent' && WX.locationDecision({ consent: 'denied', cached: null, now: NOW }) === 'off' && WX.locationDecision({ consent: 'nonsense', cached: null, now: NOW }) === 'consent', '');
  check('weather my location: after consent the answer is reused for an hour, then asked again', WX.locationDecision({ consent: 'granted', cached: null, now: NOW }) === 'query' && WX.locationDecision({ consent: 'granted', cached: { at: NOW - 59 * 60e3 }, now: NOW }) === 'cached' && WX.locationDecision({ consent: 'granted', cached: { at: NOW - 61 * 60e3 }, now: NOW }) === 'query' && WX.locationDecision({ consent: 'granted', cached: { at: NOW + 5e3 }, now: NOW }) === 'query', '');
  const here = WX.cleanLocation({ city: 'Boston', region_code: 'MA', latitude: 42.3601, longitude: -71.0589, ip: '1.2.3.4' });
  check('weather my location: the answer is a city and rounded coordinates, the IP is dropped', here.name === 'Boston, MA' && here.lat === 42.36 && here.lon === -71.06 && !JSON.stringify(here).includes('1.2.3.4') && WX.cleanLocation({ error: true }) === null && WX.cleanLocation({ city: '', latitude: 1, longitude: 1 }) === null && WX.cleanLocation({ city: 'X', latitude: 999, longitude: 1 }) === null, JSON.stringify(here));

  // ---- widgets: page actions ----
  const { createWidgets } = require('../features/widgets');
  const w = createWidgets({ readSettings: () => ({}), writeSettings: () => {}, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}) });
  const url = (q) => `file:///x/newtab.html?${new URLSearchParams(q)}#{}`;
  const layoutText = 'wabcde:0,0,4,3;wabcdf:4,0,8,6,tr';
  check('widgets actions: layout, remove, configure, consent, undo and add are recognised and checked', w.actionFrom(url({ widget: 'wabcde', do: 'layout', l: layoutText })).items.length === 2 && w.actionFrom(url({ widget: 'wabcde', do: 'layout', l: 'junk' })).invalid && w.actionFrom(url({ widget: 'wabcde', do: 'remove' })).do === 'remove' && w.actionFrom(url({ widget: 'wabcde', do: 'configure' })).do === 'configure' && w.actionFrom(url({ widget: 'wabcde', do: 'consent', arg: 'allow' })).arg === 'allow' && w.actionFrom(url({ widget: 'wabcde', do: 'consent', arg: 'maybe' })).invalid && w.actionFrom(url({ widget: 'wabcde', do: 'undo' })).invalid && w.actionFrom(url({ widget: 'wabcde', do: 'undo', task: '12' })).task === '12' && w.actionFrom(url({ widget: 'wabcde', do: 'add', text: '  Pay rent tomorrow ' })).text === 'Pay rent tomorrow' && w.actionFrom(url({ widget: 'wabcde', do: 'add', text: '   ' })).invalid && w.actionFrom(url({ widget: 'wabcde', do: 'format-disk' })).invalid && w.actionFrom('file:///x?ask=1') === null, '');

  // ---- colours ----
  const BGS = ['plain', 'aurora', 'dusk', 'ocean', 'forest', 'sunset', 'graphite'];
  let worst = 99;
  let headWorst = 99;
  for (const bg of BGS) for (const dark of [false, true]) for (const accent of ['#007aff', '#ff9500', '#34c759', '#ffd60a', '#ffffff', '#000000']) {
    const p = WC.paletteFor({ accent, background: bg, dark });
    worst = Math.min(worst, WC.contrast(p.text, p.surface));
    headWorst = Math.min(headWorst, WC.contrast(p.head, p.surface));
  }
  check('widget colors: the text on the tinted surface is at least 4.5:1 for every built-in background, theme and a range of accents', worst >= 4.5, worst);
  check('widget colors: the title colour is at least 4.5:1 too (or falls back to the text colour)', headWorst >= 4.5, headWorst);
  const pAqua = WC.paletteFor({ accent: '#007aff', background: 'ocean' });
  const pPlain = WC.paletteFor({ accent: '#ff9500', background: 'plain' });
  check('widget colors: Match screen draws from the background (ocean is teal/blue), a plain page from the accent', WC.rgbToHsl(WC.hexToRgb(pAqua.hues[0])).h > 160 && WC.rgbToHsl(WC.hexToRgb(pAqua.hues[0])).h < 230 && pPlain.hues[0] === '#ff9500' && pPlain.hues.length === 3 && new Set(pPlain.hues).size === 3, JSON.stringify([pAqua.hues, pPlain.hues]));
  check('widget colors: light and dark pages get different surfaces', WC.paletteFor({ accent: '#007aff', dark: false }).surface !== WC.paletteFor({ accent: '#007aff', dark: true }).surface && WC.luminance(WC.paletteFor({ accent: '#007aff', dark: true }).surface) < WC.luminance(WC.paletteFor({ accent: '#007aff', dark: false }).surface), '');
  check('widget colors: a colour with no contrast is pushed lighter or darker, or dropped', WC.contrast(WC.ensureContrast('#ffff00', '#ffffff', 4.5), '#ffffff') >= 4.5 && WC.contrast(WC.ensureContrast('#aaaaaa', '#ffffff', 4.5), '#ffffff') >= 4.5 && WC.ensureContrast('#808080', '#808080', 21) === null, '');
  check('widget colors: contrast maths (white on black is 21:1)', Math.abs(WC.contrast('#ffffff', '#000000') - 21) < 1e-9 && Math.abs(WC.contrast('#777777', '#777777') - 1) < 1e-9, '');
  const accentP = WC.paletteForMode('accent', { accent: '#34c759', background: 'aurora', dark: false });
  const monoP = WC.paletteForMode('mono', { accent: '#34c759', background: 'plain', dark: true });
  check('widget colors: Accent only uses one colour, Monochrome greys, Calendar colors leaves the card alone', new Set(accentP.bars).size === 1 && WC.rgbToHsl(WC.hexToRgb(monoP.bars[0])).s < 0.05 && WC.paletteForMode('calendar', { accent: '#34c759' }) === null && WC.cleanMode('x') === 'calendar' && WC.cleanMode('match') === 'match', JSON.stringify([accentP.bars, monoP.bars]));
  // dominant colours of a synthetic picture: 60% blue, 30% orange, 10% grey
  const px2 = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) { const c = i < 60 ? [30, 90, 220] : i < 90 ? [240, 140, 30] : [128, 128, 128]; px2.set([...c, 255], i * 4); }
  const dom = WC.dominantColors(px2, 3);
  const hueOf = (hex) => WC.rgbToHsl(WC.hexToRgb(hex)).h;
  check('widget colors: dominant colours of a picture (most prominent first, distinct, colourful before grey)', dom.length >= 2 && Math.abs(hueOf(dom[0]) - 218) < 12 && Math.abs(hueOf(dom[1]) - 32) < 12, dom.join());
  check('widget colors: an empty or transparent picture has none', WC.dominantColors(new Uint8ClampedArray(0)).length === 0 && WC.dominantColors(new Uint8ClampedArray([1, 2, 3, 0])).length === 0, '');
  const imgP = WC.paletteFor({ accent: '#007aff', background: 'image', imageColors: ['#e07020', '#2060d0', '#20a060'] });
  check('widget colors: a wallpaper background uses its sampled colours and stays readable', imgP.hues[0] === '#e07020' && WC.contrast(imgP.text, imgP.surface) >= 4.5, JSON.stringify(imgP.hues));
  const noImg = WC.paletteFor({ accent: '#007aff', background: 'image', imageColors: [] });
  check('widget colors: a wallpaper with no sampled colours falls back to the accent', noImg.hues[0] === '#007aff', noImg.hues.join());

  // ---- calendar feed colours ----
  const cal = ics.eventsBetween(['BEGIN:VCALENDAR', 'X-APPLE-CALENDAR-COLOR:#FF2968FF', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20990101T100000Z', 'COLOR:teal', 'SUMMARY:x', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'DTSTART:20990101T110000Z', 'COLOR:url(x)', 'SUMMARY:y', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'), { from: Date.parse('2099-01-01T00:00:00Z'), days: 3 });
  check('calendar colors: the feed\'s calendar colour and an event\'s own colour are read and checked', cal.color === '#ff2968' && cal.events[0].color === '#008080' && cal.events[1].color === '', JSON.stringify([cal.color, cal.events.map((e) => e.color)]));
  check('widgets: the colors mode is stored per widget and defaults to Calendar colors', cleanWidget({ id: 'wcolor1', type: 'calendar', url: 'https://example.com/a.ics', colors: 'match' }).colors === 'match' && cleanWidget({ id: 'wcolor2', type: 'calendar', url: 'https://example.com/a.ics', colors: 'neon' }).colors === 'calendar' && cleanWidget({ id: 'wcolor3', type: 'todoist' }).colors === 'calendar' && cleanWidget({ id: 'wcolor4', type: 'weather', place: 'B', lat: 1, lon: 2, colors: 'accent' }).colors === 'accent', '');

  return Promise.resolve(require('./widget-edit-units')(check)).then(() => require('./slack-units')(check)); // system cards and Edit layout, then Slack
};

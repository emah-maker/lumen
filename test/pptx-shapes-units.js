// Shape geometry of PowerPoint decks (features/pptx-geom.js and its use in features/pptx.js), plain Node: the preset shapes with their adjust values
// (braces, brackets, arrows, basic shapes, stars, connectors), custom geometry (a:custGeom: guides, moveTo, lnTo, arcTo, quadBezTo, cubicBezTo, close,
// the path's own w and h), arrowheads, dash patterns, and what an unknown preset does. The expected numbers are worked out from the
// ECMA-376 formulas by hand; nothing here reads a real deck.
const P = require('../src/features/pptx');
const G = require('../src/features/pptx-geom');
const F = require('./_pptx-fixtures');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = (v) => JSON.stringify(v);
const EMU = 12700;
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// The end point of every command of a path "M0 0L10 5C..." as [x, y] (control points left out).
function ends(d) {
  const out = [];
  for (const seg of d.split(/(?=[MLCQZ])/).filter(Boolean)) {
    if (seg[0] === 'Z') continue;
    const n = seg.slice(1).split(/[ ]/).map(Number);
    out.push([n[n.length - 2], n[n.length - 1]]);
  }
  return out;
}
const same = (list, want, eps = 0.02) => list.length === want.length && list.every((p, i) => near(p[0], want[i][0], eps) && near(p[1], want[i][1], eps));
const hasPoint = (list, x, y, eps = 0.02) => list.some((p) => near(p[0], x, eps) && near(p[1], y, eps));
const geo = (prst, w, h, av = {}) => G.shapeGeometry({ prst, av }, w * EMU, h * EMU);
const outline = (prst, w, h, av) => { const g = geo(prst, w, h, av); return g ? ends(g.paths[0].d) : null; };
const bounds = (list) => ({ x0: Math.min(...list.map((p) => p[0])), x1: Math.max(...list.map((p) => p[0])), y0: Math.min(...list.map((p) => p[1])), y1: Math.max(...list.map((p) => p[1])) });

(async () => {
  // ---- braces and brackets
  {
    const g = geo('rightBrace', 30, 100);
    const stroked = g.paths.find((p) => p.stroke && p.fill === 'none');
    const pts = ends(stroked.d);
    check('rightBrace: the outline starts at the top left, ends at the bottom left, the tip is on the right edge at mid height', same([pts[0], pts[pts.length - 1]], [[0, 0], [0, 100]]) && hasPoint(pts, 30, 50), J(pts));
    check('rightBrace: the two curls meet the spine at x = half the width (default adj1 8333 of the short side: 2.5 pt)', hasPoint(pts, 15, 2.5) && hasPoint(pts, 15, 47.5) && hasPoint(pts, 15, 52.5) && hasPoint(pts, 15, 97.5), J(pts));
    check('rightBrace: the filled copy is closed and not stroked (the outline is the open one)', g.paths[0].fill === 'norm' && g.paths[0].stroke === false && /Z$/.test(g.paths[0].d) && !/Z/.test(stroked.d), J(g.paths.map((p) => [p.fill, p.stroke])));
    check('rightBrace: it is an open outline, so the line has ends (start and end carry a direction)', g.start && g.end && near(g.start.x, 0) && near(g.end.y, 100), J([g.start, g.end]));
    check('rightBrace adj2 25000 moves the tip up to a quarter of the height', hasPoint(ends(geo('rightBrace', 30, 100, { adj2: 25000 }).paths[1].d), 30, 25), '');
    check('rightBrace adj1 20000 makes the curls bigger (6 pt)', hasPoint(ends(geo('rightBrace', 30, 100, { adj1: 20000 }).paths[1].d), 15, 6), '');
    const left = ends(geo('leftBrace', 30, 100).paths[1].d);
    check('leftBrace: starts at the bottom right, ends at the top right, the tip is on the left edge', same([left[0], left[left.length - 1]], [[30, 100], [30, 0]]) && hasPoint(left, 0, 50), J(left));
    check('leftBrace: the spine is at half the width', hasPoint(left, 15, 97.5) && hasPoint(left, 15, 52.5) && hasPoint(left, 15, 47.5) && hasPoint(left, 15, 2.5), J(left));
    const rb = ends(geo('rightBracket', 20, 100).paths[1].d);
    check('rightBracket: top left, right side, bottom left; corners round by 8.33% of the short side', same([rb[0], rb[rb.length - 1]], [[0, 0], [0, 100]]) && hasPoint(rb, 20, 1.67) && hasPoint(rb, 20, 98.33), J(rb));
    const lb = ends(geo('leftBracket', 20, 100).paths[1].d);
    check('leftBracket: starts at the bottom right, runs up the left side to the top right', same([lb[0], lb[lb.length - 1]], [[20, 100], [20, 0]]) && hasPoint(lb, 0, 98.33) && hasPoint(lb, 0, 1.67), J(lb));
    const bp = geo('bracePair', 100, 60);
    const bpo = ends(bp.paths[1].d);
    check('bracePair: two braces, a tip on each side at mid height', hasPoint(bpo, 0, 30) && hasPoint(bpo, 100, 30) && bp.paths[1].d.split('M').length === 3, J(bpo));
    const kp = geo('bracketPair', 100, 60);
    const kpo = ends(kp.paths[1].d);
    check('bracketPair: a bracket on each side (16667 of the short side: 10 pt), the filled copy is the rounded rectangle', hasPoint(kpo, 0, 10) && hasPoint(kpo, 100, 50) && kp.paths[0].fill === 'norm' && kp.paths[0].stroke === false, J(kpo));
  }

  // ---- arrows
  {
    check('rightArrow 100 x 50: shaft half the height, head 25 pt long', same(outline('rightArrow', 100, 50), [[0, 12.5], [75, 12.5], [75, 0], [100, 25], [75, 50], [75, 37.5], [0, 37.5]]), J(outline('rightArrow', 100, 50)));
    check('rightArrow adj1 20000 (thin shaft) and adj2 30000 (short head)', same(outline('rightArrow', 100, 50, { adj1: 20000, adj2: 30000 }), [[0, 20], [85, 20], [85, 0], [100, 25], [85, 50], [85, 30], [0, 30]]), J(outline('rightArrow', 100, 50, { adj1: 20000, adj2: 30000 })));
    check('leftArrow', same(outline('leftArrow', 100, 50), [[0, 25], [25, 0], [25, 12.5], [100, 12.5], [100, 37.5], [25, 37.5], [25, 50]]), J(outline('leftArrow', 100, 50)));
    check('upArrow 50 x 100', same(outline('upArrow', 50, 100), [[0, 25], [25, 0], [50, 25], [37.5, 25], [37.5, 100], [12.5, 100], [12.5, 25]]), J(outline('upArrow', 50, 100)));
    check('downArrow 50 x 100', same(outline('downArrow', 50, 100), [[0, 75], [12.5, 75], [12.5, 0], [37.5, 0], [37.5, 75], [50, 75], [25, 100]]), J(outline('downArrow', 50, 100)));
    check('leftRightArrow', same(outline('leftRightArrow', 100, 50), [[0, 25], [25, 0], [25, 12.5], [75, 12.5], [75, 0], [100, 25], [75, 50], [75, 37.5], [25, 37.5], [25, 50]]), J(outline('leftRightArrow', 100, 50)));
    check('upDownArrow', same(outline('upDownArrow', 50, 100), [[25, 0], [50, 25], [37.5, 25], [37.5, 75], [50, 75], [25, 100], [0, 75], [12.5, 75], [12.5, 25], [0, 25]]), J(outline('upDownArrow', 50, 100)));
    check('notchedRightArrow: like rightArrow with a notch cut into the tail (12.5 pt deep)', same(outline('notchedRightArrow', 100, 50), [[0, 12.5], [75, 12.5], [75, 0], [100, 25], [75, 50], [75, 37.5], [0, 37.5], [12.5, 25]]), J(outline('notchedRightArrow', 100, 50)));
    check('chevron', same(outline('chevron', 100, 50), [[0, 0], [75, 0], [100, 25], [75, 50], [0, 50], [25, 25]]), J(outline('chevron', 100, 50)));
    check('homePlate (pentagon arrow)', same(outline('homePlate', 100, 50), [[0, 0], [75, 0], [100, 25], [75, 50], [0, 50]]), J(outline('homePlate', 100, 50)));
    const ba = outline('bentArrow', 100, 100);
    check('bentArrow: from the bottom left, up, an elbow, along the top to an arrowhead at the right', ba && hasPoint(ba, 0, 100) && hasPoint(ba, 25, 100) && hasPoint(ba, 43.75, 12.5) && hasPoint(ba, 75, 12.5) && hasPoint(ba, 75, 0) && hasPoint(ba, 100, 25) && hasPoint(ba, 75, 50) && hasPoint(ba, 75, 37.5), J(ba));
  }

  // ---- basic shapes
  {
    check('triangle: apex at the top middle, and adj 25000 moves it', same(outline('triangle', 100, 100), [[0, 100], [50, 0], [100, 100]]) && hasPoint(outline('triangle', 100, 100, { adj: 25000 }), 25, 0), '');
    check('rtTriangle', same(outline('rtTriangle', 100, 80), [[0, 80], [0, 0], [100, 80]]), '');
    check('diamond', same(outline('diamond', 100, 60), [[0, 30], [50, 0], [100, 30], [50, 60]]), '');
    check('parallelogram 100 x 50 (adj 25000 of the short side)', same(outline('parallelogram', 100, 50), [[0, 50], [12.5, 0], [100, 0], [87.5, 50]]), J(outline('parallelogram', 100, 50)));
    check('trapezoid 100 x 50', same(outline('trapezoid', 100, 50), [[0, 50], [12.5, 0], [87.5, 0], [100, 50]]), J(outline('trapezoid', 100, 50)));
    check('hexagon 100 x 100: points on the left and right middle, flat top and bottom', same(outline('hexagon', 100, 100), [[0, 50], [25, 0], [75, 0], [100, 50], [75, 100], [25, 100]], 0.05), J(outline('hexagon', 100, 100)));
    const oct = outline('octagon', 100, 100);
    check('octagon: corners cut by 29.289 percent', oct.length === 8 && hasPoint(oct, 0, 29.29) && hasPoint(oct, 29.29, 0) && hasPoint(oct, 100, 70.71), J(oct));
    const pen = outline('pentagon', 100, 100);
    check('pentagon (regular): apex at the top middle, the base on the bottom edge, symmetric', pen.length === 5 && hasPoint(pen, 50, 0, 0.05) && near(bounds(pen).y1, 100, 0.05) && near(bounds(pen).x0, 0, 0.05) && near(bounds(pen).x1, 100, 0.05), J(pen));
    const star = outline('star5', 100, 100);
    check('star5: ten points, one tip at the top middle, the other tips touching the box', star.length === 10 && hasPoint(star, 50, 0, 0.05) && near(bounds(star).y1, 100, 0.1) && near(bounds(star).x0, 0, 0.1) && near(bounds(star).x1, 100, 0.1), J(star));
    const s5 = outline('star5', 100, 100, { adj: 40000 });
    check('star5 adj 40000: a fatter star (the inner points move out)', s5.length === 10 && Math.hypot(s5[1][0] - 50, s5[1][1] - 55.28) > Math.hypot(star[1][0] - 50, star[1][1] - 55.28), '');
    check('star4, star6, star8, star12, star24 have 2n points', [['star4', 4], ['star6', 6], ['star8', 8], ['star12', 12], ['star24', 24]].every(([n, k]) => outline(n, 80, 80).length === 2 * k), '');
    const rr = geo('roundRect', 100, 50).paths[0].d;
    check('roundRect: corner radius 16.667 percent of the short side (8.33 pt), four arcs', ends(rr)[0][1] > 8 && near(ends(rr)[0][1], 8.33, 0.05) && (rr.match(/C/g) || []).length === 4, rr);
    check('roundRect adj 50000: the short ends are half circles', near(ends(geo('roundRect', 100, 50, { adj: 50000 }).paths[0].d)[0][1], 25, 0.05), '');
    const el = bounds(outline('ellipse', 100, 60));
    check('ellipse: four curves touching the middle of each side', near(el.x0, 0) && near(el.x1, 100) && near(el.y0, 0) && near(el.y1, 60) && (geo('ellipse', 100, 60).paths[0].d.match(/C/g) || []).length === 4, '');
    const dn = geo('donut', 100, 100).paths[0].d;
    check('donut: an outer and an inner circle (two subpaths), the hole 25% of the short side wide', dn.split('M').length === 3 && /M25 50/.test(dn), dn);
    const arc = geo('arc', 100, 100, { adj1: 16200000, adj2: 0 });
    const ao = ends(arc.paths[1].d);
    check('arc (270 degrees to 0): from the top middle to the right middle, drawn as an open curve (no fill of its own)', near(ao[0][0], 50) && near(ao[0][1], 0) && near(ao[ao.length - 1][0], 100) && near(ao[ao.length - 1][1], 50) && arc.paths[1].fill === 'none' && arc.paths[0].stroke === false, J(ao));
    const arc2 = geo('arc', 100, 100, { adj1: 5400000, adj2: 10800000 });
    check('arc (90 to 180 degrees): bottom middle to the left middle', same([ends(arc2.paths[1].d)[0], ends(arc2.paths[1].d).pop()], [[50, 100], [0, 50]]), J(ends(arc2.paths[1].d)));
    const arc3 = geo('arc', 100, 100, { adj1: 0, adj2: 16200000 });
    check('arc (0 to 270, the long way): three quarter turns of curve', (arc3.paths[1].d.match(/C/g) || []).length === 3, arc3.paths[1].d);
    const pie = geo('pie', 100, 100, { adj1: 0, adj2: 5400000 });
    check('pie (0 to 90 degrees) is closed through the center', /L50 50Z$/.test(pie.paths[0].d) && near(ends(pie.paths[0].d)[0][0], 100), pie.paths[0].d);
    const can = geo('can', 100, 100);
    check('can: a body, a lighter top and a front rim (3 paths with different fills)', can.paths.length === 3 && can.paths[1].fill === 'lightenLess' && can.paths[2].fill === 'none', J(can.paths.map((p) => p.fill)));
    check('cube: three faces and edges (darker side, lighter top)', geo('cube', 100, 100).paths.map((p) => p.fill).join() === 'norm,darkenLess,lightenLess,none', '');
    check('plus: twelve corners', outline('plus', 100, 100).length === 12, '');
    check('mathPlus, mathMinus, mathEqual', outline('mathPlus', 100, 100).length === 12 && outline('mathMinus', 100, 100).length === 4 && geo('mathEqual', 100, 100).paths[0].d.split('M').length === 3, '');
    check('flow chart shapes: process, decision, terminator, input/output, predefined process', outline('flowChartProcess', 10, 10).length === 4 && outline('flowChartDecision', 10, 10).length === 4 && geo('flowChartTerminator', 100, 40).paths[0].d.includes('C') && outline('flowChartInputOutput', 100, 50).length === 4 && geo('flowChartPredefinedProcess', 80, 40).paths.length === 2, '');
    check('round1Rect, round2SameRect, snip1Rect, snip2SameRect', hasPoint(outline('snip1Rect', 100, 100), 100, 16.67, 0.05) && outline('snip2SameRect', 100, 100).length === 8 && geo('round1Rect', 100, 100).paths[0].d.includes('C') && geo('round2SameRect', 100, 100).paths[0].d.includes('C'), '');
  }

  // ---- lines and connectors, with arrowheads
  {
    const line = G.shapeGeometry({ prst: 'straightConnector1' }, 100 * EMU, 0);
    check('a straight connector is one open stroke from the top left to the bottom right of its box', line.paths.length === 1 && line.paths[0].d === 'M0 0L100 0' && line.paths[0].fill === 'none', J(line));
    check('its ends carry their direction: the end points right (1, 0), the start points left', near(line.end.dx, 1) && near(line.end.dy, 0) && near(line.start.dx, -1), J([line.start, line.end]));
    const tail = G.arrowhead(line.end, { width: 2, tail: 'triangle' }, 'tail');
    check('tailEnd triangle, 2 pt line, medium size: tip on the end point, base 6 pt back and 6 pt wide', tail && tail.fill === true && tail.d === 'M100 0L94 3L94 -3Z', J(tail));
    const head = G.arrowhead(line.start, { width: 2, head: 'triangle' }, 'head');
    check('headEnd triangle: tip on the start point, pointing away from the line', head && head.d === 'M0 0L6 -3L6 3Z', J(head));
    check('sizes: lg is bigger than med, sm smaller (width and length from the line width)', G.arrowhead(line.end, { width: 2, tail: 'triangle', tailW: 'lg', tailLen: 'lg' }, 'tail').d === 'M100 0L90 5L90 -5Z' && G.arrowhead(line.end, { width: 2, tail: 'triangle', tailW: 'sm', tailLen: 'sm' }, 'tail').d === 'M100 0L96 2L96 -2Z', '');
    check('a thin line still gets a visible head (the line width counts as at least 2 pt)', G.arrowhead(line.end, { width: 0.5, tail: 'triangle' }, 'tail').d === 'M100 0L94 3L94 -3Z', '');
    check('a 4 pt line: the head is twice as big', G.arrowhead(line.end, { width: 4, tail: 'triangle' }, 'tail').d === 'M100 0L88 6L88 -6Z', '');
    const kinds = ['stealth', 'diamond', 'oval', 'arrow'].map((t) => G.arrowhead(line.end, { width: 2, tail: t }, 'tail'));
    check('stealth (a notched triangle), diamond, oval (four curves) and open arrow (stroked, not filled)', kinds[0].d.split('L').length === 4 && kinds[1].d === 'M100 0L97 3L94 0L97 -3Z' && (kinds[2].d.match(/C/g) || []).length === 4 && kinds[3].fill === false && kinds[3].d === 'M94 3L100 0L94 -3', J(kinds));
    check('type none or missing: no arrowhead', G.arrowhead(line.end, { width: 2, tail: 'none' }, 'tail') === null && G.arrowhead(line.end, { width: 2 }, 'tail') === null, '');
    const v = G.shapeGeometry({ prst: 'line' }, 0, 100 * EMU);
    check('a vertical line (zero width): the end points down, and the head is turned with it', near(v.end.dy, 1) && G.arrowhead(v.end, { width: 2, tail: 'triangle' }, 'tail').d === 'M0 100L-3 94L3 94Z', J(G.arrowhead(v.end, { width: 2, tail: 'triangle' }, 'tail')));
    const b3 = G.shapeGeometry({ prst: 'bentConnector3', av: {} }, 100 * EMU, 50 * EMU);
    check('bentConnector3: right, down at the middle, right again', same(ends(b3.paths[0].d), [[0, 0], [50, 0], [50, 50], [100, 50]]) && near(b3.end.dx, 1) && near(b3.start.dx, -1), J(ends(b3.paths[0].d)));
    check('bentConnector3 adj1 25000 moves the middle segment', hasPoint(ends(G.shapeGeometry({ prst: 'bentConnector3', av: { adj1: 25000 } }, 100 * EMU, 50 * EMU).paths[0].d), 25, 50), '');
    check('bentConnector2 (one elbow), bentConnector4 and 5', same(ends(geo('bentConnector2', 100, 50).paths[0].d), [[0, 0], [100, 0], [100, 50]]) && ends(geo('bentConnector4', 100, 50).paths[0].d).length === 5 && ends(geo('bentConnector5', 100, 50).paths[0].d).length === 6, '');
    const c3 = G.shapeGeometry({ prst: 'curvedConnector3', av: {} }, 100 * EMU, 50 * EMU);
    const c3e = ends(c3.paths[0].d);
    check('curvedConnector3: an S of two curves from corner to corner through the middle', c3e.length === 3 && same([c3e[0], c3e[1], c3e[2]], [[0, 0], [50, 25], [100, 50]]) && near(c3.end.dx, 1) && near(c3.end.dy, 0), J(c3e));
    check('curvedConnector2, 4 and 5 are curves from corner to corner', ['curvedConnector2', 'curvedConnector4', 'curvedConnector5'].every((n) => { const e = ends(geo(n, 100, 60).paths[0].d); return near(e[0][0], 0) && near(e[e.length - 1][0], 100) && near(e[e.length - 1][1], 60) && geo(n, 100, 60).paths[0].d.includes('C'); }), '');
  }

  // ---- custom geometry
  {
    const cust = (paths, { gd = '', av = '' } = {}, box = { x: 0, y: 0, w: 100, h: 100 }) => F.custShape({ box, paths, gd, av });
    const parse = async (xml) => (await P.parsePptx(F.deck({ slides: [{ shapes: xml }] }))).slides[0].shapes.filter((s) => s.own);
    let [s] = await parse(cust('<a:path w="200" h="200"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="200" y="0"/></a:lnTo><a:lnTo><a:pt x="200" y="200"/></a:lnTo><a:close/></a:path>'));
    check('custGeom: moveTo, lnTo and close, scaled by the path\'s own w and h (200 -> the shape\'s 100)', s && s.geom === 'path' && s.paths[0].d === 'M0 0L100 0L100 100Z', J(s));
    [s] = await parse(cust('<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="100"/></a:moveTo><a:cubicBezTo><a:pt x="0" y="0"/><a:pt x="100" y="0"/><a:pt x="100" y="100"/></a:cubicBezTo><a:quadBezTo><a:pt x="50" y="50"/><a:pt x="0" y="100"/></a:quadBezTo></a:path>'));
    check('custGeom: cubicBezTo and quadBezTo (the quadratic one stays a Q curve)', s.paths[0].d === 'M0 100C0 0 100 0 100 100Q50 50 0 100', s.paths[0] && s.paths[0].d);
    [s] = await parse(cust('<a:path w="100" h="100"><a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/></a:path>'));
    let e = ends(s.paths[0].d);
    check('custGeom arcTo: a quarter circle from the right middle clockwise to the bottom middle (one curve)', e.length === 2 && near(e[1][0], 50) && near(e[1][1], 100), J(e));
    [s] = await parse(cust('<a:path w="100" h="100"><a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="10800000"/></a:path>'));
    e = ends(s.paths[0].d);
    check('custGeom arcTo: a half circle ends on the left middle (two curves)', e.length === 3 && near(e[2][0], 0) && near(e[2][1], 50), J(e));
    [s] = await parse(cust('<a:path w="100" h="100"><a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="-5400000"/></a:path>'));
    e = ends(s.paths[0].d);
    check('custGeom arcTo with a negative sweep goes counterclockwise (up)', e.length === 2 && near(e[1][0], 50) && near(e[1][1], 0), J(e));
    [s] = await parse(cust('<a:path w="200" h="100"><a:moveTo><a:pt x="200" y="50"/></a:moveTo><a:arcTo wR="100" hR="50" stAng="0" swAng="2700000"/></a:path>', {}, { x: 0, y: 0, w: 200, h: 100 }));
    e = ends(s.paths[0].d);
    check('custGeom arcTo on an ellipse: angles are visual, so 45 degrees is the point on the diagonal (144.72, 94.72)', e.length === 2 && near(e[1][0], 144.72, 0.05) && near(e[1][1], 94.72, 0.05), J(e));
    [s] = await parse(cust('<a:path><a:moveTo><a:pt x="x1" y="t"/></a:moveTo><a:lnTo><a:pt x="r" y="y2"/></a:lnTo><a:lnTo><a:pt x="l" y="y2"/></a:lnTo><a:close/></a:path>', { gd: '<a:gd name="x1" fmla="*/ w adj 100000"/><a:gd name="y2" fmla="+- b 0 x1"/>', av: '<a:gd name="adj" fmla="val 30000"/>' }));
    check('custGeom: guides (an avLst value, a gdLst formula that uses it and the built-in names w, b, l, t, r; with no path w and h the path is in EMU)', s.paths[0].d === 'M30 0L100 70L0 70Z', s.paths[0].d);
    [s] = await parse(cust('<a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo></a:path>', {}, { x: 0, y: 0, w: 50, h: 50 }));
    check('custGeom: a path with no w and h is in the shape\'s own units (EMU)... here as points of a 50 pt box: 100 EMU is a hundredth of a point', s.paths[0].d === 'M0 0L0.01 0.01', s.paths[0].d);
    [s] = await parse(cust('<a:path w="10" h="10" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo></a:path><a:path w="10" h="10" stroke="0"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="0"/></a:lnTo><a:lnTo><a:pt x="0" y="10"/></a:lnTo><a:close/></a:path>'));
    check('custGeom: several paths keep their own fill and stroke flags', s.paths.length === 2 && s.paths[0].fill === 'none' && s.paths[0].stroke === true && s.paths[1].fill === 'norm' && s.paths[1].stroke === false, J(s.paths));
    [s] = await parse(cust('<a:path w="10" h="10"><a:moveTo><a:pt x="a" y="b"/></a:moveTo><a:lnTo><a:pt x="nope" y="5"/></a:lnTo></a:path>', { gd: '<a:gd name="a" fmla="*/ w 1 0"/><a:gd name="b" fmla="bogus 1 2 3"/>' }));
    check('custGeom: division by zero, an unknown formula and an unknown name give 0, never NaN', s && !/NaN|Infinity/.test(J(s.paths)), J(s && s.paths));
    const many = Array.from({ length: 30000 }, (_v, i) => `<a:lnTo><a:pt x="${i % 100}" y="${i % 7}"/></a:lnTo>`).join('');
    const t0 = Date.now();
    [s] = await parse(cust(`<a:path w="100" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${many}</a:path>`));
    check('custGeom: a huge path is cut off (at 20000 commands) and quick', s && s.paths[0].d.split('L').length <= 20001 && Date.now() - t0 < 3000, `${s && s.paths[0].d.split('L').length} ${Date.now() - t0} ms`);
    [s] = await parse(cust('<a:path w="10" h="10"/>'));
    check('custGeom with an empty path draws a plain box (nothing to draw)', !s || s.geom === 'rect' || !s.paths, J(s));
  }

  // ---- through the deck reader: fills, lines, rotation, groups, pictures
  {
    const parse = async (xml, opts) => (await P.parsePptx(F.deck({ slides: [{ shapes: xml, ...(opts || {}) }] }))).slides[0].shapes.filter((s) => s.own);
    let [s] = await parse(F.prstShape({ prst: 'rightBrace', box: { x: 100, y: 100, w: 30, h: 100 }, line: { color: 'FF0000', w: 2 } }));
    check('a brace with a line and no fill: geom path, the outline color and width, no fill', s.geom === 'path' && s.fill === null && s.line.color === '#ff0000' && s.line.width === 2 && s.paths.length === 2, J(s));
    [s] = await parse(F.prstShape({ prst: 'rightArrow', box: { x: 0, y: 0, w: 100, h: 50 }, fill: '00FF00', line: { color: '000000', dash: 'dash', cap: 'rnd' } }));
    check('an arrow with a fill and a dashed round-capped line', s.fill.color === '#00ff00' && J(s.line.dashArray) === '[4,3]' && s.line.cap === 'round' && s.paths[0].fill === 'norm', J(s.line));
    for (const [name, want] of [['dot', '[1,1]'], ['sysDash', '[3,1]'], ['lgDash', '[8,3]'], ['dashDot', '[4,3,1,3]'], ['lgDashDotDot', '[8,3,1,3,1,3]']]) {
      [s] = await parse(F.prstShape({ prst: 'rect', box: { x: 0, y: 0, w: 10, h: 10 }, line: { color: '000000', dash: name } }));
      check(`dash "${name}" is the pattern ${want} (in line widths)`, J(s.line.dashArray) === want, J(s.line));
    }
    [s] = await parse(F.prstShape({ prst: 'rect', box: { x: 0, y: 0, w: 10, h: 10 }, line: { color: '000000' } }));
    check('a solid line has no dash pattern; a rectangle stays a plain box (no path data)', !s.line.dashArray && s.geom === 'rect' && !s.paths, J(s));
    [s] = await parse(F.prstShape({ tag: 'cxnSp', prst: 'bentConnector3', box: { x: 10, y: 10, w: 100, h: 50 }, line: { color: '0000FF', w: 3, head: 'oval', tail: 'triangle', tw: 'lg', tl: 'sm' } }));
    check('a connector in a deck: type line, an elbow path, an oval at the start, a triangle at the end (large and short)', s.type === 'line' && s.paths.length === 1 && s.ends.length === 2 && (s.ends[0].d.match(/C/g) || []).length === 4 && s.ends[1].d.startsWith('M100 50L'), J(s));
    [s] = await parse(F.prstShape({ tag: 'cxnSp', prst: 'straightConnector1', box: { x: 10, y: 10, w: 100, h: 50, flipH: true, flipV: true }, line: { color: '0000FF', w: 2, tail: 'arrow' } }));
    check('flips stay flags on the connector (the page mirrors the whole drawing, arrowhead included)', s.flipH === true && s.flipV === true && s.ends[0].fill === false, J(s));
    [s] = await parse(F.prstShape({ prst: 'star5', box: { x: 0, y: 0, w: 60, h: 60 }, fill: 'FFCC00' }));
    check('star5 through the deck reader', s.geom === 'path' && s.paths[0].d.startsWith('M30 0'), s.paths && s.paths[0].d);
    // a group that stretches its child: the arrow is drawn for the final size
    const grp = F.group({ box: { x: 0, y: 0, w: 200, h: 100 }, chOff: { x: 0, y: 0 }, chExt: { w: 100, h: 100 }, children: F.prstShape({ prst: 'rightArrow', box: { x: 0, y: 0, w: 100, h: 100 }, fill: 'FF0000' }) });
    [s] = await parse(grp);
    check('a shape inside a stretched group: its geometry is made for the final 200 x 100 box (head 50 pt long from the short side)', s && s.w === 200 * EMU && s.paths[0].d.startsWith('M0 25L150 25L150 0L200 50'), s && s.paths[0].d);
    // a picture with a preset geometry
    const picXml = F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 100, h: 100 }, geom: 'triangle' });
    const deck = await P.parsePptx(F.deck({ slides: [{ shapes: picXml, rels: [F.imageRel('rImg', 'image1.png')] }], media: { 'image1.png': F.solid(F.RED) } }));
    const pic = deck.slides[0].shapes.find((x) => x.own);
    check('a picture cropped to a triangle: geom path with the triangle outline', pic.type === 'pic' && pic.geom === 'path' && pic.paths[0].d === 'M0 100L50 0L100 100Z', J(pic.paths));
  }

  // ---- unknown presets: a box, and a note in the log, once
  {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    const xml = F.prstShape({ prst: 'someBrandNewShape', box: { x: 0, y: 0, w: 100, h: 50 }, fill: 'AAAAAA' }) + F.prstShape({ id: 80, prst: 'someBrandNewShape', box: { x: 0, y: 60, w: 100, h: 50 }, fill: 'AAAAAA' });
    const shapes = (await P.parsePptx(F.deck({ slides: [{ shapes: xml }, { shapes: xml }] }))).slides.flatMap((x) => x.shapes.filter((s) => s.own));
    console.warn = orig;
    check('an unknown preset is drawn as its box (fill kept) and named in the log exactly once', shapes.length === 4 && shapes.every((s) => s.geom === 'rect' && s.fill && !s.paths) && warnings.filter((w) => w.includes('someBrandNewShape')).length === 1, J(warnings));
  }

  // ---- every shape the viewer promises
  {
    const names = ['rightBrace', 'leftBrace', 'rightBracket', 'leftBracket', 'bracePair', 'bracketPair', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow', 'notchedRightArrow', 'chevron', 'homePlate', 'bentArrow', 'rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'octagon', 'star4', 'star5', 'star6', 'star8', 'line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5', 'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5', 'arc', 'pie', 'chord', 'donut', 'plus', 'can', 'cube'];
    const missing = names.filter((n) => !G.has(n) || !geo(n, 120, 80) || /NaN|Infinity/.test(J(geo(n, 120, 80))));
    check(`all ${names.length} named presets exist, produce paths and no NaN`, missing.length === 0, missing.join());
    const squashed = names.filter((n) => { const g = geo(n, 0, 0); return g && /NaN|Infinity/.test(J(g)); });
    const tiny = names.filter((n) => { const g = geo(n, 1, 1000000); return g && /NaN|Infinity/.test(J(g)); });
    check('degenerate boxes (0 x 0, 1 x 1000000 pt) never give NaN', squashed.length === 0 && tiny.length === 0, `${squashed} ${tiny}`);
    const wild = names.filter((n) => { const g = geo(n, 50, 50, { adj: -5e9, adj1: 9e12, adj2: -1, adj3: 1e30, adj4: NaN }); return g && /NaN|Infinity/.test(J(g)); });
    check('wild adjust values are held in range (no NaN or Infinity)', wild.length === 0, wild.join());
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

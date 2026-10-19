// ---------- Shape geometry for PowerPoint decks: custom geometry (a:custGeom) and the preset shapes (a:prstGeom) ----------
// Loaded on first use by pptx.js (a deck of plain rectangles never loads it). It turns a shape's geometry into SVG path data in points,
// for renderer/slides.js to draw. Both kinds run on the same small machine, the guide language of ECMA-376 (DrawingML): a list of
// named formulas ("*/ w adj 100000"), then paths of moveTo, lnTo, arcTo, quadBezTo, cubicBezTo and close, whose numbers are formulas'
// names or plain numbers. A preset is a short text of that language (below), so its adjust values (a:avLst) work exactly as in
// PowerPoint; a custom geometry is the same thing read from the XML. Arcs become cubic curves here, so the page needs no arc flags and
// the ends of an open path have a tangent for an arrowhead. Nothing is evaluated that is not arithmetic, and every size is capped.
// The preset texts follow the ECMA-376 definitions (Part 1, presetShapeDefinitions.xml: the shape formulas the standard publishes for
// anyone to implement); an unknown preset name is drawn as its bounding box and named once in the log.
const EMU_PER_PT = 12700;
const MAX_GUIDES = 600;
const MAX_COMMANDS = 20000;
const MAX_PATHS = 50;
const RAD = Math.PI / 10800000; // 60000ths of a degree to radians
const TAU = Math.PI * 2;

const fin = (v) => (Number.isFinite(v) ? v : 0);
const isNum = (s) => /^-?\d+(\.\d+)?$/.test(s);

// ---- the formula language ----
function builtins(w, h) {
  const ss = Math.min(w, h); const ls = Math.max(w, h);
  return {
    w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, ss, ls,
    wd2: w / 2, wd3: w / 3, wd4: w / 4, wd5: w / 5, wd6: w / 6, wd8: w / 8, wd10: w / 10, wd32: w / 32,
    hd2: h / 2, hd3: h / 3, hd4: h / 4, hd5: h / 5, hd6: h / 6, hd8: h / 8, hd10: h / 10, hd32: h / 32,
    ssd2: ss / 2, ssd4: ss / 4, ssd6: ss / 6, ssd8: ss / 8, ssd16: ss / 16, ssd32: ss / 32,
    cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000,
  };
}
function formula(op, a, b, c) {
  switch (op) {
    case '*/': return c ? (a * b) / c : 0;
    case '+-': return a + b - c;
    case '+/': return c ? (a + b) / c : 0;
    case '?:': return a > 0 ? b : c;
    case 'abs': return Math.abs(a);
    case 'at2': { let d = Math.atan2(b, a) / RAD; if (d < 0) d += 21600000; return d; }
    case 'cat2': return a * Math.cos(Math.atan2(c, b));
    case 'sat2': return a * Math.sin(Math.atan2(c, b));
    case 'cos': return a * Math.cos(b * RAD);
    case 'sin': return a * Math.sin(b * RAD);
    case 'tan': return a * Math.tan(b * RAD);
    case 'max': return Math.max(a, b);
    case 'min': return Math.min(a, b);
    case 'mod': return Math.sqrt(a * a + b * b + c * c);
    case 'pin': return b < a ? a : b > c ? c : b;
    case 'sqrt': return Math.sqrt(Math.max(0, a));
    case 'val': return a;
    default: return 0;
  }
}
const lookup = (env, s) => (s === undefined ? 0 : isNum(s) ? Number(s) : fin(env[s]));
// Runs "name, formula" guides in order against env (which starts with the built-in names and the adjust values).
function runGuides(list, env) {
  for (const [name, fmla] of list.slice(0, MAX_GUIDES)) {
    const [op, a, b, c] = String(fmla).trim().split(/\s+/);
    env[name] = fin(formula(op, lookup(env, a), lookup(env, b), lookup(env, c)));
  }
}

// ---- arcs and paths ----
// A path is a list of absolute commands: ['M', x, y], ['L', x, y], ['Q', x1, y1, x, y], ['C', x1, y1, x2, y2, x, y], ['Z'].
// DrawingML's arcTo angles are visual (from the center to the point): the parameter on the ellipse comes from them.
const param = (theta, wR, hR) => Math.atan2(wR * Math.sin(theta), hR * Math.cos(theta));
function arcTo(out, cur, wR, hR, stAng, swAng) {
  if (!(wR > 0) || !(hR > 0)) return;
  const th = stAng * RAD; const sw = swAng * RAD;
  const t1 = param(th, wR, hR);
  const full = Math.trunc(sw / TAU);
  const rem = sw - full * TAU;
  let dt = 0;
  if (Math.abs(rem) > 1e-9) {
    dt = param(th + rem, wR, hR) - t1;
    while (rem > 0 && dt < 0) dt += TAU;
    while (rem < 0 && dt > 0) dt -= TAU;
  }
  dt += full * TAU;
  if (!dt) return;
  const cx = cur.x - wR * Math.cos(t1); const cy = cur.y - hR * Math.sin(t1);
  const n = Math.min(64, Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)));
  const step = dt / n; const k = (4 / 3) * Math.tan(step / 4);
  let t = t1;
  for (let i = 0; i < n; i++) {
    const t2 = t + step;
    const x0 = cx + wR * Math.cos(t); const y0 = cy + hR * Math.sin(t);
    const x3 = cx + wR * Math.cos(t2); const y3 = cy + hR * Math.sin(t2);
    out.push(['C', x0 - k * wR * Math.sin(t), y0 + k * hR * Math.cos(t), x3 + k * wR * Math.sin(t2), y3 - k * hR * Math.cos(t2), x3, y3]);
    cur.x = x3; cur.y = y3;
    t = t2;
  }
}
// One path of a definition ({ cmds: [[op, ...args as names or numbers]] }) in the shape's size, scaled to points. sx, sy: path units to shape units.
function buildPath(p, env, sx, sy, budget) {
  const out = []; const cur = { x: 0, y: 0 }; let start = { x: 0, y: 0 };
  const v = (s) => lookup(env, s);
  for (const [op, ...a] of p.cmds) {
    if (--budget.left < 0) break;
    if (op === 'M') { cur.x = v(a[0]); cur.y = v(a[1]); start = { x: cur.x, y: cur.y }; out.push(['M', cur.x, cur.y]); }
    else if (op === 'L') { cur.x = v(a[0]); cur.y = v(a[1]); out.push(['L', cur.x, cur.y]); }
    else if (op === 'Q') { out.push(['Q', v(a[0]), v(a[1]), v(a[2]), v(a[3])]); cur.x = v(a[2]); cur.y = v(a[3]); }
    else if (op === 'C') { out.push(['C', v(a[0]), v(a[1]), v(a[2]), v(a[3]), v(a[4]), v(a[5])]); cur.x = v(a[4]); cur.y = v(a[5]); }
    else if (op === 'A') arcTo(out, cur, v(a[0]), v(a[1]), v(a[2]), v(a[3]));
    else if (op === 'Z') { out.push(['Z']); cur.x = start.x; cur.y = start.y; }
  }
  const k = 1 / EMU_PER_PT;
  return out.map(([op, ...n]) => [op, ...n.map((x, i) => fin(x) * (i % 2 ? sy : sx) * k)]);
}
const num2 = (x) => { const s = (Math.round(x * 100) / 100).toString(); return s === '-0' ? '0' : s; };
const toD = (cmds) => cmds.map(([op, ...n]) => (n.length ? `${op}${n.map(num2).join(' ')}` : op)).join('');

// ---- the preset shapes ----
// [adjust values, guides, paths...]. Adjust: "name value;...". Guides: "name op a b c;...". A path: "flags>M x y|L x y|A wR hR stAng swAng|C ...|Q ...|Z"
// with flags n (no fill), x (no stroke), l / L (lighter / a little lighter fill), d / D (darker / a little darker); no flags: the plain fill and outline.
const RECT = 'M l t|L r t|L r b|L l b|Z';
const ELLIPSE = 'M l vc|A wd2 hd2 cd2 cd4|A wd2 hd2 3cd4 cd4|A wd2 hd2 0 cd4|A wd2 hd2 cd4 cd4|Z';
const BRACE_R = 'M l t|A wd2 y1 3cd4 cd4|L hc y2|A wd2 y1 cd2 -5400000|A wd2 y1 3cd4 -5400000|L hc y4|A wd2 y1 0 cd4';
const BRACE_L = 'M r b|A wd2 y1 cd4 cd4|L hc y4|A wd2 y1 0 -5400000|A wd2 y1 cd4 -5400000|L hc y1|A wd2 y1 cd2 cd4|L r t';
const PAIR_BRACES = 'M x2 b|A x1 x1 cd4 cd4|L x1 y3|A x1 x1 0 -5400000|A x1 x1 cd4 -5400000|L x1 x1|A x1 x1 cd2 cd4|L x3 t|A x1 x1 3cd4 cd4|L x4 y2|A x1 x1 cd2 -5400000|A x1 x1 3cd4 -5400000|L x4 y4|A x1 x1 0 cd4';
const PAIR_BRACES_OPEN = 'M x2 b|A x1 x1 cd4 cd4|L x1 y3|A x1 x1 0 -5400000|A x1 x1 cd4 -5400000|L x1 x1|A x1 x1 cd2 cd4|M x3 t|A x1 x1 3cd4 cd4|L x4 y2|A x1 x1 cd2 -5400000|A x1 x1 3cd4 -5400000|L x4 y4|A x1 x1 0 cd4';
const ROUNDED = 'M l x1|A x1 x1 cd2 cd4|L x2 t|A x1 x1 3cd4 cd4|L r y2|A x1 x1 0 cd4|L x1 b|A x1 x1 cd4 cd4|Z';
const ARC_GUIDES = 'stAng pin 0 adj1 21599999;enAng pin 0 adj2 21599999;sw11 +- enAng 0 stAng;sw12 +- sw11 21600000 0;swAng ?: sw11 sw11 sw12;wt1 sin wd2 stAng;ht1 cos hd2 stAng;dx1 cat2 wd2 ht1 wt1;dy1 sat2 hd2 ht1 wt1;x1 +- hc dx1 0;y1 +- vc dy1 0';
const BRACE_GUIDES = 'a2 pin 0 adj2 100000;q1 +- 100000 0 a2;q2 min q1 a2;q3 */ q2 1 2;maxAdj1 */ q3 h ss;a1 pin 0 adj1 maxAdj1;y1 */ ss a1 100000;y3 */ h a2 100000';

const PRESETS = {
  rect: ['', '', RECT],
  roundRect: ['adj 16667', 'a pin 0 adj 50000;x1 */ ss a 100000;x2 +- r 0 x1;y2 +- b 0 x1', ROUNDED],
  ellipse: ['', '', ELLIPSE],
  triangle: ['adj 50000', 'x2 */ w adj 100000', 'M l b|L x2 t|L r b|Z'],
  rtTriangle: ['', '', 'M l b|L l t|L r b|Z'],
  diamond: ['', '', 'M l vc|L hc t|L r vc|L hc b|Z'],
  parallelogram: ['adj 25000', 'maxAdj */ 100000 w ss;a pin 0 adj maxAdj;x2 */ ss a 100000;x6 +- r 0 x2', 'M l b|L x2 t|L r t|L x6 b|Z'],
  trapezoid: ['adj 25000', 'maxAdj */ 50000 w ss;a pin 0 adj maxAdj;x2 */ ss a 100000;x3 +- r 0 x2', 'M l b|L x2 t|L x3 t|L r b|Z'],
  pentagon: ['', 'swd2 */ wd2 105146 100000;shd2 */ hd2 110557 100000;svc */ vc 110557 100000;dx1 cos swd2 1080000;dx2 cos swd2 18360000;dy1 sin shd2 1080000;dy2 sin shd2 18360000;x1 +- hc dx1 0;x2 +- hc dx2 0;x3 +- hc 0 dx2;x4 +- hc 0 dx1;y1 +- svc 0 dy1;y2 +- svc 0 dy2', 'M x1 y1|L hc t|L x4 y1|L x3 y2|L x2 y2|Z'],
  hexagon: ['adj 25000;vf 115470', 'maxAdj */ 50000 w ss;a pin 0 adj maxAdj;shd2 */ hd2 vf 100000;x1 */ ss a 100000;x2 +- r 0 x1;dy1 sin shd2 3600000;y1 +- vc 0 dy1;y2 +- vc dy1 0', 'M l vc|L x1 y1|L x2 y1|L r vc|L x2 y2|L x1 y2|Z'],
  octagon: ['adj 29289', 'a pin 0 adj 50000;x1 */ ss a 100000;x2 +- r 0 x1;y2 +- b 0 x1', 'M l x1|L x1 t|L x2 t|L r x1|L r y2|L x2 b|L x1 b|L l y2|Z'],
  plus: ['adj 25000', 'a pin 0 adj 50000;x1 */ ss a 100000;x2 +- r 0 x1;y2 +- b 0 x1', 'M l x1|L x1 x1|L x1 t|L x2 t|L x2 x1|L r x1|L r y2|L x2 y2|L x2 b|L x1 b|L x1 y2|L l y2|Z'],
  donut: ['adj 25000', 'a pin 0 adj 50000;dr */ ss a 100000;iwd2 +- wd2 0 dr;ihd2 +- hd2 0 dr', `${ELLIPSE}|M dr vc|A iwd2 ihd2 cd2 -5400000|A iwd2 ihd2 cd4 -5400000|A iwd2 ihd2 0 -5400000|A iwd2 ihd2 3cd4 -5400000|Z`],
  arc: ['adj1 16200000;adj2 0', ARC_GUIDES, 'x>M x1 y1|A wd2 hd2 stAng swAng|L hc vc|Z', 'n>M x1 y1|A wd2 hd2 stAng swAng'],
  pie: ['adj1 0;adj2 16200000', ARC_GUIDES, 'M x1 y1|A wd2 hd2 stAng swAng|L hc vc|Z'],
  chord: ['adj1 2700000;adj2 16200000', ARC_GUIDES, 'M x1 y1|A wd2 hd2 stAng swAng|Z'],

  // braces and brackets
  rightBrace: ['adj1 8333;adj2 50000', `${BRACE_GUIDES};y2 +- y3 0 y1;y4 +- b 0 y1`, `x>${BRACE_R}|Z`, `n>${BRACE_R}`],
  leftBrace: ['adj1 8333;adj2 50000', `${BRACE_GUIDES};y4 +- y3 y1 0`, `x>${BRACE_L}|Z`, `n>${BRACE_L}`],
  rightBracket: ['adj 8333', 'a pin 0 adj 50000;y1 */ ss a 100000;y2 +- b 0 y1', 'x>M l t|A w y1 3cd4 cd4|L r y2|A w y1 0 cd4|L l b|Z', 'n>M l t|A w y1 3cd4 cd4|L r y2|A w y1 0 cd4|L l b'],
  leftBracket: ['adj 8333', 'a pin 0 adj 50000;y1 */ ss a 100000;y2 +- b 0 y1', 'x>M r b|A w y1 cd4 cd4|L l y1|A w y1 cd2 cd4|L r t|Z', 'n>M r b|A w y1 cd4 cd4|L l y1|A w y1 cd2 cd4|L r t'],
  bracePair: ['adj 8333', 'a pin 0 adj 25000;x1 */ ss a 100000;x2 */ ss a 50000;x3 +- r 0 x2;x4 +- r 0 x1;y2 +- vc 0 x1;y3 +- vc x1 0;y4 +- b 0 x1', `x>${PAIR_BRACES}|Z`, `n>${PAIR_BRACES_OPEN}`],
  bracketPair: ['adj 16667', 'a pin 0 adj 50000;x1 */ ss a 100000;x2 +- r 0 x1;y2 +- b 0 x1', `x>${ROUNDED}`, 'n>M x1 b|A x1 x1 cd4 cd4|L l x1|A x1 x1 cd2 cd4|M x2 t|A x1 x1 3cd4 cd4|L r y2|A x1 x1 0 cd4'],

  // arrows
  rightArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 100000 w ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;dx1 */ ss a2 100000;x1 +- r 0 dx1;dy1 */ h a1 200000;y1 +- vc 0 dy1;y2 +- vc dy1 0', 'M l y1|L x1 y1|L x1 t|L r vc|L x1 b|L x1 y2|L l y2|Z'],
  leftArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 100000 w ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;dx2 */ ss a2 100000;x2 +- l dx2 0;dy1 */ h a1 200000;y1 +- vc 0 dy1;y2 +- vc dy1 0', 'M l vc|L x2 t|L x2 y1|L r y1|L r y2|L x2 y2|L x2 b|Z'],
  upArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 100000 h ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;dy2 */ ss a2 100000;y2 +- t dy2 0;dx1 */ w a1 200000;x1 +- hc 0 dx1;x2 +- hc dx1 0', 'M l y2|L hc t|L r y2|L x2 y2|L x2 b|L x1 b|L x1 y2|Z'],
  downArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 100000 h ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;dy1 */ ss a2 100000;y2 +- b 0 dy1;dx1 */ w a1 200000;x1 +- hc 0 dx1;x2 +- hc dx1 0', 'M l y2|L x1 y2|L x1 t|L x2 t|L x2 y2|L r y2|L hc b|Z'],
  leftRightArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 50000 w ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;x2 */ ss a2 100000;x3 +- r 0 x2;dy */ h a1 200000;y1 +- vc 0 dy;y2 +- vc dy 0', 'M l vc|L x2 t|L x2 y1|L x3 y1|L x3 t|L r vc|L x3 b|L x3 y2|L x2 y2|L x2 b|Z'],
  upDownArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 50000 h ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;y2 */ ss a2 100000;y3 +- b 0 y2;dx1 */ w a1 200000;x1 +- hc 0 dx1;x2 +- hc dx1 0', 'M hc t|L r y2|L x2 y2|L x2 y3|L r y3|L hc b|L l y3|L x1 y3|L x1 y2|L l y2|Z'],
  notchedRightArrow: ['adj1 50000;adj2 50000', 'maxAdj2 */ 100000 w ss;a1 pin 0 adj1 100000;a2 pin 0 adj2 maxAdj2;dx2 */ ss a2 100000;x2 +- r 0 dx2;dy1 */ h a1 200000;y1 +- vc 0 dy1;y2 +- vc dy1 0;x1 */ dy1 dx2 hd2', 'M l y1|L x2 y1|L x2 t|L r vc|L x2 b|L x2 y2|L l y2|L x1 vc|Z'],
  chevron: ['adj 50000', 'maxAdj */ 100000 w ss;a pin 0 adj maxAdj;x1 */ ss a 100000;x2 +- r 0 x1', 'M l t|L x2 t|L r vc|L x2 b|L l b|L x1 vc|Z'],
  homePlate: ['adj 50000', 'maxAdj */ 100000 w ss;a pin 0 adj maxAdj;dx1 */ ss a 100000;x1 +- r 0 dx1', 'M l t|L x1 t|L r vc|L x1 b|L l b|Z'],
  bentArrow: ['adj1 25000;adj2 25000;adj3 25000;adj4 43750', 'a2 pin 0 adj2 50000;maxAdj1 */ a2 2 1;a1 pin 0 adj1 maxAdj1;a3 pin 0 adj3 50000;th */ ss a1 100000;aw2 */ ss a2 100000;th2 */ th 1 2;dh2 +- aw2 0 th2;ah */ ss a3 100000;bw +- r 0 ah;bh +- b 0 dh2;bs min bw bh;maxAdj4 */ 100000 bs ss;a4 pin 0 adj4 maxAdj4;bd */ ss a4 100000;bd3 +- bd 0 th;bd2 max bd3 0;x3 +- th bd2 0;x4 +- r 0 ah;y3 +- dh2 th 0;y4 +- y3 dh2 0;y5 +- dh2 bd 0;y6 +- y3 bd2 0', 'M l b|L l y5|A bd bd cd2 cd4|L x4 dh2|L x4 t|L r aw2|L x4 y4|L x4 y3|L x3 y3|A bd2 bd2 3cd4 -5400000|L th b|Z'],

  // rounded and snipped rectangles
  round1Rect: ['adj 16667', 'a pin 0 adj 50000;dx1 */ ss a 100000;x1 +- r 0 dx1', 'M l t|L x1 t|A dx1 dx1 3cd4 cd4|L r b|L l b|Z'],
  round2SameRect: ['adj1 16667;adj2 0', 'a1 pin 0 adj1 50000;a2 pin 0 adj2 50000;tx1 */ ss a1 100000;tx2 +- r 0 tx1;bx1 */ ss a2 100000;by1 +- b 0 bx1', 'M tx1 t|L tx2 t|A tx1 tx1 3cd4 cd4|L r by1|A bx1 bx1 0 cd4|L bx1 b|A bx1 bx1 cd4 cd4|L l tx1|A tx1 tx1 cd2 cd4|Z'],
  snip1Rect: ['adj 16667', 'a pin 0 adj 50000;dx1 */ ss a 100000;x1 +- r 0 dx1', 'M l t|L x1 t|L r dx1|L r b|L l b|Z'],
  snip2SameRect: ['adj1 16667;adj2 0', 'a1 pin 0 adj1 50000;a2 pin 0 adj2 50000;tx1 */ ss a1 100000;tx2 +- r 0 tx1;bx1 */ ss a2 100000;bx2 +- r 0 bx1;by1 +- b 0 bx1', 'M tx1 t|L tx2 t|L r tx1|L r by1|L bx2 b|L bx1 b|L l by1|L l tx1|Z'],

  // blocks and math
  can: ['adj 25000', 'maxAdj */ 50000 h ss;a pin 0 adj maxAdj;y1 */ ss a 200000;y3 +- b 0 y1', 'x>M l y1|A wd2 y1 cd2 cd4|A wd2 y1 3cd4 cd4|L r y3|A wd2 y1 0 cd4|A wd2 y1 cd4 cd4|Z', 'Lx>M l y1|A wd2 y1 cd2 cd4|A wd2 y1 3cd4 cd4|A wd2 y1 0 cd4|A wd2 y1 cd4 cd4|Z', 'n>M r y1|L r y3|A wd2 y1 0 cd4|A wd2 y1 cd4 cd4|L l y1|A wd2 y1 cd2 -5400000|A wd2 y1 cd4 -5400000'],
  cube: ['adj 25000', 'a pin 0 adj 100000;y1 */ ss a 100000;y4 +- b 0 y1;x4 +- r 0 y1', 'x>M l y1|L x4 y1|L x4 b|L l b|Z', 'Dx>M x4 y1|L r t|L r y4|L x4 b|Z', 'Lx>M l y1|L y1 t|L r t|L x4 y1|Z', 'n>M l y1|L y1 t|L r t|L r y4|L x4 b|L l b|Z|M l y1|L x4 y1|L r t|M x4 y1|L x4 b'],
  mathMinus: ['adj1 23520', 'a1 pin 0 adj1 100000;dy1 */ h a1 200000;dx1 */ w 73490 200000;y1 +- vc 0 dy1;y2 +- vc dy1 0;x1 +- hc 0 dx1;x2 +- hc dx1 0', 'M x1 y1|L x2 y1|L x2 y2|L x1 y2|Z'],
  mathPlus: ['adj1 23520', 'a1 pin 0 adj1 73490;dx1 */ w 73490 200000;dy1 */ h 73490 200000;dx2 */ ss a1 200000;x1 +- hc 0 dx1;x2 +- hc 0 dx2;x3 +- hc dx2 0;x4 +- hc dx1 0;y1 +- vc 0 dy1;y2 +- vc 0 dx2;y3 +- vc dx2 0;y4 +- vc dy1 0', 'M x1 y2|L x2 y2|L x2 y1|L x3 y1|L x3 y2|L x4 y2|L x4 y3|L x3 y3|L x3 y4|L x2 y4|L x2 y3|L x1 y3|Z'],
  mathEqual: ['adj1 23520;adj2 11760', 'a1 pin 0 adj1 36745;m2 */ a1 2 1;mA2 +- 100000 0 m2;a2 pin 0 adj2 mA2;dy1 */ h a1 100000;dy2 */ h a2 200000;dx1 */ w 73490 200000;y2 +- vc 0 dy2;y3 +- vc dy2 0;y1 +- y2 0 dy1;y4 +- y3 dy1 0;x1 +- hc 0 dx1;x2 +- hc dx1 0', 'M x1 y1|L x2 y1|L x2 y2|L x1 y2|Z|M x1 y3|L x2 y3|L x2 y4|L x1 y4|Z'],

  // flow chart
  flowChartProcess: ['', '', RECT],
  flowChartDecision: ['', '', 'M l vc|L hc t|L r vc|L hc b|Z'],
  flowChartConnector: ['', '', ELLIPSE],
  flowChartAlternateProcess: ['', 'x1 */ ss 1 6;x2 +- r 0 x1;y2 +- b 0 x1', ROUNDED],
  flowChartTerminator: ['', 'rr */ h 1 2;x2 +- r 0 rr', 'M l rr|A rr rr cd2 cd4|L x2 t|A rr rr 3cd4 cd4|A rr rr 0 cd4|L rr b|A rr rr cd4 cd4|Z'],
  flowChartInputOutput: ['', 'x1 */ w 1 5;x2 */ w 4 5', 'M l b|L x1 t|L r t|L x2 b|Z'],
  flowChartPredefinedProcess: ['', 'x2 */ w 7 8;x1 */ w 1 8', `x>${RECT}`, 'n>M x1 t|L x1 b|M x2 t|L x2 b'],
  flowChartManualOperation: ['', 'x1 */ w 1 5;x2 */ w 4 5', 'M l t|L r t|L x2 b|L x1 b|Z'],
  flowChartPreparation: ['', 'x1 */ w 1 5;x2 */ w 4 5', 'M l vc|L x1 t|L x2 t|L r vc|L x2 b|L x1 b|Z'],

  // lines and connectors: open paths, so their ends can carry arrowheads
  line: ['', '', 'n>M l t|L r b'],
  straightConnector1: ['', '', 'n>M l t|L r b'],
  bentConnector2: ['', '', 'n>M l t|L r t|L r b'],
  bentConnector3: ['adj1 50000', 'x1 */ w adj1 100000', 'n>M l t|L x1 t|L x1 b|L r b'],
  bentConnector4: ['adj1 50000;adj2 50000', 'x1 */ w adj1 100000;y2 */ h adj2 100000', 'n>M l t|L x1 t|L x1 y2|L r y2|L r b'],
  bentConnector5: ['adj1 50000;adj2 50000;adj3 50000', 'x1 */ w adj1 100000;x3 */ w adj3 100000;y2 */ h adj2 100000', 'n>M l t|L x1 t|L x1 y2|L x3 y2|L x3 b|L r b'],
  curvedConnector2: ['', '', 'n>M l t|C wd2 t r hd2 r b'],
  curvedConnector3: ['adj1 50000', 'x2 */ w adj1 100000;x1 +/ l x2 2;x3 +/ r x2 2;y3 */ h 3 4', 'n>M l t|C x1 t x2 hd4 x2 vc|C x2 y3 x3 b r b'],
  curvedConnector4: ['adj1 50000;adj2 50000', 'x2 */ w adj1 100000;x1 +/ l x2 2;x3 +/ r x2 2;x4 +/ x2 x3 2;x5 +/ x3 r 2;y4 */ h adj2 100000;y1 +/ t y4 2;y2 */ y1 1 2;y3 +/ y1 y4 2;y5 +/ b y4 2', 'n>M l t|C x1 t x2 y2 x2 y1|C x2 y3 x4 y4 x3 y4|C x5 y4 r y5 r b'],
  curvedConnector5: ['adj1 50000;adj2 50000;adj3 50000', 'x3 */ w adj1 100000;x6 */ w adj3 100000;x1 +/ x3 x6 2;x2 +/ l x3 2;x4 +/ x3 x1 2;x5 +/ x6 x1 2;x7 +/ x6 r 2;y4 */ h adj2 100000;y1 +/ t y4 2;y2 +/ t y1 2;y3 +/ y1 y4 2;y5 +/ b y4 2;y6 +/ y5 y4 2;y7 +/ y5 b 2', 'n>M l t|C x2 t x3 y2 x3 y1|C x3 y3 x4 y4 x1 y4|C x5 y4 x6 y6 x6 y5|C x6 y7 x7 b r b'],
};

// Stars: points, default inner radius (a share of the outer one), and the box factors hf and vf of the ECMA star shapes.
const STARS = { star4: [4, 12500, 100000, 100000], star5: [5, 19098, 105146, 110557], star6: [6, 28868, 115470, 100000], star8: [8, 37500, 100000, 100000], star10: [10, 42533, 105146, 100000], star12: [12, 37500, 100000, 100000], star16: [16, 37500, 100000, 100000], star24: [24, 37500, 100000, 100000], star32: [32, 37500, 100000, 100000] };
function starPath(name, w, h, adj) {
  const [n, dflt, hf, vf] = STARS[name];
  const a = Math.max(0, Math.min(50000, Number.isFinite(adj) ? adj : dflt)) / 50000;
  const rx = (w / 2) * (hf / 100000); const ry = (h / 2) * (vf / 100000);
  const cx = w / 2; const cy = name === 'star5' ? ry : h / 2;
  const cmds = [];
  for (let i = 0; i < n * 2; i++) {
    const ang = (-90 + i * (180 / n)) * (Math.PI / 180);
    const k = i % 2 ? a : 1;
    cmds.push([i ? 'L' : 'M', String(cx + rx * k * Math.cos(ang)), String(cy + ry * k * Math.sin(ang))]);
  }
  cmds.push(['Z']);
  return { cmds, fill: 'norm', stroke: true };
}

// ---- reading a preset's text (once each) ----
const parsed = new Map();
const FILLS = { n: 'none', L: 'lightenLess', l: 'lighten', D: 'darkenLess', d: 'darken' };
function readPreset(name) {
  if (parsed.has(name)) return parsed.get(name);
  const src = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : null;
  let def = null;
  if (src) {
    def = {
      av: src[0] ? src[0].split(';').map((s) => s.trim().split(/\s+/)) : [],
      gd: src[1] ? src[1].split(';').map((s) => { const i = s.indexOf(' '); return [s.slice(0, i), s.slice(i + 1)]; }) : [],
      paths: src.slice(2).map((s) => {
        const m = /^([nxlLdD]*)>/.exec(s);
        const flags = m ? m[1] : '';
        const fill = [...flags].map((f) => FILLS[f]).find(Boolean) || 'norm';
        return { cmds: (m ? s.slice(m[0].length) : s).split('|').map((c) => c.trim().split(/\s+/)), fill, stroke: !flags.includes('x') };
      }),
    };
  }
  parsed.set(name, def);
  return def;
}
const has = (name) => Object.prototype.hasOwnProperty.call(PRESETS, name) || Object.prototype.hasOwnProperty.call(STARS, name);
const warned = new Set();
function unknownPreset(name) {
  const clean = String(name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  if (warned.size >= 200 || warned.has(clean)) return;
  warned.add(clean);
  console.warn(`[pptx] the shape "${clean}" is not drawn yet: shown as its bounding box`);
}

// ---- the result for one shape ----
// spec: { prst, av: { name: value } } for a preset, or { cust } (from readCustom). w, h: the shape's size in EMU.
// Returns { paths: [{ d, fill: 'norm' | 'none' | 'lighten' | ..., stroke }], start, end } in points, or null (nothing to draw / unknown).
// start and end: the first and last point of an open outline with the direction the line travels there (for arrowheads), else null.
function shapeGeometry(spec, w, h) {
  w = Math.max(0, w); h = Math.max(0, h);
  const budget = { left: MAX_COMMANDS };
  let built;
  if (!spec.cust && Object.prototype.hasOwnProperty.call(STARS, spec.prst)) {
    const p = starPath(spec.prst, w, h, spec.av && spec.av.adj);
    built = [{ fill: p.fill, stroke: p.stroke, cmds: buildPath(p, {}, 1, 1, budget) }];
  } else {
    const def = spec.cust || readPreset(spec.prst);
    if (!def) { unknownPreset(spec.prst); return null; }
    const env = builtins(w, h);
    const given = spec.av || {};
    for (const [name, dflt] of def.av) env[name] = Object.prototype.hasOwnProperty.call(given, name) ? fin(given[name]) : fin(Number(dflt));
    runGuides(def.gd, env);
    built = def.paths.map((p) => ({ fill: p.fill, stroke: p.stroke, cmds: buildPath(p, env, p.w > 0 ? w / p.w : 1, p.h > 0 ? h / p.h : 1, budget) }));
  }
  built = built.filter((p) => p.cmds.some((c) => c[0] !== 'M' && c[0] !== 'Z'));
  if (!built.length) return null;
  const ends = outlineEnds(built);
  return { paths: built.map((p) => ({ d: toD(p.cmds), fill: p.fill, stroke: p.stroke })), start: ends ? ends.start : null, end: ends ? ends.end : null };
}

// The two ends of the last path that is stroked and open (no close command).
function outlineEnds(paths) {
  for (let k = paths.length - 1; k >= 0; k--) {
    const p = paths[k];
    if (!p.stroke || p.cmds.some((c) => c[0] === 'Z')) continue;
    // Points along the path, control points included: a curve leaves its start toward its first control point.
    const pts = [];
    for (const [, ...n] of p.cmds) for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
    if (pts.length < 2) continue;
    const apart = (from, list) => list.find((q) => Math.hypot(q.x - from.x, q.y - from.y) > 1e-6);
    const first = pts[0]; const last = pts[pts.length - 1];
    const next = apart(first, pts.slice(1)); const prev = apart(last, pts.slice(0, -1).reverse());
    if (!next || !prev) continue;
    const unit = (a, b) => { const d = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { dx: (b.x - a.x) / d, dy: (b.y - a.y) / d }; };
    return { start: { x: first.x, y: first.y, ...unit(next, first) }, end: { x: last.x, y: last.y, ...unit(prev, last) } };
  }
  return null;
}

// ---- custom geometry from the XML (a:custGeom) ----
// `kid`, `kids`, `num`: pptx.js's tree helpers. Returns { av, gd, paths } for shapeGeometry, or null.
function readCustom(cust, { kid, kids, num }) {
  const av = [];
  const gd = [];
  for (const g of kids(kid(cust, 'avLst'), 'gd')) {
    const f = String(g.attrs.fmla || '');
    const m = /^val\s+(-?\d+(?:\.\d+)?)$/.exec(f);
    if (g.attrs.name && m) av.push([g.attrs.name, m[1]]); else if (g.attrs.name && f) gd.push([g.attrs.name, f]);
  }
  for (const g of kids(kid(cust, 'gdLst'), 'gd')) if (g.attrs.name && g.attrs.fmla) gd.push([g.attrs.name, String(g.attrs.fmla)]);
  const pt = (n) => [String(n ? n.attrs.x ?? 0 : 0), String(n ? n.attrs.y ?? 0 : 0)];
  const paths = [];
  let total = 0;
  for (const p of kids(kid(cust, 'pathLst'), 'path').slice(0, MAX_PATHS)) {
    const cmds = [];
    for (const c of p.children) {
      if (++total > MAX_COMMANDS) break;
      const pts = kids(c, 'pt');
      if (c.name === 'moveTo' && pts[0]) cmds.push(['M', ...pt(pts[0])]);
      else if (c.name === 'lnTo' && pts[0]) cmds.push(['L', ...pt(pts[0])]);
      else if (c.name === 'quadBezTo' && pts[1]) cmds.push(['Q', ...pt(pts[0]), ...pt(pts[1])]);
      else if (c.name === 'cubicBezTo' && pts[2]) cmds.push(['C', ...pt(pts[0]), ...pt(pts[1]), ...pt(pts[2])]);
      else if (c.name === 'arcTo') cmds.push(['A', String(c.attrs.wR ?? 0), String(c.attrs.hR ?? 0), String(c.attrs.stAng ?? 0), String(c.attrs.swAng ?? 0)]);
      else if (c.name === 'close') cmds.push(['Z']);
    }
    if (!cmds.length) continue;
    const fill = p.attrs.fill || 'norm';
    paths.push({ cmds, w: Math.max(0, num(p.attrs.w, 0)), h: Math.max(0, num(p.attrs.h, 0)), fill: ['none', 'lighten', 'lightenLess', 'darken', 'darkenLess'].includes(fill) ? fill : 'norm', stroke: p.attrs.stroke !== '0' && p.attrs.stroke !== 'false' });
  }
  return paths.length ? { av, gd, paths } : null;
}

// ---- arrowheads (a:headEnd / a:tailEnd: type, w, len) ----
// `end`: { x, y, dx, dy } from shapeGeometry (points; dx, dy is the direction the line travels there). `line`: { width (points), head, tail, headW, headLen, ... }.
// Returns { d, fill } (fill false: an open arrow, stroked), or null.
const SIZES = { sm: 2, med: 3, lg: 5 };
function arrowhead(end, line, which) {
  const type = line[which];
  if (!end || !type || type === 'none') return null;
  const lw = Math.max(Number(line.width) || 0.75, 2);
  const wide = lw * (SIZES[line[`${which}W`]] || 3);
  const long = lw * (SIZES[line[`${which}Len`]] || 3);
  const ux = end.dx; const uy = end.dy; // pointing out of the line at this end
  const px = -uy; const py = ux;
  const at = (a, b) => [end.x - ux * a + px * b, end.y - uy * a + py * b];
  const poly = (list, close) => `${list.map(([x, y], i) => `${i ? 'L' : 'M'}${num2(x)} ${num2(y)}`).join('')}${close ? 'Z' : ''}`;
  if (type === 'triangle') return { d: poly([at(0, 0), at(long, wide / 2), at(long, -wide / 2)], true), fill: true };
  if (type === 'stealth') return { d: poly([at(0, 0), at(long, wide / 2), at(long * 0.65, 0), at(long, -wide / 2)], true), fill: true };
  if (type === 'diamond') return { d: poly([at(0, 0), at(long / 2, wide / 2), at(long, 0), at(long / 2, -wide / 2)], true), fill: true };
  if (type === 'arrow') return { d: poly([at(long, wide / 2), at(0, 0), at(long, -wide / 2)], false), fill: false };
  if (type === 'oval') {
    const k = 0.5523; const rx = long / 2; const ry = wide / 2;
    const P = (a, b) => at(long / 2 - a, b); // a along the line from the oval's center, b across it
    const f = (...pts) => pts.map(([x, y]) => `${num2(x)} ${num2(y)}`).join(' ');
    return { d: `M${f(P(rx, 0))}C${f(P(rx, ry * k), P(rx * k, ry), P(0, ry))}C${f(P(-rx * k, ry), P(-rx, ry * k), P(-rx, 0))}C${f(P(-rx, -ry * k), P(-rx * k, -ry), P(0, -ry))}C${f(P(rx * k, -ry), P(rx, -ry * k), P(rx, 0))}Z`, fill: true };
  }
  return null;
}

module.exports = { shapeGeometry, readCustom, arrowhead, has, unknownPreset, STARS };

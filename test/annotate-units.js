// The annotate tool (ai/annotate.js): the AI draws on the page to explain it. Plain Node: argument checks and caps, screenshot
// -> page coordinate math, the overlay builder against a fake DOM (every mark type, live tracking of elements and scroll, clear,
// navigation, Esc), the PDF viewer's page space, the path choice, the tool lists, MCP exposure and the prompt budgets.
const fs = require('fs');
const path = require('path');
const annotate = require('../src/ai/annotate');
const { Agent, EXTERNAL_TOOLS, validateInput } = require('../src/ai/agent');
const mcp = require('../src/automation/mcp');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };

// ---------------------------------------------------------------- arguments
{
  const n = annotate.normalize({ marks: [{ type: 'box', target: '12' }, { type: 'arrow', target: '[3]', to: { target: 'text:Buy now' } }, { type: 'highlight', target: 'text:  two   words ' }, { type: 'label', target: '#7', text: 'hi' }] });
  check('normalize: element ids ("12", "[3]", "#7") and text: targets', J(n.marks.map((m) => m.at)) === J([{ ref: 12 }, { ref: 3 }, { text: 'two words' }, { ref: 7 }]) && J(n.marks[1].to) === J({ text: 'Buy now' }), J(n.marks));
  check('normalize: knows what it uses (to pick the path)', n.usesRefs && n.usesText && !n.usesBox);
}
check('normalize: a mark needs a known type, a location, a palette colour', /marks\[0\]: type must be one of/.test(throws(() => annotate.normalize({ marks: [{ type: 'star', target: '1' }] }))) && /marks\[1\]: say where/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: '1' }, { type: 'box' }] }))) && /color must be one of/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: '1', color: 'red; background:url(x)' }] }))));
check('normalize: a bad target is refused with the way to give one', /target must be an element id/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: 'button.save' }] }))) && /target must be an element id/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: '0' }] }))) && /target must be an element id/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: 'text:' }] }))));
check('normalize: nothing to do is an error; clear alone is fine', /Give marks to draw/.test(throws(() => annotate.normalize({}))) && annotate.normalize({ clear: true }).clear === true && annotate.normalize({ clear: true }).marks.length === 0);
{
  const many = { marks: Array.from({ length: 27 }, () => ({ type: 'box', target: '1' })) };
  const n = annotate.normalize(many);
  check('caps: at most 20 marks per call, the rest counted', n.marks.length === annotate.MAX_MARKS && n.dropped === 7 && annotate.MAX_MARKS === 20, `${n.marks.length} ${n.dropped}`);
  const t = annotate.normalize({ marks: [{ type: 'label', target: '1', text: `${'x'.repeat(200)}\u0000\u0007 end` }] }).marks[0].text;
  check('caps: label text is cut to 80 characters and loses control characters', t.length <= annotate.MAX_TEXT && !/[\u0000-\u001f]/.test(t), String(t.length));
  const big = annotate.normalize({ marks: [{ type: 'box', x: 1e12, y: -1e12, w: 1e15, h: 5 }] }, { ratio: 1, zoom: 1 }).marks[0].at.box;
  check('caps: coordinates are clamped to a sane range', Math.abs(big.x) <= 20000 && Math.abs(big.y) <= 20000 && big.w <= 20000, J(big));
  check('caps: duration is until_dismissed (default) or 1..600 seconds', annotate.normalize({ marks: [{ type: 'box', target: '1' }], duration: 'until_dismissed' }).seconds === null && annotate.normalize({ marks: [{ type: 'box', target: '1' }], duration: '30' }).seconds === 30 && annotate.normalize({ marks: [{ type: 'box', target: '1' }], duration: '99999' }).seconds === 600 && /duration must be/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', target: '1' }], duration: 'forever' }))));
}
{
  const input = { marks: [{ type: 'box', target: 12, to: { target: 4 } }], duration: 20 };
  annotate.coerce(input);
  check('coerce: a numeric target (or duration) a model sends becomes a string, so the schema check passes', input.marks[0].target === '12' && input.marks[0].to.target === '4' && input.duration === '20' && validateInput('annotate', { marks: [{ type: 'box', target: 12 }] }) === null, String(validateInput('annotate', { marks: [{ type: 'box', target: 12 }] })));
  check('validate: bad type/colour are caught by the schema; marks or clear is needed', /one of/.test(validateInput('annotate', { marks: [{ type: 'star' }] }) || '') && /one of/.test(validateInput('annotate', { marks: [{ type: 'box', color: 'chartreuse' }] }) || '') && /Provide one of: marks, clear/.test(validateInput('annotate', {}) || '') && validateInput('annotate', { clear: true }) === null);
}

// ---------------------------------------------------------------- coordinates: screenshot px -> page CSS px
{
  // ratio = view width / screenshot width (it absorbs devicePixelRatio: a 1500 px capture of a 1000 DIP view is 1000/1500), zoom = the tab's zoom.
  check('math: dpr 1.5 capture (ratio 1000/1500): screenshot px -> view px', Math.abs(annotate.shotToCss(300, { ratio: 1000 / 1500, zoom: 1 }) - 200) < 1e-9);
  check('math: page zoom 1.25 divides (view px -> CSS px)', Math.abs(annotate.shotToCss(300, { ratio: 1, zoom: 1.25 }) - 240) < 1e-9);
  check('math: a downscaled screenshot (1280 px of a 1920 view): ratio 1.5', Math.abs(annotate.shotToCss(400, { ratio: 1.5, zoom: 1 }) - 600) < 1e-9);
  // Screenshot px -> CSS px for every device pixel ratio, page zoom, downscale and scroll. A tab whose window is 1000 x 700 DIPs at
  // zoom z shows (1000 x 700) CSS px at innerWidth = 1000 / z; the capture is 1000 * dpr px wide and is downscaled to <= 1280 (or 1024).
  {
    let bad = '';
    for (const dpr of [1, 1.25, 1.5, 2]) for (const zoom of [1, 1.25, 0.8]) for (const maxW of [1024, 1280, 5000]) for (const scrollY of [0, 640]) {
      const dipW = 1000, dipH = 700, cssW = dipW / zoom, cssH = dipH / zoom;
      let w = Math.round(dipW * dpr), h = Math.round(dipH * dpr);
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const scale = annotate.shotScaleOf({ innerWidth: cssW, innerHeight: cssH, scrollX: 0, scrollY }, { width: w, height: h }, zoom);
      // The element sits at CSS (300, 200) size 90 x 40 in the viewport; where it is in the screenshot:
      const px = { x: 300 * w / cssW, y: 200 * h / cssH, w: 90 * w / cssW, h: 40 * h / cssH };
      const mark = annotate.normalize({ marks: [{ type: 'box', ...px }] }, { ...scale, now: { x: 0, y: scrollY } }).marks[0].at.box;
      const near = (a, b) => Math.abs(a - b) < 1e-6;
      if (!(near(mark.x, 300) && near(mark.y, 200) && near(mark.w, 90) && near(mark.h, 40))) bad += ` dpr${dpr}/z${zoom}/w${maxW}/s${scrollY}:${J(mark)}`;
      // The page scrolled 120 px after the screenshot: the same spot is 120 px higher in the viewport now.
      const later = annotate.normalize({ marks: [{ type: 'box', ...px }] }, { ...scale, now: { x: 0, y: scrollY + 120 } }).marks[0].at.box;
      if (!near(later.y, 80) || !near(later.x, 300)) bad += ` scroll dpr${dpr}/z${zoom}:${J(later)}`;
    }
    check('math: right at DPR 1/1.25/1.5/2, page zoom 0.8/1/1.25, downscaled captures and scrolled pages', !bad, bad);
    // The zoom changing after the screenshot used to skew every mark (ratio had the old zoom in it, the live zoom divided again).
    const s = annotate.shotScaleOf({ innerWidth: 800, innerHeight: 560, scrollX: 0, scrollY: 0 }, { width: 1000, height: 700 }, 1.25);
    check('math: independent of the zoom at call time', Math.abs(annotate.normalize({ marks: [{ type: 'box', x: 500, y: 350 }] }, { ...s, zoom: 2 }).marks[0].at.box.x - 400) < 1e-9);
  }
  const m = annotate.normalize({ marks: [{ type: 'box', x: 300, y: 150, w: 90, h: 60 }, { type: 'step', x: 10, y: 20 }] }, { ratio: 2 / 3, zoom: 0.5 }).marks;
  check('math: x, y, w, h of a mark all go through the same mapping; a point has no size', J(m[0].at.box) === J({ x: 400, y: 200, w: 120, h: 80 }) && m[1].at.box.w === 0 && m[1].at.box.h === 0, J(m[0].at));
  check('math: coordinates without a screenshot are refused (take one first); element targets are not', /need a screenshot of this tab first/.test(throws(() => annotate.normalize({ marks: [{ type: 'box', x: 1, y: 2 }] }, null))) && annotate.normalize({ marks: [{ type: 'box', target: '3' }] }, null).marks.length === 1);
}

// ---------------------------------------------------------------- the overlay against a fake DOM
const { miniDom } = annotate;
const all = (node, pick, out = []) => { if (pick(node)) out.push(node); for (const c of node.children || []) all(c, pick, out); return out; };
const tags = (node, tag) => all(node, (n) => n.tagName === tag);
const draw = (marks, extra = {}) => {
  const spec = annotate.normalize({ marks }, { ratio: 1, zoom: 1 });
  const { document } = miniDom();
  return annotate.overlayMain({ marks: spec.marks, clear: false, static: { w: 800, h: 600 }, maxTotal: 30, ...extra }, { document, window: { innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0 }, space: { capture: (b) => ({ ...b }), locate: (t) => ({ ...t }) } });
};
const box = { x: 100, y: 200, w: 200, h: 60 };
{
  const r = draw([{ type: 'box', ...box }]);
  const paths = tags(r.svg, 'path');
  check('box: a halo path and a coloured path (hand-drawn, with pathLength for the stroke animation), from the red palette', paths.length === 2 && paths.every((p) => /^M/.test(p.attrs.d) && p.attrs.pathLength === '1' && p.attrs.fill === 'none') && paths[1].attrs.stroke === '#d92d20' && paths[0].attrs.stroke === '#ffffff' && Number(paths[0].attrs['stroke-width']) > Number(paths[1].attrs['stroke-width']), J(paths.map((p) => p.attrs.stroke)));
  const nums = paths[1].attrs.d.match(/-?\d+(\.\d+)?/g).map(Number);
  check('box: the outline surrounds the target box', Math.min(...nums.filter((_, i) => i % 2 === 0)) < 100 && Math.max(...nums.filter((_, i) => i % 2 === 0)) > 300 && Math.min(...nums.filter((_, i) => i % 2 === 1)) < 200 && Math.max(...nums.filter((_, i) => i % 2 === 1)) > 260);
}
{
  const r = draw([{ type: 'circle', ...box, color: 'purple' }]);
  const paths = tags(r.svg, 'path');
  check('circle: a closed-ish smooth curve in the chosen colour', paths.length === 2 && /C/.test(paths[1].attrs.d) && paths[1].attrs.stroke === '#7a3ff2');
}
{
  const r = draw([{ type: 'arrow', x: 50, y: 400, to: { x: 300, y: 250 } }]);
  const paths = tags(r.svg, 'path');
  check('arrow: a curved shaft and an arrowhead (each with a halo), the shaft ends at the tip', paths.length === 4 && /Q/.test(paths[1].attrs.d) && /^M[\d. ]+L[\d. ]+L/.test(paths[3].attrs.d) && /300 250$/.test(paths[1].attrs.d), J(paths.map((p) => p.attrs.d)));
}
{
  const r = draw([{ type: 'arrow', target: undefined, x: 100, y: 100, w: 50, h: 40, to: { x: 400, y: 100, w: 50, h: 40 } }]);
  const shaft = tags(r.svg, 'path')[1].attrs.d;
  const [sx] = shaft.match(/-?\d+(\.\d+)?/g).map(Number);
  const tip = shaft.match(/-?\d+(\.\d+)?/g).map(Number).slice(-2);
  check('arrow: between two boxes it leaves one edge and stops short of the other (not at the centres)', sx > 140 && sx < 165 && tip[0] > 380 && tip[0] < 410, shaft);
}
{
  const r = draw([{ type: 'highlight', ...box }]);
  const rect = tags(r.svg, 'rect')[0];
  check('highlight: a translucent yellow marker rectangle', rect.attrs.fill === '#f5c400' && Number(rect.attrs['fill-opacity']) < 0.6 && Number(rect.attrs.width) > 200, J(rect.attrs));
}
{
  const r = draw([{ type: 'label', ...box, text: 'Click this button to save your work in the cloud' }]);
  const text = tags(r.svg, 'text')[0];
  const spans = tags(text, 'tspan');
  check('label: a bubble, a pointer and wrapped text in tspans, via textContent', tags(r.svg, 'rect').length === 1 && tags(r.svg, 'path').length === 1 && spans.length >= 2 && spans.map((s) => s.textContent).join(' ') === 'Click this button to save your work in the cloud', spans.map((s) => s.textContent).join('|'));
}
{
  const evil = '<img src=x onerror=alert(1)>"&';
  const r = draw([{ type: 'label', ...box, text: evil }, { type: 'step', x: 5, y: 5, text: evil }]);
  const markup = r.svg.children.map(String).join('');
  check('security: label text is only ever text (escaped when serialized, no element is made from it)', !/<img/.test(markup) && /&lt;img/.test(markup) && all(r.svg, (n) => n.tagName === 'img').length === 0);
}
{
  const r = draw([{ type: 'step', ...box }, { type: 'step', x: 400, y: 300 }, { type: 'step', x: 500, y: 300, text: '7' }, { type: 'step', x: 600, y: 300, text: 'Then click Save' }]);
  const texts = tags(r.svg, 'text').map((t) => t.textContent);
  check('step: numbered badges that count up (1, 2), an explicit number is kept, a longer text becomes a note beside the badge', J(texts) === J(['1', '2', '7', '4', 'Then click Save']), J(texts));
  check('step: a disc with a white outline and the colour from the palette', tags(r.svg, 'circle')[0].attrs.fill === '#1a6ef0' && tags(r.svg, 'circle')[0].attrs.stroke === '#ffffff');
}
{
  const r = draw([{ type: 'spotlight', ...box, text: 'Look here' }]);
  const dim = tags(r.svg, 'path').find((p) => p.attrs['fill-rule'] === 'evenodd');
  check('spotlight: a dimming layer with a hole round the box, and a ring', dim && /^M0 0H800V600H0Z/.test(dim.attrs.d) && tags(r.svg, 'rect').some((x) => x.attrs.stroke === '#ffffff'), dim && dim.attrs.d);
  const two = draw([{ type: 'spotlight', ...box }, { type: 'spotlight', x: 10, y: 10, w: 50, h: 50 }]);
  check('spotlight: only one at a time (the newer replaces the older)', tags(two.svg, 'path').filter((p) => p.attrs['fill-rule'] === 'evenodd').length === 1 && two.drawn === 1);
}
{
  const r = draw([{ type: 'underline', ...box }]);
  const paths = tags(r.svg, 'path');
  const ys = paths[1].attrs.d.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 1);
  check('underline: a slightly wavy line just below the box', paths.length === 2 && ys.every((y) => y > 255 && y < 270), J(ys));
}
check('colour: contrast halos follow the colour (light colours get a dark halo), and every colour in the palette draws', annotate.COLORS.every((c) => draw([{ type: 'box', ...box, color: c }]).drawn === 1) && tags(draw([{ type: 'box', ...box, color: 'yellow' }]).svg, 'path')[0].attrs.stroke === '#000000' && tags(draw([{ type: 'box', ...box, color: 'red' }]).svg, 'path')[0].attrs.stroke === '#ffffff');
{
  const r = draw([{ type: 'box', ...box }, { type: 'circle', x: 1e6, y: 1e6, w: 10, h: 10 }, { type: 'label', x: 5, y: 5 }]);
  check('builder: a label with no text draws nothing and says so; the others still draw', r.drawn === 2 && r.missing.length === 1 && /label: nothing to draw/.test(r.missing[0]), J(r.missing));
}

// ---------------------------------------------------------------- live: tracking, scroll, clear, Esc, navigation
function liveEnv({ scrollY = 0, elements = [], texts = [] } = {}) {
  const { document, Node } = miniDom();
  const html = document.documentElement;
  html.clientWidth = 1000; html.clientHeight = 700;
  const handlers = {};
  const win = {
    innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY, location: { href: 'https://a.test/' },
    __claudeEls: elements.map((e) => ({ el: e, chain: [] })),
    addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { handlers[t] = (handlers[t] || []).filter((f) => f !== fn); },
    requestAnimationFrame: (fn) => fn(),
    matchMedia: () => ({ matches: false }),
  };
  document.elementFromPoint = () => null;
  document.querySelectorAll = () => [];
  document.createTreeWalker = () => { let i = -1; return { nextNode: () => texts[++i] || null }; };
  document.createRange = () => { const r = { setStart(n) { r.n = n; }, setEnd() {}, get startContainer() { return r.n; }, getClientRects: () => r.n.rects() }; return r; };
  html.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  return { document, win, handlers, Node };
}
const element = (rect) => ({ isConnected: true, rect, getBoundingClientRect() { const r = this.rect; return { left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h }; }, clientLeft: 0, clientTop: 0 });
const live = (env, marks, extra = {}) => {
  const spec = annotate.normalize({ marks, clear: extra.clear === true }, { ratio: 1, zoom: 1 });
  return annotate.overlayMain({ marks: spec.marks, clear: false, maxTotal: 30, ...extra }, { document: env.document, window: env.win });
};
const withTimers = (fn) => {
  const real = { si: global.setInterval, st: global.setTimeout, ci: global.clearInterval, ct: global.clearTimeout };
  const timers = [];
  global.setInterval = (f, ms) => { const t = { f, ms, interval: true }; timers.push(t); return t; };
  global.setTimeout = (f, ms) => { const t = { f, ms }; timers.push(t); return t; };
  global.clearInterval = (t) => { if (t) t.cleared = true; };
  global.clearTimeout = (t) => { if (t) t.cleared = true; };
  try { return fn(timers); } finally { Object.assign(global, { setInterval: real.si, setTimeout: real.st, clearInterval: real.ci, clearTimeout: real.ct }); }
};
const pathOf = (r, i = 1) => tags(r.svg, 'path')[i].attrs.d;
const firstNums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

withTimers((timers) => {
  const el = element({ x: 100, y: 300, w: 120, h: 40 });
  const env = liveEnv({ elements: [el] });
  const r = live(env, [{ type: 'highlight', target: '1' }]);
  const host = r.host;
  check('live: the overlay is a closed shadow root in a pointer-events:none, top-most fixed host', host.tagName === 'lumen-annotations' && /position:fixed/.test(host.style.cssText) && /pointer-events:none/.test(host.style.cssText) && /z-index:2147483647/.test(host.style.cssText) && host.shadow && env.document.documentElement.children.includes(host), host.style.cssText);
  const pill = host.shadow.children.find((c) => c.tagName === 'button');
  check('live: a "Clear drawings" pill is the one element that takes the mouse', pill && /pointer-events:auto/.test(pill.style.cssText) && /Clear drawings/.test(pill.textContent) && /pointer-events:none/.test(r.svg.style.cssText), pill && pill.style.cssText);
  const rect = () => tags(r.svg, 'rect')[0].attrs;
  check('live: an element target is drawn where the element is', Number(rect().x) < 100 && Number(rect().y) < 300 && Number(rect().width) > 120, J(rect()));
  el.rect = { x: 100, y: 250, w: 120, h: 40 };
  r.board.layout();
  check('live: when the element moves (scroll, layout), the mark follows', Number(rect().y) < 250 && Number(rect().y) > 240, J(rect()));
  el.isConnected = false;
  r.board.layout();
  check('live: when the element is gone the mark hides', rect().visibility === 'hidden');
  check('live: it re-lays out on scroll (captured, for inner scrollers too), resize and on a timer', env.handlers.scroll.length === 1 && env.handlers.resize.length === 1 && timers.some((t) => t.interval && t.ms <= 250), J(Object.keys(env.handlers)));
  r.board.destroy();
  check('live: clearing removes the host, the listeners and the timers', !env.document.documentElement.children.includes(host) && !env.handlers.scroll.length && !env.handlers.keydown.length && timers.filter((t) => t.interval).every((t) => t.cleared) && env.win.__lumenDraw === null, '');
});

withTimers(() => {
  const env = liveEnv({ scrollY: 100 });
  const r = live(env, [{ type: 'box', x: 100, y: 300, w: 80, h: 40 }]);
  const before = firstNums(pathOf(r));
  env.win.scrollY = 150;
  r.board.layout();
  const after = firstNums(pathOf(r));
  check('scroll offsets: a mark placed from a screenshot is anchored to the page where it was drawn (it moves up 50 when the page scrolls 50)', Math.abs(before[1] - after[1] - 50) < 6 && Math.abs(before[0] - after[0]) < 6, `${before[1]} -> ${after[1]}`);
  r.board.destroy();
});

withTimers(() => {
  const el = element({ x: 10, y: 10, w: 50, h: 20 });
  const env = liveEnv({ elements: [el] });
  const first = live(env, [{ type: 'box', target: '1' }]);
  const again = live(env, [{ type: 'circle', target: '1' }]);
  check('add: another call adds to the drawing (one host, both marks)', again.created === false && again.drawn === 2 && env.document.documentElement.children.filter((c) => c.tagName === 'lumen-annotations').length === 1);
  const replaced = live(env, [{ type: 'underline', target: '1' }], { clear: true });
  check('clear: clear:true wipes the old drawing first (a fresh host)', replaced.drawn === 1 && replaced.created === true && env.document.documentElement.children.filter((c) => c.tagName === 'lumen-annotations').length === 1 && first.board.alive === false);
  const cleared = live(env, [], { clear: true });
  check('clear: clear alone leaves nothing on the page', cleared.cleared === true && env.document.documentElement.children.length === 0 && env.win.__lumenDraw === null);
  const many = Array.from({ length: 12 }, () => ({ type: 'box', target: '1' }));
  live(env, many, { maxTotal: 30 }); live(env, many, { maxTotal: 30 }); const third = live(env, many, { maxTotal: 30 });
  check('cap: at most 30 marks stay on the page (the oldest go)', third.drawn === 30, String(third.drawn));
  third.board.destroy();
});

withTimers(() => {
  const el = element({ x: 10, y: 10, w: 50, h: 20 });
  const env = liveEnv({ elements: [el] });
  const r = live(env, [{ type: 'box', target: '1' }]);
  env.handlers.keydown[0]({ key: 'a' });
  check('Esc: other keys leave it', r.board.alive === true);
  env.handlers.keydown[0]({ key: 'Escape' });
  check('Esc: clears the drawing (the page still gets the key)', r.board.alive === false && !env.document.documentElement.children.length);
});

withTimers((timers) => {
  const el = element({ x: 10, y: 10, w: 50, h: 20 });
  const env = liveEnv({ elements: [el] });
  const r = live(env, [{ type: 'box', target: '1' }]);
  const tick = timers.find((t) => t.interval).f;
  tick();
  check('navigation: the same page keeps its drawing', r.board.alive === true);
  env.win.location.href = 'https://a.test/other';
  tick();
  check('persist: a single-page route change does not clear it (a full navigation drops the page world with it)', r.board.alive === true);
  for (let i = 0; i < 20; i++) tick();
  check('persist: it stays through many layout ticks and no timer ends it', r.board.alive === true && !timers.some((t) => !t.interval));
  env.document.documentElement.children.length = 0; r.host.isConnected = false; r.host.parentNode = null; // the page's own script removed it
  tick();
  check('persist: the host is put back when the page removes it', r.board.alive === true && env.document.documentElement.children.includes(r.host));
  env.handlers.keydown[0]({ key: 'Escape' });
  check('persist: only Esc ends it', r.board.alive === false);
});

withTimers((timers) => {
  const env = liveEnv({ elements: [element({ x: 10, y: 10, w: 50, h: 20 })] });
  const r = live(env, [{ type: 'box', target: '1' }], { seconds: 5 });
  const t = timers.find((x) => !x.interval && x.ms === 5000);
  check('duration: a number of seconds schedules the clear', Boolean(t));
  t.f();
  check('duration: and it clears', r.board.alive === false);
});

withTimers(() => {
  // text targets: the first match inside the viewport wins; the rects follow the text
  const mk = (data, y, parentName = 'P') => { const n = { data, nodeName: '#text', parentNode: { nodeName: parentName, isConnected: true, scrollIntoView() {} }, isConnected: true, y }; n.rects = () => [{ left: 20, top: n.y, width: 100, height: 18, right: 120, bottom: n.y + 18 }]; return n; };
  const offscreen = mk('Revenue grew', 2000);
  const hidden = mk('Revenue grew', 50, 'SCRIPT');
  const visible = mk('The revenue   grew a lot', 120);
  const env = liveEnv({ texts: [hidden, offscreen, visible] });
  const r = live(env, [{ type: 'highlight', target: 'text:revenue grew' }]);
  const rect = () => tags(r.svg, 'rect')[0].attrs;
  check('text: matches ignoring case and spacing, skips script text, and prefers the match on screen', r.drawn === 1 && Number(rect().y) > 100 && Number(rect().y) < 125, J(rect()));
  visible.y = 200; r.board.layout();
  check('text: the highlight follows the text', Number(rect().y) > 190 && Number(rect().y) < 205, J(rect()));
  const none = live(env, [{ type: 'box', target: 'text:never on this page' }]);
  check('text: a text that is not there is reported, not drawn', none.drawn === 1 && none.missing.length === 1 && /no visible text "never on this page"/.test(none.missing[0]), J(none.missing));
  r.board.destroy();
});

withTimers(() => {
  const env = liveEnv({ elements: [] });
  const r = live(env, [{ type: 'box', target: '9' }]);
  check('ref: an element id that is not in the registry is reported with the fix', r.drawn === 0 && /element 9 is gone or not visible \(read_page \/ find again\)/.test(r.missing[0]), J(r.missing));
  if (r.board) r.board.destroy();
});

// ---- the PDF viewer's space: page number + fractions of the page's box, so marks follow scroll and zoom
{
  const pages = [{ n: 1, r: { left: 100, top: 0, width: 600, height: 800 } }, { n: 2, r: { left: 100, top: 820, width: 600, height: 800 } }].map((p) => ({ dataset: { pageNumber: String(p.n) }, r: p.r, getBoundingClientRect() { const r = this.r; return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height }; }, scrollIntoView() { this.revealed = true; } }));
  const container = { getBoundingClientRect: () => ({ left: 0, top: 48 }), clientWidth: 1000, clientHeight: 650 };
  const doc = { querySelectorAll: () => pages, querySelector: (s) => pages.find((p) => s.includes(`"${p.dataset.pageNumber}"`)) || null, getElementById: (id) => (id === 'viewerContainer' ? container : null) };
  const space = annotate.viewerSpace({}, doc);
  const tok = space.capture({ x: 250, y: 900, w: 120, h: 40 }); // on page 2: 150 px across, 80 px down
  check('pdf viewer space: a box is kept as page 2 with fractions of the page', tok.page === 2 && Math.abs(tok.fx - 0.25) < 1e-9 && Math.abs(tok.fy - 0.1) < 1e-9 && Math.abs(tok.fw - 0.2) < 1e-9, J(tok));
  pages.forEach((p) => { p.r = { ...p.r, top: p.r.top - 300 }; });
  const scrolled = space.locate(tok);
  check('pdf viewer space: scrolling moves it with the page', Math.abs(scrolled.x - 250) < 1e-9 && Math.abs(scrolled.y - 600) < 1e-9, J(scrolled));
  pages.forEach((p) => { p.r = { left: 0, top: p.r.top * 2, width: 1200, height: 1600 }; });
  const zoomed = space.locate(tok);
  check('pdf viewer space: zooming scales position and size with the page', Math.abs(zoomed.w - 240) < 1e-9 && Math.abs(zoomed.x - 300) < 1e-9, J(zoomed));
  check('pdf viewer space: marks are clipped to the scroller (the viewer\'s toolbar stays clear), and a page that is gone hides the mark', J(space.clip()) === J({ x: 0, y: 48, w: 1000, h: 650 }) && space.locate({ page: 9, fx: 0, fy: 0, fw: 1, fh: 1 }) === null);
  space.reveal(tok);
  check('pdf viewer space: show again scrolls to the mark\'s page', pages[1].revealed === true);
  const s = annotate.overlayScript({ marks: [] }, { viewer: true });
  check('pdf viewer: the script carries the viewer space only when asked', /viewerSpace\(window, document\)/.test(s) && !/viewerSpace\(window, document\)/.test(annotate.overlayScript({ marks: [] })) && /"fast":true/.test(s));
}

// ---------------------------------------------------------------- which way: overlay, or a picture of the tab
check('path: a web page or the slide or PDF viewer (pages) is drawn over; Chrome\'s own PDF viewer, or a failed overlay, on a screenshot', annotate.choosePath({}) === 'overlay' && annotate.choosePath({ chromePdf: true }) === 'screenshot' && annotate.choosePath({ failed: true }) === 'screenshot');
{
  const spec = annotate.normalize({ marks: [{ type: 'box', x: 10, y: 20, w: 100, h: 50, text: 'Look' }, { type: 'arrow', x: 300, y: 300, to: { x: 120, y: 60 } }] }, { ratio: 1, zoom: 1 });
  const out = annotate.staticSvg(spec.marks, { w: 640, h: 480, image: 'data:image/png;base64,AAAA' });
  check('screenshot path: one SVG of the tab\'s size, the picture first, the marks over it', /^<svg [^>]*width="640" height="480" viewBox="0 0 640 480"/.test(out.svg) && out.svg.indexOf('<image href="data:image/png;base64,AAAA"') < out.svg.indexOf('<path') && out.drawn === 2 && !/<script|onload|onerror/i.test(out.svg), out.svg.slice(0, 200));
  check('screenshot path: nothing placeable gives no picture', annotate.staticSvg([{ type: 'label', at: { box: { x: 1, y: 1, w: 0, h: 0 } }, text: '', to: null, color: null }], { w: 100, h: 100, image: 'data:image/png;base64,AAAA' }).svg === null);
}

// ---------------------------------------------------------------- the tool in the agent (a fake tab)
(async () => {
  const fakeAgent = (over = {}) => {
    const wc = { id: 5, getURL: () => 'https://a.test/page', getTitle: () => 'A test page', getZoomFactor: () => 1, isDestroyed: () => false };
    const calls = [];
    const self = {
      requireTab: () => wc, screenshotScale: { wc, ratio: 1 }, lastDrawing: null, calls,
      async annotateRun(_wc, code) { calls.push(code); return over.result || { ok: true, drawn: 2, missing: [], frozen: [{ type: 'box', at: { tok: { x: 1, y: 2, w: 3, h: 4 } }, to: null, text: '', color: null }, { type: 'step', at: { ref: 3 }, to: null, text: '', color: null }] }; },
      annotateOnScreenshot: async () => 'SCREENSHOT PATH', annotateBoxOf: async () => null, frameAllow: () => () => true,
      ...over.self,
    };
    return { self, wc };
  };
  const call = (self, input) => Agent.prototype.annotateTool.call(self, annotate.coerce(input));
  {
    const { self, wc } = fakeAgent();
    const out = await call(self, { marks: [{ type: 'box', target: '3' }, { type: 'step', x: 5, y: 5 }] });
    check('tool: draws through the overlay, reports the count and the tab, and asks for matching step numbers', /^Drew 2 marks on “A test page”/.test(out) && /until they click "Clear drawings" or press Esc/.test(out) && /Number your written steps to match/.test(out) && self.calls.length === 1, out);
    check('tool: remembers the drawing for Show again (frozen tokens, the page it was on)', self.lastDrawing && self.lastDrawing.wc === wc && self.lastDrawing.marks.length === 2 && self.lastDrawing.url === 'https://a.test/page' && self.lastDrawing.viewer === false);
    check('tool: the page script gets the marks, not the model\'s raw input', /"type":"box"/.test(self.calls[0]) && /"ref":3/.test(self.calls[0]) && !/"target"/.test(self.calls[0]));
  }
  {
    const { self } = fakeAgent({ self: { screenshotScale: null } });
    check('tool: coordinates need a screenshot first (element targets do not)', /need a screenshot of this tab first/.test(await call(self, { marks: [{ type: 'box', x: 1, y: 2 }] }).catch((e) => e.message)) && /^Drew/.test(await call(self, { marks: [{ type: 'box', target: '2' }] })));
  }
  {
    const { self } = fakeAgent({ result: { ok: false } });
    check('tool: when the overlay can\'t be put in the page it falls back to a screenshot, and says so', (await call(self, { marks: [{ type: 'box', target: '2' }] })) === 'SCREENSHOT PATH');
  }
  {
    const { self } = fakeAgent({ self: { async annotateRun() { throw new Error('page refused'); } } });
    check('tool: an overlay that throws is the same fallback', (await call(self, { marks: [{ type: 'box', target: '2' }] })) === 'SCREENSHOT PATH');
  }
  {
    const { self } = fakeAgent({ result: { ok: true, drawn: 1, missing: ['marks[1] box: no visible text "zzz"'], frozen: [{ type: 'box', at: { text: 'a' }, to: null, text: '', color: null }] } });
    const out = await call(self, { marks: [{ type: 'box', target: 'text:a' }, { type: 'box', target: 'text:zzz' }] });
    check('tool: what could not be placed is listed for the model', /Drew 1 mark on/.test(out) && /Not drawn: marks\[1\] box: no visible text "zzz"/.test(out), out);
  }
  {
    const { self } = fakeAgent();
    const out = await call(self, { clear: true });
    check('tool: clear alone clears and forgets the marks', out === 'Cleared the drawings.' && /__lumenDraw/.test(self.calls[0]));
  }
  {
    const { self } = fakeAgent();
    const taskScope = null;
    void taskScope;
    const out = await call(self, { marks: Array.from({ length: 25 }, () => ({ type: 'box', target: '2' })) });
    check('tool: marks beyond 20 are ignored and the model is told', /5 extra marks beyond the 20 per call were ignored/.test(out), out);
  }
  {
    const viewerSelf = fakeAgent();
    viewerSelf.wc.getURL = () => 'lumen-pdf://app/viewer.html?u=https%3A%2F%2Fa.test%2Fdoc.pdf';
    const out = await call(viewerSelf.self, { marks: [{ type: 'box', x: 10, y: 10, w: 20, h: 20 }] });
    check('tool: on Lumen\'s PDF viewer it draws over the viewer with page-anchored marks and says it is the PDF', /"fast":true/.test(viewerSelf.self.calls[0]) && /viewerSpace\(window, document\)/.test(viewerSelf.self.calls[0]) && /on the PDF /.test(out) && viewerSelf.self.lastDrawing.viewer === true, out);
  }
  {
    const { self } = fakeAgent();
    // show again / clear from the sidebar
    await call(self, { marks: [{ type: 'box', target: '3' }] });
    self.lastDrawing.wc.getURL = () => 'https://a.test/page';
    self.calls.length = 0;
    check('sidebar: Show again redraws the remembered marks on the same page, replacing what is there', (await Agent.prototype.annotateAgain.call(self, 'show')) === true && /"clear":true/.test(self.calls[0]) && /"tok"/.test(self.calls[0]));
    check('sidebar: Clear removes them', (await Agent.prototype.annotateAgain.call(self, 'clear')) === true && /__lumenDraw/.test(self.calls[1]));
    self.lastDrawing.wc.getURL = () => 'https://a.test/elsewhere';
    check('sidebar: Show again is refused once the page moved on, and for nothing remembered', (await Agent.prototype.annotateAgain.call(self, 'show')) === false && (await Agent.prototype.annotateAgain.call({ lastDrawing: null }, 'show')) === false);
  }

  // ------------------------------------------------------------ lists, MCP, budgets
  const agentSrc = src('ai', 'agent.js');
  const set = (name) => { const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(agentSrc); return m ? m[1] : ''; };
  check('lists: annotate is in the tool list, validated by its schema, and needs marks or clear', EXTERNAL_TOOLS.some((t) => t.name === 'annotate') && /annotate: \[\['marks', 'clear'\]\]/.test(agentSrc));
  check('lists: it changes nothing a site could notice, so it is neither an acting tool (no approval card) nor a reading one, and it works on the task\'s tab (a site with AI off refuses it)', !/'annotate'/.test(set('ACTING_TOOLS')) && !/'annotate'/.test(set('READING_TOOLS')) && !/'annotate'/.test(set('TAB_FREE_TOOLS')) && !/'annotate'/.test(set('ACTING_TOOL_NAMES')) && /case 'annotate': return this\.annotateTool\(input\)/.test(agentSrc));
  check('lists: the read tracker keeps element ids (annotate is read-only to snapshot.js)', /READ_ONLY = new Set\(\[[^\]]*'annotate'/.test(src('ai', 'snapshot.js')));
  check('lists: Claude Code\'s early label, the sidebar\'s step label, and the strings exist', /annotate: 'Drawing on the page'/.test(src('ai', 'claude-code.js')) && /annotate: \(\) => t\('tool\.annotate'\)/.test(src('renderer', 'chat-core.js')) && ['tool.annotate', 'tool.annotate.done.one', 'tool.annotate.done.other', 'tool.annotate.show', 'tool.annotate.clear'].every((k) => JSON.parse(src('locales', 'en.json'))[k]) && /Drawing \$\{/.test(agentSrc));
  check('lists: the sidebar shows "Drew N marks" with Show again / Clear (only where the bridge exists), and main answers it', /annotateChip\(step\)/.test(src('renderer', 'chat-core.js')) && /window\.assistant\?\.annotate/.test(src('renderer', 'chat-core.js')) && /annotate: \(action\) => ipcRenderer\.invoke\('agent:annotate', action\)/.test(src('preload', 'preload.js')) && /ipcMain\.handle\('agent:annotate'/.test(src('main.js')) && /'agent:annotate'/.test(src('main.js').split('UI_ONLY_IPC = new Set([')[1].split(']);')[0]));
  const listed = [];
  const { handle } = mcp.createSession({ tools: EXTERNAL_TOOLS, callTool: async () => ({}), enabled: () => true, onEvent: () => {}, send: (m) => listed.push(m) });
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = (listed.find((m) => m.id === 1)?.result?.tools || []).find((t) => t.name === 'annotate');
  check('MCP: Grok Build, Claude Code and others see annotate, marked read-only (no per-call prompt in Codex)', tool && tool.annotations && tool.annotations.readOnlyHint === true && /^Draw on the page/.test(tool.description) && tool.inputSchema.properties.marks.type === 'array', J(tool && tool.annotations));
  const slim = EXTERNAL_TOOLS.find((t) => t.name === 'annotate');
  check('budget: the description stays short (one line of guidance, under 300 characters) and the MCP listing under 520 characters', annotate.TOOL.description.length < 300 && J(slim).length < 520, `${annotate.TOOL.description.length} ${J(slim).length}`);
  check('description: says when to use it, where targets come from, and that step numbers match the answer', /Draw on the page to explain it/.test(annotate.TOOL.description) && /Screenshot\/find first/.test(annotate.TOOL.description) && /number steps like your answer/.test(annotate.TOOL.description));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

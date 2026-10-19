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

// ---------------------------------------------------------------- resize / reflow: marks are anchored to page content
{
  const anchored = (rect) => Object.assign(element(rect), { nodeType: 1, tagName: 'DIV', parentNode: null });
  const hl = (r) => { const a = tags(r.svg, 'rect')[0].attrs; return { x: Number(a.x) + 2, y: Number(a.y) + 1, w: Number(a.width) - 4, h: Number(a.height) - 2, hidden: a.visibility === 'hidden' }; };
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
  const setup = (rect, extra = {}) => {
    const el = anchored(rect);
    const env = liveEnv();
    env.document.elementFromPoint = () => el;
    Object.assign(env.win, extra);
    const observed = [];
    env.win.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(e) { observed.push(e); } disconnect() {} };
    const r = live(env, [{ type: 'highlight', x: 150, y: 220, w: 100, h: 40 }]);
    return { el, env, r, observed };
  };
  withTimers(() => {
    const { el, env, r, observed } = setup({ x: 100, y: 200, w: 400, h: 100 });
    check('resize: a box placed from a screenshot is drawn where it was put', near(hl(r).x, 150) && near(hl(r).y, 220) && near(hl(r).w, 100) && near(hl(r).h, 40), J(hl(r)));
    check('resize: the element under the mark is watched (ResizeObserver) along with the document', observed.includes(el) && observed.includes(env.document.documentElement));
    el.rect = { x: 50, y: 300, w: 800, h: 200 }; // the page reflowed: wider and lower
    env.document.documentElement.clientWidth = 1400; env.win.innerWidth = 1400;
    r.board.layout();
    check('reflow: the mark moves and scales with the element it sits on (fractions of its box)', near(hl(r).x, 150) && near(hl(r).y, 340) && near(hl(r).w, 200) && near(hl(r).h, 80), J(hl(r)));
    el.rect = { x: 0, y: 200, w: 200, h: 50 }; // narrower (a sidebar opened)
    r.board.layout();
    check('resize: narrower, the mark shrinks with its element', near(hl(r).x, 25) && near(hl(r).w, 50) && near(hl(r).y, 210) && near(hl(r).h, 20), J(hl(r)));
    r.board.destroy();
  });
  withTimers(() => {
    const { env, r } = setup({ x: 100, y: 200, w: 400, h: 100 });
    env.document.documentElement.clientWidth = 1400; env.document.documentElement.clientHeight = 900;
    env.handlers.resize[0]();
    check('canvas: the overlay is re-fitted to the window at once on resize (view box = client size, never stretched)', r.svg.attrs.viewBox === '0 0 1400 900' && r.svg.attrs.width === '100%', J(r.svg.attrs));
    env.document.documentElement.clientWidth = 640; env.document.documentElement.clientHeight = 480;
    env.handlers.resize[0]();
    check('canvas: and again when it shrinks', r.svg.attrs.viewBox === '0 0 640 480');
    r.board.destroy();
  });
  withTimers(() => {
    const mqs = [];
    const { env, r, el } = setup({ x: 100, y: 200, w: 400, h: 100 }, { devicePixelRatio: 1, matchMedia: (q) => { const mq = { q, list: [], matches: false, addEventListener(t, fn) { mq.list.push(fn); }, removeEventListener() {} }; mqs.push(mq); return mq; } });
    check('dpr: the overlay listens for a pixel-ratio change (resolution media query)', mqs.some((m) => /resolution: 1dppx/.test(m.q) && m.list.length === 1), J(mqs.map((m) => m.q)));
    // DPR 1 -> 1.5 (another screen): the window is 1000 DIPs, so it is 667 CSS px wide; the element is 2/3 as wide now.
    env.win.devicePixelRatio = 1.5; env.win.innerWidth = 667; env.win.innerHeight = 467;
    env.document.documentElement.clientWidth = 667; env.document.documentElement.clientHeight = 467;
    el.rect = { x: 66.7, y: 133.3, w: 266.7, h: 66.7 };
    mqs.find((m) => /resolution: 1dppx/.test(m.q)).list[0]();
    check('dpr: 1 -> 1.5 re-fits the view box and the mark follows its element', r.svg.attrs.viewBox === '0 0 667 467' && near(hl(r).x, 100, 1) && near(hl(r).w, 66.7, 1) && near(hl(r).y, 146.6, 1) && mqs.some((m) => /resolution: 1.5dppx/.test(m.q)), `${r.svg.attrs.viewBox} ${J(hl(r))} ${mqs.length}`);
    r.board.destroy();
  });
  withTimers(() => {
    const vv = {};
    const env = liveEnv();
    env.win.visualViewport = { addEventListener: (t, fn) => { (vv[t] ||= []).push(fn); }, removeEventListener: (t, fn) => { vv[t] = (vv[t] || []).filter((f) => f !== fn); } };
    const r = live(env, [{ type: 'highlight', x: 150, y: 220, w: 100, h: 40 }]);
    check('visual viewport: resize and scroll of the visual viewport re-lay the marks out (and are removed on clear)', vv.resize.length === 1 && vv.scroll.length === 1);
    r.board.destroy();
    check('visual viewport: listeners are removed when cleared', !vv.resize.length && !vv.scroll.length);
  });
  withTimers(() => {
    // page zoom 1 -> 1.25: the element is 1.25x as big in CSS px terms of the viewport
    const { el, env, r } = setup({ x: 100, y: 200, w: 400, h: 100 });
    el.rect = { x: 125, y: 250, w: 500, h: 125 };
    env.win.innerWidth = 800; env.win.innerHeight = 560; env.document.documentElement.clientWidth = 800; env.document.documentElement.clientHeight = 560;
    env.handlers.resize[0]();
    check('zoom: the mark scales with the element (x 1.25) and stays on the same content', near(hl(r).x, 187.5) && near(hl(r).w, 125) && near(hl(r).y, 275) && near(hl(r).h, 50), J(hl(r)));
    r.board.destroy();
  });
  withTimers(() => {
    // scroll + resize together
    const { el, env, r } = setup({ x: 100, y: 200, w: 400, h: 100 });
    env.win.scrollY = 120;
    el.rect = { x: 100, y: 200 - 120, w: 400, h: 100 };
    r.board.layout();
    check('scroll: the mark scrolls with the content', near(hl(r).y, 100));
    el.rect = { x: 100, y: 250 - 120, w: 200, h: 50 }; // the window narrowed while scrolled: the element reflowed to half the size, lower
    r.board.layout();
    check('scroll + resize: both at once still land on the content', near(hl(r).x, 125) && near(hl(r).w, 50) && near(hl(r).y, 250 - 120 + 0.2 * 50) && near(hl(r).h, 20), J(hl(r)));
    r.board.destroy();
  });
  withTimers(() => {
    const { el, env, r } = setup({ x: 100, y: 200, w: 400, h: 100 });
    el.isConnected = false; // the page removed the element
    env.win.scrollY = 50;
    r.board.layout();
    check('removed element: falls back to the document coordinates (and scroll still moves it)', !hl(r).hidden && near(hl(r).x, 150) && near(hl(r).y, 170) && near(hl(r).w, 100), J(hl(r)));
    r.board.destroy();
  });
  withTimers(() => {
    const env = liveEnv(); // nothing to hit-test: document coordinates only, as before
    env.win.scrollY = 30;
    const r = live(env, [{ type: 'highlight', x: 150, y: 220, w: 100, h: 40 }]);
    env.win.scrollY = 80;
    r.board.layout();
    check('no anchor element: document coordinates keep it on the page when it scrolls', near(hl(r).y, 170));
    check('frozen: the remembered token is plain JSON (document coordinates), never the element', J(r.frozen[0].at) === J({ tok: { x: 150, y: 250, w: 100, h: 40 } }), J(r.frozen[0].at));
    r.board.destroy();
  });
  withTimers(() => {
    const big = Object.assign(element({ x: 0, y: 0, w: 1000, h: 700 }), { nodeType: 1, tagName: 'BODY', parentNode: null });
    const env = liveEnv();
    env.document.body = big; env.document.elementFromPoint = () => big;
    const r = live(env, [{ type: 'highlight', x: 150, y: 220, w: 100, h: 40 }]);
    big.rect = { x: 0, y: 0, w: 2000, h: 1400 };
    r.board.layout();
    check('anchor: the body itself is never the anchor (document coordinates are used, it does not scale)', near(hl(r).w, 100) && near(hl(r).x, 150));
    r.board.destroy();
  });
  withTimers(() => {
    // the smallest element that holds the whole box: a small inner element that does not hold it is skipped
    const outer = Object.assign(element({ x: 0, y: 100, w: 600, h: 300 }), { nodeType: 1, tagName: 'DIV', parentNode: null });
    const inner = Object.assign(element({ x: 160, y: 230, w: 50, h: 10 }), { nodeType: 1, tagName: 'SPAN', parentNode: outer });
    const env = liveEnv();
    env.document.elementFromPoint = () => inner;
    const r = live(env, [{ type: 'highlight', x: 150, y: 220, w: 100, h: 40 }]);
    outer.rect = { x: 0, y: 200, w: 600, h: 300 };
    r.board.layout();
    const y = Number(tags(r.svg, 'rect')[0].attrs.y) + 1;
    check('anchor: climbs from the element under the centre to the one that holds the whole box', near(y, 320), String(y));
    r.board.destroy();
  });
}

// ---------------------------------------------------------------- the new mark types: geometry and options
{
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
  const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
  const xs = (d) => nums(d).filter((_, i) => i % 2 === 0);
  const ys = (d) => nums(d).filter((_, i) => i % 2 === 1);
  {
    const r = draw([{ type: 'strike', ...box }]);
    const d = pathOf(r);
    check('strike: a line through the middle of the box, red by default', ys(d).every((y) => y > 222 && y < 238) && Math.min(...xs(d)) < 105 && Math.max(...xs(d)) > 295 && tags(r.svg, 'path')[1].attrs.stroke === '#d92d20', d);
  }
  {
    const tall = draw([{ type: 'bracket', x: 300, y: 100, w: 40, h: 200 }]);
    const d = pathOf(tall);
    check('bracket: tall target -> a curly brace on its left, spanning its height, tip pointing away', Math.max(...xs(d)) < 300 && Math.min(...xs(d)) < 285 && Math.min(...ys(d)) <= 100 && Math.max(...ys(d)) >= 300, d);
    const wide = draw([{ type: 'bracket', x: 100, y: 300, w: 300, h: 40 }]);
    const e = pathOf(wide);
    check('bracket: wide target -> a brace above it', Math.max(...ys(e)) < 300 && Math.min(...xs(e)) <= 100 && Math.max(...xs(e)) >= 400, e);
  }
  {
    const r = draw([{ type: 'check', x: 100, y: 100, w: 40, h: 40 }]);
    const d = pathOf(r);
    check('check: a tick (down-stroke then a long up-stroke) centred on the target, green', /^M[\d. -]+L[\d. -]+L/.test(d) && (d.match(/M/g) || []).length === 1 && tags(r.svg, 'path')[1].attrs.stroke === '#1a9d4a' && Math.abs((Math.min(...xs(d)) + Math.max(...xs(d))) / 2 - 120) < 8, d);
    const x = draw([{ type: 'cross', x: 100, y: 100, w: 40, h: 40 }]);
    const e = pathOf(x);
    check('cross: two crossing strokes in one path, red', (e.match(/M/g) || []).length === 2 && tags(x.svg, 'path')[1].attrs.stroke === '#d92d20' && Math.abs((Math.min(...ys(e)) + Math.max(...ys(e))) / 2 - 120) < 6, e);
    const pt = xs(pathOf(draw([{ type: 'check', x: 500, y: 300 }])));
    check('check/cross: a bare point gets a default size', Math.max(...pt) - Math.min(...pt) > 15);
  }
  {
    const r = draw([{ type: 'redact', ...box }]);
    const rect = tags(r.svg, 'rect')[0].attrs;
    check('redact: a near-opaque dark box that covers the target (a little bigger)', rect.fill === '#111111' && Number(rect['fill-opacity']) > 0.9 && Number(rect.x) <= 100 && Number(rect.width) >= 200 && Number(rect.y) <= 200 && Number(rect.height) >= 60, J(rect));
    check('redact: a colour or opacity can be chosen', tags(draw([{ type: 'redact', ...box, color: 'blue', opacity: 0.5 }]).svg, 'rect')[0].attrs.fill === '#1a6ef0' && tags(draw([{ type: 'redact', ...box, opacity: 0.5 }]).svg, 'rect')[0].attrs.opacity === '0.5');
  }
  {
    const r = draw([{ type: 'callout', ...box, text: 'This sets the limit' }]);
    const rect = tags(r.svg, 'rect')[0].attrs;
    const lead = pathOf(r);
    const [lx, ly, tx, ty] = nums(lead);
    check('callout: a bubble beside the target with a straight leader line from the bubble to the target edge', tags(r.svg, 'path').length === 2 && Number(rect.x) > 300 && /^M[\d. ]+L[\d. ]+$/.test(lead) && lx >= Number(rect.x) - 1 && tx >= 295 && tx <= 310 && ty >= 195 && ty <= 265 && Number.isFinite(ly), `${J(rect)} ${lead}`);
    check('callout: text is required', draw([{ type: 'callout', ...box }]).missing.length === 1);
    const edge = draw([{ type: 'callout', x: 700, y: 200, w: 90, h: 40, text: 'Left side' }]);
    check('callout: no room on the right -> the bubble goes to the left', Number(tags(edge.svg, 'rect')[0].attrs.x) < 700);
    const far = draw([{ type: 'callout', ...box, to: { x: 500, y: 100, w: 40, h: 40 }, text: 'See there' }]);
    const t2 = nums(pathOf(far)).slice(-2);
    check('callout: with `to` the leader line ends at that target', t2[0] >= 495 && t2[0] <= 545 && t2[1] >= 95 && t2[1] <= 145, J(t2));
  }
  {
    const pts = [[100, 100], [150, 140], [200, 100], [250, 140]];
    const m = annotate.normalize({ marks: [{ type: 'path', points: pts }] }, { ratio: 1, zoom: 1 }).marks[0];
    check('path: points become fractions of their bounding box, which is the anchor', J(m.at.box) === J({ x: 100, y: 100, w: 150, h: 40 }) && m.pts.length === 4 && m.pts[0][0] === 0 && m.pts[3][0] === 1 && m.pts[1][1] === 1, J(m));
    check('path: needs 2+ points and a screenshot; capped at 120 points', /needs points/.test(throws(() => annotate.normalize({ marks: [{ type: 'path', points: [[1, 1]] }] }, { ratio: 1, zoom: 1 }))) && /screenshot/.test(throws(() => annotate.normalize({ marks: [{ type: 'path', points: [[1, 1], [2, 2]] }] }, null))) && annotate.normalize({ marks: [{ type: 'path', points: Array.from({ length: 300 }, (_, i) => [i, i % 7]) }] }, { ratio: 1, zoom: 1 }).marks[0].pts.length === 120);
    const d = pathOf(draw([{ type: 'path', points: pts }]));
    check('path: a smooth stroke through the points', /^M100 100C/.test(d) && /250 140$/.test(d), d);
    // anchored to an element: it scales with the element's box
    const el = Object.assign(element({ x: 90, y: 90, w: 200, h: 100 }), { nodeType: 1, tagName: 'DIV', parentNode: null });
    const env = liveEnv();
    env.document.elementFromPoint = () => el;
    withTimers(() => {
      const lr = live(env, [{ type: 'path', points: pts }]);
      el.rect = { x: 90, y: 90, w: 400, h: 200 };
      lr.board.layout();
      const dd = pathOf(lr);
      check('path: scales with the element it was drawn on', near(nums(dd)[0], 90 + (10 / 200) * 400, 1) && Math.max(...xs(dd)) > 300, dd);
      lr.board.destroy();
    });
  }
  {
    const w1 = tags(draw([{ type: 'box', ...box, width: 9 }]).svg, 'path');
    check('options: width sets the stroke (halo stays 4 wider), clamped to 1..12', w1[1].attrs['stroke-width'] === '9' && w1[0].attrs['stroke-width'] === '13' && annotate.normalize({ marks: [{ type: 'box', target: '1', width: 99 }] }).marks[0].width === 12 && annotate.normalize({ marks: [{ type: 'box', target: '1', width: -3 }] }).marks[0].width === 1);
    check('options: opacity is applied to the mark parts, clamped to .1..1', w1.every((p) => p.attrs.opacity === undefined) && tags(draw([{ type: 'box', ...box, opacity: 0.4 }]).svg, 'path').every((p) => p.attrs.opacity === '0.4') && annotate.normalize({ marks: [{ type: 'box', target: '1', opacity: 7 }] }).marks[0].opacity === 1 && annotate.normalize({ marks: [{ type: 'box', target: '1', opacity: 0 }] }).marks[0].opacity === 0.1);
    const straight = pathOf(draw([{ type: 'arrow', x: 50, y: 400, to: { x: 300, y: 250 }, curve: false }]));
    const curved = pathOf(draw([{ type: 'arrow', x: 50, y: 400, to: { x: 300, y: 250 }, curve: true }]));
    const dflt = pathOf(draw([{ type: 'arrow', x: 50, y: 400, to: { x: 300, y: 250 } }]));
    const ctl = (d) => nums(d).slice(2, 4);
    const dist = (p) => Math.hypot(p[0] - 175, p[1] - 325);
    check('arrow: curve:false is straight (control point on the line), curve:true bows more than the default', dist(ctl(straight)) < 1 && dist(ctl(curved)) > dist(ctl(dflt)), `${straight} | ${curved}`);
    check('every new type draws and takes the palette', ['strike', 'bracket', 'check', 'cross', 'redact'].every((t) => annotate.COLORS.every((c) => draw([{ type: t, ...box, color: c }]).drawn === 1)));
    check('schema: a compact tool (one type enum + shared options), the new types are in it, and validation accepts them', ['strike', 'bracket', 'check', 'cross', 'redact', 'callout', 'path'].every((t) => annotate.TYPES.includes(t)) && ['width', 'opacity', 'curve', 'points'].every((k) => annotate.TOOL.input_schema.properties.marks.items.properties[k]) && validateInput('annotate', { marks: [{ type: 'path', points: [[1, 2], [3, 4]], width: 3, opacity: 0.5 }, { type: 'arrow', target: '1', curve: false }] }) === null);
  }
}

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

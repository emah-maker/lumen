// Pure unit test for renderer/newtab-effects.js: the animation loop asks for an animation frame only when one is due (no 60 Hz callbacks that
// return early), makes no request while hidden, and rests after 90 s without input until the next input.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-effects.js'), 'utf8');

function make() {
  let clock = 1000;
  const timers = []; const rafs = []; const listeners = {};
  const stats = { raf: 0, frames: 0, timers: 0 };
  const grad = { addColorStop() {} };
  const draws = { clears: 0, fills: 0 }; const canvases = [];
  const ctx2d = new Proxy({}, { get: (o, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => grad : k === 'createPattern' ? () => ({}) : k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(128 * 128 * 4) }) : k === 'clearRect' ? () => { draws.clears++; } : k === 'fill' || k === 'stroke' || k === 'fillRect' ? () => { draws.fills++; } : typeof o[k] === 'undefined' ? () => {} : o[k]), set: (o, k, v) => { o[k] = v; return true; } });
  const doc = {
    hidden: false,
    listeners: {},
    addEventListener(t, f) { (doc.listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { doc.listeners[t] = (doc.listeners[t] || []).filter((x) => x !== f); },
    getElementById: () => ({ after() {} }),
    createElement: () => { const c = { setAttribute() {}, remove() {}, getContext: () => ctx2d, set width(v) { c.w = v; }, set height(v) { c.h = v; } }; canvases.push(c); return c; },
    documentElement: { addEventListener() {}, removeEventListener() {} },
  };
  const g = {
    document: doc, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)', getPropertyValue: () => '#0a84ff' }),
    matchMedia: () => ({ matches: false }),
    performance: { now: () => clock },
    Math, JSON, Object, Array, Number, String, Date,
    requestAnimationFrame: (f) => { stats.raf++; const r = { f, dead: false }; rafs.push(r); return r; },
    cancelAnimationFrame: (r) => { if (r) r.dead = true; },
    setTimeout: (f, ms) => { stats.timers++; const t = { f, at: clock + ms, dead: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.dead = true; },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  };
  g.window = g; g.globalThis = g;
  vm.runInNewContext(src, g);
  // Advance the fake clock in 1 ms steps: due timers fire, and a pending animation frame fires on each 16.67 ms vsync.
  let nextVsync = clock + 16.67;
  const advance = (ms) => {
    const end = clock + ms;
    while (clock < end) {
      clock += 1;
      for (const t of timers.filter((x) => !x.dead && x.at <= clock)) { t.dead = true; t.f(); }
      if (clock >= nextVsync) {
        nextVsync += 16.67;
        for (const r of rafs.splice(0)) if (!r.dead) { r.dead = true; stats.frames++; r.f(clock); }
      }
    }
    if (timers.length > 500) timers.splice(0, timers.length - 50);
  };
  const fire = (type) => (listeners[type] || []).slice().forEach((f) => f({ clientX: 1, clientY: 1 }));
  const setHidden = (h) => { doc.hidden = h; (doc.listeners.visibilitychange || []).slice().forEach((f) => f()); };
  return { g, stats, advance, fire, setHidden, listeners, draws, canvases };
}

{
  const t = make();
  t.g.setBackdropEffect('particles', { still: false, lite: false, effectStyle: {} });
  t.advance(1000);
  check('running: about 30 frames in a second', t.stats.frames >= 26 && t.stats.frames <= 31, `frames ${t.stats.frames}`);
  check('every animation frame asked for was a drawn one (none wasted)', t.stats.raf - t.stats.frames <= 1, `raf ${t.stats.raf} frames ${t.stats.frames}`);
}
{
  const t = make();
  t.g.setBackdropEffect('snow', { lite: true, effectStyle: {} });
  t.advance(5000);
  check('Performance mode (and battery saver): one still frame, no loop, no timer', t.stats.raf === 0 && t.stats.timers === 0 && t.draws.clears === 1, `raf ${t.stats.raf} timers ${t.stats.timers} draws ${t.draws.clears}`);
}
{
  const t = make();
  t.g.setBackdropEffect('stars', { effectStyle: {} });
  t.advance(500);
  t.setHidden(true);
  const raf = t.stats.raf; const timers = t.stats.timers;
  t.advance(60e3);
  check('hidden: no animation frame and no timer is asked for', t.stats.raf === raf && t.stats.timers === timers, `raf +${t.stats.raf - raf} timers +${t.stats.timers - timers}`);
  t.setHidden(false);
  const frames = t.stats.frames;
  t.advance(500);
  check('shown again: the loop starts again', t.stats.frames - frames >= 10);
}
{
  const t = make();
  t.g.setBackdropEffect('bubbles', { effectStyle: {} });
  t.advance(60e3);
  check('60 s without input: still animating', t.stats.frames > 1700, `frames ${t.stats.frames}`);
  t.advance(40e3); // past 90 s
  const raf = t.stats.raf; const timers = t.stats.timers; const frames = t.stats.frames;
  t.advance(60e3);
  check('after 90 s without input: the loop rests (no frames, no timers, no animation frames)', t.stats.frames === frames && t.stats.raf === raf && t.stats.timers === timers, `frames +${t.stats.frames - frames} raf +${t.stats.raf - raf} timers +${t.stats.timers - timers}`);
  t.fire('pointermove');
  t.advance(500);
  check('the next input wakes it', t.stats.frames - frames >= 10, `frames +${t.stats.frames - frames}`);
}
{
  const t = make();
  t.g.setBackdropEffect('particles', { effectStyle: {} });
  for (let i = 0; i < 20; i++) { t.advance(10e3); t.fire('keydown'); }
  const f = t.stats.frames;
  t.advance(1000);
  check('input every 10 s keeps it running', t.stats.frames - f >= 26);
  t.g.setBackdropEffect('none');
  const n = Object.values(t.listeners).reduce((a, l) => a + l.length, 0);
  check('turning the effect off removes every listener', n === 0, `left ${n}`);
  const raf = t.stats.raf; const frames = t.stats.frames;
  t.advance(5000);
  check('and stops the loop', t.stats.frames === frames && t.stats.raf === raf);
}
{
  const t = make();
  t.g.setBackdropEffect('particles', { still: true, effectStyle: {} });
  t.advance(5000);
  check('Reduce motion: one still frame, no loop', t.stats.raf === 0 && t.stats.timers === 0);
}

{
  // The grid finds the same lines the all-pairs scan did, with far fewer comparisons.
  const t = make();
  t.g.setBackdropEffect('particles', { effectStyle: {} });
  t.advance(2000);
  const s = t.g.setBackdropEffect.info();
  const perFrame = s.stats.checks / s.stats.frames;
  check('particles: 80 of them at 1280 x 800, a few hundred comparisons a frame (not 3160)', s.count === 80 && perFrame > 0 && perFrame < 800, `count ${s.count} checks/frame ${perFrame}`);
  check('particles: a frame costs well under 2 ms of script', s.stats.ms / s.stats.frames < 2, `${s.stats.ms / s.stats.frames} ms`);
}
{
  // One canvas pixel per CSS pixel on a dense screen, half that for the soft ones.
  const t = make();
  t.g.devicePixelRatio = 2;
  t.g.setBackdropEffect('particles', { effectStyle: {} });
  const c = t.canvases.at(-1);
  check('particles: the canvas is 1 pixel per CSS pixel even at a pixel ratio of 2', c.w === 1280 && c.h === 800, `${c.w} x ${c.h}`);
  t.g.setBackdropEffect('blobs', { effectStyle: {} });
  const b = t.canvases.at(-1);
  check('soft effects: half the size, scaled up by the page', b.w === 640 && b.h === 400, `${b.w} x ${b.h}`);
}
for (const [name, fps] of [['aurora', 15], ['blobs', 15], ['grain', 8]]) {
  const t = make();
  t.g.setBackdropEffect(name, { effectStyle: {} });
  t.advance(2000);
  check(`${name}: about ${fps} frames a second`, t.stats.frames >= fps * 2 - 4 && t.stats.frames <= fps * 2 + 2, `frames ${t.stats.frames}`);
  check(`${name}: it draws something`, t.draws.fills > 0, '');
  t.setHidden(true);
  const raf = t.stats.raf; const timers = t.stats.timers;
  t.advance(30e3);
  check(`${name}: hidden, no animation frame and no timer is asked for`, t.stats.raf === raf && t.stats.timers === timers, `raf +${t.stats.raf - raf} timers +${t.stats.timers - timers}`);
  const still = make();
  still.g.setBackdropEffect(name, { still: true, effectStyle: {} });
  still.advance(5000);
  check(`${name}: Reduce motion draws one frame and nothing else`, still.stats.raf === 0 && still.stats.timers === 0 && still.draws.clears === 1, `raf ${still.stats.raf} timers ${still.stats.timers} draws ${still.draws.clears}`);
}
{
  const t = make();
  t.g.setBackdropEffect('aurora', { effectStyle: {} });
  t.advance(95e3);
  const raf = t.stats.raf; const timers = t.stats.timers;
  t.advance(60e3);
  check('aurora: after 90 s without input it rests like the others', t.stats.raf === raf && t.stats.timers === timers, `raf +${t.stats.raf - raf}`);
}

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('newtab-effects units passed');

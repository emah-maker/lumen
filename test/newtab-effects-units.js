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
  const ctx2d = new Proxy({}, { get: (o, k) => (k === 'createLinearGradient' ? () => grad : typeof o[k] === 'undefined' ? () => {} : o[k]), set: (o, k, v) => { o[k] = v; return true; } });
  const doc = {
    hidden: false,
    listeners: {},
    addEventListener(t, f) { (doc.listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { doc.listeners[t] = (doc.listeners[t] || []).filter((x) => x !== f); },
    getElementById: () => ({ after() {} }),
    createElement: () => ({ setAttribute() {}, remove() {}, getContext: () => ctx2d, set width(v) {}, set height(v) {} }),
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
  return { g, stats, advance, fire, setHidden, listeners };
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
  t.advance(1000);
  check('Performance mode: about 20 frames a second', t.stats.frames >= 17 && t.stats.frames <= 21, `frames ${t.stats.frames}`);
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

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('newtab-effects units passed');

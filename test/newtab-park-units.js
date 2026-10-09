// Pure unit test for renderer/newtab-park.js: TradingView frames of a page that stays hidden are sent to a blank page and get their address back when it is shown.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-park.js'), 'utf8');

function make(startHidden = false) {
  const listeners = [];
  const doc = { hidden: startHidden, addEventListener: (t, f) => { if (t === 'visibilitychange') listeners.push(f); } };
  const frame = (a) => ({ attrs: { src: a }, isConnected: true, getAttribute(n) { return this.attrs[n] ?? null; }, set src(v) { this.attrs.src = v; }, get src() { return this.attrs.src; } });
  const frames = [frame('https://s.tradingview.com/widgetembed/?symbol=A'), frame('https://s.tradingview.com/embed-widget/mini-symbol-overview/?x=1')];
  doc.querySelectorAll = (sel) => (sel === '.tradingview iframe' ? frames : []);
  const timers = [];
  let clock = 0;
  const ctx = { document: doc, setTimeout: (f, ms) => { const t = { f, at: clock + ms, dead: false }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.dead = true; } };
  vm.runInNewContext(src, ctx);
  const advance = (ms) => { clock += ms; for (const t of timers) if (!t.dead && t.at <= clock) { t.dead = true; t.f(); } };
  const set = (hidden) => { doc.hidden = hidden; listeners.forEach((f) => f()); };
  return { frames, advance, set };
}

{
  const { frames, advance, set } = make();
  const a = frames[0].src; const b = frames[1].src;
  set(true);
  advance(30e3);
  check('hidden 30 s: the charts are still loaded', frames[0].src === a && frames[1].src === b);
  advance(20e3);
  check('hidden 50 s: each TradingView frame is a blank page', frames[0].src === 'about:blank' && frames[1].src === 'about:blank');
  set(false);
  check('shown: each has its address back', frames[0].src === a && frames[1].src === b);
  set(true); advance(10e3); set(false); advance(60e3);
  check('hidden and shown again within the wait: nothing was parked', frames[0].src === a && frames[1].src === b);
  set(true); advance(50e3);
  frames[0].src = 'https://s.tradingview.com/widgetembed/?symbol=A&theme=dark'; // the card changed theme while parked
  set(false);
  check('an address set meanwhile (a theme change) is kept, not overwritten', frames[0].src.endsWith('theme=dark') && frames[1].src === b);
  set(true); advance(50e3); set(false);
  check('a second round parks and restores again', frames[0].src.endsWith('theme=dark') && frames[1].src === b);
}
{
  const { frames, advance, set } = make(true);
  const a = frames[0].src;
  advance(50e3);
  check('a page that loaded hidden (the spare page, a background tab) parks too, with no event', frames[0].src === 'about:blank');
  set(false);
  check('…and is restored when shown', frames[0].src === a);
}
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html'), 'utf8');
  check('newtab.html loads it', html.includes('<script src="newtab-park.js"></script>'));
}
{
  const fx = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-effects.js'), 'utf8');
  check('effect: asks for no animation frame while hidden, frees its canvas after a while, and starts again when shown', /document\.hidden\) \{ r\.raf = 0; return; \}/.test(fx) && /FREE_AFTER_MS/.test(fx) && /addEventListener\('visibilitychange', run\.onVisibility\)/.test(fx) && /removeEventListener\('visibilitychange', run\.onVisibility\)/.test(fx));
  check('effect: the canvas is capped in pixels (a huge window)', /MAX_PIXELS/.test(fx));
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('newtab-park units OK');

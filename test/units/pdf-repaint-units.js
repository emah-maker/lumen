// Chromium's PDF viewer redraw nudge and the same-origin blob rule for window.open (features/pdf-repaint.js): plain Node, no window.
const fs = require('fs');
const path = require('path');
const { createRepainter, isSameOriginBlob, NEXT_FRAME_MS, AGAIN_MS } = require('../../src/features/pdf-repaint');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// A fake clock: timers run when time is advanced.
function clock() {
  let now = 0; let id = 0; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return t; },
    clearTimer: (t) => timers.delete(t),
    advance(ms) { now += ms; for (const [t, x] of [...timers]) if (x.at <= now) { timers.delete(t); x.fn(); } },
  };
}
const fakeWc = (pdf = true) => ({ pdf, destroyed: false, calls: 0, isDestroyed() { return this.destroyed; }, invalidate() { this.calls++; } });

{
  const c = clock();
  const r = createRepainter({ isPdfTab: (wc) => wc.pdf, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const pdf = fakeWc(true);
  check('a PDF tab poke is accepted', r.poke(pdf) === true);
  c.advance(NEXT_FRAME_MS);
  check('invalidate is called once on the next frame', pdf.calls === 1, String(pdf.calls));
  c.advance(AGAIN_MS);
  check('and once more about 150 ms later', pdf.calls === 2, String(pdf.calls));
  c.advance(1000);
  check('and then no more', pdf.calls === 2, String(pdf.calls));

  const burst = fakeWc(true);
  r.poke(burst); r.poke(burst); r.poke(burst);
  c.advance(1000);
  check('a burst of shows and resizes is one pair of repaints', burst.calls === 2, String(burst.calls));

  const plain = fakeWc(false);
  check('a page that is not a PDF is not poked', r.poke(plain) === false);
  c.advance(1000);
  check('and is never invalidated', plain.calls === 0, String(plain.calls));

  const gone = fakeWc(true);
  r.poke(gone); gone.destroyed = true; c.advance(1000);
  check('a destroyed page is left alone', gone.calls === 0 && r.poke(gone) === false);

  const left = fakeWc(true);
  r.poke(left); left.pdf = false; c.advance(1000);
  check('a tab that stopped being a PDF before the timer is not invalidated', left.calls === 0, String(left.calls));
  check('no page and a throwing check are harmless', r.poke(null) === false && createRepainter({ isPdfTab: () => { throw new Error('x'); } }).poke(fakeWc()) === false);
}

check('blob: the page\'s own origin is allowed', isSameOriginBlob('blob:https://canvas.example.edu/3f2a-11', 'https://canvas.example.edu/courses/1') && isSameOriginBlob('blob:http://127.0.0.1:8080/abc', 'http://127.0.0.1:8080/x'));
check('blob: another site\'s is refused (host, scheme, port)', !isSameOriginBlob('blob:https://evil.example/abc', 'https://canvas.example.edu/') && !isSameOriginBlob('blob:http://canvas.example.edu/abc', 'https://canvas.example.edu/') && !isSameOriginBlob('blob:https://canvas.example.edu:8443/abc', 'https://canvas.example.edu/'));
check('blob:null and an opaque opener are refused', !isSameOriginBlob('blob:null/abc', 'https://canvas.example.edu/') && !isSameOriginBlob('blob:null/abc', 'null') && !isSameOriginBlob('blob:https://a.test/abc', 'about:blank') && !isSameOriginBlob('blob:https://a.test/abc', 'file:///C:/x.html'));
check('not a blob, or garbage, is refused', !isSameOriginBlob('https://a.test/x', 'https://a.test/') && !isSameOriginBlob('', 'https://a.test/') && !isSameOriginBlob('blob:', 'https://a.test/') && !isSameOriginBlob('blob:https://a.test/x', undefined));

// main.js wires the nudge where a PDF tab is shown, resized and its window restored; and the blob rule into window.open
const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
check('main.js pokes a PDF tab when shown, when its bounds change and when the window is restored', /if \(show\) pokePdf\(tab\)/.test(main) && /pdfBoundsKey !== boundsKey\) \{ if \(tab\.pdfBoundsKey !== undefined\) pokePdf\(tab\)/.test(main) && /\['restore', 'show'\]\) w\.on\(ev, \(\) => withWindow\(rec, \(\) => pokePdf/.test(main));
check('main.js lets window.open take a same-origin blob', /ownBlob = target\.startsWith\('blob:'\) && require\('\.\/features\/pdf-repaint'\)\.isSameOriginBlob\(target, wc\.getURL\(\)\)/.test(main) && /isWebUrl\(target\) \|\| ownBlob \|\| target === 'about:blank'\)\) \{/.test(main));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

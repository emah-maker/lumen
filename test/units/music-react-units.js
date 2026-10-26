// Music-reactive home screen and music cards that react, pure logic (features/music-react.js, features/music-react-source.js) and the wiring around
// them: the analyser-to-picture mapping, the field of dots (bursts, swirl, twinkle, limits), the flash-rate ceiling, who may run (the home screen, a card,
// both, neither), what the browser will and will not hand the page, the contrast the picture leaves the text, and that everything is off by default and
// the page loads nothing until one is on. No Electron window, no audio, no network.
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const MR = require('../../src/features/music-react');
const SRC = require('../../src/features/music-react-source');
const TC = require('../../src/features/theme-colors');
const BG = require('../../src/features/backgrounds');
const SB = require('../../src/settings/settings-backend');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');

// A spectrum of 512 bytes at 48 kHz / fft 1024 (46.875 Hz a bin): `fill(hz)` gives the byte for each bin's frequency.
const SR = 48000; const FFT = 1024;
const spectrum = (fill) => Uint8Array.from({ length: FFT / 2 }, (_, i) => fill((i * SR) / FFT));

// ---- bands ----
const bass = MR.bandsOf(spectrum((hz) => (hz >= 40 && hz <= 200 ? 255 : 0)), SR, FFT);
check('bands: a bass-only sound is bass, not mids or highs', bass.bass > 0.5 && bass.mids === 0 && bass.highs === 0 && bass.level > 0, JSON.stringify(bass));
const mids = MR.bandsOf(spectrum((hz) => (hz >= 500 && hz <= 3000 ? 200 : 0)), SR, FFT);
check('bands: a mid-range sound is mids only', mids.mids > 0.5 && mids.bass === 0 && mids.highs === 0, JSON.stringify(mids));
const highs = MR.bandsOf(spectrum((hz) => (hz >= 4000 && hz <= 16000 ? 180 : 0)), SR, FFT);
check('bands: treble is highs only', highs.highs > 0.6 && highs.bass === 0 && highs.mids === 0, JSON.stringify(highs));
check('bands: silence and bad input are all zeros, never NaN', JSON.stringify(MR.bandsOf(new Uint8Array(512), SR, FFT)) === '{"level":0,"bass":0,"mids":0,"highs":0}'
  && MR.bandsOf(null, SR, FFT).level === 0 && MR.bandsOf(new Uint8Array(512), 0, FFT).level === 0 && MR.bandsOf(new Uint8Array(0), SR, FFT).bass === 0, '');
check('bands: every number is within 0..1', Object.values(MR.bandsOf(spectrum(() => 255), SR, FFT)).every((v) => v >= 0 && v <= 1), '');
check('silence: a frame with nothing in any band is silent, a single steady tone is not', MR.isSilent({ bass: 0, mids: 0, highs: 0 }) && MR.isSilent({ bass: 0.02, mids: 0.01, highs: 0 }) && !MR.isSilent({ bass: 0.1, mids: 0, highs: 0 }) && MR.isSilent(null), '');

// ---- the flash ceiling ----
check('flash: the ceiling is 3 a second or less', MR.MAX_FLASH_HZ <= 3 && 1000 / MR.MIN_RISE_GAP_MS <= 3 && 1000 / MR.MIN_BEAT_GAP_MS <= 3 && MR.TWINKLE_MAX_HZ <= 3, `${MR.MAX_FLASH_HZ} ${MR.MIN_RISE_GAP_MS} ${MR.MIN_BEAT_GAP_MS}`);
const worstPerSecond = (times) => { let w = 0; for (const a of times) w = Math.max(w, times.filter((b) => b >= a && b < a + 1000).length); return w; };
{
  const lim = MR.flashLimiter(3);
  const allowed = []; for (let t = 0; t < 3000; t += 10) if (lim.allow(t)) allowed.push(t);
  check('flash limiter: never more than 3 in any second, however often it is asked', worstPerSecond(allowed) <= 3 && allowed.length >= 8, `${worstPerSecond(allowed)} ${allowed.length}`);
}
function beatsFor(periodMs, seconds = 10) {
  const det = MR.beatDetector(); const hits = [];
  for (let t = 0; t < seconds * 1000; t += 16) { const kick = t % periodMs < 48; if (det.push(t, kick ? 0.9 : 0.05)) hits.push(t); }
  return hits;
}
const slow = beatsFor(500);
check('beats: a 2 Hz kick is found nearly every time', slow.length >= 17 && slow.length <= 21, String(slow.length));
const fast = beatsFor(83);
check('beats: a 12 Hz kick still gives at most 3 beats in any second', worstPerSecond(fast) <= 3 && fast.length > 0, `${worstPerSecond(fast)} of ${fast.length}`);
check('beats: steady loud bass with no hits is no beat at all', (() => { const d = MR.beatDetector(); let n = 0; for (let t = 0; t < 5000; t += 16) if (d.push(t, 0.7)) n++; return n <= 1; })(), '');
check('beats: quiet music has beats too (the bass is judged against its own ceiling)', (() => { const d = MR.beatDetector(); let n = 0; for (let t = 0; t < 8000; t += 16) if (d.push(t, t % 500 < 48 ? 0.1 : 0.01)) n++; return n >= 12; })(), '');

// ---- the mapper ----
function run(frameAt, ms, step = 16) {
  const m = MR.createMapper(); const det = MR.beatDetector(); const out = [];
  for (let t = 0; t <= ms; t += step) {
    const f = frameAt(t);
    out.push({ t, ...m.step(f ? { ...f, beat: det.push(t, f.bass) } : null, t) });
  }
  return out;
}
const KEYS = ['bass', 'mids', 'highs', 'level', 'beat'];
const loud = run(() => ({ bass: 1, mids: 1, highs: 1, level: 1 }), 4000);
check('map: every output is within 0..1, whatever the input', loud.every((o) => KEYS.every((k) => o[k] >= 0 && o[k] <= 1)), '');
check('map: loud bass, mids and highs fill their outputs', loud.at(-1).bass > 0.9 && loud.at(-1).mids > 0.9 && loud.at(-1).highs > 0.9, JSON.stringify(loud.at(-1)));
const quiet = run((t) => (t < 2000 ? { bass: 1, mids: 1, highs: 1, level: 1 } : { bass: 0, mids: 0, highs: 0, level: 0 }), 6000);
check('map: after the music stops everything fades out smoothly', quiet.at(-1).bass < 0.02 && quiet.at(-1).mids < 0.02 && quiet.at(-1).highs < 0.02, JSON.stringify(quiet.at(-1)));
check('map: no single frame moves an output by more than a fifth', Math.max(...quiet.slice(1).map((o, i) => Math.abs(o.bass - quiet[i].bass))) <= 0.2, '');
const quietBeats = run((t) => (t % 500 < 100 ? { bass: 0.12, mids: 0.05, highs: 0.03, level: 0.05 } : { bass: 0.01, mids: 0.01, highs: 0.01, level: 0.01 }), 8000);
const tail = quietBeats.filter((o) => o.t > 4000);
check('map: quiet music still moves the page (automatic gain: its beats swing the bass over most of the range)', Math.max(...tail.map((o) => o.bass)) - Math.min(...tail.map((o) => o.bass)) > 0.4, '');
const idle = run(() => null, 24000, 40);
check('map: idle is a gentle drift: low, no beat, and far slower than a flash', Math.max(...idle.map((o) => o.bass)) <= 0.3 && idle.every((o) => o.beat === 0) && Math.max(...idle.slice(1).map((o, i) => Math.abs(o.bass - idle[i].bass))) < 0.05, '');
check('map: the beat value jumps on a kick and decays between kicks', (() => { const k = run((t) => (t % 500 < 60 ? { bass: 0.9, mids: 0.3, highs: 0.2, level: 0.6 } : { bass: 0.1, mids: 0.1, highs: 0.1, level: 0.2 }), 5000); return Math.max(...k.map((o) => o.beat)) > 0.9 && k.some((o) => o.beat < 0.1); })(), '');
function swings(outs, key, hi = 0.5, lo = 0.25) { const ups = []; let armed = true; for (const o of outs) { if (armed && o[key] > hi) { ups.push(o.t); armed = false; } else if (!armed && o[key] < lo) armed = true; } return ups; }
for (const [hz, step] of [[2, 8], [4, 8], [8, 8], [12, 8], [20, 8], [8, 33], [12, 33], [12, 66]]) {
  const period = 1000 / hz;
  const o = run((t) => (t % period < period / 2 ? { bass: 1, mids: 1, highs: 1, level: 1 } : { bass: 0, mids: 0, highs: 0, level: 0 }), 10000, step);
  const worst = Math.max(...['bass', 'mids', 'highs', 'beat'].map((k) => worstPerSecond(swings(o, k).map((x) => x))));
  check(`flash rate: a ${hz} Hz on/off sound read every ${step} ms never makes the bass, mids, highs or beat flash more than 3 times in a second`, worst <= 3, String(worst));
}

// ---- the field of dots ----
const BOUNDS = (f) => { for (let i = 0; i < f.n; i++) if (!(f.x[i] >= -41 && f.x[i] <= f.w + 41 && f.y[i] >= -41 && f.y[i] <= f.h + 41)) return false; return true; };
const meanBurst = (f) => { let s = 0; for (let i = 0; i < f.n; i++) s += Math.hypot(f.bx[i], f.by[i]); return s / f.n; };
check('field: 180 dots for the full version, 40 for the reduced one', MR.COUNTS.full === 180 && MR.COUNTS.reduced === 40 && MR.createField(MR.COUNTS.full, 1920, 1080).n === 180, '');
{
  const a = MR.createField(60, 800, 600, 3); const b = MR.createField(60, 800, 600, 3);
  check('field: it starts the same way every time (a fixed seed)', a.x.every((v, i) => v === b.x[i]) && a.r.every((v, i) => v === b.r[i]), '');
  const f = MR.createField(180, 1920, 1080);
  const rest = []; for (let i = 0; i < 120; i++) { f.step(1 / 30, { bass: 0, mids: 0, highs: 0, beat: false }); rest.push(meanBurst(f)); }
  check('field: at rest the dots only drift (no burst velocity at all) and stay on the page', rest.every((v) => v === 0) && BOUNDS(f), '');
  let speed = 0; for (let i = 0; i < f.n; i++) speed += Math.hypot(f.vx[i], f.vy[i]); speed /= f.n;
  check('field: the drift is slow (5 to 19 px/s)', speed > 5 && speed < 19, String(speed));
  const g = MR.createField(180, 1920, 1080);
  g.step(1 / 30, { bass: 1, mids: 0, highs: 0, beat: true });
  const burst0 = meanBurst(g);
  const radial = (() => { let s = 0; for (let i = 0; i < g.n; i++) { const dx = g.x[i] - g.cx; const dy = g.y[i] - g.cy; s += (g.bx[i] * dx + g.by[i] * dy) / Math.hypot(dx, dy); } return s / g.n; })();
  check('field: on a beat the dots burst outward from the centre (a fast, outward push)', burst0 > 150 && radial > 100, `${burst0} ${radial}`);
  const decay = []; for (let i = 0; i < 90; i++) { g.step(1 / 30, { bass: 0, mids: 0, highs: 0, beat: false }); decay.push(meanBurst(g)); }
  check('field: the burst dies away within about two seconds', decay[59] < burst0 * 0.1 && decay[89] < burst0 * 0.05, `${burst0} ${decay[59]} ${decay[89]}`);
  const tiny = MR.createField(60, 800, 600); for (let i = 0; i < 100; i++) tiny.step(1 / 30, { bass: 0.1, mids: 0, highs: 0, beat: 1e-6 * (100 - i) });
  check('field: a fading beat value that is not a beat (it never reaches zero) does not burst the dots again and again', meanBurst(tiny) === 0, String(meanBurst(tiny)));
  const twice = MR.createField(60, 800, 600); twice.step(1 / 30, { bass: 1, mids: 0, highs: 0, beat: 1 }); const b1 = meanBurst(twice); twice.step(1 / 30, { bass: 1, mids: 0, highs: 0, beat: 0.8 });
  check('field: one beat is one burst (the frames after it, while its value fades, add nothing)', b1 > 100 && meanBurst(twice) < b1, `${b1} ${meanBurst(twice)}`);
  const cap = MR.createField(180, 1920, 1080); let maxB = 0; for (let i = 0; i < 300; i++) { cap.step(1 / 30, { bass: 1, mids: 1, highs: 1, beat: i % 15 === 0 }); for (let k = 0; k < cap.n; k++) maxB = Math.max(maxB, Math.hypot(cap.bx[k], cap.by[k])); }
  check('field: the burst speed is capped (720 px/s) and the dots never leave the page', maxB <= 721 && BOUNDS(cap), String(maxB));
  const sw = MR.createField(180, 1920, 1080); for (let i = 0; i < 20; i++) sw.step(1 / 30, { bass: 0, mids: 1, highs: 0, beat: false });
  const tang = (() => { let s = 0; for (let i = 0; i < sw.n; i++) { const dx = sw.x[i] - sw.cx; const dy = sw.y[i] - sw.cy; s += (-sw.bx[i] * dy + sw.by[i] * dx) / Math.hypot(dx, dy); } return s / sw.n; })();
  const radial2 = (() => { let s = 0; for (let i = 0; i < sw.n; i++) { const dx = sw.x[i] - sw.cx; const dy = sw.y[i] - sw.cy; s += (sw.bx[i] * dx + sw.by[i] * dy) / Math.hypot(dx, dy); } return s / sw.n; })();
  check('field: the mids swirl the dots round the centre (sideways, not outward)', tang > 20 && Math.abs(radial2) < tang * 0.3, `${tang} ${radial2}`);
  const sp = (hi) => { const x = MR.createField(180, 1920, 1080); let n = 0; for (let i = 0; i < 90; i++) { x.step(1 / 30, { bass: 0, mids: 0, highs: hi, beat: false }); for (let k = 0; k < x.n; k++) if (x.spark[k] > 0.9) n++; } return n; };
  check('field: the highs make dots twinkle (sparks), and no highs, none', sp(1) > 15 && sp(0) === 0, `${sp(1)} ${sp(0)}`);
  const fast2 = MR.createField(180, 1920, 1080); const slow2 = MR.createField(180, 1920, 1080);
  for (let i = 0; i < 30; i++) { fast2.step(1 / 30, { bass: 1, mids: 0, highs: 0, beat: false }); slow2.step(1 / 30, { bass: 0, mids: 0, highs: 0, beat: false }); }
  const d = (x) => { let s = 0; for (let i = 0; i < x.n; i++) s += Math.hypot(x.vx[i], x.vy[i]); return s; };
  check('field: the bass makes the dots swell and the drift faster', fast2.bass > 0.9 && slow2.bass < 0.01 && fast2.x.some((v, i) => Math.abs(v - slow2.x[i]) > 20), `${fast2.bass}`);
  void d;
  // what is drawn: the opacity never passes its cap, the size grows with the bass, the twinkle is no faster than 1.2 Hz and never jumps
  const out = { x: 0, y: 0, r: 0, a: 0 };
  for (const tone of ['plain', 'media']) {
    const h = MR.createField(180, 1920, 1080); let worstA = 0; let worstStep = 0; const prev = new Float32Array(h.n); let maxR = 0;
    for (let s = 0; s < 600; s++) {
      h.step(1 / 30, { bass: s % 15 < 4 ? 1 : 0.2, mids: 0.6, highs: 1, beat: s % 15 === 0 });
      for (let i = 0; i < h.n; i++) { h.look(i, tone, out); worstA = Math.max(worstA, out.a); if (s > 0) worstStep = Math.max(worstStep, Math.abs(out.a - prev[i])); prev[i] = out.a; maxR = Math.max(maxR, out.r / h.r[i]); }
    }
    check(`field: ${tone}: no dot is ever more opaque than ${MR.DOT_CAP[tone]}, and none changes by more than a fifth of that between two frames`, worstA <= MR.DOT_CAP[tone] + 1e-6 && worstStep <= MR.DOT_CAP[tone] * 0.2, `${worstA} ${worstStep}`);
    check(`field: ${tone}: a dot swells to 2.1 times its size at the most`, maxR <= 2.1 + 1e-6 && maxR > 1.3, String(maxR));
  }
  const rz = MR.createField(10, 1000, 500); const x0 = rz.x[0]; rz.resize(2000, 1000);
  check('field: resizing moves the dots with the window', Math.abs(rz.x[0] - x0 * 2) < 1e-3 && rz.w === 2000 && rz.cx === 1000, '');
}
check('column: a tenth of the picture is left behind the content column, all of it beyond the edge, and it eases in between', MR.columnGain(960, 960, 640) === MR.COLUMN_GAIN && MR.COLUMN_GAIN === 0.1 && MR.columnGain(960 + 320 + 90, 960, 640) === 1 && MR.columnGain(960 + 320 + 45, 960, 640) > 0.4 && MR.columnGain(960 + 320 + 45, 960, 640) < 0.7, '');
check('demo: Preview\'s made-up beat has a kick every half second, hats between and a swell, and the detector finds the kicks', (() => { const det = MR.beatDetector(); let n = 0; for (let t = 0; t < 10000; t += 33) { const b = MR.demoFrame(t); if (det.push(t, b.bass)) n++; if (!KEYS.filter((k) => k !== 'beat').every((k) => b[k] >= 0 && b[k] <= 1)) return false; } return n >= 16 && n <= 21; })(), '');

// ---- who may run ----
const on = { musicReactive: true, still: false, reduceMotion: false, light: false, soft: false, lite: false };
const off = { ...on, musicReactive: false };
check('mode: full when on and nothing limits it', MR.modeOf(on, false) === 'full' && MR.motionAllowed(on, false) === true, '');
check('mode: off when the setting is off or the look is missing', MR.modeOf(off, false) === 'off' && MR.modeOf(null, false) === 'off' && MR.motionAllowed(null, false) === false, '');
check('mode: Reduce motion (the system\'s or Settings\') and Performance mode turn it off fully', MR.modeOf(on, true) === 'off' && MR.modeOf({ ...on, reduceMotion: true }, false) === 'off' && MR.modeOf({ ...on, lite: true }, false) === 'off', '');
check('mode: Visual effects: Light and software drawing give the reduced version, not nothing', MR.modeOf({ ...on, light: true }, false) === 'reduced' && MR.modeOf({ ...on, light: true, soft: true, still: true }, false) === 'reduced', '');
check('mode: software drawing\'s "still" is not Reduce motion (the setting itself is look.reduceMotion)', MR.modeOf({ ...on, soft: true, light: true, still: true, reduceMotion: false }, false) === 'reduced', '');
check('mode: Reduce motion and Performance mode beat Light (off, not reduced)', MR.modeOf({ ...on, light: true, reduceMotion: true }, false) === 'off' && MR.modeOf({ ...on, light: true, lite: true }, false) === 'off', '');
check('reduced: at most 15 frames a second', MR.REDUCED_MS >= 66, String(MR.REDUCED_MS));
{
  for (const [hz, step] of [[4, MR.REDUCED_MS], [8, MR.REDUCED_MS], [12, MR.REDUCED_MS]]) {
    const period = 1000 / hz;
    const o = run((t) => (t % period < period / 2 ? { bass: 1, mids: 1, highs: 1, level: 1 } : { bass: 0, mids: 0, highs: 0, level: 0 }), 10000, step);
    check(`reduced: read every ${step} ms a ${hz} Hz on/off sound flashes at most 3 times a second`, Math.max(...['bass', 'mids', 'highs', 'beat'].map((k) => worstPerSecond(swings(o, k)))) <= 3, '');
  }
}
{
  const P = (look, cards, rm = false) => MR.plan(look, cards, rm);
  check('plan: the home screen alone starts the analyser (no card needed)', JSON.stringify(P(on, false)) === '{"bg":"full","cards":"off","listen":true}', JSON.stringify(P(on, false)));
  check('plan: a reacting card alone starts the analyser, with the home screen off (no canvas)', JSON.stringify(P(off, true)) === '{"bg":"off","cards":"full","listen":true}', JSON.stringify(P(off, true)));
  check('plan: both on: one analyser for both', JSON.stringify(P(on, true)) === '{"bg":"full","cards":"full","listen":true}', JSON.stringify(P(on, true)));
  check('plan: both off: nothing runs', JSON.stringify(P(off, false)) === '{"bg":"off","cards":"off","listen":false}' && P(null, false).listen === false, '');
  check('plan: Reduce motion (either one) and Performance mode turn both off, listening included', [P(on, true, true), P({ ...on, reduceMotion: true }, true), P({ ...on, lite: true }, true)].every((p) => p.listen === false && p.bg === 'off' && p.cards === 'off'), '');
  check('plan: Light and software drawing: both simplified, still listening', P({ ...on, light: true }, true).bg === 'reduced' && P({ ...on, light: true }, true).cards === 'reduced' && P({ ...off, soft: true, light: true }, true).cards === 'reduced', '');
}

// ---- what the browser hands the page ----
{
  const wc = (id, url) => ({ id, isDestroyed: () => false, getURL: () => url });
  const page = wc(100, 'file:///app/renderer/newtab.html#x');
  let enabled = true; let t = 1000;
  const mk = (platform = 'win32') => SRC.create({ isNewTab: (u) => u.startsWith('file:///app/renderer/newtab.html'), enabled: () => enabled, now: () => t, platform });
  const ask = (o = {}) => ({ mediaTypes: [], isMainFrame: true, ...o }); // (what Chromium asks for getDisplayMedia: 'media' with no media type)
  check('source: Windows says yes to the new-tab page, and the page is told why when it cannot (not Windows, setting off)', mk().start(page).ok === true && mk('darwin').start(page).why === 'platform' && mk('linux').supported() === false && mk().supported() === true && (() => { enabled = false; const r = mk().start(page); enabled = true; return r.ok === false && r.why === 'off'; })(), '');
  check('source: a destroyed asker gets nothing', mk().start({ ...page, isDestroyed: () => true }).ok === false, '');
  const g = mk(); g.start(page);
  check('permission: getDisplayMedia (display-capture, or media with no media type) for the new-tab page with a live grant', g.allowsDisplay(page, 'display-capture', ask()) === true && g.allowsDisplay(page, 'media', ask()) === true, '');
  check('permission: never the microphone or the camera (a request that names its type), never a sub-frame', g.allowsDisplay(page, 'media', ask({ mediaTypes: ['audio'] })) === false && g.allowsDisplay(page, 'media', ask({ mediaTypes: ['video'] })) === false && g.allowsDisplay(page, 'media', { mediaTypes: [], mediaType: 'audio' }) === false && g.allowsDisplay(page, 'display-capture', ask({ isMainFrame: false })) === false, '');
  check('permission: nothing else (notifications, location, other app)', ['notifications', 'geolocation', 'clipboard-read', 'openExternal', 'fullscreen'].every((p) => g.allowsDisplay(page, p, ask()) === false), '');
  check('permission: not for any other page, and not for the new-tab page without a grant', g.allowsDisplay(wc(5, 'https://evil.example/'), 'media', ask()) === false && mk().allowsDisplay(page, 'media', ask()) === false, '');
  check('permission: not once the asking page is no longer the new-tab page, and never off Windows', (() => { const m = mk(); const away = { ...page, getURL: () => 'https://example.com/' }; m.start(away); const n = mk('darwin'); n.start(page); return m.allowsDisplay(away, 'media', ask()) === false && n.allowsDisplay(page, 'media', ask()) === false; })(), '');
  check('display: the display-media handler uses the grant up (one stream per grant), for the top frame only', (() => { const m = mk(); m.start(page); return m.takeDisplay(page, false) === false && m.takeDisplay(page, true) === true && m.takeDisplay(page, true) === false; })(), '');
  check('display: not for another page, and not without a grant', (() => { const m = mk(); m.start(page); return m.takeDisplay(wc(7, 'https://example.com/'), true) === false && mk().takeDisplay(page, true) === false; })(), '');
  const h = mk(); h.start(page); t += SRC.GRANT_MS + 1;
  check('permission: the grant expires', h.allowsDisplay(page, 'media', ask()) === false && h.takeDisplay(page, true) === false, '');
  const o = mk(); o.start(page); enabled = false;
  check('permission: switching the setting off ends it at once', o.allowsDisplay(page, 'media', ask()) === false && o.takeDisplay(page, true) === false, ''); enabled = true;
}

// ---- the text keeps its contrast ----
{
  const MUTED = { light: '#66666b', dark: '#a1a1a6' }; const TEXT = { light: '#1d1d1f', dark: '#f5f5f7' }; // newtab.html's :root tokens
  // Behind the content column: two dots and the glow at their ceilings, over the same pixel, then cut to a tenth. Beyond it, in glass cards, the whole canvas
  // is shown at the opacity newtab.html gives it there.
  const css = read('src/renderer/newtab.html');
  const glass = Number(/data-wglass="clear"\] #mr-canvas \{ opacity: ([0-9.]+); \}/.exec(css)?.[1]);
  const stackColumn = (tone) => (2 * MR.DOT_CAP[tone] + MR.FLOW_CAP[tone]) * MR.COLUMN_GAIN;
  const stackGlass = (tone) => (MR.DOT_CAP[tone] + MR.FLOW_CAP[tone]) * glass;
  const worst = (stack) => {
    let worstMuted = 99; let worstText = 99; let who = '';
    for (const id of TC.ACCENT_IDS) {
      const pair = TC.ACCENTS[id]; if (!pair) continue;
      for (const mode of ['light', 'dark']) {
        const accent = TC.tokensFor(pair[mode === 'light' ? 0 : 1], mode).accent;
        for (const surface of TC.SURFACES[mode]) {
          const b = TC.over(accent, stack, surface);
          const m = TC.contrast(MUTED[mode], b); const x = TC.contrast(TEXT[mode], b);
          if (m < worstMuted) { worstMuted = m; who = `${id} ${mode}`; }
          worstText = Math.min(worstText, x);
        }
      }
    }
    return { worstMuted, worstText, who };
  };
  const wc1 = worst(stackColumn('plain'));
  check('contrast: behind the content column on Plain, two dots and the glow at their ceilings leave secondary text 4.5:1 or better on every accent, light and dark', wc1.worstMuted >= 4.5, `${wc1.worstMuted.toFixed(2)} (${wc1.who})`);
  check('contrast: and body text 7:1 or better', wc1.worstText >= 7, wc1.worstText.toFixed(2));
  check('contrast: the canvas is shown at a fraction in Frosted and Clear cards, which let the page through', glass > 0 && glass <= 0.3, String(glass));
  const wc2 = worst(stackGlass('plain'));
  check('contrast: ...and one dot with the glow at that fraction leaves secondary text 4.5:1 or better there too', wc2.worstMuted >= 4.5, `${wc2.worstMuted.toFixed(2)} (${wc2.who})`);
  const wc3 = worst(MR.CARD_HALO_CAP.plain);
  check('contrast: a reacting card\'s glow at its ceiling leaves secondary text 4.5:1 or better on every accent', wc3.worstMuted >= 4.5, `${wc3.worstMuted.toFixed(2)} (${wc3.who})`);
  let dropMedia = -1; let whoMedia = '';
  const dropFor = (stack) => { let w = -1; let who = ''; for (const b of BG.BACKGROUNDS) { if (b.tone !== 'dark' || !b.seed) continue; for (const id of TC.ACCENT_IDS) { const pair = TC.ACCENTS[id]; if (!pair) continue; const accent = TC.tokensFor(pair[1], 'dark').accent; const drop = 1 - TC.contrast('#ffffff', TC.over(accent, stack, b.seed)) / TC.contrast('#ffffff', b.seed); if (drop > w) { w = drop; who = `${b.id} ${id}`; } } } return { w, who }; };
  ({ w: dropMedia, who: whoMedia } = dropFor(stackColumn('media')));
  check('contrast: over a dark background the picture behind the column lowers the contrast of white text by no more than 15 % of what the background has by itself', dropMedia <= 0.15, `${(dropMedia * 100).toFixed(1)} % (${whoMedia})`);
  const dg = dropFor(stackGlass('media'));
  check('contrast: ...and in glass cards there too', dg.w <= 0.15, `${(dg.w * 100).toFixed(1)} % (${dg.who})`);
  const dc = dropFor(MR.CARD_HALO_CAP.media);
  check('contrast: ...and a reacting card\'s glow at its ceiling', dc.w <= 0.15, `${(dc.w * 100).toFixed(1)} % (${dc.who})`);
  check('contrast: the numbers in newtab.html are the ones tested here (card glow 7 % / 11 %, cover swell 4 %, clock bounce 1.2 %)', css.includes(`opacity: calc(var(--mr-halo, 0) * ${MR.CARD_HALO_CAP.plain});`) && css.includes(`opacity: calc(var(--mr-halo, 0) * ${MR.CARD_HALO_CAP.media});`) && css.includes(`scale: calc(1 + var(--mr-pulse, 0) * ${MR.CARD_PULSE});`) && css.includes(`scale: calc(1 + var(--mr-beat, 0) * ${MR.BOUNCE});`), '');
}

// ---- the setting, the page, the wiring ----
check('setting: off by default, a boolean', SB.DEFAULTS.newTabMusicReactive === false && SB.validate('newTabMusicReactive', true) === true && SB.validate('newTabMusicReactive', 'yes') === null, '');
check('setting: the page is told only a literal true', /musicReactive: p\.newTabMusicReactive === true/.test(read('src/settings/settings-backend.js')) && /musicReactive: look\.musicReactive === true/.test(read('src/renderer/newtab.js')), '');
const page = read('src/renderer/newtab.html'); const js = read('src/renderer/newtab.js'); const drv = read('src/renderer/newtab-music-react.js'); const cvs = read('src/renderer/music-field-canvas.js');
check('page: nothing of it is loaded until one of them is on (not in the page\'s script list), and then three scripts load in turn', !/music-react|music-field/.test(page.slice(page.indexOf('<script src'))) && /if \(!\(look\.musicReactive \|\| document\.querySelector\('\.w-card\[data-mreact="1"\]'\)\) \|\| musicScripts\) return;/.test(js) && /load\('\.\.\/features\/music-react\.js', \(\) => load\('music-field-canvas\.js', \(\) => load\('newtab-music-react\.js'/.test(js), '');
check('page: the CSP is unchanged (no media-src, no new sources)', /default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:/.test(page), '');
check('page: the canvas is decorative: hidden from screen readers, never takes a click, behind the content, and it covers the window', /setAttribute\('aria-hidden', 'true'\)/.test(drv) && /#mr-canvas \{ position: fixed; inset: 0; z-index: -1; width: 100vw; height: 100vh; pointer-events: none; \}/.test(page), '');
check('page: the system\'s Reduce motion hides the canvas and the card glow in CSS too', /prefers-reduced-motion: reduce\) \{ #mr-canvas \{ display: none; \}/.test(page) && /\.w-card\[data-mreact="1"\]::after \{ display: none; \}/.test(page), '');
check('page: the card glow rims the edge and leaves the middle, where the text is, clear; only opacity and scale change', /radial-gradient\(farthest-corner at 50% 50%, transparent 58%, var\(--accent\) 100%\)/.test(page) && !/#mr-canvas \{[^}]*(filter|blur)/.test(page), '');
const code = drv.replace(/\/\/.*$/gm, '');
check('driver: it listens to the PC\'s output through getDisplayMedia (audio, the video it insists on stopped at once), never the microphone, never a tab', /getDisplayMedia\(\{ audio: true, video: true \}\)/.test(code) && /getVideoTracks\(\)\) \{ t\.stop\(\)/.test(code) && !/getUserMedia/.test(code) && !/chromeMediaSource/.test(code), '');
check('driver: this page is silent (no connection to anything that makes a sound) and nothing is recorded, stored or sent', !/destination/.test(code) && !/MediaRecorder|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage/.test(code) && (code.match(/ipcRenderer/g) || []).length === 0, '');
check('driver: it listens only while shown: hidden, no frames, no timer and the loopback is closed; and the stream ending closes it', /visibilitychange/.test(code) && /function pause\(\)/.test(code) && /stopCapture\(\);\n\s*\}/.test(code) && /'ended'/.test(code) && /!active \|\| document\.hidden/.test(code), '');
check('driver: one analyser serves the home screen and the cards, decided again by plan() whenever the look, a card or Reduce motion changes', /MR\.plan\(look, hasCards\(\), reduced\.matches\)/.test(code) && /window\.musicCardsChanged = /.test(code) && !/getDisplayMedia[\s\S]*getDisplayMedia/.test(code) && /if \(!p\.listen\) \{[^}]*stop\(\); return; \}/.test(code), '');
check('driver: frames are throttled (about 30 a second live, 20 idle, 15 in the reduced mode) and the cover and glow are two variables on the card itself', /LIVE_MS = 33/.test(code) && /IDLE_MS = 50/.test(code) && /MR\.REDUCED_MS/.test(code) && /'--mr-halo'/.test(code) && /'--mr-pulse'/.test(code), '');
check('driver: the reduced mode has no clock bounce and no cover pulse', /bgMode === 'full' \? document\.getElementById\('clock-card'\)/.test(code) && /cardMode === 'full' \? q3\(pulse\) : '0\.000'/.test(code), '');
check('canvas: one 2D canvas, sized by the screen\'s pixel ratio and a pixel budget, nothing allocated per frame', /getContext\('2d'\)/.test(cvs) && /MAX_PIXELS = 1\.6e6/.test(cvs) && /Math\.min\(Math\.max\(dpr \|\| 1, 1\), 1\)/.test(cvs) && !/new Float32Array|new Array|\.map\(\(\) =>/.test(cvs.split('draw(t, c, dt)')[1] || ''), '');
const preload = read('src/preload/newtab-preload.js');
check('preload: the new-tab page\'s own preload carries it (the main preload is untouched)', /musicSource/.test(preload) && !/newtab-music/.test(read('src/preload/preload.js')), '');
const main = read('src/main.js');
check('main: only the new-tab page\'s top frame is answered, only with the setting on or a card asking, and only on Windows', /ipcMain\.handle\('newtab-music:source', \(event\) => \{\s*if \(!newTabTab\(event\)\) return \{ ok: false, why: 'off' \};\s*const r = musicReact\.start\(event\.sender\);/.test(main) && /musicReactOn = \(\) => /.test(main), '');
check('main: the permission handlers and the display-media handler ask the same module first, and hand the page the output loopback', /musicReact\.allowsDisplay\(wc, permission, details\)\) return callbackAsked\(true\)/.test(main) && /musicReact\.takeDisplay\(wc, request\.frame === wc\.mainFrame\)\) return callback\(\{ audio: 'loopback'/.test(main), '');
check('main: the loopback runs when the home screen is on or a card reacts (the setting the cards turn on lives with the cards)', /const musicReactOn = \(\) => readSettings\(\)\.newTabMusicReactive === true \|\| musicCardsOn\(\)/.test(main), '');
const en = JSON.parse(read('src/locales/en.json'));
const settingsJs = read('src/renderer/settings.js');
check('locale: the setting, its notes, the Preview and the cards\' option have strings', ['label', 'desc', 'offMotion', 'offPerformance', 'lightSoftware', 'lightChosen', 'lightAuto', 'linkLight', 'platform', 'preview', 'previewStop'].every((k) => typeof en['settings.musicReactive.' + k] === 'string' && settingsJs.includes('settings.musicReactive.' + k)) && typeof en['settings.widgets.react.label'] === 'string' && typeof en['settings.widgets.react.desc'] === 'string', '');
check('settings: the description says plainly what it reacts to, and that nothing is recorded or sent', /reacts to the sound your PC is playing/.test(en['settings.musicReactive.desc']) && /nothing is recorded or sent/.test(en['settings.musicReactive.desc']) && /microphone is never used/.test(en['settings.musicReactive.desc']), en['settings.musicReactive.desc']);
check('settings: a labelled switch and a Preview in Settings, and none on the home page or the music widget\'s own page', /toggle\('newTabMusicReactive', tr\('settings\.musicReactive\.label'/.test(settingsJs) && /id: 'music-reactive-preview'/.test(settingsJs) && !/newTabMusicReactive/.test(page), '');
check('settings: the note under the switch says why it is limited, in the same cases as the page, and says it is Windows only elsewhere', /st\.prefs\?\.reduceMotion\) text/.test(settingsJs) && /st\.performance\?\.active\) text/.test(settingsJs) && /st\.platform !== 'win32'\) text/.test(settingsJs) && /id: 'music-reactive-note'/.test(settingsJs), '');
check('settings: the Light note links to Visual effects, which the page can route to; the note follows the three settings that decide it', /location\.hash = '#visual-effects'/.test(settingsJs) && /'visual-effects': \{ cat: 'advanced', sub: 'system', focusEl: '#pref-graphicsMode' \}/.test(settingsJs) && /\['reduceMotion', 'performanceMode', 'graphicsMode'\]\.includes\(e\.detail\.key\)/.test(settingsJs), '');
check('settings: Preview draws the page\'s own dots with a made-up beat, loads its scripts only when pressed and stops by itself', /MusicReact\.demoFrame\(t\)/.test(settingsJs) && /loadScript\('\.\.\/features\/music-react\.js'\)/.test(settingsJs) && /t > 10000\) \{ stopPreview\(\)/.test(settingsJs) && !/music-react|music-field/.test(read('src/renderer/settings.src.html')), '');
check('cards: a Spotify (all three modes) and an Apple Music card have "React to music", off by default, in Settings and in the home page\'s own editor', (settingsJs.match(/settings\.widgets\.react\.label/g) || []).length === 2 && /same \? same\.react === true : false/.test(settingsJs) && /react: val\(inputs\.react\)/.test(settingsJs) && /s\.react === true \? 'on' : 'off'/.test(read('src/renderer/newtab-setup.js')) && /react: react\.value === 'on'/.test(read('src/renderer/newtab-setup.js')), '');
const widgets = read('src/features/widgets.js');
check('cards: the choice is kept with the card (every mode), is only a literal true, and reaches the page', (widgets.match(/react: input\.react === true/g) || []).length === 4 && /react: c\.react === true/.test(widgets) && /react: i\.react === true/.test(widgets) && /react: w\.react === true, layout/.test(widgets) && /applemusic: \(w\) => \(\{ mode: w\.mode, art: w\.art, app: w\.app, react: w\.react === true \}\)/.test(widgets), String((widgets.match(/react: input\.react === true/g) || []).length));
const wpage = read('src/renderer/newtab-widgets.js');
check('cards: the page marks only a Spotify or Apple Music card that asked, and tells the driver when the cards change', /w\.react === true && \(w\.type === 'spotify' \|\| w\.type === 'applemusic'\)\) card\.dataset\.mreact = '1'; else delete card\.dataset\.mreact/.test(wpage) && /window\.musicCardsChanged\?\.\(\);/.test(wpage) && /window\.musicCardsChanged = \(\) => applyMusicReactive\(currentLook\)/.test(js), '');
const priv = read('PRIVACY.md');
check('privacy: PRIVACY.md says it listens to the PC\'s sound (output loopback), derives only loudness numbers, and records, stores and sends nothing', /sound the PC is playing/.test(priv) && /loopback/i.test(priv) && /never uses the microphone/.test(priv) && /nothing leaves/.test(priv), '');

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('music-react units passed');

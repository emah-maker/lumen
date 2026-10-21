// [look] Music-reactive home screen (Settings → Appearance → New tab page): the maths between the audio analyser and the picture.
// Pure functions, no DOM, no Electron, no audio: used by renderer/newtab-music-react.js (which owns the analyser), renderer/music-field-canvas.js (which
// draws), Settings' Preview and the unit tests.
//
// What goes in is one frame of the analyser's frequency bytes. What comes out is a few numbers (bass, mids, highs, level, beat) and, from them, where a
// field of soft dots is. Nothing here ever sees the sound itself, and nothing is stored: a frame is read, reduced to those numbers and dropped.
//
// The picture is a living background: a field of soft dots in the accent's tones drifting slowly; on the beat they burst outward, the bass makes them
// swell and speed up, the mids swirl them round, the highs make them twinkle, and a soft glow flows behind them.
//
// Comfort rules, built into the numbers:
//   - The dots and the glow have opacity ceilings (DOT_CAP, FLOW_CAP, stronger over a dark background) and fade to a fifth of that behind the content
//     column (COLUMN_GAIN), so text keeps its contrast: test/units/music-react-units.js works the worst case out from the page's own colours.
//   - MIN_RISE_GAP_MS: a new rise can only start once per 360 ms (a swell that is already rising carries on), so nothing on the page can flash more
//     than 2.8 times a second, whatever the music does (a hi-hat roll at 12 Hz becomes a slow swell). Falling is always smooth.
//   - MIN_BEAT_GAP_MS: a beat at most every 400 ms (2.5 a second). A dot twinkles at 1.2 Hz at the most.
(function () {
'use strict';

const DOT_CAP = { plain: 0.22, media: 0.34 }; // the most opacity one dot reaches, on the page's own background (Plain, or a light one) / over a dark picture or gradient
const FLOW_CAP = { plain: 0.06, media: 0.12 }; // the same for the glow that flows behind the dots
const COLUMN_GAIN = 0.1; // behind the content column (the clock, greeting, search box and cards) the dots and glow are this much of that (the canvas carves it out)
const BOUNCE = 0.012; // the clock card grows by at most this share on a beat (CSS: scale: calc(1 + var(--mr-beat) * 0.012))
const CARD_HALO_CAP = { plain: 0.07, media: 0.11 }; // a music card that reacts: the most opacity of the accent glow round its edge (CSS: newtab.html, --mr-halo)
const CARD_PULSE = 0.04; // ...and the most its cover art swells on a beat (CSS: --mr-pulse)
const MIN_RISE_GAP_MS = 360;
const MIN_BEAT_GAP_MS = 400;
const REDUCED_MS = 66; // Light and software drawing: at most 15 frames a second
const MAX_FLASH_HZ = 3;
const TWINKLE_MAX_HZ = 1.2;
const COUNTS = { full: 180, reduced: 40 };
const BANDS = { bass: [20, 250], mids: [250, 4000], highs: [4000, 16000] };

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// The analyser's frequency bytes -> { level, bass, mids, highs }, each 0..1. `sampleRate` and `fftSize` say which bin is which frequency.
function bandsOf(bytes, sampleRate, fftSize) {
  const out = { level: 0, bass: 0, mids: 0, highs: 0 };
  if (!bytes || !bytes.length || !(sampleRate > 0) || !(fftSize > 0)) return out;
  const width = sampleRate / fftSize; // Hz per bin
  let total = 0;
  let count = 0;
  for (const name of Object.keys(BANDS)) {
    const [lo, hi] = BANDS[name];
    const from = Math.max(1, Math.ceil(lo / width));
    const to = Math.min(bytes.length - 1, Math.floor(hi / width));
    let sum = 0; let sq = 0;
    let n = 0;
    for (let i = from; i <= to; i++) { sum += bytes[i]; sq += bytes[i] * bytes[i]; n++; }
    out[name] = n ? clamp01(Math.sqrt(sq / n) / 255) : 0; // (the root of the mean square: one strong tone in a wide band still counts, as it does to the ear)
    total += sum;
    count += n;
  }
  out.level = count ? clamp01(total / count / 255) : 0;
  return out;
}

// At most `maxPerSec` events in any one second: allow(t) says whether one more may happen at time t (ms), and counts it if so.
function flashLimiter(maxPerSec = MAX_FLASH_HZ) {
  const times = [];
  return {
    allow(t) {
      while (times.length && t - times[0] >= 1000) times.shift();
      if (times.length >= maxPerSec) return false;
      times.push(t);
      return true;
    },
  };
}

// A beat is the bass jumping above its own recent average, no closer than MIN_BEAT_GAP_MS to the last one. The bass is judged against a slow
// ceiling of its own, so quiet music has beats too and loud music is not all beats.
function beatDetector() {
  const limiter = flashLimiter(MAX_FLASH_HZ);
  let avg = -1; // (seeded from the first frame: steady loud bass from the start is not a beat)
  let peak = 0.06;
  let last = -1e9;
  let prev = 0;
  return {
    // (t in ms, bass 0..1) -> true on a beat
    push(t, bass) {
      const dt = Math.min(250, Math.max(1, t - prev || 16));
      prev = t;
      peak = Math.max(0.06, bass, peak * Math.exp(-dt / 8000));
      const n = bass / peak; // 0..1 against the slow ceiling
      if (avg < 0) avg = n;
      const hit = n > 0.5 && n > avg * 1.28 + 0.04 && t - last >= MIN_BEAT_GAP_MS;
      avg += (n - avg) * (1 - Math.exp(-dt / 900));
      if (hit && limiter.allow(t)) { last = t; return true; }
      return false;
    },
  };
}

// Is this frame silence? (no band has anything in it; tonal sounds fill few bins, so the mean of all of them is no judge)
const isSilent = (b) => !b || Math.max(b.bass, b.mids, b.highs) < 0.03;

// One mapper per run: frames in (bands + a beat flag + the time), { bass, mids, highs, level, beat } out, each 0..1 and smoothed. A new rise can start
// once per MIN_RISE_GAP_MS (shared by the three bands); until then an output can only hold or fall.
// `null` (nothing is playing) drifts very slowly, well under 1 Hz.
function createMapper() {
  const peak = { bass: 0.06, mids: 0.025, highs: 0.025 }; // a slow ceiling per band (automatic gain): quiet music moves the page as much as loud music does
  const FLOOR = { bass: 0.06, mids: 0.025, highs: 0.025 }; // (a band's own floor: broad bands hold less of a single tone)
  const cur = { bass: 0, mids: 0, highs: 0 };
  let beat = 0; let level = 0;
  let lastT = null;
  let lastRise = -1e9;
  let rising = false; // an output is on its way up: a swell carries on; a new rise waits for MIN_RISE_GAP_MS
  const follow = (c, target, dt, attack, release) => c + (target - c) * (1 - Math.exp(-dt / (target > c ? attack : release)));
  const TIMES = { bass: [60, 190], mids: [120, 380], highs: [60, 220] };
  return {
    // frame: { bass, mids, highs, level, beat } or null for idle
    step(frame, t) {
      const dt = lastT === null ? 16 : Math.min(250, Math.max(1, t - lastT));
      lastT = t;
      const tgt = { bass: 0, mids: 0, highs: 0 };
      let bTarget = 0;
      if (frame) {
        for (const k of ['bass', 'mids', 'highs']) { peak[k] = Math.max(FLOOR[k], frame[k], peak[k] * Math.exp(-dt / 8000)); tgt[k] = smooth(0.3, 0.9, frame[k] / peak[k]); } // (below a third of the band's own peak reads as nothing: the gaps between beats are gaps)
        if (frame.beat) bTarget = 1;
      } else {
        const s = 0.5 + 0.5 * Math.sin((t / 8000) * Math.PI * 2); // 0.125 Hz
        tgt.bass = 0.10 + 0.10 * s; tgt.mids = 0.08 + 0.06 * (1 - s); tgt.highs = 0.04;
      }
      const up = ['bass', 'mids', 'highs'].some((k) => tgt[k] > cur[k] + 0.04);
      const down = ['bass', 'mids', 'highs'].every((k) => tgt[k] < cur[k] - 0.04);
      if (up) {
        if (!rising) {
          if (t - lastRise >= MIN_RISE_GAP_MS) { rising = true; lastRise = t; } else for (const k of ['bass', 'mids', 'highs']) tgt[k] = Math.min(tgt[k], cur[k]);
        }
      } else if (down) rising = false;
      const slowIn = frame ? 1 : 12; // coming up from nothing into the idle drift takes a second, not a frame
      for (const k of ['bass', 'mids', 'highs']) cur[k] = follow(cur[k], tgt[k], dt, TIMES[k][0] * slowIn, TIMES[k][1]);
      beat = bTarget ? 1 : beat * Math.exp(-dt / 170);
      level = follow(level, frame ? clamp01(frame.level) : 0, dt, 120, 400);
      return { bass: clamp01(cur.bass), mids: clamp01(cur.mids), highs: clamp01(cur.highs), level, beat: clamp01(beat) };
    },
  };
}

// A made-up piece of music for Settings' Preview: a kick every 500 ms, a pad that swells and fades, hi-hats on the off-beats. -> bands for time t (ms).
function demoFrame(t) {
  const phase = t % 500;
  const kick = phase < 130 ? 0.9 : 0.08;
  const swell = 0.25 + 0.5 * Math.pow(Math.sin((t / 4000) * Math.PI), 2);
  const hat = (t + 250) % 500 < 70 ? 0.7 : 0.06;
  return { bass: kick, mids: swell, highs: hat, level: (kick + swell + hat) / 3 };
}

// How much of the effect runs: 'off' (the setting is off, or Reduce motion (the setting or the system's) or Performance mode say stop), 'reduced'
// (Visual effects: Light, or software drawing: about 40 dots at 15 frames a second) or 'full'. look.reduceMotion is the Reduce motion setting
// itself (look.still also stands for software drawing).
function modeOf(look, prefersReduced) {
  if (!look || look.musicReactive !== true || prefersReduced || look.reduceMotion === true || look.lite) return 'off';
  return look.light || look.soft ? 'reduced' : 'full';
}
const motionAllowed = (look, prefersReduced) => modeOf(look, prefersReduced) !== 'off';
// The same rules for whoever wants the analyser, whatever the home-screen setting says (a music card that reacts): 'off' for Reduce motion and Performance
// mode, 'reduced' for Light and software drawing, else 'full'.
function calmOf(look, prefersReduced) {
  if (!look || prefersReduced || look.reduceMotion === true || look.lite) return 'off';
  return look.light || look.soft ? 'reduced' : 'full';
}
// What runs, given the page's look, whether any card asked to react, and the system's Reduce motion: { bg, cards, listen } (listen: the analyser is open).
function plan(look, cardsWant, prefersReduced) {
  const calm = calmOf(look, prefersReduced);
  const bg = look && look.musicReactive === true ? calm : 'off';
  const cards = cardsWant ? calm : 'off';
  return { bg, cards, listen: bg !== 'off' || cards !== 'off' };
}

// The factor for the picture at horizontal position x: COLUMN_GAIN behind the content column (centre cx, width colW), 1 outside it, with soft edges
// (the canvas draws exactly this as a band it cuts out of everything).
function columnGain(x, cx, colW) {
  const half = colW / 2;
  const d = Math.abs(x - cx);
  return COLUMN_GAIN + (1 - COLUMN_GAIN) * smooth(half, half + 90, d);
}

// A small deterministic random generator (so the field starts the same every time, and tests can rely on it).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// The field of dots. `n` dots in a w x h area (CSS pixels); step(dt seconds, { bass, mids, highs, beat }) moves them. Arrays are typed and reused:
// nothing is allocated per frame.
//   x, y    position            vx, vy  the slow drift (px/s, never changes)      bx, by  the burst and swirl velocity (decays)
//   r       radius at rest      alpha   rest opacity share (0.5..1)               ph, tw  twinkle phase and rate (Hz)
//   tone    which of the three colours (0..2)                                      spark   a twinkle's flash, 0..1
function createField(n, w, h, seed = 7) {
  const rand = rng(seed);
  const f = {
    n, w, h, cx: w / 2, cy: h / 2,
    x: new Float32Array(n), y: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n),
    bx: new Float32Array(n), by: new Float32Array(n), r: new Float32Array(n), alpha: new Float32Array(n),
    ph: new Float32Array(n), tw: new Float32Array(n), tone: new Uint8Array(n), spark: new Float32Array(n),
    bass: 0, time: 0, prevBeat: 0,
  };
  for (let i = 0; i < n; i++) {
    f.x[i] = rand() * w; f.y[i] = rand() * h;
    const ang = rand() * Math.PI * 2; const sp = 5 + rand() * 14; // px/s at rest: a slow drift
    f.vx[i] = Math.cos(ang) * sp; f.vy[i] = Math.sin(ang) * sp;
    f.r[i] = 5 + Math.pow(rand(), 2) * 17; // many small, a few large
    f.alpha[i] = 0.5 + rand() * 0.5;
    f.ph[i] = rand() * Math.PI * 2; f.tw[i] = 0.2 + rand() * (TWINKLE_MAX_HZ - 0.2); f.tone[i] = Math.floor(rand() * 3);
  }
  f.rand = rand;
  f.resize = (nw, nh) => {
    if (!(nw > 0 && nh > 0)) return;
    const sx = nw / f.w; const sy = nh / f.h;
    for (let i = 0; i < n; i++) { f.x[i] *= sx; f.y[i] *= sy; }
    f.w = nw; f.h = nh; f.cx = nw / 2; f.cy = nh / 2;
  };
  f.step = (dt, c) => {
    dt = Math.min(0.1, Math.max(0.001, dt));
    f.time += dt;
    const bass = clamp01(c.bass); const mids = clamp01(c.mids); const highs = clamp01(c.highs);
    f.bass += (bass - f.bass) * (1 - Math.exp(-dt / 0.12)); // the dots swell and speed up with the (already smoothed) bass
    const speed = 1 + 3.2 * f.bass; // the drift is faster with the bass
    const burst = c.beat > 0.9 && f.prevBeat <= 0.9 ? 1 : 0; // a burst on the frame the beat arrives (its value then fades, and never counts again)
    f.prevBeat = Number(c.beat) || 0;
    const swirl = 170 * mids; // px/s² of sideways push around the centre
    const damp = Math.exp(-dt / 0.45);
    const sparkP = 0.18 * highs * dt; // each dot's chance to twinkle in this step
    const w2 = f.w + 80; const h2 = f.h + 80;
    for (let i = 0; i < n; i++) {
      let bx = f.bx[i]; let by = f.by[i];
      const dx = f.x[i] - f.cx; const dy = f.y[i] - f.cy;
      const d = Math.sqrt(dx * dx + dy * dy) + 1;
      if (burst) { // out from the centre: the nearer and the larger dots a bit harder
        const kick = (140 + 180 * bass) * (0.55 + 0.45 * f.alpha[i]);
        bx += (dx / d) * kick; by += (dy / d) * kick;
      }
      if (swirl > 0) { bx += (-dy / d) * swirl * dt; by += (dx / d) * swirl * dt; } // round the centre
      const bs = Math.sqrt(bx * bx + by * by);
      if (bs > 720) { bx *= 720 / bs; by *= 720 / bs; }
      bx *= damp; by *= damp;
      f.bx[i] = bx; f.by[i] = by;
      let x = f.x[i] + (f.vx[i] * speed + bx) * dt;
      let y = f.y[i] + (f.vy[i] * speed + by) * dt;
      if (x < -40) x += w2; else if (x > f.w + 40) x -= w2; // wraps round, a little outside the edge
      if (y < -40) y += h2; else if (y > f.h + 40) y -= h2;
      f.x[i] = x; f.y[i] = y;
      f.ph[i] += Math.PI * 2 * f.tw[i] * dt;
      let s = f.spark[i];
      if (s > 0) s = Math.max(0, s - dt / 0.6);
      else if (sparkP > 0 && f.rand() < sparkP) s = 1;
      f.spark[i] = s;
    }
  };
  // One dot as drawn: { x, y, r (CSS px), a (opacity 0..cap) } into `out`, for the page's caps (the column behind the content is carved out by the canvas).
  f.look = (i, tone, out) => {
    const twinkle = 0.7 + 0.3 * Math.sin(f.ph[i]);
    const sp = f.spark[i]; const spark = sp > 0 ? Math.sin(Math.min(1, sp) * Math.PI) : 0; // a quick rise and a slow fall
    const grow = 1 + 0.55 * f.bass + 0.5 * spark;
    out.x = f.x[i]; out.y = f.y[i]; out.r = f.r[i] * grow;
    out.a = Math.min(DOT_CAP[tone], DOT_CAP[tone] * (f.alpha[i] * twinkle + 0.5 * spark))
    return out;
  };
  return f;
}

const api = {
  DOT_CAP, FLOW_CAP, COLUMN_GAIN, BOUNCE, CARD_HALO_CAP, CARD_PULSE, MIN_RISE_GAP_MS, MIN_BEAT_GAP_MS, REDUCED_MS, MAX_FLASH_HZ, TWINKLE_MAX_HZ, COUNTS, BANDS,
  bandsOf, isSilent, flashLimiter, beatDetector, createMapper, createField, demoFrame, columnGain, modeOf, motionAllowed, calmOf, plan,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.MusicReact = api;
})();

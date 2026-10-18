// [look] Music-reactive home screen (Settings → Appearance → New tab page): the maths between the audio analyser and the CSS.
// Pure functions, no DOM, no Electron, no audio: used by renderer/newtab-music-react.js (which owns the analyser) and the unit tests.
//
// What goes in is one frame of the analyser's frequency bytes. What comes out is three numbers for CSS variables (glow, wave, beat).
// Nothing here ever sees the sound itself, and nothing is stored: a frame is read, reduced to a few numbers and dropped.
//
// Comfort rules, built into the numbers:
//   - GLOW_CAP and WAVE_CAP (times MEDIA_GAIN over a dark background): the most opacity either layer ever reaches. Both layers stacked at
//     their ceiling still leave the secondary text 4.5:1 or better on every accent (test/music-react-units.js works it out from the page's colours).
//   - MIN_RISE_GAP_MS: a new rise can only start once per 360 ms (a swell that is already rising carries on), so nothing on the page can
//     flash more than 2.8 times a second, whatever the music does (a hi-hat roll at 12 Hz becomes a slow swell). Falling is always smooth.
//   - MIN_BEAT_GAP_MS: a beat flag at most every 400 ms (2.5 a second).
(function () {
'use strict';

const GLOW_CAP = 0.05; // opacity ceilings of the two layers on the page's own background (Plain, or a light one)
const WAVE_CAP = 0.03;
const MEDIA_GAIN = 1.5; // over a dark picture or gradient (white text on a dark base) the layers may be this much stronger (newtab.html: --mr-gain)
const BOUNCE = 0.012; // the clock and the music card grow by at most this share on a beat (CSS: scale: calc(1 + var(--mr-beat) * 0.012))
const MIN_RISE_GAP_MS = 360;
const MIN_BEAT_GAP_MS = 400;
const REDUCED_MS = 100; // the reduced mode (Light, software drawing) writes at most 10 times a second
const MAX_FLASH_HZ = 3;
const BANDS = { bass: [20, 250], mids: [250, 4000], highs: [4000, 16000] };

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);

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
    let sum = 0;
    let n = 0;
    for (let i = from; i <= to; i++) { sum += bytes[i]; n++; }
    out[name] = n ? clamp01(sum / n / 255) : 0;
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

// One mapper per run: frames in (bands + a beat flag + the time), { glow, wave, beat, level } out, for the CSS variables.
// `idle` frames (nothing is playing) drift very slowly, well under 1 Hz.
function createMapper() {
  const peak = { bass: 0.06, mids: 0.06 }; // a slow ceiling per band (automatic gain): quiet music moves the page as much as loud music does
  let glow = 0; let wave = 0; let beat = 0; let level = 0;
  let lastT = null;
  let lastRise = -1e9;
  let rising = false; // the output is on its way up: a swell carries on; a new rise waits for MIN_RISE_GAP_MS
  const follow = (cur, target, dt, attack, release) => cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? attack : release)));
  return {
    // frame: { bass, mids, level, beat } or null for idle
    step(frame, t) {
      const dt = lastT === null ? 16 : Math.min(250, Math.max(1, t - lastT));
      lastT = t;
      let gTarget; let wTarget; let bTarget = 0;
      if (frame) {
        for (const k of ['bass', 'mids']) peak[k] = Math.max(0.06, frame[k], peak[k] * Math.exp(-dt / 8000));
        gTarget = clamp01(frame.bass / peak.bass) * GLOW_CAP;
        wTarget = clamp01(frame.mids / peak.mids) * WAVE_CAP;
        if (frame.beat) bTarget = 1;
      } else {
        const s = 0.5 + 0.5 * Math.sin((t / 8000) * Math.PI * 2); // 0.125 Hz
        gTarget = 0.02 + 0.03 * s;
        wTarget = 0.02 + 0.02 * (1 - s);
      }
      // A new rise may start once per MIN_RISE_GAP_MS; until then the output can only hold or fall. A rise that has started carries on.
      if (gTarget > glow + 0.002 || wTarget > wave + 0.002) {
        if (!rising) {
          if (t - lastRise >= MIN_RISE_GAP_MS) { rising = true; lastRise = t; }
          else { gTarget = Math.min(gTarget, glow); wTarget = Math.min(wTarget, wave); }
        }
      } else if (gTarget < glow - 0.002 && wTarget < wave - 0.002) rising = false;
      const slowIn = frame ? 1 : 12; // coming up from nothing into the idle drift takes a second, not a frame
      glow = follow(glow, gTarget, dt, 70 * slowIn, 260);
      wave = follow(wave, wTarget, dt, 120 * slowIn, 380);
      beat = bTarget ? 1 : beat * Math.exp(-dt / 170);
      level = follow(level, frame ? clamp01(frame.level) : 0, dt, 120, 400);
      return { glow: Math.min(GLOW_CAP, glow), wave: Math.min(WAVE_CAP, wave), beat: clamp01(beat), level };
    },
  };
}

// The CSS variables for one output (rounded: a variable that changes by less than 0.002 is not written again by the page).
const round3 = (v) => Math.round(v * 500) / 500;
function cssVars(out) {
  return { '--mr-glow': String(round3(out.glow)), '--mr-wave': String(round3(out.wave)), '--mr-beat': String(round3(out.beat)) };
}

// How much of the effect runs: 'off' (the setting is off, or Reduce motion (the setting or the system's) or Performance mode say stop), 'reduced'
// (Visual effects: Light, or software drawing: the glow only, no wave, no bounce, about 10 updates a second) or 'full'. look.reduceMotion is the
// Reduce motion setting itself (look.still also stands for software drawing).
function modeOf(look, prefersReduced) {
  if (!look || look.musicReactive !== true || prefersReduced || look.reduceMotion === true || look.lite) return 'off';
  return look.light || look.soft ? 'reduced' : 'full';
}
const motionAllowed = (look, prefersReduced) => modeOf(look, prefersReduced) !== 'off';

// Which window to listen to, among those playing sound: Lumen's own music players first (Spotify, Apple Music), then any tab.
// `players` and `tabs` are lists of { id, audible }. -> the chosen id, or null when nothing is playing.
function pickSource(players, tabs, selfId) {
  for (const p of players || []) if (p && p.audible && p.id !== selfId) return p.id;
  for (const t of tabs || []) if (t && t.audible && t.id !== selfId) return t.id;
  return null;
}

const api = { GLOW_CAP, WAVE_CAP, MEDIA_GAIN, BOUNCE, MIN_RISE_GAP_MS, MIN_BEAT_GAP_MS, REDUCED_MS, MAX_FLASH_HZ, BANDS, bandsOf, isSilent, flashLimiter, beatDetector, createMapper, cssVars, modeOf, motionAllowed, pickSource };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.MusicReact = api;
})();

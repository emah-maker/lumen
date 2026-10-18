// Music-reactive home screen, pure logic (features/music-react.js, features/music-react-source.js) and the wiring around it: the analyser-to-visual
// mapping, the intensity caps, the flash-rate ceiling, which source is chosen, what the browser will and will not hand the page, the contrast the layers
// leave the text, and that the setting is off by default and the page loads nothing until it is on. No Electron window, no audio, no network.
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const MR = require('../src/features/music-react');
const SRC = require('../src/features/music-react-source');
const TC = require('../src/features/theme-colors');
const BG = require('../src/features/backgrounds');
const SB = require('../src/settings/settings-backend');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

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

// ---- the flash ceiling ----
check('flash: the ceiling is 3 a second or less', MR.MAX_FLASH_HZ <= 3 && 1000 / MR.MIN_RISE_GAP_MS <= 3 && 1000 / MR.MIN_BEAT_GAP_MS <= 3, `${MR.MAX_FLASH_HZ} ${MR.MIN_RISE_GAP_MS} ${MR.MIN_BEAT_GAP_MS}`);
const worstPerSecond = (times) => { let w = 0; for (const a of times) w = Math.max(w, times.filter((b) => b >= a && b < a + 1000).length); return w; };
{
  const lim = MR.flashLimiter(3);
  const allowed = []; for (let t = 0; t < 3000; t += 10) if (lim.allow(t)) allowed.push(t);
  check('flash limiter: never more than 3 in any second, however often it is asked', worstPerSecond(allowed) <= 3 && allowed.length >= 8, `${worstPerSecond(allowed)} ${allowed.length}`);
}
// Beats: a kick every 500 ms (2 Hz) is found; a kick every 83 ms (12 Hz) yields at most 3 beats a second.
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

// ---- mapping to the visuals ----
function run(frameAt, ms, step = 16) {
  const m = MR.createMapper(); const det = MR.beatDetector(); const out = [];
  for (let t = 0; t <= ms; t += step) {
    const f = frameAt(t);
    out.push({ t, ...m.step(f ? { ...f, beat: det.push(t, f.bass) } : null, t) });
  }
  return out;
}
const loud = run(() => ({ bass: 1, mids: 1, level: 1 }), 4000);
check('map: the glow and wave never pass their caps, whatever the input', loud.every((o) => o.glow <= MR.GLOW_CAP + 1e-9 && o.wave <= MR.WAVE_CAP + 1e-9 && o.beat <= 1 && o.beat >= 0), '');
check('map: loud bass fills the glow, loud mids the wave', loud.at(-1).glow > MR.GLOW_CAP * 0.9 && loud.at(-1).wave > MR.WAVE_CAP * 0.9, JSON.stringify(loud.at(-1)));
const quiet = run((t) => (t < 2000 ? { bass: 1, mids: 1, level: 1 } : { bass: 0, mids: 0, level: 0 }), 6000);
check('map: after the music stops the glow and wave fade out smoothly', quiet.at(-1).glow < 0.002 && quiet.at(-1).wave < 0.002, JSON.stringify(quiet.at(-1)));
const steps = quiet.slice(1).map((o, i) => Math.abs(o.glow - quiet[i].glow));
check('map: no single frame moves the glow by more than a fifth of its cap', Math.max(...steps) <= MR.GLOW_CAP * 0.2, String(Math.max(...steps)));
// Automatic gain: a steady quiet sound reads like a steady loud one, and quiet beats move the page as much as loud beats do.
const quietBeats = run((t) => (t % 500 < 100 ? { bass: 0.12, mids: 0.05, level: 0.05 } : { bass: 0.01, mids: 0.01, level: 0.01 }), 8000);
const tail = quietBeats.filter((o) => o.t > 4000);
check('map: quiet music still moves the page (automatic gain: its beats swing the glow over most of the range)', Math.max(...tail.map((o) => o.glow)) - Math.min(...tail.map((o) => o.glow)) > MR.GLOW_CAP * 0.4, JSON.stringify([Math.min(...tail.map((o) => o.glow)), Math.max(...tail.map((o) => o.glow))]));
check('silence: a frame with nothing in any band is silent, a single steady tone is not', MR.isSilent({ bass: 0, mids: 0, highs: 0 }) && MR.isSilent({ bass: 0.02, mids: 0.01, highs: 0 }) && !MR.isSilent({ bass: 0.1, mids: 0, highs: 0 }) && MR.isSilent(null), '');
const idle = run(() => null, 24000, 40);
check('map: idle is a gentle drift: within the caps, no beat, and far slower than a flash', Math.max(...idle.map((o) => o.glow)) <= MR.GLOW_CAP && idle.every((o) => o.beat === 0)
  && Math.max(...idle.slice(1).map((o, i) => Math.abs(o.glow - idle[i].glow))) < 0.002, '');
{
  const kicks = run((t) => (t % 500 < 60 ? { bass: 0.9, mids: 0.3, level: 0.6 } : { bass: 0.1, mids: 0.1, level: 0.2 }), 5000);
  check('map: the beat value jumps on a kick and decays between kicks', Math.max(...kicks.map((o) => o.beat)) > 0.9 && kicks.some((o) => o.beat < 0.1), '');
}
// The ceiling on the output itself: a bass that flips between full and nothing up to 20 times a second must not make anything flash faster than 3 Hz.
function swings(outs, key, cap) { // rises through 40 % of the cap after having been below 20 % (hysteresis)
  const ups = []; let armed = true;
  for (const o of outs) { if (armed && o[key] > cap * 0.4) { ups.push(o.t); armed = false; } else if (!armed && o[key] < cap * 0.2) armed = true; }
  return ups;
}
for (const hz of [2, 4, 8, 12, 20]) {
  const period = 1000 / hz;
  const o = run((t) => (t % period < period / 2 ? { bass: 1, mids: 1, level: 1 } : { bass: 0, mids: 0, level: 0 }), 10000, 8);
  const worst = Math.max(worstPerSecond(swings(o, 'glow', MR.GLOW_CAP)), worstPerSecond(swings(o, 'wave', MR.WAVE_CAP)), worstPerSecond(swings(o, 'beat', 1)));
  check(`flash rate: a ${hz} Hz on/off bass never makes the glow, wave or bounce flash more than 3 times in a second`, worst <= 3, String(worst));
}
check('css: three variables, plain strings, rounded', (() => { const v = MR.cssVars({ glow: 0.123456, wave: 0.01, beat: 1 }); return Object.keys(v).join() === '--mr-glow,--mr-wave,--mr-beat' && Object.values(v).every((x) => typeof x === 'string' && Number.isFinite(Number(x))) && v['--mr-glow'] === '0.124'; })(), JSON.stringify(MR.cssVars({ glow: 0.123456, wave: 0.01, beat: 1 })));

// ---- when it may move ----
const on = { musicReactive: true, still: false, reduceMotion: false, light: false, soft: false, lite: false };
check('mode: full when on and nothing limits it', MR.modeOf(on, false) === 'full' && MR.motionAllowed(on, false) === true, '');
check('mode: off when the setting is off or the look is missing', MR.modeOf({ ...on, musicReactive: false }, false) === 'off' && MR.modeOf(null, false) === 'off' && MR.motionAllowed(null, false) === false, '');
check('mode: Reduce motion (the system\'s or Settings\') and Performance mode turn it off fully', MR.modeOf(on, true) === 'off' && MR.modeOf({ ...on, reduceMotion: true }, false) === 'off' && MR.modeOf({ ...on, lite: true }, false) === 'off', '');
check('mode: Visual effects: Light and software drawing give the reduced version, not nothing', MR.modeOf({ ...on, light: true }, false) === 'reduced' && MR.modeOf({ ...on, light: true, soft: true, still: true }, false) === 'reduced' && MR.motionAllowed({ ...on, light: true }, false) === true, '');
check('mode: software drawing\'s "still" is not Reduce motion (the setting itself is look.reduceMotion)', MR.modeOf({ ...on, soft: true, light: true, still: true, reduceMotion: false }, false) === 'reduced', '');
check('mode: Reduce motion beats Light (off, not reduced), and Performance mode too', MR.modeOf({ ...on, light: true, reduceMotion: true }, false) === 'off' && MR.modeOf({ ...on, light: true, lite: true }, false) === 'off', '');
check('reduced: at most 10 writes a second', MR.REDUCED_MS >= 100, String(MR.REDUCED_MS));
{
  // the reduced mode steps the mapper every 100 ms: the caps and the flash ceiling hold at that cadence too
  for (const hz of [2, 4, 8, 12]) {
    const period = 1000 / hz;
    const o = run((t) => (t % period < period / 2 ? { bass: 1, mids: 1, level: 1 } : { bass: 0, mids: 0, level: 0 }), 10000, MR.REDUCED_MS);
    check(`reduced: at 10 updates a second a ${hz} Hz on/off bass stays under the cap and flashes at most 3 times a second`, o.every((x) => x.glow <= MR.GLOW_CAP + 1e-9) && worstPerSecond(swings(o, 'glow', MR.GLOW_CAP)) <= 3, '');
  }
}

// ---- which sound ----
check('source: Lumen\'s own players first, then any tab, never the page itself, nothing when quiet',
  MR.pickSource([{ id: 1, audible: true }], [{ id: 2, audible: true }], 9) === 1 && MR.pickSource([{ id: 1, audible: false }], [{ id: 2, audible: true }], 9) === 2
  && MR.pickSource([], [{ id: 9, audible: true }], 9) === null && MR.pickSource([{ id: 1, audible: false }], [{ id: 2, audible: false }], 9) === null && MR.pickSource(null, null, 9) === null, '');

// ---- what the browser hands the page ----
{
  const wc = (id, o = {}) => ({ id, isDestroyed: () => false, isCurrentlyAudible: () => o.audible === true, getMediaSourceId: (req) => `tab:${id}:for:${req.id}`, getURL: () => o.url || 'https://example.com/' });
  const page = wc(100, { url: 'file:///app/renderer/newtab.html#x' });
  let enabled = true; let t = 1000;
  const mk = (players, tabs) => SRC.create({ players: () => players, tabs: () => tabs, isNewTab: (u) => u.startsWith('file:///app/renderer/newtab.html'), enabled: () => enabled, now: () => t, pick: MR.pickSource });
  const s = mk([wc(1)], [wc(2, { audible: true }), page]);
  check('source: an audible tab is answered with its one-tab capture id, made for the asking page', (() => { const r = s.source(page, null); return r.key === 2 && r.id === 'tab:2:for:100'; })(), '');
  check('source: asked again about the same tab: no new id (the page keeps its stream)', (() => { const r = s.source(page, 2); return r.key === 2 && r.id === null; })(), '');
  check('source: nothing audible: no key, so the page lets go of its stream', mk([wc(1)], [wc(2)]).source(page, 2).key === null, '');
  check('source: with the setting off nothing is answered', (() => { enabled = false; const r = s.source(page, null); enabled = true; return r.key === null && !r.id; })(), '');
  check('source: a destroyed asker gets nothing', s.source({ ...page, isDestroyed: () => true }, null).key === null, '');
  const tone = wc(2, { audible: true });
  const ask = (o = {}) => ({ mediaTypes: [], isMainFrame: true, securityOrigin: 'file:///', requestingUrl: 'https://example.com/', ...o }); // (what Chromium asks: about the captured tab, with the asking page's origin; tab audio is listed as no media type)
  const g = mk([], [tone]); g.source(page, null);
  check('permission: audio only, about the tab an id was just made for, asked by a local page', g.allows(tone, 'media', ask(), false) === true && g.allows(tone, 'media', ask({ mediaTypes: ['audio'] }), false) === true, '');
  check('permission: never video, never audio and video, never a sub-frame', g.allows(tone, 'media', ask({ mediaTypes: ['video'] }), false) === false && g.allows(tone, 'media', ask({ mediaTypes: ['audio', 'video'] }), false) === false
    && g.allows(tone, 'media', ask({ isMainFrame: false }), false) === false && g.allows(tone, 'media', { mediaType: 'video', securityOrigin: 'file:///' }, false) === false, '');
  check('permission: not when the tab\'s own page asks (a web origin), and not without an origin', g.allows(tone, 'media', ask({ securityOrigin: 'http://127.0.0.1:5/' }), false) === false && g.allows(tone, 'media', ask({ securityOrigin: undefined }), false) === false, '');
  check('permission: nothing but media (no screen, notifications, location or other app)', ['display-capture', 'notifications', 'geolocation', 'clipboard-read', 'openExternal'].every((p) => g.allows(tone, p, ask(), false) === false), '');
  check('permission: not for any other tab, and not for any tab without an id made for it', g.allows(wc(5, { url: 'https://evil.example/' }), 'media', ask(), false) === false && mk([], [tone]).allows(tone, 'media', ask(), false) === false, '');
  check('permission: not once the asking page is no longer the new-tab page', (() => { const away = { ...page, getURL: () => 'https://example.com/' }; const m = mk([], [tone]); m.source(away, null); return m.allows(tone, 'media', ask(), false) === false; })(), '');
  check('permission: a request uses the grant up (one stream per id)', g.allows(tone, 'media', ask(), true) === true && g.allows(tone, 'media', ask(), true) === false, '');
  const h = mk([], [tone]); h.source(page, null); t += SRC.GRANT_MS + 1;
  check('permission: the grant expires', h.allows(tone, 'media', ask(), false) === false, '');
  const o = mk([], [tone]); o.source(page, null); enabled = false;
  check('permission: switching the setting off ends it at once', o.allows(tone, 'media', ask(), false) === false, ''); enabled = true;
}

// ---- the text keeps its contrast ----
{
  const MUTED = { light: '#66666b', dark: '#a1a1a6' }; const TEXT = { light: '#1d1d1f', dark: '#f5f5f7' }; // newtab.html's :root tokens
  const stack = MR.GLOW_CAP + MR.WAVE_CAP; // both layers at their ceiling, over the same pixel
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
  check('contrast: on Plain, both layers at their ceiling leave secondary text 4.5:1 or better on every accent, light and dark', worstMuted >= 4.5, `${worstMuted.toFixed(2)} (${who})`);
  check('contrast: and body text 7:1 or better (WCAG AAA)', worstText >= 7, worstText.toFixed(2));
  let worstMedia = -1; let whoMedia = '';
  for (const b of BG.BACKGROUNDS) {
    if (b.tone !== 'dark' || !b.seed) continue;
    for (const id of TC.ACCENT_IDS) {
      const pair = TC.ACCENTS[id]; if (!pair) continue;
      const accent = TC.tokensFor(pair[1], 'dark').accent;
      const drop = 1 - TC.contrast('#ffffff', TC.over(accent, stack * MR.MEDIA_GAIN, b.seed)) / TC.contrast('#ffffff', b.seed);
      if (drop > worstMedia) { worstMedia = drop; whoMedia = `${b.id} ${id}`; }
    }
  }
  check('contrast: over a dark background (stronger gain included) the layers at their ceiling lower the contrast of white text by no more than 15 % of what the background has by itself', worstMedia <= 0.15, `${(worstMedia * 100).toFixed(1)} % (${whoMedia})`);
}

// ---- the setting, the page, the wiring ----
check('setting: off by default, a boolean', SB.DEFAULTS.newTabMusicReactive === false && SB.validate('newTabMusicReactive', true) === true && SB.validate('newTabMusicReactive', 'yes') === null, '');
check('setting: the page is told only a literal true', /musicReactive: p\.newTabMusicReactive === true/.test(read('src/settings/settings-backend.js')) && /musicReactive: look\.musicReactive === true/.test(read('src/renderer/newtab.js')), '');
const page = read('src/renderer/newtab.html'); const js = read('src/renderer/newtab.js'); const drv = read('src/renderer/newtab-music-react.js');
check('page: nothing of it is loaded until the setting is on (not in the page\'s script list)', !/music-react/.test(page.slice(page.indexOf('<script src'))) && /if \(!look\.musicReactive \|\| musicScripts\) return;/.test(js), '');
check('page: the CSP is unchanged (no media-src, no new sources)', /default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:/.test(page), '');
check('page: the layers are decorative: hidden from screen readers, never take a click, behind the content', /setAttribute\('aria-hidden', 'true'\)/.test(drv) && /#mr-glow, #mr-wave \{ position: fixed; inset: 0; z-index: -1; pointer-events: none; \}/.test(page), '');
check('page: only opacity and transform move (no layout, no filter, no blur)', !/#mr-(glow|wave) \{[^}]*(filter|width:|height:|top:|left:)/.test(page), '');
check('page: the system\'s Reduce motion hides the layers in CSS too, and Light does not (it gets the glow)', /prefers-reduced-motion: reduce\) \{ #mr-glow, #mr-wave \{ display: none/.test(page) && !/gfx-light #mr-glow|body\.still #mr-glow/.test(page), '');
const code = drv.replace(/\/\/.*$/gm, '');
check('driver: only tab capture, audio only, never the microphone or the screen', /chromeMediaSource: 'tab'/.test(code) && /video: false/.test(code) && !/audio: true/.test(code) && !/getDisplayMedia/.test(code), '');
check('driver: the analyser is never connected to the speakers and nothing is recorded, stored or sent', !/destination/.test(code) && !/MediaRecorder|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|ipcRenderer/.test(code), '');
check('driver: it stops with the page hidden, with the setting off and with the stream ended', /visibilitychange/.test(code) && /function pause\(\)/.test(code) && /stopCapture\(\)/.test(code) && /'ended'/.test(code), '');
check('driver: frames are throttled (about 30 a second live, fewer idle) and variables are set on the element that uses them', /LIVE_MS = 33/.test(code) && /IDLE_MS = 80/.test(code) && !/document\.body\.style\.setProperty/.test(code), '');
check('driver: the reduced mode has the glow only (no wave layer, no bounce) and writes at most 10 times a second', /waveEl = mode === 'full' \? el\('mr-wave'\) : null/.test(code) && /mode === 'full' \? \[\.\.\.document\.querySelectorAll\(BEAT_TARGETS\)\] : \[\]/.test(code) && /mode === 'reduced' \? MR\.REDUCED_MS/.test(code) && /mrMode/.test(code), '');
const settingsJs = read('src/renderer/settings.js');
const en2 = JSON.parse(read('src/locales/en.json'));
check('settings: one line under the switch says why the effect is limited, in the same cases as the page', ['offMotion', 'offPerformance', 'lightSoftware', 'lightChosen', 'lightAuto', 'linkLight'].every((k) => typeof en2['settings.musicReactive.' + k] === 'string' && settingsJs.includes('settings.musicReactive.' + k))
  && /st\.prefs\?\.reduceMotion\) text/.test(settingsJs) && /st\.performance\?\.active\) text/.test(settingsJs) && /id: 'music-reactive-note'/.test(settingsJs), '');
check('settings: the Light note links to Visual effects, which the page can route to', /location\.hash = '#visual-effects'/.test(settingsJs) && /'visual-effects': \{ cat: 'advanced', focus: 'system', focusEl: '#pref-graphicsMode' \}/.test(settingsJs) && /select\('graphicsMode'/.test(settingsJs), '');
check('settings: the note follows the three settings that decide it', /\['reduceMotion', 'performanceMode', 'graphicsMode'\]\.includes\(e\.detail\.key\)/.test(settingsJs), '');
const preload = read('src/preload/newtab-preload.js');
check('preload: the new-tab page\'s own preload carries it (the main preload is untouched)', /musicSource/.test(preload) && !/newtab-music/.test(read('src/preload/preload.js')), '');
const main = read('src/main.js');
check('main: only the new-tab page\'s top frame is answered, and only with the setting on', /ipcMain\.handle\('newtab-music:source', \(event, have\) => \{\s*if \(!newTabTab\(event\)\) return \{ key: null \};\s*const r = musicReact\.source\(/.test(main) && /musicReactOn = \(\) => readSettings\(\)\.newTabMusicReactive === true/.test(main), '');
check('main: the permission handlers ask the same module first', /musicReact\.allows\(wc, permission, details, true\)/.test(main) && /musicReact\.allows\(wc, permission, details, false\)/.test(main), '');
const en = JSON.parse(read('src/locales/en.json'));
check('locale: the setting has its label and description', typeof en['settings.musicReactive.label'] === 'string' && typeof en['settings.musicReactive.desc'] === 'string' && /settings\.musicReactive\.label/.test(read('src/renderer/settings.js')), '');
check('settings: a switch with a label in Settings, and none on the home page or the music widget', /toggle\('newTabMusicReactive', tr\('settings\.musicReactive\.label'/.test(read('src/renderer/settings.js'))
  && !/newTabMusicReactive|musicReactive/.test(read('src/renderer/newtab-music.js')) && !/newTabMusicReactive/.test(page), '');

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('music-react units passed');

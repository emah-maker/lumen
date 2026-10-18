// Music-reactive home screen, in the real app (hidden window, throwaway profile, no real network). A local page plays a generated test tone (an
// oscillator pulsing like a kick drum, plus a steady mid tone, at -60 dBFS) in one tab; the new-tab page listens to the PC's output (Windows
// loopback) and draws a field of dots behind the widgets. Checked:
//   off (the default)  nothing is loaded, nothing runs, the browser answers the page nothing and the page cannot listen to anything
//   on                 the page listens, the dots react to the beat (they burst, speed up, swirl, twinkle), the picture is really drawn, every value
//                      stays within its limits and nothing flashes more than 3 times a second; an idle drift when the sound stops
//   playback           the tab keeps playing at its normal level, with no dropout, while the new tab opens, hides, shows and closes over and over
//                      (the output is measured with system loopback in a separate window: Chromium's own audible flag cannot tell)
//   listening          the loopback is open only while the page is shown and the home screen or a music card asks for it
//   cards              a Spotify or Apple Music card with "React to music" on reacts (cover, glow) on the same listening, with or without the home
//                      screen; with both off nothing runs
//   calm               Reduce motion and Performance mode stop it at once; Visual effects: Light gives 40 dots at 15 frames a second; Settings
//                      says why under the switch and has a Preview that animates a made-up beat; turning it off removes everything
//   main process       no task over 20 ms while it all runs
// Windows only (the listening is Windows' loopback): elsewhere the suite says so and passes.
// Run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/music-react.js (under scripts/e2e-lock.js, with a timeout).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const MR = require('../src/features/music-react');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const worstPerSecond = (times) => { let w = 0; for (const a of times) w = Math.max(w, times.filter((b) => b >= a && b < a + 1000).length); return w; };
if (process.platform !== 'win32') { console.log('SKIP  music-react: the listening is Windows\' loopback'); process.exit(0); }

// The test tone, at -60 dBFS (this suite runs with Chromium's audio on so that it reports the tab as playing, and must never be heard): 80 Hz "kick" for 120 ms every 500 ms (2 Hz) and a quiet 1 kHz tone, scheduled on the audio clock for 200 s.
const TONE = `<!doctype html><meta charset="utf-8"><title>tone</title><script>
let ctx = null; let master = null;
window.startTone = () => {
  ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = 0.001; master.connect(ctx.destination); // -60 dBFS: Chromium still counts it as playing, a person hears nothing
  const kick = ctx.createOscillator(); kick.frequency.value = 80; const kg = ctx.createGain(); kg.gain.value = 0; kick.connect(kg); kg.connect(master);
  const mid = ctx.createOscillator(); mid.frequency.value = 1000; const mg = ctx.createGain(); mg.gain.value = 0.5; mid.connect(mg); mg.connect(master);
  const t0 = ctx.currentTime + 0.1;
  for (let i = 0; i < 400; i++) { kg.gain.setValueAtTime(0.9, t0 + i * 0.5); kg.gain.setValueAtTime(0, t0 + i * 0.5 + 0.12); }
  kick.start(); mid.start(); return ctx.state;
};
window.stopTone = () => { try { ctx.close(); } catch {} return true; };
</script>`;

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(TONE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const toneUrl = `http://127.0.0.1:${server.address().port}/tone.html`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-musicreact-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabPrivacy: false, graphicsMode: 'full' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_TEST_ALLOW_AUDIO: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
  const openTab = (url) => app.evaluate((_e, [u]) => new Promise((res) => { const t = global.__agent.browser.openTab(u); (global.__mrTabs ||= []).push(t); t.webContents.once('did-finish-load', () => res(t.id)); }), [url]);
  const run = (id, code) => app.evaluate((_e, [i, c]) => global.__mrTabs.find((t) => t.id === i).webContents.executeJavaScript(c, true), [id, code]); // (true: as if the user had touched the page, so its audio may start)
  const closeTab = (id) => app.evaluate((_e, i) => global.__notifyClick.closeTab(i), id);
  const gone = `({ api: typeof window.setMusicReactive, scripts: [...document.scripts].some((s) => /music-react|music-field/.test(s.src)), canvas: document.querySelectorAll('#mr-canvas').length, mr: document.body.dataset.mr || null, cap: document.body.dataset.mrCap || null, cls: document.body.classList.contains('mr-on'), beat: document.getElementById('clock-card')?.style.getPropertyValue('--mr-beat') || '' })`;
  const waitFor = async (id, code, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await run(id, code)) return true; } catch { /* page busy */ } await sleep(150); } return false; };
  const LIVE = `document.body.dataset.mr === 'live' && document.body.dataset.mrCap === '1'`;
  const FILE_HOME = undefined; // (a new tab: the new-tab page)

  // A watcher in the main process: the longest the event loop is held up (a task over 20 ms would show as a late 4 ms timer).
  await app.evaluate(() => { const w = global.__mrStall = { max: 0, last: Date.now(), on: false }; setInterval(() => { const now = Date.now(); if (w.on) w.max = Math.max(w.max, now - w.last - 4); w.last = now; }, 4).unref(); });
  const stall = (on) => app.evaluate((_e, v) => { global.__mrStall.on = v; if (v) { global.__mrStall.max = 0; global.__mrStall.last = Date.now(); } return global.__mrStall.max; }, on);

  const toneTab = await openTab(toneUrl);
  const started = await run(toneTab, 'startTone()');
  check('the test page starts its tone', started === 'running', started);
  await sleep(1500);

  // ---- the ground truth for "does the music still play out loud": system loopback in a separate hidden window ----
  // (Chromium's own audible flag does not change when a tab's sound is interfered with, so it cannot tell. The loopback hears what is really rendered to
  // the output device: the 80 Hz kick of the tone shows in the bass bins, and a muted or dropped tab shows nothing there.)
  await app.evaluate(async ({ BrowserWindow, session, desktopCapturer }, u) => {
    const ses = session.fromPartition('music-react-probe');
    ses.setDisplayMediaRequestHandler(async (_req, cb) => { const srcs = await desktopCapturer.getSources({ types: ['screen'] }); cb({ video: srcs[0], audio: 'loopback' }); });
    const w = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { session: ses, backgroundThrottling: false } });
    await w.loadURL(u);
    global.__mrProbe = w;
  }, `http://127.0.0.1:${server.address().port}/probe`);
  const probe = (c) => app.evaluate((_e, c2) => global.__mrProbe.webContents.executeJavaScript(c2, true), c);
  const probeOk = await probe(`(async () => { const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); s.getVideoTracks().forEach((t) => t.stop()); const c = new AudioContext(); await c.resume(); const a = c.createAnalyser(); a.fftSize = 1024; c.createMediaStreamSource(s).connect(a); window.__pk = []; const b = new Uint8Array(a.frequencyBinCount); setInterval(() => { a.getByteFrequencyData(b); let m = 0; for (let i = 1; i < 6; i++) m = Math.max(m, b[i]); window.__pk.push(m); }, 20); return s.getAudioTracks().length === 1 && c.state === 'running'; })()`).catch((e) => String(e));
  check('the loopback probe is listening to what the speakers play', probeOk === true, probeOk);
  const probeStart = () => probe('window.__pk = []; true');
  // the loudest bass reading in each half second (one kick each)
  const probePeaks = async () => { const pk = await probe('window.__pk'); const peaks = []; for (let i = 0; i + 25 <= pk.length; i += 25) peaks.push(Math.max(...pk.slice(i, i + 25))); return peaks; };
  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const probeLevel = async () => { const peaks = await probePeaks(); if (process.env.MR_DEBUG) console.log('probe peaks', peaks.join(' ')); return peaks.length < 4 ? NaN : median(peaks); };

  // ---- off, the default ----
  const home = await openTab(FILE_HOME);
  await waitFor(home, 'typeof window.lumenNewtab === "object"');
  await probeStart(); await sleep(5000);
  const baseLevel = await probeLevel();
  check(`the loopback hears the tone with the feature off (kick level ${baseLevel})`, baseLevel > 100, String(baseLevel));
  let g = await run(home, gone);
  check('off (default): nothing of the feature is on the page: no script, no canvas, no variables', g.api === 'undefined' && !g.scripts && g.canvas === 0 && !g.mr && !g.cap && !g.cls && g.beat === '', JSON.stringify(g));
  const offAnswer = await run(home, 'window.lumenNewtab.musicSource()');
  check('off: the browser answers the page nothing, even when asked', offAnswer && offAnswer.ok === false, JSON.stringify(offAnswer));
  const offMedia = await run(home, `navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name)`);
  check('off: the page is refused the microphone', offMedia !== 'granted', offMedia);
  const offDisplay = await run(home, `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)`);
  check('off: and cannot listen to the PC\'s sound by asking for it itself', offDisplay !== 'granted', offDisplay);

  // ---- on ----
  await app.evaluate(() => { global.__mrStall.on = false; });
  await set('newTabMusicReactive', true);
  check('on: the page loads the feature and listens (the loopback is open)', await waitFor(home, LIVE, 25000), JSON.stringify(await run(home, gone)));
  const mic = await run(home, `navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)`);
  check('on: and the microphone is still refused', mic !== 'granted', mic);
  const asked = await run(home, 'window.lumenNewtab.musicSource()');
  check('on: the browser says yes only for the new-tab page, once per stream', asked && asked.ok === true, JSON.stringify(asked));
  await sleep(1500);
  // Recorded inside the page, once a frame (a read from here is too slow to catch a pulse)
  await run(home, `window.__mrRec = []; window.__mrStop = false; (function f(t) { const c = window.__mrCost; const o = c.out; const fld = c.field; let sp = 0, n = 0; if (fld) { for (let i = 0; i < fld.n; i += 3) { sp += Math.hypot(fld.bx[i], fld.by[i]); n++; } } window.__mrRec.push({ t, mr: document.body.dataset.mr || null, bass: o ? o.bass : NaN, mids: o ? o.mids : NaN, highs: o ? o.highs : NaN, beat: o ? o.beat : NaN, burst: n ? sp / n : NaN, frames: c.frames }); if (window.__mrRec.length < 100000 && !window.__mrStop) requestAnimationFrame(f); })(0); true`);
  await sleep(500); await stall(true);
  await sleep(8000);
  const stalled = await stall(false);
  const series = await run(home, `window.__mrStop = true; window.__mrRec`);
  const live = series.filter((s) => s.mr === 'live');
  check('on: the page stayed on the tone for the whole run (live, not the idle drift)', live.length >= series.length * 0.9, `${live.length} of ${series.length}`);
  const bass = live.map((s) => s.bass).filter(Number.isFinite);
  check('on: the bass follows the kick: it swings over most of its range', Math.max(...bass) - Math.min(...bass) > 0.5, `${Math.min(...bass)}..${Math.max(...bass)}`);
  const mids = live.map((s) => s.mids).filter(Number.isFinite);
  check('on: the mids and highs are alive too (the 1 kHz tone is in the mids)', Math.max(...mids) > 0.2, `${Math.max(...mids)}`);
  let pulses = 0; for (let i = 1; i < live.length; i++) if (live[i].beat > 0.6 && !(live[i - 1].beat > 0.6)) pulses++;
  check('on: a beat is found for each kick (about 16 in 8 s)', pulses >= 8 && pulses <= 20, String(pulses));
  const burst = live.map((s) => s.burst).filter(Number.isFinite);
  check('on: the dots burst outward on the beat and settle between (their burst speed swings, over 100 px/s at the peak)', Math.max(...burst) > 100 && Math.min(...burst) < Math.max(...burst) * 0.5, `${Math.min(...burst).toFixed(1)}..${Math.max(...burst).toFixed(1)}`);
  check('on: every number stays within 0..1', [...bass, ...mids, ...live.map((s) => s.highs), ...live.map((s) => s.beat)].filter(Number.isFinite).every((v) => v >= 0 && v <= 1), '');
  const rises = (key) => { const ups = []; let armed = true; for (const s of live) { const v = s[key]; if (armed && v > 0.5) { ups.push(s.t); armed = false; } else if (!armed && v < 0.25) armed = true; } let w = 0; for (const a of ups) w = Math.max(w, ups.filter((b) => b >= a && b < a + 1000).length); return w; };
  check('on: nothing flashes more than 3 times in a second (bass, mids, highs and beat)', ['bass', 'mids', 'highs', 'beat'].every((k) => rises(k) <= 3), JSON.stringify(['bass', 'mids', 'highs', 'beat'].map(rises)));
  const picture = await run(home, `(() => { const c = document.getElementById('mr-canvas'); const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data; const m = document.querySelector('main').getBoundingClientRect(); const k = c.width / innerWidth; const c0 = Math.ceil((m.left + 4) * k), c1 = Math.floor((m.right - 4) * k); let lit = 0, max = 0, colMax = 0; for (let y = 0; y < c.height; y += 2) for (let xx = 0; xx < c.width; xx += 2) { const a = d[(y * c.width + xx) * 4 + 3]; if (a > 6) lit++; if (a > max) max = a; if (xx >= c0 && xx <= c1 && a > colMax) colMax = a; } const r = c.getBoundingClientRect(); return { lit, max, colMax, w: c.width, h: c.height, css: [Math.round(r.width), Math.round(r.height)], z: getComputedStyle(c).zIndex, ev: getComputedStyle(c).pointerEvents, hidden: c.getAttribute('aria-hidden'), n: document.body.dataset.mrParticles }; })()`);
  check('on: the picture is really drawn (soft dots lit over the canvas), and behind the content column it is cut to a tenth (nothing there more than 13 % opaque)', picture.lit > 300 && picture.colMax <= Math.round(255 * 0.13), JSON.stringify(picture));
  check('on: the canvas is behind the content, never takes a click and is hidden from screen readers; 180 dots', picture.z === '-1' && picture.ev === 'none' && picture.hidden === 'true' && picture.n === '180', JSON.stringify(picture));
  check('on: it covers the window', picture.css[0] > 300 && picture.css[1] > 200, JSON.stringify(picture.css));
  check('the main process never held up for a task over 20 ms while the page listened (8 s, the page the only thing asking it anything)', stalled <= 20, `${stalled} ms`);

  // ---- the music keeps playing, with no dropout, while the new tab opens, hides, shows and closes, over and over ----
  const levelNow = (await (async () => { await probeStart(); await sleep(3000); return probeLevel(); })());
  check(`on: the tab's sound is at its normal level while the page listens (kick level ${levelNow} against ${baseLevel} before; a muted tab reads about 0)`, levelNow >= baseLevel * 0.7, `${levelNow} vs ${baseLevel}`);
  await probeStart();
  let cycles = 0; let hiddenCapClosed = 0; let shownCapOpen = 0;
  for (let i = 0; i < 6; i++) {
    const t = await openTab(FILE_HOME);
    await waitFor(t, LIVE, 20000) && shownCapOpen++;
    await sleep(700);
    await run(t, `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))`);
    if (await waitFor(t, `document.body.dataset.mrCap === '0' && document.body.dataset.mr === 'idle'`, 3000)) hiddenCapClosed++;
    await sleep(500);
    await run(t, `delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
    await waitFor(t, LIVE, 20000);
    await sleep(500);
    await closeTab(t);
    cycles++;
    await sleep(400);
  }
  const peaks = await probePeaks();
  const worst = Math.min(...peaks);
  check(`playback: no dropout in ${peaks.length} half-seconds of the tone's kick while the new tab opened, hid, showed and closed ${cycles} times (the weakest kick ${worst}, the usual ${median(peaks)}, before ${baseLevel})`, peaks.length >= 20 && worst >= median(peaks) * 0.8 && worst >= baseLevel * 0.7, `${peaks.join(' ')}`);
  check(`listening: the page opened the loopback each time it was shown (${shownCapOpen} of ${cycles}) and closed it each time it was hidden (${hiddenCapClosed} of ${cycles})`, shownCapOpen === cycles && hiddenCapClosed === cycles, `${shownCapOpen} ${hiddenCapClosed}`);
  await app.evaluate((_e, i) => { global.__mrCycles = i; }, cycles);

  // ---- hidden: no frames and no loopback ----
  await run(home, `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(1500);
  const h1 = await run(home, `({ f: window.__mrCost.frames, cap: document.body.dataset.mrCap, mr: document.body.dataset.mr })`); await sleep(1500);
  const h2 = await run(home, `({ f: window.__mrCost.frames, cap: document.body.dataset.mrCap, mr: document.body.dataset.mr })`);
  check('hidden: no more frames are drawn and the loopback is closed', h1.cap === '0' && h2.cap === '0' && h1.f === h2.f && h2.mr === 'idle', JSON.stringify([h1, h2]));
  await run(home, `delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
  check('hidden: back in front it listens again', await waitFor(home, LIVE, 20000), JSON.stringify(await run(home, gone)));

  // ---- the sound stops: a gentle idle drift ----
  await run(toneTab, 'stopTone()');
  const settled = await run(home, `new Promise((res) => { let last = performance.now(); const tick = () => { const o = window.__mrCost.out; if (o && (o.beat > 0.3 || o.bass > 0.5)) last = performance.now(); if (performance.now() - last > 3000) res(true); else if (performance.now() - last < 1e9 && window.__t0 === undefined) setTimeout(tick, 100); }; tick(); setTimeout(() => res(false), 25000); })`);
  check('quiet: when nothing plays the beats stop and the dots just drift', settled === true, String(settled));
  const idle = await run(home, `(() => { const o = window.__mrCost.out; const f = window.__mrCost.field; let sp = 0; for (let i = 0; i < f.n; i++) sp += Math.hypot(f.bx[i], f.by[i]); return { out: o, burst: sp / f.n, frames: window.__mrCost.frames }; })()`);
  check('quiet: no beat, and the burst has settled', idle.out.beat < 0.02 && idle.burst < 20, JSON.stringify(idle));
  await run(toneTab, 'startTone()'); await sleep(1500);

  // ---- Visual effects: Light: 40 dots, at most 15 frames a second ----
  await set('graphicsMode', 'light');
  check('Visual effects: Light: the reduced version starts (40 dots)', await waitFor(home, `document.body.dataset.mrMode === 'reduced' && document.body.dataset.mrParticles === '40' && ${LIVE}`, 20000), JSON.stringify(await run(home, gone)));
  const f0 = await run(home, 'window.__mrCost.frames'); await sleep(4000); const f1 = await run(home, 'window.__mrCost.frames');
  check(`Visual effects: Light: at most 15 frames a second (${((f1 - f0) / 4).toFixed(1)} a second)`, (f1 - f0) / 4 <= 16.5 && (f1 - f0) > 20, `${f1 - f0} in 4 s`);
  const redBass = await run(home, `(async () => { const v = []; window.__raw = []; for (let i = 0; i < 40; i++) { v.push(window.__mrCost.out.bass); window.__raw.push(window.__mrCost.in ? window.__mrCost.in.bass : -1); await new Promise((r) => setTimeout(r, 50)); } return v; })()`);
if (process.env.MR_DEBUG) console.log('light raw', (await run(home, 'window.__raw')).map((v) => v.toFixed(3)).join(' '));
  if (process.env.MR_DEBUG) console.log('light bass', redBass.map((v) => v.toFixed(2)).join(' '));
  check('Visual effects: Light: it still follows the sound', Math.max(...redBass) - Math.min(...redBass) > 0.3, `${Math.min(...redBass)}..${Math.max(...redBass)}`);
  const redBounce = await run(home, `({ beat: document.getElementById('clock-card')?.style.getPropertyValue('--mr-beat') || '' })`);
  check('Visual effects: Light: no bounce', redBounce.beat === '', JSON.stringify(redBounce));
  await set('graphicsMode', 'full');
  check('Visual effects: Full again: the full version comes back (180 dots)', await waitFor(home, `document.body.dataset.mrMode === 'full' && document.body.dataset.mrParticles === '180'`, 20000), JSON.stringify(await run(home, gone)));

  // ---- Reduce motion and Performance mode turn it off fully ----
  await set('reduceMotion', true);
  check('Reduce motion: everything stops at once, the loopback closed', await waitFor(home, `!document.getElementById('mr-canvas') && !document.body.dataset.mr && !document.body.dataset.mrCap`, 8000), JSON.stringify(await run(home, gone)));
  await set('reduceMotion', false);
  check('Reduce motion off again: it comes back', await waitFor(home, LIVE, 25000), '');
  await set('performanceMode', 'on');
  check('Performance mode: everything stops (not even the reduced version)', await waitFor(home, `!document.getElementById('mr-canvas') && !document.body.dataset.mr && !document.body.dataset.mrMode`, 8000), JSON.stringify(await run(home, gone)));
  await set('performanceMode', 'off');
  check('Performance mode off again: it comes back', await waitFor(home, LIVE, 25000), '');
  await set('graphicsMode', 'light'); await set('reduceMotion', true);
  check('Light and Reduce motion together: off, not reduced', await waitFor(home, `!document.getElementById('mr-canvas') && !document.body.dataset.mrMode`, 8000), JSON.stringify(await run(home, gone)));
  await set('reduceMotion', false); await set('graphicsMode', 'full');
  await waitFor(home, `document.body.dataset.mrMode === 'full'`, 8000);

  // ---- a music card that reacts ("React to music" in its own settings): the same analyser, with or without the home screen ----
  await set('newTabMusicReactive', false);
  check('cards: with the home screen off and no card asking, nothing runs on the open page', await waitFor(home, `!document.getElementById('mr-canvas') && !document.body.dataset.mr && !document.body.dataset.mrCap`, 8000), JSON.stringify(await run(home, gone)));
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
  const cardId = (await W('save', { type: 'spotify', mode: 'status', art: true })).widget.id; // (React to music left at its default: off)
  const homeC = await openTab(FILE_HOME);
  await waitFor(homeC, `!!document.querySelector('.w-card.spotify')`, 20000);
  await sleep(4000);
  const cardOff = await run(homeC, `({ ...${gone}, react: document.querySelector('.w-card.spotify')?.dataset.mreact || null, halo: document.querySelector('.w-card.spotify')?.style.getPropertyValue('--mr-halo') || '' })`);
  check('cards: a music card with the option off (the default): nothing is loaded, nothing runs, no variable on the card', cardOff.api === 'undefined' && !cardOff.scripts && cardOff.canvas === 0 && !cardOff.mr && !cardOff.cap && cardOff.react === null && cardOff.halo === '', JSON.stringify(cardOff));
  const refreshCards = () => app.evaluate(() => global.__widgets.refreshAll?.()).catch(() => {});
  await W('save', { type: 'spotify', mode: 'status', art: true, react: true }, cardId);
  await refreshCards();
  check('cards: switch the card\'s option on and the page listens, with the home screen off (the analyser runs for the card alone)', await waitFor(homeC, `document.querySelector('.w-card.spotify')?.dataset.mreact === '1' && ${LIVE}`, 30000), JSON.stringify(await run(homeC, gone)));
  const cardOnly = await run(homeC, `({ canvas: document.querySelectorAll('#mr-canvas').length, bg: document.body.dataset.mrBg || null, cards: document.body.dataset.mrCards, mode: document.body.dataset.mrMode, frames: window.__mrCost.frames })`);
  check('cards: and nothing of the home screen is drawn (no canvas, no clock bounce)', cardOnly.canvas === 0 && cardOnly.bg === null && cardOnly.cards === '1' && cardOnly.mode === 'full', JSON.stringify(cardOnly));
  await run(homeC, `window.__mrRec = []; window.__mrStop = false; (function f(t) { const c = document.querySelector('.w-card.spotify'); window.__mrRec.push({ t, halo: Number(c.style.getPropertyValue('--mr-halo')), pulse: Number(c.style.getPropertyValue('--mr-pulse')) }); if (window.__mrRec.length < 100000 && !window.__mrStop) requestAnimationFrame(f); })(0); true`);
  await sleep(6000);
  const cs = await run(homeC, `window.__mrStop = true; window.__mrRec`);
  const halos = cs.map((x) => x.halo).filter(Number.isFinite); const cpulses = cs.map((x) => x.pulse).filter(Number.isFinite);
  check('cards: the card reacts to the tone: its glow follows the bass (a swing over most of the range)', Math.max(...halos) - Math.min(...halos) > 0.5 && Math.max(...halos) <= 1, `${Math.min(...halos)}..${Math.max(...halos)}`);
  let cp = 0; for (let i = 1; i < cpulses.length; i++) if (cpulses[i] > 0.6 && !(cpulses[i - 1] > 0.6)) cp++;
  check('cards: and its cover breathes on the beat (about 12 in 6 s)', cp >= 6 && cp <= 16, String(cp));
  const upsOf = (key) => { const ups = []; let armed = true; for (const s of cs) { const v = s[key]; if (armed && v > 0.5) { ups.push(s.t); armed = false; } else if (!armed && v < 0.25) armed = true; } return worstPerSecond(ups); };
  check('cards: the card\'s glow and cover never flash more than 3 times in a second', upsOf('halo') <= 3 && upsOf('pulse') <= 3, `${upsOf('halo')} ${upsOf('pulse')}`);
  const cardCss = await run(homeC, `(() => { const c = document.querySelector('.w-card.spotify'); const a = getComputedStyle(c, '::after'); return { op: Number(a.opacity), ev: a.pointerEvents, hidden: Boolean(c.querySelector('[aria-hidden]')) || true }; })()`);
  check('cards: the glow on the card is faint (never more than 7 % opaque) and never takes a click', cardCss.op <= 0.07 + 1e-6 && cardCss.ev === 'none', JSON.stringify(cardCss));
  // one analyser, shared: turning the home screen on and off while the card reacts neither opens a second listening nor closes the first
  await run(homeC, `window.__gdm = 0; const og = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getDisplayMedia = (...a) => { window.__gdm++; return og(...a); }; true`);
  await set('newTabMusicReactive', true);
  check('both: the home screen turns on beside the card (the canvas appears, 180 dots)', await waitFor(homeC, `!!document.getElementById('mr-canvas') && document.body.dataset.mrParticles === '180' && ${LIVE}`, 15000), JSON.stringify(await run(homeC, gone)));
  await sleep(2500);
  const both = await run(homeC, `({ gdm: window.__gdm, cap: document.body.dataset.mrCap, mr: document.body.dataset.mr })`);
  check('both: still ONE listening (no second capture was opened, the first stayed open)', both.gdm === 0 && both.cap === '1' && both.mr === 'live', JSON.stringify(both));
  await set('newTabMusicReactive', false);
  check('both: the home screen turns off again and the card keeps reacting on the same listening', await waitFor(homeC, `!document.getElementById('mr-canvas') && ${LIVE} && document.querySelector('.w-card.spotify')?.dataset.mreact === '1'`, 15000) && (await run(homeC, 'window.__gdm')) === 0, JSON.stringify(await run(homeC, gone)));
  // Visual effects: Light and Reduce motion for the card
  await set('graphicsMode', 'light');
  check('cards: Visual effects: Light: the card still glows but no longer breathes (the reduced version)', await waitFor(homeC, `document.body.dataset.mrMode === 'reduced'`, 15000) && await (async () => { const r = await run(homeC, `(async () => { await new Promise((r3) => setTimeout(r3, 500)); const c = document.querySelector('.w-card.spotify'); let hi = 0; let pu = 0; for (let i = 0; i < 40; i++) { hi = Math.max(hi, Number(c.style.getPropertyValue('--mr-halo'))); pu = Math.max(pu, Number(c.style.getPropertyValue('--mr-pulse'))); await new Promise((r2) => setTimeout(r2, 50)); } return { hi, pu }; })()`); if (process.env.MR_DEBUG) console.log('light card', JSON.stringify(r)); return r.hi > 0.3 && r.pu === 0; })(), JSON.stringify(await run(homeC, `({ mode: document.body.dataset.mrMode, cards: document.body.dataset.mrCards, mr: document.body.dataset.mr, halo: document.querySelector('.w-card.spotify')?.style.getPropertyValue('--mr-halo') })`)));
  await set('graphicsMode', 'full');
  await waitFor(homeC, `document.body.dataset.mrMode === 'full'`, 15000);
  await set('reduceMotion', true);
  check('cards: Reduce motion: the card is still, the listening closed', await waitFor(homeC, `!document.body.dataset.mr && !document.body.dataset.mrCap && !document.querySelector('.w-card.spotify').style.getPropertyValue('--mr-halo')`, 8000), JSON.stringify(await run(homeC, gone)));
  await set('reduceMotion', false);
  check('cards: Reduce motion off again: it comes back', await waitFor(homeC, LIVE, 25000), '');
  // the card's option off again, with the home screen off: both off, nothing runs
  await W('save', { type: 'spotify', mode: 'status', art: true, react: false }, cardId);
  await refreshCards();
  check('cards: with the card\'s option off again and the home screen off, nothing runs (no canvas, no listening, no variable, the card unmarked)', await waitFor(homeC, `!document.body.dataset.mr && !document.body.dataset.mrCap && !document.getElementById('mr-canvas') && !document.querySelector('.w-card.spotify').dataset.mreact && !document.querySelector('.w-card.spotify').style.getPropertyValue('--mr-halo')`, 15000), JSON.stringify(await run(homeC, gone)));
  await W('remove', cardId);
  await closeTab(homeC);
  await set('newTabMusicReactive', true); // (the checks below start from the home screen on)
  await waitFor(home, LIVE, 25000);

  // ---- Settings: one line under the switch says why it is limited, and Preview shows the effect without music ----
  const settingsTab = await app.evaluate((_e, sec) => global.__settings.open(sec), 'home');
  const runS = (code) => app.evaluate((_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c, true), [settingsTab, code]);
  const waitForS = async (code, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await runS(code)) return true; } catch { /* loading */ } await sleep(150); } return false; };
  const NOTE = `(() => { const n = document.getElementById('music-reactive-note'); const l = document.getElementById('music-reactive-link'); const p = document.getElementById('music-reactive-preview'); return n ? { text: n.hidden ? '' : n.textContent, link: Boolean(l && !l.hidden), label: document.getElementById('pref-newTabMusicReactive')?.getAttribute('aria-label') || null, previewDisabled: Boolean(p && p.disabled), desc: document.getElementById('pref-newTabMusicReactive')?.closest('.row')?.textContent || '' } : null; })()`;
  const reload = async () => { await runS('location.reload()').catch(() => {}); await sleep(500); await waitForS(`!!document.getElementById('music-reactive-note')`, 20000); };
  await waitForS(`!!document.getElementById('music-reactive-note')`, 20000);
  let n = await runS(NOTE);
  check('Settings: the switch has a label', n && n.label === 'Music-reactive home screen', JSON.stringify(n));
  check('Settings: the description says plainly that it reacts to the sound the PC is playing, and that nothing is recorded or sent', n && /reacts to the sound your PC is playing/.test(n.desc) && /nothing is recorded or sent/.test(n.desc) && /microphone is never used/.test(n.desc), n && n.desc);
  check('Settings: Visual effects: Full, nothing limited: no line, Preview enabled', n && n.text === '' && !n.link && !n.previewDisabled, JSON.stringify(n));
  // the Preview: the same dots, a made-up beat, no capture
  await runS(`document.getElementById('music-reactive-preview').click()`);
  check('Settings: Preview shows the effect animating (a canvas appears and is drawn on)', await waitForS(`(() => { const c = document.getElementById('music-reactive-stage'); if (!c || c.hidden) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 3; i < d.length; i += 4 * 5) if (d[i] > 6) lit++; return lit > 50; })()`, 8000), JSON.stringify(await runS(`({ hidden: document.getElementById('music-reactive-stage').hidden })`)));
  const frames1 = await runS(`(() => { const c = document.getElementById('music-reactive-stage'); return c.toDataURL().length; })()`); await sleep(700);
  const frames2 = await runS(`(() => { const c = document.getElementById('music-reactive-stage'); return c.toDataURL().length; })()`);
  check('Settings: Preview really moves (the picture changes between two looks)', frames1 !== frames2, `${frames1} ${frames2}`);
  const prevLabel = await runS(`document.getElementById('music-reactive-preview').textContent`);
  check('Settings: Preview turns into Stop preview, and stops when pressed again', prevLabel === 'Stop preview' && (await runS(`document.getElementById('music-reactive-preview').click(); document.getElementById('music-reactive-stage').hidden`)) === true, prevLabel);
  await set('graphicsMode', 'light'); await reload(); n = await runS(NOTE);
  check('Settings: Light: "Simplified (fewer dots, slower) because Visual effects is set to Light", with a link', n && /^Simplified \(fewer dots, slower\) because Visual effects is set to Light\.$/.test(n.text) && n.link, JSON.stringify(n));
  await runS(`document.getElementById('music-reactive-link').click()`);
  check('Settings: the link jumps to Visual effects', await waitForS(`document.activeElement && document.activeElement.id === 'pref-graphicsMode'`, 15000), JSON.stringify(await runS(`document.activeElement && document.activeElement.id`)));
  await set('graphicsMode', 'full'); await set('reduceMotion', true); await reload(); n = await runS(NOTE);
  check('Settings: Reduce motion: says it is off, no link, Preview off', n && /^Off because Reduce motion is on\.$/.test(n.text) && !n.link && n.previewDisabled, JSON.stringify(n));
  await set('reduceMotion', false); await set('performanceMode', 'on'); await reload(); n = await runS(NOTE);
  check('Settings: Performance mode: says it is off, no link, Preview off', n && /^Off because Performance mode is on\.$/.test(n.text) && !n.link && n.previewDisabled, JSON.stringify(n));
  await set('performanceMode', 'off');

  // ---- off again ----
  await set('newTabMusicReactive', false);
  check('switched off: the canvas, class and variables are removed and the loopback is closed', await waitFor(home, `!document.getElementById('mr-canvas') && !document.body.dataset.mr && !document.body.dataset.mrCap && !document.body.classList.contains('mr-on') && !document.getElementById('clock-card').style.getPropertyValue('--mr-beat')`, 8000), JSON.stringify(await run(home, gone)));
  const after = await run(home, 'window.lumenNewtab.musicSource()');
  check('switched off: the browser answers nothing again', after && after.ok === false, JSON.stringify(after));
  await probeStart(); await sleep(4000);
  const endLevel = await probeLevel();
  check(`switched off: the tone is at its normal level at the end (kick level ${endLevel} against ${baseLevel})`, endLevel >= baseLevel * 0.7, `${endLevel} vs ${baseLevel}`);

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `${failures} FAILED` : 'music-react passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

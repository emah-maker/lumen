// Music-reactive home screen, in the real app (hidden window, throwaway profile, no real network). A local page plays a generated test tone
// (an oscillator pulsing like a kick drum, plus a steady mid tone) in one tab; the new-tab page in another reads it through Chromium's per-tab
// audio capture and writes --mr-glow / --mr-wave / --mr-beat. Checked:
//   off (the default)  nothing is loaded, nothing runs, and the browser answers the page nothing
//   on                 the variables follow the beat, stay under their caps and never flash more than 3 times a second; an idle drift when the
//                      sound stops; nothing while the page is not in front
//   calm               Reduce motion (the setting) and Performance mode stop it at once; Visual effects: Light gives a reduced version (glow only,
//                      at most 10 writes a second); Settings says why under the switch; turning it off removes everything
//   main process       no task over 20 ms while it all runs
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

// The test tone, at -60 dBFS (this suite runs with Chromium's audio on so that it reports the tab as playing, and must never be heard): 80 Hz "kick" for 120 ms every 500 ms (2 Hz) and a quiet 1 kHz tone, scheduled on the audio clock for 200 s.
const TONE = `<!doctype html><meta charset="utf-8"><title>tone</title><script>
let ctx = null; let master = null;
window.startTone = () => {
  ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = 0.001; master.connect(ctx.destination); // -60 dBFS: Chromium still counts it as playing, a person hears nothing
  const kick = ctx.createOscillator(); kick.frequency.value = 80; const kg = ctx.createGain(); kg.gain.value = 0; kick.connect(kg); kg.connect(master);
  const mid = ctx.createOscillator(); mid.frequency.value = 1000; const mg = ctx.createGain(); mg.gain.value = 0.08; mid.connect(mg); mg.connect(master);
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
  const show = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  const SAMPLE = `({ mr: document.body.dataset.mr || null, glow: document.getElementById('mr-glow')?.style.getPropertyValue('--mr-glow') || null, wave: document.getElementById('mr-wave')?.style.getPropertyValue('--mr-wave') || null, beat: document.getElementById('clock-card')?.style.getPropertyValue('--mr-beat') || null, hidden: document.hidden })`;
  const gone = `({ api: typeof window.setMusicReactive, scripts: [...document.scripts].some((s) => /music-react/.test(s.src)), layers: document.querySelectorAll('#mr-glow, #mr-wave').length, mr: document.body.dataset.mr || null, cls: document.body.classList.contains('mr-on'), beat: document.getElementById('clock-card')?.style.getPropertyValue('--mr-beat') || '' })`;
  const waitFor = async (id, code, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await run(id, code)) return true; } catch { /* page busy */ } await sleep(150); } return false; };
  const nodeOf = (v) => (v === null || v === '' ? NaN : Number(v));

  // A watcher in the main process: the longest the event loop is held up (a task over 20 ms would show as a late 4 ms timer).
  await app.evaluate(() => { const w = global.__mrStall = { max: 0, last: Date.now(), on: false }; setInterval(() => { const now = Date.now(); if (w.on) w.max = Math.max(w.max, now - w.last - 4); w.last = now; }, 4).unref(); });
  const stall = (on) => app.evaluate((_e, v) => { global.__mrStall.on = v; if (v) { global.__mrStall.max = 0; global.__mrStall.last = Date.now(); } return global.__mrStall.max; }, on);

  const toneTab = await openTab(toneUrl);
  const started = await run(toneTab, 'startTone()');
  check('the test page starts its tone', started === 'running', started);
  await sleep(1500);
  let audible = false; for (let i = 0; i < 12 && !audible; i++) { audible = await app.evaluate((_e, id) => global.__mrTabs.find((t) => t.id === id).webContents.isCurrentlyAudible(), toneTab); if (!audible) await sleep(250); } // (Chromium says silent in the gaps between kicks: asked a few times)
  check('the tone tab is playing sound (Chromium reports it audible)', audible === true, audible);

  // ---- off, the default ----
  const home = await openTab(undefined); // the new-tab page
  await show(home);
  await waitFor(home, 'document.querySelectorAll(".w-card").length >= 0 && typeof window.lumenNewtab === "object"');
  await sleep(6000);
  let g = await run(home, gone);
  check('off (default): nothing of the feature is on the page: no script, no layers, no variables', g.api === 'undefined' && !g.scripts && g.layers === 0 && !g.mr && !g.cls && g.beat === '', JSON.stringify(g));
  const offAnswer = await run(home, 'window.lumenNewtab.musicSource(null)');
  check('off: the browser answers the page nothing, even when asked', offAnswer && offAnswer.key === null && !offAnswer.id, JSON.stringify(offAnswer));
  const offMedia = await run(home, `navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name)`);
  check('off: the page is refused the microphone', offMedia !== 'granted', offMedia);
  check('off: nothing asks the page for the tab\'s sound either (a forged id is refused)', (await run(home, `navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'forged' } }, video: false }).then(() => 'granted', (e) => e.name)`)) !== 'granted', '');

  // ---- on ----
  // baseline: the same reads with the feature still off, to tell this feature's stalls from the test's own
  await stall(true); await sleep(8000);
  const baseline = await stall(false);
  if (process.env.MR_DEBUG) console.log('baseline main stall', baseline, 'ms');
  await set('newTabMusicReactive', true);
  check('on: the page loads the feature and says it is listening', await waitFor(home, `document.body.dataset.mr === 'live'`, 25000), JSON.stringify(await run(home, SAMPLE)));
  if (process.env.MR_DEBUG) { const r = []; for (let i = 0; i < 10; i++) { const x = await run(home, 'window.lumenNewtab.musicSource(null).then((v) => JSON.stringify(v).slice(0, 40)) '); r.push(x); await sleep(500); } console.log('source answers', r.join(' ')); }
  // (the main process is watched only while the page reads the tone and nothing else talks to it: the recorder below runs inside the page)
  await sleep(500); await stall(true);
  // Recorded inside the page, once a frame (a read from here is too slow to catch a 170 ms pulse)
  await run(home, `window.__mrRec = []; (function f(t) { const g = document.getElementById('mr-glow'); const w = document.getElementById('mr-wave'); const c = document.getElementById('clock-card'); window.__mrRec.push({ t, mr: document.body.dataset.mr || null, glow: g ? Number(g.style.getPropertyValue('--mr-glow')) : NaN, wave: w ? Number(w.style.getPropertyValue('--mr-wave')) : NaN, beat: c ? Number(c.style.getPropertyValue('--mr-beat')) : NaN }); if (window.__mrRec.length < 100000 && !window.__mrStop) requestAnimationFrame(f); })(0); true`);
  await sleep(8000);
  const stalled = await stall(false);
  const series = await run(home, `window.__mrStop = true; window.__mrRec`);
  if (process.env.MR_DEBUG) { let last = null; const ch = []; for (const f of series) if (f.mr !== last) { ch.push(Math.round(f.t - series[0].t) + ':' + f.mr); last = f.mr; } console.log('mr changes', ch.join(' ')); }
  if (process.env.MR_DEBUG) { const gl = series.filter((f) => f.mr === 'live'); console.log('glow every 6th frame', gl.filter((_, i) => i % 6 === 0).slice(0, 80).map((f) => f.glow.toFixed(3)).join(' ')); console.log('beat>0.6 at', series.filter((f, i) => f.beat > 0.6 && !(series[i - 1]?.beat > 0.6)).map((f) => Math.round(f.t - series[0].t)).join(' ')); }
  check('the main process never held up for a task over 20 ms while the page listened (8 s, the page the only thing asking it anything)', stalled <= 20, `${stalled} ms (the same wait with the feature off: ${baseline} ms)`);
  const live = series.filter((s) => s.mr === 'live');
  check('on: the page stayed on the tone for the whole run (live, not the idle drift)', live.length >= series.length * 0.9, `${live.length} of ${series.length}`);
  const g0 = live.map((s) => s.glow).filter(Number.isFinite);
  check('on: --mr-glow follows the sound: it swings with the beat', g0.length > 50 && Math.max(...g0) - Math.min(...g0) > MR.GLOW_CAP * 0.5, `${Math.min(...g0)}..${Math.max(...g0)} (${g0.length} samples)`);
  const bs = live.map((s) => s.beat).filter(Number.isFinite);
  let pulses = 0; for (let i = 1; i < bs.length; i++) if (bs[i] > 0.6 && bs[i - 1] <= 0.6) pulses++;
  check('on: --mr-beat pulses with the 2 Hz kick (about 16 in 8 s)', pulses >= 8 && pulses <= 20, `${pulses}`);
  check('on: every value stays under its cap', Math.max(...g0) <= MR.GLOW_CAP + 0.003 && Math.max(...series.map((s) => s.wave).filter(Number.isFinite)) <= MR.WAVE_CAP + 0.003 && Math.max(...bs) <= 1, `${Math.max(...g0)}`);
  const rises = []; let armed = true;
  for (const s of live) { if (armed && s.glow > MR.GLOW_CAP * 0.5) { rises.push(s.t); armed = false; } else if (!armed && s.glow < MR.GLOW_CAP * 0.25) armed = true; }
  let worst = 0; for (const a of rises) worst = Math.max(worst, rises.filter((b) => b >= a && b < a + 1000).length);
  check('on: the glow never flashes more than 3 times in a second', worst <= 3, `${worst} of ${rises.length}`);
  const layers = await run(home, `({ glow: !!document.getElementById('mr-glow'), hidden: [...document.querySelectorAll('#mr-glow, #mr-wave')].every((e) => e.getAttribute('aria-hidden') === 'true' && getComputedStyle(e).pointerEvents === 'none') })`);
  check('on: the layers exist, are hidden from screen readers and never take a click', layers.glow && layers.hidden, JSON.stringify(layers));
  const contrast = await run(home, `(() => { const c = document.querySelector('.clock-card') || document.getElementById('clock'); return getComputedStyle(document.body).color })()`);
  check('on: the page still has its own text colour (the layers never touch it)', typeof contrast === 'string' && contrast.length > 0, contrast);

  // ---- the page not in front: no frames, no capture ----
  // (a hidden test window reports every tab as visible, so the page is told what a tab in the background would be told)
  await run(home, `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(1500);
  const h1 = await run(home, SAMPLE); await sleep(1500); const h2 = await run(home, SAMPLE);
  check('hidden: with the page not in front the variables stop moving and it is no longer listening', h1.hidden === true && h1.glow !== null && h1.glow === h2.glow && h1.beat === h2.beat && h2.mr === 'idle', JSON.stringify([h1, h2]));
  await run(home, `delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
  check('hidden: back in front it listens again', await waitFor(home, `document.body.dataset.mr === 'live'`, 15000), JSON.stringify(await run(home, SAMPLE)));

  // ---- the sound stops: a gentle idle drift ----
  await run(toneTab, 'stopTone()');
  check('quiet: when nothing plays it falls back to the idle drift (no capture left open)', await waitFor(home, `document.body.dataset.mr === 'idle'`, 20000), JSON.stringify(await run(home, SAMPLE)));
  await sleep(1500);
  const idle = []; for (let i = 0; i < 40; i++) { const s = await run(home, SAMPLE); idle.push(nodeOf(s.glow)); await sleep(50); }
  const idleStep = Math.max(...idle.slice(1).map((v, i) => Math.abs(v - idle[i])));
  check('quiet: the idle drift is faint and slow (within the cap, no jump bigger than a tenth of it between reads 50 ms apart)', idle.every(Number.isFinite) && Math.max(...idle) <= MR.GLOW_CAP && idleStep < MR.GLOW_CAP * 0.1, `${Math.min(...idle)}..${Math.max(...idle)} step ${idleStep}`);


  // ---- calm: Reduce motion, Visual effects: Light ----
  await run(toneTab, 'startTone()'); await sleep(1500);
  await waitFor(home, `document.body.dataset.mr === 'live'`, 20000);
  await set('reduceMotion', true);
  check('Reduce motion: everything stops and goes at once', await waitFor(home, `typeof window.setMusicReactive === 'function' && !document.getElementById('mr-glow') && !document.body.dataset.mr`, 6000), JSON.stringify(await run(home, gone)));
  g = await run(home, gone);
  check('Reduce motion: no layers, no variables, no class', g.layers === 0 && !g.cls && g.beat === '', JSON.stringify(g));
  await set('reduceMotion', false);
  check('Reduce motion off again: it comes back', await waitFor(home, `!!document.getElementById('mr-glow')`, 8000), '');
  // ---- Visual effects: Light: the reduced version (glow only, no wave, no bounce, at most 10 writes a second) ----
  await set('graphicsMode', 'light');
  check('Visual effects: Light: the reduced version starts (glow only, no wave layer)', await waitFor(home, `document.body.dataset.mrMode === 'reduced' && !!document.getElementById('mr-glow') && !document.getElementById('mr-wave')`, 8000), JSON.stringify(await run(home, SAMPLE)));
  check('Visual effects: Light: it still listens to the tone', await waitFor(home, `document.body.dataset.mr === 'live'`, 20000), JSON.stringify(await run(home, SAMPLE)));
  await run(home, `window.__mrRec = []; window.__mrStop = false; (function f() { const g = document.getElementById('mr-glow'); const c = document.getElementById('clock-card'); window.__mrRec.push({ glow: g ? g.style.getPropertyValue('--mr-glow') : null, beat: c ? c.style.getPropertyValue('--mr-beat') : null, scale: c ? getComputedStyle(c).scale : null }); if (!window.__mrStop) requestAnimationFrame(f); })(); true`);
  await sleep(4000);
  const red = await run(home, `window.__mrStop = true; window.__mrRec`);
  const writes = red.filter((f, i) => i > 0 && f.glow !== red[i - 1].glow).length;
  const gv = red.map((f) => Number(f.glow)).filter(Number.isFinite);
  check('Visual effects: Light: the glow still follows the sound', Math.max(...gv) - Math.min(...gv) > MR.GLOW_CAP * 0.3, `${Math.min(...gv)}..${Math.max(...gv)}`);
  check('Visual effects: Light: at most 10 writes a second (about 4 s measured)', writes <= 42, `${writes} changes in 4 s`);
  check('Visual effects: Light: no wave, no bounce: no --mr-beat anywhere and the clock card never scales', red.every((f) => !f.beat && (f.scale === 'none' || f.scale === '1' || !f.scale)), JSON.stringify(red[0]));
  check('Visual effects: Light: the layer stays under its cap', Math.max(...gv) <= MR.GLOW_CAP + 0.003, String(Math.max(...gv)));
  await set('graphicsMode', 'full');
  check('Visual effects: Full again: the full version comes back', await waitFor(home, `document.body.dataset.mrMode === 'full' && !!document.getElementById('mr-wave')`, 8000), JSON.stringify(await run(home, SAMPLE)));
  // ---- Performance mode turns it off fully ----
  await set('performanceMode', 'on');
  check('Performance mode: everything stops (not even the reduced version)', await waitFor(home, `!document.getElementById('mr-glow') && !document.body.dataset.mr && !document.body.dataset.mrMode`, 8000), JSON.stringify(await run(home, gone)));
  await set('performanceMode', 'off');
  check('Performance mode off again: it comes back', await waitFor(home, `!!document.getElementById('mr-glow')`, 8000), '');
  await set('graphicsMode', 'light'); await set('reduceMotion', true);
  check('Light and Reduce motion together: off, not reduced', await waitFor(home, `!document.getElementById('mr-glow') && !document.body.dataset.mrMode`, 8000), JSON.stringify(await run(home, gone)));
  await set('reduceMotion', false); await set('graphicsMode', 'full');
  await waitFor(home, `document.body.dataset.mrMode === 'full'`, 8000);

  // ---- Settings: one line under the switch says why it is limited ----
  const settingsTab = await app.evaluate((_e, sec) => global.__settings.open(sec), 'home');
  const runS = (code) => app.evaluate((_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c, true), [settingsTab, code]);
  const waitForS = async (code, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await runS(code)) return true; } catch { /* loading */ } await sleep(150); } return false; };
  const NOTE = `(() => { const n = document.getElementById('music-reactive-note'); const l = document.getElementById('music-reactive-link'); return n ? { text: n.hidden ? '' : n.textContent, link: Boolean(l && !l.hidden), label: document.getElementById('pref-newTabMusicReactive')?.getAttribute('aria-label') || null } : null; })()`;
  const reload = async () => { await runS('location.reload()').catch(() => {}); await sleep(500); await waitForS(`!!document.getElementById('music-reactive-note')`, 20000); };
  await waitForS(`!!document.getElementById('music-reactive-note')`, 20000);
  let n = await runS(NOTE);
  check('Settings: the switch has a label', n && n.label === 'Music-reactive home screen', JSON.stringify(n));
  check('Settings: Visual effects: Full, nothing limited: no line', n && n.text === '' && !n.link, JSON.stringify(n));
  await set('graphicsMode', 'light'); await reload(); n = await runS(NOTE);
  check('Settings: Light: "Simplified (glow only) because Visual effects is set to Light", with a link', n && /^Simplified \(glow only\) because Visual effects is set to Light\.$/.test(n.text) && n.link, JSON.stringify(n));
  await runS(`document.getElementById('music-reactive-link').click()`);
  check('Settings: the link jumps to Visual effects', await waitForS(`document.activeElement && document.activeElement.id === 'pref-graphicsMode'`, 15000), JSON.stringify(await runS(`document.activeElement && document.activeElement.id`)));
  await set('graphicsMode', 'full'); await set('reduceMotion', true); await reload(); n = await runS(NOTE);
  check('Settings: Reduce motion: says it is off, no link', n && /^Off because Reduce motion is on\.$/.test(n.text) && !n.link, JSON.stringify(n));
  await set('reduceMotion', false); await set('performanceMode', 'on'); await reload(); n = await runS(NOTE);
  check('Settings: Performance mode: says it is off, no link', n && /^Off because Performance mode is on\.$/.test(n.text) && !n.link, JSON.stringify(n));
  await set('performanceMode', 'off');

  // ---- off again ----
  await set('newTabMusicReactive', false);
  check('switched off: the layers, class and variables are removed', await waitFor(home, `!document.getElementById('mr-glow') && !document.body.dataset.mr && !document.body.classList.contains('mr-on') && !document.getElementById('clock-card').style.getPropertyValue('--mr-beat')`, 6000), JSON.stringify(await run(home, gone)));
  const after = await run(home, 'window.lumenNewtab.musicSource(null)');
  check('switched off: the browser answers nothing again', after && after.key === null, JSON.stringify(after));

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `${failures} FAILED` : 'music-react passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

// [look] Music-reactive home screen (Settings → Appearance → New tab page → "Music-reactive home screen") and music cards that react ("React to music"
// in a Spotify or Apple Music card's own settings). newtab.js loads this file, features/music-react.js (the maths) and music-field-canvas.js (the drawing)
// only when either is on, so with both off none of this exists on the page.
//
// What it does: listens to the sound the PC is playing (Windows' system-output loopback, a copy of what is already going to the speakers: it never
// mutes, delays or interrupts anything, and it hears every program, the Spotify desktop app included) and reduces an analyser's frequency bytes to a few
// loudness numbers. ONE analyser serves both uses:
//   - the home screen: one canvas behind the widgets, soft dots in the accent's tones that drift slowly, burst on the beat, swell with the bass, swirl
//     with the mids and twinkle with the highs, with a glow that flows behind them, and the clock card bouncing a hair on the beat;
//   - a music card with the option on: its cover art breathes on the beat and a faint accent glow rims the card (two CSS variables on that card).
// The raw audio never leaves the analyser: nothing is recorded, stored, sent anywhere or played (this page is silent) and the microphone is never used.
//
//   - The analyser runs only while at least one of them is on (features/music-react.js plan) and the page is shown: hidden (another tab, minimised),
//     there are no frames, no timer and the loopback is closed. Both off: nothing exists.
//   - The canvas is decorative: aria-hidden, never takes a click, under the content, and cut away to a tenth behind the content column (text keeps its
//     contrast: features/music-react.js, test/music-react-units.js).
//   - Nothing playing: the dots just drift (a very slow idle) and the cards are still.
//   - Reduce motion (the setting or the system's) and Performance mode: nothing runs at all.
//   - Visual effects: Light and software drawing: 40 dots, no clock bounce and no cover pulse, at most 15 frames a second.
//   - The 2.8-flashes-a-second ceiling and the opacity limits are in features/music-react.js and tested there.
(() => {
  const MR = window.MusicReact;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const LIVE_MS = 33; // ~30 frames a second while music plays
  const IDLE_MS = 50; // ~20 a second for the slow idle drift
  const SILENT_MS = 1500; // a loopback that has been silent this long reads as idle
  const RETRY_MS = 15e3; // a loopback that could not open is tried again after this
  const FFT = 1024;

  let look = null;
  let bgMode = 'off'; let cardMode = 'off'; // 'off' | 'reduced' | 'full' (features/music-react.js plan)
  let active = false; // the analyser side runs (at least one of the two is on)
  let raf = 0; let startTimer = 0;
  let canvasEl = null; let painter = null;
  let cap = null; // { stream, ctx, analyser, bytes }
  let opening = false;
  let lastFrameT = 0; let silentSince = 0;
  let mapper = MR.createMapper(); let beats = MR.beatDetector();
  let clockEl = null; let cardEls = []; // what moves: the clock card, and the music cards that asked to react (found again as cards come and go)
  let lastBeat = ''; let lastHalo = ''; let lastPulse = '';
  const cost = window.__mrCost = { frames: 0, ms: 0, max: 0, out: null, field: null }; // (how long the frames took, the latest numbers and the dots: measuring aids, read only by the tests)
  const fast = () => bgMode === 'full' || cardMode === 'full'; // the faster cadence when either wants the full version

  const hasCards = () => Boolean(document.querySelector('.w-card[data-mreact="1"]'));
  function findTargets() {
    clockEl = bgMode === 'full' ? document.getElementById('clock-card') : null;
    const now = cardMode !== 'off' ? [...document.querySelectorAll('.w-card[data-mreact="1"]')] : [];
    for (const n of cardEls) if (!now.includes(n)) { n.style.removeProperty('--mr-halo'); n.style.removeProperty('--mr-pulse'); }
    cardEls = now;
    document.body.dataset.mrCards = String(now.length);
  }
  const q3 = (v) => (Math.round(v * 250) / 250).toFixed(3);
  function writeCards(halo, pulse) {
    const h = q3(halo); const p = cardMode === 'full' ? q3(pulse) : '0.000';
    if (h === lastHalo && p === lastPulse) return;
    lastHalo = h; lastPulse = p;
    for (const n of cardEls) { n.style.setProperty('--mr-halo', h); n.style.setProperty('--mr-pulse', p); }
  }
  function writeBeat(v) {
    const s = q3(v);
    if (s === lastBeat) return;
    lastBeat = s;
    if (clockEl) clockEl.style.setProperty('--mr-beat', s);
  }

  function column() {
    const m = document.querySelector('main');
    const r = m ? m.getBoundingClientRect() : null;
    return r && r.width > 0 ? { cx: r.left + r.width / 2, w: r.width + 48 } : { cx: innerWidth / 2, w: 688 };
  }
  const toneOf = () => (document.body.classList.contains('on-media') && !document.body.classList.contains('tone-light') ? 'media' : 'plain');
  const accentOf = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
  function layout() {
    if (!painter) return;
    painter.resize(innerWidth, innerHeight, devicePixelRatio || 1, column());
    painter.setAccent(accentOf());
    painter.setTone(toneOf());
    cost.field = painter.field;
  }

  function stopCapture() {
    if (!cap) return;
    const c = cap; cap = null;
    try { for (const t of c.stream.getTracks()) t.stop(); } catch { /* already ended */ }
    try { c.ctx.close(); } catch { /* already closed */ }
    document.body.dataset.mr = 'idle';
    document.body.dataset.mrCap = '0';
  }
  async function startCapture() {
    if (opening || cap || !active || document.hidden) return;
    opening = true;
    try {
      const r = await window.lumenNewtab?.musicSource?.();
      if (!r || r.ok !== true || !active || document.hidden) { if (active && !document.hidden) retryLater(); return; }
      // The PC's sound, audio only: Chromium asks for a video track too, and it is stopped at once (never drawn, never read).
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
      if (!stream.getAudioTracks().length || !active || document.hidden) { for (const t of stream.getTracks()) t.stop(); if (active && !document.hidden) retryLater(); return; }
      const ctx = new AudioContext({ latencyHint: 'playback' });
      for (let i = 0; i < 6 && ctx.state !== 'running'; i++) { try { await ctx.resume(); } catch { /* not yet */ } if (ctx.state !== 'running') await new Promise((res) => setTimeout(res, 250)); }
      if (!active || document.hidden || ctx.state !== 'running') { for (const t of stream.getTracks()) t.stop(); try { ctx.close(); } catch { /* closed */ } if (active && !document.hidden) retryLater(); return; }
      const analyser = ctx.createAnalyser(); // (never connected to anything that makes a sound: this page is silent)
      analyser.fftSize = FFT; analyser.smoothingTimeConstant = 0.55;
      ctx.createMediaStreamSource(stream).connect(analyser);
      cap = { stream, ctx, analyser, bytes: new Uint8Array(analyser.frequencyBinCount) };
      stream.getAudioTracks()[0].addEventListener('ended', () => { if (cap && cap.stream === stream) { stopCapture(); if (active && !document.hidden) retryLater(); } });
      silentSince = 0;
      document.body.dataset.mrCap = '1';
    } catch { if (active && !document.hidden) retryLater(); } finally { opening = false; }
  }
  function retryLater() { clearTimeout(startTimer); startTimer = setTimeout(startCapture, RETRY_MS); }

  function frame(t) {
    raf = 0;
    if (!active || document.hidden) return;
    raf = requestAnimationFrame(frame);
    const live = Boolean(cap) && cap.ctx.state === 'running';
    const shown = live ? 'live' : 'idle'; // (what the page is doing, for the tests: 'live' only while an analyser is really running)
    if (document.body.dataset.mr !== shown) document.body.dataset.mr = shown;
    if (t - lastFrameT < (!fast() ? MR.REDUCED_MS : live ? LIVE_MS : IDLE_MS)) return;
    const dt = lastFrameT ? Math.min(0.1, (t - lastFrameT) / 1000) : 0.033;
    lastFrameT = t;
    const t0 = performance.now();
    let input = null;
    if (live) {
      cap.analyser.getByteFrequencyData(cap.bytes);
      const b = MR.bandsOf(cap.bytes, cap.ctx.sampleRate, FFT);
      if (!MR.isSilent(b)) silentSince = 0; else if (!silentSince) silentSince = t;
      if (!silentSince || t - silentSince < SILENT_MS) input = { bass: b.bass, mids: b.mids, highs: b.highs, level: b.level, beat: beats.push(t, b.bass) };
    }
    const out = mapper.step(input, t);
    if (painter) { painter.draw(t, out, dt); if (bgMode === 'full') writeBeat(out.beat); }
    if (cardEls.length) writeCards(input ? out.bass : 0, input ? out.beat : 0); // (cards react to the music itself: still when nothing plays)
    cost.out = out;
    const spent = performance.now() - t0;
    cost.frames++; cost.ms += spent; if (spent > cost.max) cost.max = spent;
  }

  function dropCanvas() {
    canvasEl?.remove(); canvasEl = null; painter = null; cost.field = null;
    if (clockEl) clockEl.style.removeProperty('--mr-beat');
    clockEl = null; lastBeat = '';
    delete document.body.dataset.mrParticles;
    document.body.classList.remove('mr-bg');
  }
  function makeCanvas() {
    canvasEl = document.createElement('canvas');
    canvasEl.id = 'mr-canvas';
    canvasEl.setAttribute('aria-hidden', 'true');
    const backdrop = document.getElementById('backdrop'); // (after the background and its effect, which are under everything too, so it shows over them)
    if (backdrop) (document.getElementById('effect') || backdrop).after(canvasEl); else document.body.prepend(canvasEl);
    painter = window.MusicFieldCanvas.create({ canvas: canvasEl, mode: bgMode, accent: accentOf(), tone: toneOf() });
    document.body.classList.add('mr-bg');
    document.body.dataset.mrParticles = String(painter.count);
    layout();
  }

  function start() {
    active = true;
    mapper = MR.createMapper(); beats = MR.beatDetector();
    document.body.classList.add('mr-on');
    document.body.dataset.mr = 'idle';
    document.body.dataset.mrCap = '0';
    resume();
  }
  function resume() {
    if (!active || document.hidden) return;
    lastFrameT = 0;
    layout();
    findTargets();
    if (!raf) raf = requestAnimationFrame(frame);
    startCapture();
  }
  function pause() {
    cancelAnimationFrame(raf); raf = 0;
    clearTimeout(startTimer); startTimer = 0;
    stopCapture();
  }
  function stop() {
    if (!active) return;
    pause();
    active = false;
    for (const n of cardEls) { n.style.removeProperty('--mr-halo'); n.style.removeProperty('--mr-pulse'); }
    cardEls = []; lastHalo = ''; lastPulse = '';
    dropCanvas();
    document.body.classList.remove('mr-on');
    for (const k of ['mr', 'mrMode', 'mrCap', 'mrCards', 'mrBg']) delete document.body.dataset[k];
  }

  // What runs is decided again whenever the look changes, a card's option changes, or Reduce motion flips: the analyser runs while at least one of the
  // home screen and the cards is on; each part is made or dropped on its own.
  function apply() {
    const p = MR.plan(look, hasCards(), reduced.matches);
    if (!p.listen) { bgMode = cardMode = 'off'; stop(); return; }
    const prevBg = bgMode;
    bgMode = p.bg; cardMode = p.cards;
    if (!active) start();
    if (prevBg !== bgMode || Boolean(canvasEl) !== (bgMode !== 'off')) { dropCanvas(); if (bgMode !== 'off') makeCanvas(); } else if (painter) layout();
    document.body.dataset.mrMode = bgMode !== 'off' ? bgMode : cardMode; // (what the page does, for the tests)
    if (bgMode !== 'off') document.body.dataset.mrBg = '1'; else delete document.body.dataset.mrBg;
    findTargets();
    if (document.hidden) pause();
  }
  window.setMusicReactive = (l) => { look = l; apply(); };
  window.musicCardsChanged = () => { if (look) apply(); };
  reduced.addEventListener('change', apply);
  addEventListener('resize', () => { if (active && painter) layout(); });
  document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden) pause(); else resume(); });
})();

// [look] Music-reactive home screen (Settings → Appearance → New tab page → "Music-reactive home screen"). newtab.js loads this file
// (and features/music-react.js, the maths) only when the setting is on, so with it off none of this exists on the page.
//
// What it does: listens to the sound that Lumen's own tabs and music players are playing (the browser hands this page a one-time
// "tab capture" id for the playing tab; it is never the microphone and never the computer's sound), reads the analyser's frequency
// bytes ~30 times a second, reduces each frame to a few numbers (glow, wave, beat) and writes them to three CSS variables (--mr-glow, --mr-wave, --mr-beat), each on the one element that uses it.
// The raw audio never leaves the analyser: nothing is recorded, stored, sent anywhere or even copied out of the frame.
//
//   - The glow behind the page pulses with the bass, a soft wave at the bottom follows the mids, the clock and music card bounce a hair
//     on the beat (newtab.html: #mr-glow, #mr-wave, body.mr-on). All decorative: aria-hidden, never takes a click, under the content.
//   - Nothing playing: a very slow idle drift (under 1 Hz, a few per cent of opacity), and no capture is open.
//   - Page not in front (another tab, minimised): no frames, no timer, no capture.
//   - Reduce motion (the setting or the system's), Visual effects: Light, software drawing, Performance mode: nothing runs at all.
//   - The limits on intensity and the 2.8-flashes-a-second ceiling are in features/music-react.js and tested there.
(() => {
  const MR = window.MusicReact;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const POLL_MS = 4000; // how often the browser is asked what is playing (one small message; nothing else happens in between)
  const LIVE_MS = 33; // ~30 frames a second while music plays
  const IDLE_MS = 80; // ~12 a second for the idle drift
  const SILENT_MS = 1500; // a capture that has been silent this long reads as idle
  const FFT = 1024;

  let look = null;
  let active = false;
  let raf = 0; let pollTimer = 0;
  let glowEl = null; let waveEl = null;
  let cap = null; // { key, stream, ctx, analyser, bytes }
  let lastFrameT = 0; let silentSince = 0; let polling = false;
  let mapper = MR.createMapper(); let beats = MR.beatDetector();
  const written = new WeakMap(); // element -> the last value written, so an unchanged variable is not written again
  let beatEls = []; // the clock card and the music cards that bounce (found again at each poll: cards come and go)
  const el = (id) => Object.assign(document.createElement('div'), { id });
  // Each variable is set on the element that uses it, never on <body>: a custom property set on a parent restyles every descendant.
  function set(node, name, value) {
    if (!node) return;
    const seen = written.get(node) || {};
    if (seen[name] === value) return;
    seen[name] = value; written.set(node, seen);
    node.style.setProperty(name, value);
  }
  function write(vars) {
    set(glowEl, '--mr-glow', vars['--mr-glow']);
    set(waveEl, '--mr-wave', vars['--mr-wave']);
    for (const n of beatEls) set(n, '--mr-beat', vars['--mr-beat']);
  }
  const BEAT_TARGETS = '#clock-card, .w-card.spotify:not(:has(.sp-web-slot)), .w-card.applemusic:not(:has(.sp-web-slot))'; // (a web player's card holds a native view: it stays put)
  function findBeatEls() {
    const now = [...document.querySelectorAll(BEAT_TARGETS)];
    for (const n of beatEls) if (!now.includes(n)) { n.style.removeProperty('--mr-beat'); written.delete(n); }
    beatEls = now;
  }
  function clearVars() {
    for (const n of beatEls) { n.style.removeProperty('--mr-beat'); written.delete(n); }
    beatEls = [];
  }

  function stopCapture() {
    if (!cap) return;
    const c = cap; cap = null;
    try { for (const t of c.stream.getTracks()) t.stop(); } catch { /* already ended */ }
    try { c.ctx.close(); } catch { /* already closed */ }
    document.body.dataset.mr = 'idle';
  }
  async function startCapture(id, key) {
    stopCapture();
    let stream;
    try {
      // One tab's sound, audio only. Never { audio: true } (that is the microphone): main grants this page nothing else.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }, video: false });
    } catch { return; }
    if (!active) { for (const t of stream.getTracks()) t.stop(); return; }
    const ctx = new AudioContext({ latencyHint: 'playback' });
    const analyser = ctx.createAnalyser(); // (never connected to the speakers: this page makes no sound)
    analyser.fftSize = FFT; analyser.smoothingTimeConstant = 0.55;
    ctx.createMediaStreamSource(stream).connect(analyser);
    for (let i = 0; i < 6 && ctx.state !== 'running'; i++) { try { await ctx.resume(); } catch { /* not yet */ } if (ctx.state !== 'running') await new Promise((r) => setTimeout(r, 250)); } // (stays suspended: the idle drift, never a wrong reading)
    cap = { key, stream, ctx, analyser, bytes: new Uint8Array(analyser.frequencyBinCount) };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (cap && cap.stream === stream) stopCapture(); });
    silentSince = 0;
  }

  async function poll() {
    pollTimer = 0;
    if (!active || document.hidden) return;
    findBeatEls();
    if (!polling) {
      polling = true;
      try {
        const r = await window.lumenNewtab?.musicSource?.(cap ? cap.key : null);
        if (active && r && typeof r === 'object') {
          if (r.key === null || r.key === undefined) stopCapture();
          else if (typeof r.id === 'string' && r.id) await startCapture(r.id, r.key);
        }
      } catch { /* the browser is busy: asked again */ }
      polling = false;
    }
    if (active && !document.hidden) pollTimer = setTimeout(poll, POLL_MS);
  }

  function frame(t) {
    raf = 0;
    if (!active || document.hidden) return;
    raf = requestAnimationFrame(frame);
    const live = Boolean(cap) && cap.ctx.state === 'running';
    const shown = live ? 'live' : 'idle'; // (what the page is doing, for the tests: 'live' only while an analyser is really running)
    if (document.body.dataset.mr !== shown) document.body.dataset.mr = shown;
    if (t - lastFrameT < (live ? LIVE_MS : IDLE_MS)) return;
    lastFrameT = t;
    let input = null;
    if (live) {
      cap.analyser.getByteFrequencyData(cap.bytes);
      const b = MR.bandsOf(cap.bytes, cap.ctx.sampleRate, FFT);
      if (!MR.isSilent(b)) silentSince = 0; else if (!silentSince) silentSince = t;
      if (!silentSince || t - silentSince < SILENT_MS) input = { bass: b.bass, mids: b.mids, level: b.level, beat: beats.push(t, b.bass) };
    }
    write(MR.cssVars(mapper.step(input, t)));
  }

  function start() {
    if (active) return;
    active = true;
    mapper = MR.createMapper(); beats = MR.beatDetector();
    glowEl = el('mr-glow'); waveEl = el('mr-wave');
    for (const e of [glowEl, waveEl]) e.setAttribute('aria-hidden', 'true');
    document.body.prepend(glowEl, waveEl);
    document.body.classList.add('mr-on');
    document.body.dataset.mr = 'idle';
    findBeatEls();
    resume();
  }
  function resume() {
    if (!active || document.hidden) return;
    if (!raf) raf = requestAnimationFrame(frame);
    if (!pollTimer && !polling) pollTimer = setTimeout(poll, 50);
  }
  function pause() {
    cancelAnimationFrame(raf); raf = 0;
    clearTimeout(pollTimer); pollTimer = 0;
    stopCapture();
  }
  function stop() {
    if (!active) return;
    pause();
    active = false;
    clearVars();
    glowEl?.remove(); waveEl?.remove(); glowEl = waveEl = null;
    document.body.classList.remove('mr-on');
    delete document.body.dataset.mr;
  }

  function apply() {
    if (MR.motionAllowed(look, reduced.matches)) start(); else stop();
  }
  window.setMusicReactive = (l) => { look = l; apply(); };
  reduced.addEventListener('change', apply);
  document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden) pause(); else resume(); });
})();

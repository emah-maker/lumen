// Voice input in the chat box, in the sidebar (index.html) and the full-page chat (chat-page.html). Loaded after chat-core.js,
// whose functions it uses (showAttachNote, sendComposer).
//
// Chromium's SpeechRecognition can't work in Electron (no Google speech key), so the page records the microphone itself
// (getUserMedia + MediaRecorder, WebM/Opus) and main sends the recording, once, to the provider chosen in Settings → AI and agents
// (ai/dictation.js), with the user's own key; the key never reaches this page. Nothing is saved: the recording lives in
// memory until its text comes back. Lumen allows the microphone for its own sidebar and chat page only (main.js ownPageMic).
//
// Click the mic to start and again to stop, or hold it (or Ctrl+Shift+Space / ⇧⌘Space in the box) and let go to stop.
// Esc cancels. A recording stops by itself after two minutes. The text goes into the box to read over, or is sent at once
// when "Send voice messages at once" is on.
(() => {
  const api = window.assistant?.dictation;
  const byId = (id) => document.getElementById(id);
  const box = byId('prompt');
  const form = byId('composer');
  const attach = byId('attach');
  if (!api || !box || !form || !attach || typeof MediaRecorder !== 'function') return;
  const tr = (key, vars) => (typeof window.t === 'function' ? window.t(key, vars) : key);
  const HOLD_MS = 400; // held at least this long: push to talk (let go to stop)
  const MAC = /^Mac/.test(navigator.platform || '');

  const mic = Object.assign(document.createElement('button'), { type: 'button', className: 'mic-btn', id: 'mic-btn' });
  mic.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2" width="5" height="8" rx="2.5"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"/></svg>';
  const barEnd = form.querySelector('.cb-end');
  if (barEnd) barEnd.prepend(mic); // the toolbar's right side: mic, then send
  else attach.after(mic);
  const bar = Object.assign(document.createElement('div'), { className: 'dictation-bar', hidden: true });
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span class="dictation-dot" aria-hidden="true"></span><span class="dictation-meter" aria-hidden="true"><i></i></span><span class="dictation-time"></span><span class="dictation-hint"></span>';
  box.before(bar);
  const meter = bar.querySelector('.dictation-meter i');
  const timeEl = bar.querySelector('.dictation-time');
  const hintEl = bar.querySelector('.dictation-hint');

  let state = 'idle'; // idle | starting | recording | sending
  let session = null; // { stream, recorder, chunks, ctx, raf, timer, startedAt, status, cancelled }
  let pressAt = 0; // when the press (pointer or shortcut) that started the recording began

  const label = () => ({
    idle: tr('dictation.start', { key: MAC ? '⇧⌘Space' : 'Ctrl+Shift+Space' }),
    starting: tr('dictation.starting'),
    recording: tr('dictation.stop'),
    sending: tr('dictation.sending'),
  })[state];
  function render() {
    mic.dataset.state = state;
    mic.title = label();
    mic.setAttribute('aria-label', label());
    mic.setAttribute('aria-pressed', String(state === 'recording'));
    mic.setAttribute('aria-busy', String(state === 'sending' || state === 'starting'));
    bar.hidden = state !== 'recording' && state !== 'sending';
    bar.dataset.state = state;
    hintEl.textContent = state === 'sending' ? tr('dictation.sending') : tr('dictation.escHint');
  }
  render();

  const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function note(text, settings) {
    const line = document.createElement('div');
    line.textContent = text;
    if (settings) {
      const link = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: tr('dictation.openSettings') });
      link.onclick = () => window.lumenPrefs?.openSettingsPage('you-and-ai');
      line.append(' ', link);
    }
    window.showAttachNote([line]);
  }

  // Everything the recording held is let go: the microphone, the meter, the recorded data.
  function release() {
    const s = session;
    session = null;
    if (!s) return;
    cancelAnimationFrame(s.raf);
    clearInterval(s.timer);
    try { s.stream?.getTracks().forEach((track) => track.stop()); } catch { /* already stopped */ }
    try { s.ctx?.close(); } catch { /* already closed */ }
    s.chunks = [];
  }

  async function start() {
    if (state !== 'idle') return;
    state = 'starting';
    render();
    const status = await api.status().catch(() => null);
    if (state !== 'starting') return; // cancelled meanwhile
    if (!status?.provider) {
      state = 'idle';
      render();
      note(status?.message || tr('dictation.error.other', { provider: '', status: '?' }), true); // (Settings: add a key, or turn voice input back on)
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (err) {
      state = 'idle';
      render();
      note(tr(err?.name === 'NotFoundError' ? 'dictation.noMic' : 'dictation.micBlocked'));
      return;
    }
    if (state !== 'starting') { stream.getTracks().forEach((track) => track.stop()); return; } // cancelled while asking
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const s = { stream, recorder, chunks: [], ctx: null, raf: 0, timer: 0, startedAt: performance.now(), status, cancelled: false };
    session = s;
    recorder.ondataavailable = (e) => { if (e.data?.size) s.chunks.push(e.data); };
    recorder.onstop = () => finish(s);
    recorder.start(1000);
    // The level meter: an analyser on the microphone, connected to nothing that plays.
    try {
      s.ctx = new AudioContext();
      const analyser = s.ctx.createAnalyser();
      analyser.fftSize = 512;
      s.ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        meter.style.transform = `scaleX(${Math.min(1, Math.sqrt(sum / data.length) * 4).toFixed(3)})`;
        s.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* no meter: the recording still works */ }
    const max = (status.maxSeconds || 120) * 1000;
    const showTime = () => {
      const ms = performance.now() - s.startedAt;
      timeEl.textContent = `${clock(ms)} / ${clock(max)}`;
      if (ms >= max) stop();
    };
    showTime();
    s.timer = setInterval(showTime, 250);
    state = 'recording';
    render();
  }

  function stop() {
    if (state === 'starting') { cancel(); return; }
    if (state !== 'recording' || !session) return;
    state = 'sending';
    render();
    clearInterval(session.timer);
    cancelAnimationFrame(session.raf);
    try { session.recorder.stop(); } catch { finish(session); }
  }

  function cancel() {
    if (state === 'idle') return;
    if (session) {
      session.cancelled = true;
      try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* stopped */ }
    }
    release();
    state = 'idle';
    render();
  }

  async function finish(s) {
    if (s.cancelled) return;
    const blob = new Blob(s.chunks, { type: s.recorder.mimeType || 'audio/webm' });
    s.stream.getTracks().forEach((track) => track.stop()); // the mic goes off as soon as recording ends
    const format = s.status.format;
    let result;
    try {
      const bytes = format === 'wav' ? await toWav(blob) : new Uint8Array(await blob.arrayBuffer());
      // Over the cap (main refuses it too): not sent at all.
      result = bytes.byteLength > (s.status.maxBytes || 8 * 1024 * 1024) ? { error: tr('dictation.error.tooLong') } : await api.transcribe(bytes, format);
    } catch (err) {
      result = { error: tr('dictation.error.audioLocal', { detail: String(err?.message || err).slice(0, 80) }) };
    }
    if (s.cancelled || session !== s) return; // Esc while it was being sent: the text is dropped
    release();
    state = 'idle';
    render();
    if (result?.error) { note(result.error, Boolean(result.settings)); return; }
    const text = String(result?.text || '').trim();
    if (!text) { note(tr('dictation.nothingHeard')); return; }
    insert(text);
    if (result.autoSend) window.sendComposer();
    else box.focus();
  }

  // The words go where the cursor is, with a space between them and what is already there.
  function insert(text) {
    const startAt = box.selectionStart ?? box.value.length;
    const endAt = box.selectionEnd ?? startAt;
    const before = box.value.slice(0, startAt);
    const after = box.value.slice(endAt);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    box.setRangeText(lead + text + trail, startAt, endAt, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true })); // (the draft, the Send button, the box's size)
  }

  // Gemini takes WAV, not WebM: decoded here and written as 16 kHz mono 16-bit PCM.
  async function toWav(blob) {
    const RATE = 16000;
    const ctx = new AudioContext();
    let decoded;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (at, str) => { for (let i = 0; i < str.length; i++) out.setUint8(at + i, str.charCodeAt(i)); };
    text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, RATE, true);
    out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); text(36, 'data'); out.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
    return new Uint8Array(out.buffer);
  }

  window.lumenDictation = { toWav }; // (the Meeting helper's Listen sends its pieces the same way: renderer/meeting.js)

  // A press starts; letting go after a hold stops (push to talk). A short click leaves it running until the next click.
  mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // (the box keeps the focus)
    if (state === 'idle') { pressAt = performance.now(); start(); } else if (state === 'recording' || state === 'starting') { pressAt = 0; stop(); }
  });
  const letGo = () => { if (pressAt && performance.now() - pressAt >= HOLD_MS && (state === 'recording' || state === 'starting')) stop(); pressAt = 0; };
  mic.addEventListener('pointerup', letGo);
  mic.addEventListener('pointercancel', letGo);
  mic.addEventListener('keydown', (e) => { // Enter / Space on the focused button: a toggle
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat) return;
    pressAt = 0;
    if (state === 'idle') start(); else stop();
  });

  const isShortcut = (e) => e.code === 'Space' && e.shiftKey && (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
  box.addEventListener('keydown', (e) => {
    if (!isShortcut(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    if (state === 'idle') { pressAt = performance.now(); start(); } else { pressAt = 0; stop(); }
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && pressAt) letGo(); }, true);
  // Esc cancels a recording (or the wait for its text), before chat-core's Esc (stop the reply) or the page's own.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state === 'idle') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
    box.focus();
  }, true);
  // The view going away (the sidebar hidden, the page closed) ends a recording: no microphone left on behind the user's back.
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  new MutationObserver(() => { if (document.body.classList.contains('sidebar-hidden')) cancel(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('pagehide', cancel);
})();

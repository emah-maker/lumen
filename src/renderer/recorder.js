// Lumen's screen recorder: the page features/screen-recorder.js opens in its own small window. It records what main hands it (a tab, or a
// screen or window the user picked) with MediaRecorder, sends each piece to main (which writes the file), and draws the small bar:
// a timer, Pause and Stop while recording, then "Saved ... Show in folder". Main drives it; the buttons only report back.
(() => {
  const api = window.screenRec;
  const $ = (id) => document.getElementById(id);
  const bar = $('bar');
  let view = { mode: 'idle', labels: {} };
  let rec = null; // { recorder, streams, ctx, queue, bytes, t0, pausedAt, pausedTotal, timer }

  const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const MP4 = ['video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1', 'video/mp4'];
  // MP4 only when asked for and when this Chromium can record it; otherwise WebM (main names the file by the format it gets back).
  const pickMime = (format) => (format === 'mp4' ? MP4.find((m) => MediaRecorder.isTypeSupported(m)) : '') || MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60) % 60;
    const ss = String(s % 60).padStart(2, '0');
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  const elapsed = () => (rec ? (rec.pausedAt || Date.now()) - rec.t0 - rec.pausedTotal : 0);

  function draw() {
    const l = view.labels || {};
    const recording = view.mode === 'recording' || view.mode === 'paused';
    bar.className = view.mode;
    $('time').hidden = !recording;
    $('time').textContent = clock(elapsed());
    $('text').textContent = view.text || '';
    $('pause').hidden = !recording;
    $('pause').textContent = view.mode === 'paused' ? l.resume || 'Resume' : l.pause || 'Pause';
    $('stop').hidden = !recording;
    $('stop').textContent = l.stop || 'Stop';
    $('show').hidden = view.mode !== 'saved';
    $('show').textContent = l.show || 'Show in folder';
    $('close').hidden = view.mode !== 'saved' && view.mode !== 'error';
    $('close').textContent = l.close || 'Close';
  }

  function release() {
    if (!rec) return;
    clearInterval(rec.timer);
    for (const s of rec.streams) for (const t of s.getTracks()) t.stop();
    try { rec.ctx?.close(); } catch { /* closed */ }
  }

  // Called by main (with a user gesture, which getDisplayMedia wants).
  // -> { ok: true, mime } | { ok: false, error: 'cancelled' | 'mic' | 'failed' | 'busy', name }
  async function start(opts) {
    if (rec) return { ok: false, error: 'busy' };
    const streams = [];
    const fail = (error, err) => { for (const s of streams) for (const t of s.getTracks()) t.stop(); return { ok: false, error, name: err?.name || '' }; };
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: opts.sound === true });
      streams.push(display);
    } catch (err) {
      return fail(err?.name === 'NotAllowedError' || err?.name === 'NotFoundError' || err?.name === 'AbortError' ? 'cancelled' : 'failed', err);
    }
    let mic = null;
    if (opts.mic === true) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streams.push(mic);
      } catch (err) { return fail('mic', err); }
    }
    try {
      const sounds = [...display.getAudioTracks(), ...(mic ? mic.getAudioTracks() : [])];
      const tracks = [...display.getVideoTracks()];
      let ctx = null;
      if (sounds.length === 1) tracks.push(sounds[0]);
      else if (sounds.length > 1) { // the tab's or PC's sound and the microphone, mixed into one track
        ctx = new AudioContext();
        const out = ctx.createMediaStreamDestination();
        for (const t of sounds) ctx.createMediaStreamSource(new MediaStream([t])).connect(out);
        tracks.push(...out.stream.getAudioTracks());
      }
      const mime = pickMime(opts.format);
      const recorder = new MediaRecorder(new MediaStream(tracks), { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 5000000 });
      const state = { recorder, streams, ctx, queue: Promise.resolve(), bytes: 0, t0: Date.now(), pausedAt: 0, pausedTotal: 0, timer: 0 };
      rec = state;
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        state.queue = state.queue.then(async () => { const buffer = await e.data.arrayBuffer(); state.bytes += buffer.byteLength; api.chunk(buffer); });
      };
      recorder.onstop = () => { state.queue.then(() => { release(); rec = null; api.done({ bytes: state.bytes }); }); };
      recorder.onerror = () => { try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* stopped */ } };
      display.getVideoTracks()[0]?.addEventListener('ended', () => stop()); // the tab closed, or the shared window went away
      recorder.start(1000);
      state.timer = setInterval(() => { if (view.mode === 'recording') $('time').textContent = clock(elapsed()); }, 250);
      return { ok: true, mime: recorder.mimeType };
    } catch (err) {
      return fail('failed', err);
    }
  }
  function stop() { try { if (rec && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* stopped */ } return true; }
  function pause() { if (!rec || rec.recorder.state !== 'recording') return false; rec.recorder.pause(); rec.pausedAt = Date.now(); return true; }
  function resume() { if (!rec || rec.recorder.state !== 'paused') return false; rec.recorder.resume(); rec.pausedTotal += Date.now() - rec.pausedAt; rec.pausedAt = 0; return true; }
  window.__rec = { start, stop, pause, resume, info: () => (rec ? { state: rec.recorder.state, bytes: rec.bytes, mime: rec.recorder.mimeType } : null) };

  api.onView((next) => { view = next || view; draw(); });
  $('pause').addEventListener('click', () => api.ctl(view.mode === 'paused' ? 'resume' : 'pause'));
  $('stop').addEventListener('click', () => api.ctl('stop'));
  $('show').addEventListener('click', () => api.ctl('show'));
  $('close').addEventListener('click', () => api.ctl('close'));
  draw();
})();

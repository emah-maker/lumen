// [gpu health] Lumen cannot fix a graphics driver, but it can live through one that resets: Windows logs TDR timeouts (0x116/0x117), engine
// timeouts (0x141) and hardware errors (0x124) on some laptops with two GPUs, and while the driver recovers the main process can sit blocked
// natively for seconds. After a reset Chromium may also quietly fall back to software drawing and stay slow until Lumen restarts.
//
// What this does, all event-driven (no timer runs while everything is healthy):
//   - Watches the GPU process ('child-process-gone' type GPU), 'gpu-info-update' and display-added/removed, and writes
//     GPU resets to <userData>/diagnostics/gpu-events.jsonl: reasons, exit codes, times and feature-status words, nothing else.
//   - Calm period: for CALM_MS after a GPU loss or a real display/GPU change (never a power-source change; one window per 3 minutes) the UI is told to put almost nothing on the GPU (the new-tab effects pause, the sidebar
//     moves without a page snapshot). Bursts do not restart it: see createCalm().
//   - Software-fallback notice: once the status is read a few times after a GPU loss, if drawing fell to software while hardware
//     acceleration is on, the browser UI gets ONE notice with a Restart button (never an automatic restart). Again only after a further reset.
//   - app.disableDomainBlockingFor3DAPIs(): Chromium blocks WebGL for a site after GPU resets; maps and canvases must keep working.
// The decisions are pure functions (testable without Electron); install() only wires them to events.

const CALM_MS = 10000; // how long the GPU is left alone after an event
const MIN_GAP_MS = 180000; // one calm window per 3 minutes at most
const CHECK_AFTER_MS = [1500, 5000, 12000]; // feature-status reads after a GPU loss (the new GPU process needs a moment to say what it got)
const MAX_LINES = 200;
const UNSTABLE_LOSSES = 6; // this many GPU process losses...
const UNSTABLE_WINDOW_MS = 120000; // ...within this: the driver keeps failing (offer safe drawing mode, once)
const STATUS_KEYS = ['gpu_compositing', 'rasterization', 'webgl', 'webgl2', 'video_decode', 'canvas', 'opengl'];

// Chromium's feature-status words: enabled, enabled_on, disabled_software, disabled_off, unavailable_software, unavailable_off ...
const SOFT = /disabled_software|unavailable/i;
// true when drawing is in software: compositing on the CPU, or rasterization that is not on the GPU.
function softwareFallback(status) {
  if (!status || typeof status !== 'object') return false;
  const comp = String(status.gpu_compositing ?? '');
  const rast = String(status.rasterization ?? '');
  return SOFT.test(comp) || /disabled_off/i.test(comp) || SOFT.test(rast);
}

// Only the words (a-z, digits, underscore) of the status keys worth knowing: no adapter names, no driver strings.
function statusWords(status) {
  const out = {};
  if (!status || typeof status !== 'object') return out;
  for (const k of STATUS_KEYS) if (typeof status[k] === 'string' && /^[a-z0-9_]{1,40}$/i.test(status[k])) out[k] = status[k];
  return out;
}

// The calm window. poke(kind, t) with kind 'gpu' (the GPU process was lost) or 'display' (a display or the active GPU really changed; power
// events never come here: a laptop logging "power source change" every 2 s would keep it on). Returns true when a window began. At most one
// window per MIN_GAP_MS (3 minutes, measured from one start to the next), each CALM_MS long and never extended: a burst of resets is one
// window, and the app is never calm for more than CALM_MS in any 3-minute span.
function createCalm({ calmMs = CALM_MS, gapMs = MIN_GAP_MS } = {}) {
  let until = 0;
  let started = -Infinity;
  return {
    active(t) { return t < until; },
    until() { return until; },
    poke(kind, t) {
      if (kind !== 'gpu' && kind !== 'display') return false;
      if (t < started + gapMs) return false;
      started = t; until = t + calmMs;
      return true;
    },
  };
}

// Once per session, and again after a further reset: shows when drawing is in software, hardware acceleration is on, a reset has happened,
// and this reset has not been told about yet. baselineSoft: it was already software before any reset (a restart will not help).
function createNotice() {
  let resets = 0;
  let toldAt = 0; // the reset count when the notice was last shown
  return {
    reset() { resets++; },
    resets: () => resets,
    shouldShow({ status, hwOn, baselineSoft = false }) {
      if (!hwOn || baselineSoft || resets === 0 || resets <= toldAt) return false;
      if (!softwareFallback(status)) return false;
      toldAt = resets;
      return true;
    },
    shown: () => toldAt > 0,
  };
}

// Counts GPU process losses in a sliding window: add(t) returns true once there are max or more within windowMs.
function createLossCounter({ max = UNSTABLE_LOSSES, windowMs = UNSTABLE_WINDOW_MS } = {}) {
  let times = [];
  return {
    add(t) { times = times.filter((x) => t - x < windowMs); times.push(t); return times.length >= max; },
    count: () => times.length,
  };
}

const nowMs = () => Date.now();

// app, screen: Electron's. hwOn(): Settings → hardware acceleration. send(channel, payload): to every window's UI.
// readStatus(): app.getGPUFeatureStatus (a test replaces it). dir(): where diagnostics go.
function install({ app, screen, hwOn, send, readStatus, dir, version = '', log = () => {}, onLoss = null, onSoftware = null, setTimeoutFn = setTimeout, now = nowMs }) {
  const fs = require('fs');
  const path = require('path');
  const calm = createCalm();
  const notice = createNotice();
  let calmTimer = null;
  let calmOn = false;
  let baseline = null; // the feature status read once, a few seconds after start (before any reset): null while unknown
  let checks = [];
  let writes = 0;
  const losses = createLossCounter();
  let unstableOffered = false;
  const stats = { gpuLosses: 0, calmStarts: 0, notices: 0, unstableOffers: 0, lastReason: '' };
  const file = () => path.join(dir(), 'gpu-events.jsonl');

  function record(entry) { // a line per event; async, rare; never throws
    try {
      const f = file();
      fs.mkdir(path.dirname(f), { recursive: true }, () => {
        fs.appendFile(f, JSON.stringify({ t: new Date(now()).toISOString(), v: version, ...entry }) + '\n', (err) => {
          if (err || ++writes % 25) return;
          fs.readFile(f, 'utf8', (e, text) => { // keep the last MAX_LINES
            if (e) return;
            const lines = text.split('\n').filter(Boolean);
            if (lines.length > MAX_LINES) fs.writeFile(f, lines.slice(-MAX_LINES).join('\n') + '\n', () => {});
          });
        });
      });
    } catch { /* diagnostics must never take Lumen down */ }
  }
  const status = () => { try { return (readStatus ? readStatus() : app.getGPUFeatureStatus()) || {}; } catch { return {}; } };

  function applyCalm() {
    const t = now();
    const on = calm.active(t);
    if (on !== calmOn) { calmOn = on; try { send('gpu:calm', on); } catch { /* no window */ } }
    clearTimeout(calmTimer);
    calmTimer = null;
    if (on) { calmTimer = setTimeoutFn(applyCalm, Math.max(50, calm.until() - t + 20)); calmTimer.unref?.(); }
  }
  function poke(kind, why) {
    const began = calm.poke(kind, now());
    if (began) stats.calmStarts++;
    applyCalm();
    return began;
  }

  function checkNow() {
    const s = status();
    if (softwareFallback(s)) { try { onSoftware?.(); } catch { /* the UI follows the next time it asks */ } } // [software mode] the renderers go to the software level at once; the notice below still offers the restart
    if (notice.shouldShow({ status: s, hwOn: hwOn(), baselineSoft: baseline ? softwareFallback(baseline) : false })) {
      stats.notices++;
      record({ e: 'software-notice', status: statusWords(s) });
      try { send('gpu:software-note', { kind: 'software' }); } catch { /* no window */ }
    }
  }
  function scheduleChecks() { // only after a reset: a few reads while the new GPU process settles, none while healthy
    for (const c of checks) clearTimeout(c);
    checks = CHECK_AFTER_MS.map((ms) => { const c = setTimeoutFn(checkNow, ms); c.unref?.(); return c; });
  }

  function gpuGone(details) {
    stats.gpuLosses++;
    notice.reset();
    const reason = String(details?.reason || '').replace(/[^\w-]/g, '').slice(0, 40);
    stats.lastReason = reason;
    record({ e: 'gpu-gone', reason, code: Number.isFinite(details?.exitCode) ? details.exitCode : null, status: statusWords(status()) });
    poke('gpu');
    try { onLoss?.(); send('gpu:lost', true); } catch { /* no window */ } // views frozen for a sidebar slide are put back: a GPU that died must not leave a still picture
    if (losses.add(now()) && !unstableOffered) { // never an automatic restart: the notice offers it
      unstableOffered = true; stats.unstableOffers++;
      record({ e: 'unstable-offer' });
      try { send('gpu:software-note', { kind: 'unstable' }); } catch { /* no window */ }
    }
    scheduleChecks();
    log(`[lumen] GPU process gone (${reason})`);
  }
  app.on('child-process-gone', (_e, details) => { if (details?.type === 'GPU') gpuGone(details); });
  // A real change of display or of the GPU that is drawing: calm. Power-source, speed-limit and thermal events are not watched at all.
  let activeGpu = null;
  const gpuId = (info) => { const d = info?.gpuDevice?.find?.((x) => x.active) || info?.gpuDevice?.[0]; return d ? `${d.vendorId}:${d.deviceId}` : null; };
  app.on('gpu-info-update', () => {
    if (notice.resets()) scheduleChecks(); // (a new GPU info after a reset: read the status again)
    if (app.getGPUInfo) app.getGPUInfo('basic').then((i) => onGpuInfo(gpuId(i))).catch(() => {}); // (async, rare: only when Chromium says the GPU info changed)
  });
  function onGpuInfo(id) { // id: the active GPU's vendor:device, or null when unknown
    if (id && activeGpu && id !== activeGpu && poke('display')) record({ e: 'gpu-changed' });
    if (id) activeGpu = id;
  }
  const onDisplay = (name) => () => { if (poke('display')) record({ e: name }); };
  const wired = () => {
    for (const n of ['display-added', 'display-removed']) screen.on(n, onDisplay(n));
    const t = setTimeoutFn(() => { baseline = status(); if (softwareFallback(baseline)) { try { onSoftware?.(); } catch { /* ignore */ } } }, 10000); // once: what drawing looked like before any reset (unless one came first)
    t.unref?.();
    const first = setTimeoutFn(() => { if (notice.resets()) baseline = null; }, 10001); first.unref?.();
    if (app.getGPUInfo) app.getGPUInfo('basic').then((i) => { activeGpu = gpuId(i); }).catch(() => {});
  };
  app.whenReady().then(wired).catch(() => {});

  return {
    stats: () => ({ ...stats }),
    calmActive: () => calm.active(now()),
    poke, gpuGone, checkNow, record, onGpuInfo,
    noticeShown: () => notice.shown(),
    file,
  };
}

module.exports = { install, createCalm, createNotice, createLossCounter, UNSTABLE_LOSSES, UNSTABLE_WINDOW_MS, softwareFallback, statusWords, CALM_MS, MIN_GAP_MS, CHECK_AFTER_MS };

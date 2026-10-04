// Performance mode: Lumen's lighter way of running on a slow computer. The setting (Settings → System)
// is Auto (default), Always on or Off. Auto turns it on for a PC with 4 GB of memory or less, 4 or
// fewer logical CPUs, no graphics acceleration (turned off, or blocklisted so Chromium draws in
// software), or one whose CPU is being throttled (Windows battery saver or thermal limits report
// through powerMonitor's speed limit; macOS also reports a thermal state).
//
// What it changes (see limits()): background tabs sleep after 5 minutes instead of 20 and at most
// four stay loaded, the disk caches are smaller, no blur and no animation in Lumen's own pages (the
// page adds the pref-lite class), streaming replies redraw less often, non-urgent work that runs
// after startup (update check, model lists) waits longer, background tasks run one at a time, and at
// most one idle Claude Code chat keeps its process warm (4 otherwise: features/warm-chats.js). It
// never removes a feature.
const fs = require('fs');
const os = require('os');
const path = require('path');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MODES = ['auto', 'on', 'off'];

// The hardware verdicts that need nothing but Node. Returns the reasons Auto would turn the mode on.
function hardwareReasons({ totalMem = os.totalmem(), cpus = os.cpus().length } = {}) {
  const reasons = [];
  // A "4 GB" PC reports a little less than 4 GB to the OS.
  if (totalMem <= 4.5 * GB) reasons.push({ key: 'memory', vars: { gb: Math.max(1, Math.round(totalMem / GB)) } });
  if (cpus > 0 && cpus <= 4) reasons.push({ key: 'cpu', vars: { count: cpus } });
  return reasons;
}

const LIMITS = {
  normal: { sleepAfterMs: 20 * 60e3, maxLiveBackgroundTabs: Infinity, diskCacheBytes: 256 * MB, codeCacheBytes: 192 * MB, startupDelayMs: 0, maxBackgroundTasks: 3, streamRedrawMs: 0, maxWarmChats: 4 },
  lite: { sleepAfterMs: 5 * 60e3, maxLiveBackgroundTabs: 4, diskCacheBytes: 96 * MB, codeCacheBytes: 64 * MB, startupDelayMs: 45e3, maxBackgroundTasks: 1, streamRedrawMs: 100, maxWarmChats: 1 },
};

// deps: { app, readSettings, powerMonitor? (or a function returning it), onChange?, totalMem?, cpus? } (the last two for tests)
function create(deps) {
  const { app, readSettings, onChange } = deps;
  const hardware = hardwareReasons({ totalMem: deps.totalMem, cpus: deps.cpus });
  let gpuSoftware = false; // learned once the GPU process has reported (after ready)
  let throttled = false;
  let lastActive = null;

  const mode = () => (MODES.includes(readSettings().performanceMode) ? readSettings().performanceMode : 'auto');
  function reasons() {
    const out = [...hardware];
    if (gpuSoftware) out.push({ key: 'gpu', vars: {} });
    if (throttled) out.push({ key: 'throttled', vars: {} });
    return out;
  }
  const active = () => mode() === 'on' || (mode() === 'auto' && reasons().length > 0);
  const limits = () => (active() ? LIMITS.lite : LIMITS.normal);
  function info() {
    const on = active();
    return { mode: mode(), active: on, reasons: mode() === 'auto' && on ? reasons() : [], limits: on ? 'lite' : 'normal' };
  }
  function refresh() {
    const now = active();
    if (now !== lastActive) { lastActive = now; onChange?.(info()); }
  }

  // The disk cache size applies to a session that starts after this call: run it before app.whenReady.
  function applyLaunchSwitches() {
    app.commandLine.appendSwitch('disk-cache-size', String(limits().diskCacheBytes));
  }

  // Once the app is ready: what only Chromium knows (is the GPU really drawing?) and power events.
  function checkGpu() {
    try {
      const status = app.getGPUFeatureStatus?.() || {};
      gpuSoftware = app.isHardwareAccelerationEnabled?.() === false || /^disabled/.test(String(status.gpu_compositing || ''));
    } catch { /* leave it off */ }
    refresh();
  }
  function start() {
    checkGpu();
    try {
      const powerMonitor = typeof deps.powerMonitor === 'function' ? deps.powerMonitor() : deps.powerMonitor; // only usable once the app is ready
      powerMonitor?.on('speed-limit-change', (details) => { throttled = Number(details?.limit) > 0 && Number(details.limit) < 100; refresh(); });
      powerMonitor?.on('thermal-state-change', (details) => { throttled = ['serious', 'critical'].includes(details?.state); refresh(); });
    } catch { /* not supported here */ }
    refresh();
  }
  lastActive = active();

  // Runs fn now, or after the mode's startup delay when it is on: for work nobody is waiting for.
  const later = (fn) => { const delay = limits().startupDelayMs; if (!delay) return fn(); return setTimeout(fn, delay).unref?.(); };

  return { mode, active, info, limits, reasons, refresh, start, checkGpu, later, applyLaunchSwitches };
}

// ---- disk cache housekeeping ----
// Chromium's HTTP cache honours --disk-cache-size (applyLaunchSwitches), but its compiled-JavaScript
// cache ("Code Cache") has no cap and reached ~300 MB on a normal profile. Once a week (a stamp file's
// modification time), before Chromium opens it, measure that folder; over the cap it is renamed aside
// (fast) and deleted in the background. It refills on its own as pages load.
const WEEK = 7 * 86400e3;

function folderBytes(dir, limit = Infinity) {
  let total = 0;
  const stack = [dir];
  while (stack.length && total <= limit) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

// Returns what it did: 'skipped' (checked recently), 'kept' or 'trimmed'.
function trimCodeCache(userData, capBytes, { now = Date.now(), every = WEEK } = {}) {
  const stamp = path.join(userData, 'code-cache-check');
  const dir = path.join(userData, 'Code Cache');
  const leftover = `${dir}.old`;
  if (fs.existsSync(leftover)) fs.promises.rm(leftover, { recursive: true, force: true }).catch(() => {});
  try { if (every > 0 && now - fs.statSync(stamp).mtimeMs < every) return 'skipped'; } catch { /* never checked */ }
  try { fs.writeFileSync(stamp, String(now)); } catch { /* read-only profile: check again next time */ }
  if (!fs.existsSync(dir) || folderBytes(dir, capBytes) <= capBytes) return 'kept';
  try {
    fs.rmSync(leftover, { recursive: true, force: true });
    fs.renameSync(dir, leftover);
    fs.promises.rm(leftover, { recursive: true, force: true }).catch(() => {});
    return 'trimmed';
  } catch { return 'kept'; }
}

module.exports = { create, hardwareReasons, trimCodeCache, folderBytes, LIMITS, MODES };

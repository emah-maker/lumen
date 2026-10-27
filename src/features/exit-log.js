// Why Lumen closed by itself: the record that tells the next look at main-errors.log what happened.
//
// Before this, a crash of Lumen's own process (in Chromium's code, not a JavaScript error) and a computer that restarted under it both looked
// the same afterwards: no line in main-errors.log, no crash report, only the crash marker (features/crash-recovery.js) left behind. Now:
// - Crash reports are written (main.js starts Crashpad, nothing uploaded) to <userData>/diagnostics/crashes; prune() keeps the newest few.
// - Every process that ends other than cleanly (a page, the GPU, a helper) gets a main-errors.log line: goneText().
// - A start that finds the marker logs how the last run ended: lastRunEnd(), from the boot time and any crash report written since it began.
// Loaded with the first such event, not at startup (test/e2e/perf-budget.js counts startup modules).
const nodeFs = require('fs');
const nodeOs = require('os');
const path = require('path');

const KEEP_DUMPS = 10;

// One line for a process that ended: "GPU crashed, exit 34" / "renderer oom, exit -1073741571".
function goneText(details) {
  const d = details && typeof details === 'object' ? details : {};
  const type = String(d.type || 'renderer').replace(/[^\w -]/g, '').slice(0, 40);
  const name = d.name ? ` (${String(d.name).replace(/[^\w .-]/g, '').slice(0, 60)})` : ''; // a utility process says which one it was
  const reason = String(d.reason || 'unknown').replace(/[^\w-]/g, '').slice(0, 40);
  return `${type}${name} ${reason}, exit ${Number.isFinite(d.exitCode) ? d.exitCode : '?'}`;
}

// Every crash report under dir, newest first: [{ file, mtimeMs }].
function listDumps(dir, fs = nodeFs) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.dmp')) { try { out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* removed meanwhile */ } }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Keeps the newest `keep` reports (each is a few hundred KB to a few MB): the folder never grows without end.
function prune(dir, { keep = KEEP_DUMPS, fs = nodeFs } = {}) {
  let removed = 0;
  for (const d of listDumps(dir, fs).slice(keep)) { try { fs.rmSync(d.file, { force: true }); removed++; } catch { /* in use */ } }
  return removed;
}

// How the last run ended, when it left the crash marker behind (it never quit). startedAtMs: when that run began (the marker's time).
//   system-restart  the computer started again after that run began: a power loss, a Windows crash (blue screen) or a forced restart took Lumen with it
//   lumen-crashed   a crash report was written after it began: Lumen's own process crashed
//   ended           neither: ended from Task Manager or by Windows, or a crash that wrote no report
function lastRunEnd({ startedAtMs, dir, now = Date.now(), uptimeSec = nodeOs.uptime(), fs = nodeFs } = {}) {
  const bootAtMs = now - uptimeSec * 1000;
  const started = Number.isFinite(startedAtMs) ? startedAtMs : null;
  const dumps = started == null ? [] : listDumps(dir, fs).filter((d) => d.mtimeMs >= started);
  const kind = started != null && bootAtMs > started ? 'system-restart' : dumps.length ? 'lumen-crashed' : 'ended';
  const when = (ms) => (ms == null ? '?' : new Date(ms).toISOString());
  const text = {
    'system-restart': 'the computer restarted while Lumen was running (power loss, a Windows crash or a forced restart)',
    'lumen-crashed': 'Lumen crashed',
    ended: 'Lumen ended without quitting (Task Manager, Windows, or a crash that wrote no report)',
  }[kind];
  return { kind, dumps: dumps.length, text: `${text}; that run began ${when(started)}, the computer started ${when(bootAtMs)}, ${dumps.length} crash report(s) since` };
}

module.exports = { goneText, listDumps, prune, lastRunEnd, KEEP_DUMPS };

// ---------- crash recovery: "Lumen didn't shut down correctly. Restore your tabs?" ----------
//
// With On startup set to "Continue where you left off" (the default) a crash costs nothing: the
// session is saved as tabs change, and the next launch restores it. With "Open the new-tab page" or
// "Open specific pages", a crash used to lose every tab, because the next launch did what the
// setting says and the saved session was overwritten soon after. Now, as in Chrome:
//
// - A marker file (`running` in the profile folder) is written when Lumen starts and removed when it
//   quits normally (before-quit, an update's restart included). Finding it at start-up means the
//   previous run did not quit: it crashed, was killed, or the computer lost power.
// - Then, and only when the startup setting would not restore the tabs anyway, the session saved by
//   that run is kept aside before anything overwrites it, and once the first window is ready Lumen's
//   own dialog asks "Restore N tabs?" (Not now / Restore). Restore brings back every window's tabs,
//   groups and pins the same way a normal restore does. Not now just drops the copy.
//
// deps: { file() -> the marker's path, readSettings(), fs? }
const nodeFs = require('fs');

// What the session saved by the last run holds: the first window's urls plus the other windows'.
function tabCount(saved) {
  if (!saved || typeof saved !== 'object') return 0;
  const count = (entry) => (Array.isArray(entry?.urls) ? entry.urls.filter((u) => typeof u === 'string' && u).length : 0);
  return count(saved) + (Array.isArray(saved.more) ? saved.more.reduce((n, m) => n + count(m), 0) : 0);
}

// Whether to offer: the last run did not quit normally, the startup setting would not bring the tabs
// back by itself, and there is something to bring back.
function decide({ crashed, mode, saved }) {
  const tabs = tabCount(saved);
  return { offer: Boolean(crashed) && mode !== 'last' && mode !== 'restore' && tabs > 0, tabs };
}

function createCrashRecovery(deps) {
  const fs = deps.fs || nodeFs;
  const file = () => (typeof deps.file === 'function' ? deps.file() : deps.file);
  let crashed = false;
  let kept = null; // the last run's session, kept aside until the offer is answered

  // At start-up, before any window saves a session: was the marker left behind? Then write it for this run.
  function begin({ mode }) {
    try { crashed = fs.existsSync(file()); } catch { crashed = false; }
    const saved = deps.readSettings().session;
    if (decide({ crashed, mode, saved }).offer) kept = JSON.parse(JSON.stringify(saved));
    try { fs.writeFileSync(file(), String(process.pid)); } catch (err) { console.error('[lumen] could not write the crash marker:', err.message); }
    return { crashed, offer: Boolean(kept) };
  }

  // A normal quit (before-quit): the next start is not a crash.
  function end() {
    try { fs.rmSync(file(), { force: true }); } catch (err) { console.error('[lumen] could not remove the crash marker:', err.message); }
  }

  // The kept session, once: { saved, tabs } or null.
  function take() {
    const saved = kept;
    kept = null;
    return saved ? { saved, tabs: tabCount(saved) } : null;
  }

  return { begin, end, take, crashed: () => crashed, pending: () => Boolean(kept) };
}

module.exports = { createCrashRecovery, decide, tabCount };

// One dedicated Lumen window per outside agent (MCP) session, so an agent such as Claude Code works in a
// window of its own and never in the user's tabs, nor in the tabs the sidebar's AI works in.
//
// This file is the pure part (main.js wires it to real windows): which session has which window, when it is
// made, reused, kept or closed.
//   ensure(key, label)   the session's window, made on its first call that needs one (calls arriving together
//                        share one window), made again if the user closed it
//   get(key)             the session's window if it has one now (never makes one)
//   release(key)         the session ended: after a grace period the window is closed, unless the user has used
//                        it or pinned a tab in it, then it is kept and becomes an ordinary window (`keep`)
//   isAgentWindow(rec)   is this window one of these (not yet kept)?
//
// deps: open(label, key) -> Promise<rec>, alive(rec), close(rec), keep(rec), userUsed(rec), hasPinned(rec),
//       graceMs, setTimer, clearTimer
const GRACE_MS = 20000; // a client that reconnects within a run (Claude Code starts a bridge per run) finds its work still open

// Windows are made one at a time, with the main process let alone for a moment after each: a window's creation is Chromium work on the
// main thread (tens of ms, spread over the next second as its renderers start), and several sessions' windows made together stacked it into
// stalls of 40 ms and more that every other session's calls then waited behind.
const OPEN_SPACING_MS = 150;

function createAgentWindows({ open, alive, close, keep, userUsed = () => false, hasPinned = () => false, graceMs = GRACE_MS, spacingMs = OPEN_SPACING_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const entries = new Map(); // key -> { key, label, rec, creating, timer }
  const owned = new Set(); // windows made here and not kept
  let openChain = Promise.resolve(); // the last window's creation, and its spacing
  function openOne(label, key) {
    const run = openChain.then(() => open(label, key));
    openChain = run.then(() => {}, () => {}).then(() => (spacingMs > 0 ? new Promise((resolve) => { setTimeout(resolve, spacingMs); }) : null));
    return run;
  }

  function settle(entry) {
    entries.delete(entry.key);
    const rec = entry.rec;
    if (!rec) return 'none';
    if (!alive(rec)) { owned.delete(rec); return 'gone'; }
    if (userUsed(rec) || hasPinned(rec)) { owned.delete(rec); keep(rec); return 'kept'; }
    owned.delete(rec);
    close(rec);
    return 'closed';
  }

  function ensure(key, label = '') {
    let entry = entries.get(key);
    if (!entry) { entry = { key, label, rec: null, creating: null, timer: null }; entries.set(key, entry); }
    if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
    if (entry.rec && alive(entry.rec)) return Promise.resolve(entry.rec);
    if (entry.rec) { owned.delete(entry.rec); entry.rec = null; } // the user closed it: the next call makes a new one
    if (entry.creating) return entry.creating;
    entry.label = label || entry.label;
    entry.creating = openOne(entry.label, key).then((rec) => {
      if (entries.get(key) !== entry) { try { close(rec); } catch {} throw new Error('The agent session ended.'); }
      entry.rec = rec;
      owned.add(rec);
      return rec;
    }).finally(() => { entry.creating = null; });
    return entry.creating;
  }

  function get(key) {
    const rec = entries.get(key)?.rec || null;
    return rec && alive(rec) ? rec : null;
  }

  function release(key) {
    const entry = entries.get(key);
    if (!entry || entry.timer) return false;
    entry.timer = setTimer(() => { entry.timer = null; settle(entry); }, graceMs);
    entry.timer?.unref?.();
    return true;
  }

  // Ends every session now (Lumen is quitting, or the setting went off): windows are settled as if the grace had passed.
  function releaseAll() {
    for (const entry of [...entries.values()]) {
      if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
      settle(entry);
    }
  }

  return {
    ensure,
    get,
    release,
    releaseAll,
    isAgentWindow: (rec) => owned.has(rec),
    windows: () => [...owned].filter(alive),
    keyOf: (rec) => [...entries.values()].find((e) => e.rec === rec)?.key ?? null,
    size: () => entries.size,
  };
}

// Tools that can answer without a window: a session that has none yet has no tabs to list.
const NEEDS_NO_WINDOW = new Set(['find_sources', 'list_tabs', 'wait', 'analyze_posts', 'list_files', 'clipboard']);
const needsWindow = (tool) => !NEEDS_NO_WINDOW.has(tool);

module.exports = { createAgentWindows, needsWindow, GRACE_MS };

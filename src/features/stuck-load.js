// ---------- a Lumen page that never commits is loaded again (used by main.js wireView) ----------
// A tab asked to show one of Lumen's own pages (the new-tab page, Settings, History: local files that load in
// milliseconds) can end up with a navigation that never commits: the tab shows its spinner, the address stays empty, the page
// is white and its console has nothing in it, because no document exists yet. Seen once, right after an update's restart; the
// cause was not found, so this does not wait for it: a local page that has had no first response after a grace period is
// stopped and asked for again, twice at most. Web pages are never touched (a slow server is not a stuck load), and neither is
// a tab that has already shown a page (a later navigation that never commits is the user's to stop).
const GRACE_MS = 10e3;
const MAX_TRIES = 2;

const isLocalPage = (url) => /^file:/i.test(String(url || ''));
const hasShownPage = (url) => Boolean(url) && url !== 'about:blank';

// Is this navigation stuck? Pure: the tab's facts in, a yes or no out.
function isStuck({ destroyed = false, loading = false, waiting = false, shown = false, url = '' } = {}) {
  return !destroyed && loading && waiting && !shown && isLocalPage(url);
}

// wc: the tab's webContents. url: what it was asked to load. Options: graceMs, tries; fresh(url) -> the address to ask for
// again (the new-tab page's data may have changed); alive() -> false once the tab no longer holds this webContents;
// log(msg); timers { set, clear } for tests. Returns { stop() } (the guard also ends with the webContents).
function guard(wc, { url, graceMs = GRACE_MS, tries = MAX_TRIES, fresh = (u) => u, alive = () => true, log = () => {}, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  let asked = url;
  let timer = null;
  let used = 0;
  const stop = () => { if (timer) { timers.clear(timer); timer = null; } };
  const gone = () => wc.isDestroyed() || !alive();
  function check() {
    timer = null;
    if (gone()) return;
    const state = { destroyed: false, loading: wc.isLoading(), waiting: wc.isWaitingForResponse(), shown: hasShownPage(wc.getURL()), url: asked };
    if (!isStuck(state) || used >= tries) return;
    used++;
    log(`[lumen] ${asked.split('#')[0]} had no response after ${graceMs / 1000} s: loading it again (${used} of ${tries})`);
    try { wc.stop(); } catch { /* already over */ }
    wc.loadURL(fresh(asked)).catch(() => {});
  }
  const arm = () => { stop(); timer = timers.set(check, graceMs); timer.unref?.(); };
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    asked = details.url;
    if (isLocalPage(asked)) arm(); else stop();
  });
  // A page that came up (or a load the user stopped, or that failed with its own error page) ends the watch.
  wc.on('did-navigate', () => { used = 0; stop(); });
  wc.on('did-stop-loading', stop);
  wc.once('destroyed', stop);
  if (isLocalPage(asked) && wc.isLoading()) arm();
  return { stop };
}

module.exports = { guard, isStuck, GRACE_MS, MAX_TRIES };

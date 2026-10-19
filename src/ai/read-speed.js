// Speed helpers for read_urls (agent.js readInBackground): a pool of warm hidden reader views, a short-lived result cache
// shared across runs, and the asset filter for the reader's own session. Electron-free (views, timers and sessions are
// injected) so test/read-speed-units.js covers them in plain Node.

const READER_PARTITION = 'claude-reader';

// ---- warm view pool -------------------------------------------------------------------------------------------------
// Making a WebContentsView per URL is a good part of a short read. Finished views go back, blanked, up to maxIdle of
// them, and are destroyed after idleMs unused. A view is reused only when it came back healthy: a read that timed out,
// crashed or could not be blanked is destroyed instead. Isolation is the partition's, as before (cookies/storage are
// shared by every read in it, and gone when Lumen quits), so reuse adds no sharing beyond the page's own in-view state,
// which blanking drops.
class ReaderPool {
  // create(): entry | Promise<entry>; reset(entry): Promise<boolean> (blank it; false = not reusable);
  // destroy(entry); alive(entry): boolean. setTimer/clearTimer are injectable for tests.
  constructor({ create, reset, destroy, alive = () => true, maxIdle = 3, idleMs = 60000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { create, reset, destroy, alive, maxIdle, idleMs, setTimer, clearTimer });
    this.idle = [];
    this.timer = null;
    this.stats = { created: 0, reused: 0, destroyed: 0 };
  }
  async acquire() {
    while (this.idle.length) {
      const entry = this.idle.pop();
      if (this.alive(entry)) { this.stats.reused++; this.arm(); return entry; }
      this.drop(entry);
    }
    this.arm();
    this.stats.created++;
    return this.create();
  }
  // healthy:false (timeout, failure) always destroys.
  async release(entry, healthy = true) {
    if (!healthy || !this.alive(entry) || this.idle.length >= this.maxIdle) return this.drop(entry);
    let ok = false;
    try { ok = await this.reset(entry); } catch {}
    if (!ok || !this.alive(entry) || this.idle.length >= this.maxIdle) return this.drop(entry);
    this.idle.push(entry);
    this.arm();
  }
  drop(entry) { this.stats.destroyed++; try { this.destroy(entry); } catch {} }
  arm() {
    this.clearTimer(this.timer);
    this.timer = this.idle.length ? this.setTimer(() => this.closeAll(), this.idleMs) : null;
    this.timer?.unref?.(); // never keeps the app from quitting
  }
  closeAll() {
    this.clearTimer(this.timer);
    this.timer = null;
    for (const entry of this.idle.splice(0)) this.drop(entry);
  }
}

// ---- result cache ---------------------------------------------------------------------------------------------------
// The sidebar's follow-up question about the page it just read should not fetch it again. Process-wide LRU with a TTL.
// Keyed by the requested URL plus the options that change what a read returns, and the run's trust state (`scope`, e.g.
// sidebar vs MCP client). Callers never put signed-in (as_user) reads in it; it also refuses failed reads and a page
// whose final address left the host that was asked for (a redirect the approval gate may have had to ask about).
class ResultCache {
  // `maxBytes`: the pages' text kept at once (50 long pages was tens of MB of main-process memory): the oldest go first.
  constructor({ max = 50, ttlMs = 5 * 60 * 1000, now = Date.now, maxBytes = 6 * 1024 * 1024 } = {}) {
    Object.assign(this, { max, ttlMs, now, maxBytes });
    this.map = new Map(); // insertion order = recency
    this.hits = 0;
  }
  key(url, options = {}, scope = '') {
    return `${scope}|${url}|${JSON.stringify(Object.keys(options).sort().map((k) => [k, options[k]]))}`;
  }
  get(url, options, scope) {
    const key = this.key(url, options, scope);
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, hit); // most recently used
    this.hits++;
    return hit.page;
  }
  put(url, options, scope, page) {
    if (!cacheable(url, page)) return false;
    const key = this.key(url, options, scope);
    this.map.delete(key);
    this.map.set(key, { at: this.now(), page });
    while (this.map.size > this.max || (this.map.size > 1 && this.bytes() > this.maxBytes)) this.map.delete(this.map.keys().next().value);
    return true;
  }
  bytes() { let n = 0; for (const { page } of this.map.values()) n += (page.text?.length || 0) * 2; return n; } // (UTF-16: two bytes a character)
  clear() { this.map.clear(); }
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
function cacheable(url, page) {
  if (!page || !page.title || /^Could not read this page/.test(page.text || '')) return false;
  return hostOf(page.url) !== null && hostOf(page.url) === hostOf(url);
}

// ---- reader session asset filter --------------------------------------------------------------------------------------
// Reading needs the DOM text, not pictures, video or web fonts: cancelling them saves bandwidth and layout work on heavy
// pages. Stylesheets and scripts stay (they decide what text is visible). Only the reader's own session gets this.
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const shouldBlockReaderRequest = (details) => BLOCKED_TYPES.has(details?.resourceType);

// main.js passes the reader session and its partition name; anything else is refused, so a refactor can never put the
// filter on the user's own sessions. (onBeforeRequest has one listener per session: the reader had none to share.)
function installReaderFilter(ses, partition) {
  if (partition !== READER_PARTITION) throw new Error('The asset filter is for the reader partition only.');
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: shouldBlockReaderRequest(details) }));
}

module.exports = { READER_PARTITION, ReaderPool, ResultCache, cacheable, BLOCKED_TYPES, shouldBlockReaderRequest, installReaderFilter };

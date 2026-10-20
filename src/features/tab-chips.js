// Tab chips (renderer/tab-ref.js): what the chat knows about a tab it names. Main answers three things, with no polling:
//   info(keys)         a tab as it is now: open (title, address, icon), closed (the last title and address we saw, and whether it can be
//                      reopened) or gone (an id from an earlier run of the app, or one never seen)
//   watch(sender, keys) the keys a chat view shows; it is sent only the ones that change, from the events that already report a tab changing
//   open(request)      the chip was clicked: switch to the tab (its window comes to the front), or open a closed one again from its address
// A key is "12" (a tab of this run of the app) or "12@ab12cd34": a saved chat's own reference, whose tab ids are only good for the run of
// the app that wrote them (`ab12cd34`, BOOT). A saved reference from an older run never matches a live tab: it reads as closed.
const crypto = require('crypto');

const BOOT = crypto.randomBytes(4).toString('hex');
const MAX_KEYS = 200; // what one chat view may watch

const parseKey = (key) => {
  const m = /^(\d{1,9})(?:@([0-9a-f]{8}))?$/.exec(String(key ?? ''));
  return m ? { id: Number(m[1]), s: m[2] || '' } : null;
};
const icon = (f) => (typeof f === 'string' && /^(https?:|lumen-favicon:|file:|data:image[/])/i.test(f) && f.length <= 2000 ? f : null); // a saved chat's icon address
const isWeb = (url) => /^https?:\/\//i.test(String(url || '')) && String(url).length <= 4000;

// deps: { closed (a Map of id -> { t, u }), lookup(id) -> { title, url, favicon, sleeping } | null (a tab that is open, in any window),
//         raise(id, senderWc) -> boolean (switch to the tab and bring its window forward), openUrl(url, senderWc) -> tab | null,
//         isInternal(url) -> boolean, aliveSender(wc) -> boolean }
function create(deps) {
  const closed = deps.closed; // id -> { t, u }: the last title and address of a tab that closed (main keeps it from the first close, oldest dropped first)
  const watchers = new Map(); // webContents id -> { wc, keys: Set, sent: Map(key -> signature) }
  let timer = null;

  // One key's state. `snap` is what a saved chat kept for it: { t, u }.
  function describe(key, snap = null) {
    const ref = parseKey(key);
    if (!ref) return { state: 'gone', title: '', url: '', favicon: null, reopen: false };
    if (!ref.s || ref.s === BOOT) {
      const live = deps.lookup(ref.id);
      if (live) return { state: 'open', title: String(live.title || ''), url: String(live.url || ''), favicon: live.favicon || null, sleeping: Boolean(live.sleeping), reopen: false };
      const seen = closed.get(ref.id);
      if (seen) return { state: 'closed', title: seen.t, url: seen.u, favicon: seen.f || null, reopen: isWeb(seen.u) };
    }
    const kept = snap && typeof snap === 'object' ? snap : null;
    if (kept && (kept.t || kept.u)) return { state: 'closed', title: String(kept.t || ''), url: String(kept.u || ''), favicon: icon(kept.f), reopen: isWeb(kept.u) };
    return { state: 'gone', title: '', url: '', favicon: null, reopen: false };
  }
  const signature = (info) => `${info.state}|${info.title}|${info.url}|${info.favicon || ''}|${info.reopen ? 1 : 0}`;

  const infos = (keys, snaps = {}) => {
    const out = {};
    for (const key of Array.isArray(keys) ? keys.slice(0, MAX_KEYS) : []) if (parseKey(key)) out[key] = describe(key, snaps?.[key]);
    return out;
  };

  // The view shows exactly these keys now. Returns their state (and remembers it, so only later changes are sent).
  function watch(wc, keys) {
    const list = (Array.isArray(keys) ? keys : []).filter((k) => parseKey(k)).slice(0, MAX_KEYS);
    if (!list.length) { watchers.delete(wc.id); return {}; }
    const entry = watchers.get(wc.id) || { wc, keys: new Set(), sent: new Map() };
    entry.wc = wc;
    entry.keys = new Set(list);
    const out = {};
    for (const key of list) { const info = describe(key); out[key] = info; entry.sent.set(key, signature(info)); }
    for (const key of [...entry.sent.keys()]) if (!entry.keys.has(key)) entry.sent.delete(key);
    watchers.set(wc.id, entry);
    return out;
  }

  // A tab changed somewhere (the strip's own events: title, icon, address, loading, close): send what differs, one message per view.
  function pushNow() {
    timer = null;
    for (const [id, entry] of watchers) {
      if (!deps.aliveSender(entry.wc)) { watchers.delete(id); continue; }
      const changed = {};
      for (const key of entry.keys) {
        const info = describe(key);
        const sig = signature(info);
        if (entry.sent.get(key) !== sig) { entry.sent.set(key, sig); changed[key] = info; }
      }
      if (Object.keys(changed).length) { try { entry.wc.send('chips:update', changed); } catch { watchers.delete(id); } }
    }
  }
  function changed() {
    if (!watchers.size || timer) return; // (nobody shows a chip: nothing to do; a burst of events is one push)
    timer = setTimeout(pushNow, 30);
    timer.unref?.();
  }

  // The chip was clicked. request: { key, url } (url: the address a saved chat kept, used only for a tab that is gone).
  function open(wc, request) {
    const ref = parseKey(request?.key);
    if (!ref) return { ok: false, reason: 'bad' };
    if (!ref.s || ref.s === BOOT) {
      if (deps.lookup(ref.id)) return deps.raise(ref.id, wc) ? { ok: true, reopened: false, tabId: ref.id } : { ok: false, reason: 'gone' };
    }
    const info = describe(request.key, { u: typeof request?.url === 'string' ? request.url : '' });
    const url = info.url;
    if (!isWeb(url) || deps.isInternal(url)) return { ok: false, reason: 'gone' };
    const tab = deps.openUrl(url, wc);
    return tab ? { ok: true, reopened: true, tabId: tab.id ?? null } : { ok: false, reason: 'gone' };
  }

  function forget(wcId) { watchers.delete(wcId); }
  function snapshot(id) { // { t, u, s } for a saved chat: the tab as it is, or as it was when it closed
    const info = describe(String(id));
    if (info.state === 'gone') return null;
    return { t: info.title.slice(0, 200), u: info.url.slice(0, 1000), ...(icon(info.favicon) ? { f: info.favicon } : {}), s: BOOT };
  }
  return { describe, infos, watch, changed, open, forget, snapshot, watching: () => watchers.size };
}

module.exports = { create, BOOT, parseKey, isWeb };

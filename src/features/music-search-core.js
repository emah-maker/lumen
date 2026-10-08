// The music card's search-as-you-type, without a page: when a search is asked, which results are shown before the answer, and which pictures are
// asked for. The card (renderer/newtab-music.js) uses it as a global (MusicSearch); a test loads it as a module.
//
//   createScheduler({ send(term), shown(term), setTimeout?, clearTimeout?, cache?, now? })
//     .type(text)   the user typed: after DEBOUNCE_MS without another key, and only from MIN_CHARS letters, `send` is called with the term
//     .enter(text)  Enter: `send` at once, from one letter (the user asked), without waiting for the pause
//     .cancel()     a pending (not yet sent) search is dropped; one already sent is outrun by the next one (main answers the newest request only)
//     A term whose answer is in the cache (fresh, exactly this term) is `shown`, not sent: it costs nothing and is on screen at once.
//   createCache({ now?, max?, ttl? })   the last MAX_QUERIES queries' rows per card, kept TTL_MS (a small LRU)
//     .get(scope, term)      the fresh entry for exactly this term, or null (and a hit becomes the newest)
//     .prefix(scope, term)   the freshest entry whose term starts with what is typed so far (a longer query already asked), or null
//     .put(scope, term, rows)
//   thumbsToAsk(rows, asked, max)  the ids of rows with no picture yet that were not asked for already (at most `max`)
'use strict';

(function () {
const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;
const MAX_QUERIES = 50;
const TTL_MS = 10 * 60e3;
const THUMB_BATCH = 12;

// What a term is compared as: trimmed, one space between words, lower case.
const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();

function createCache({ now = Date.now, max = MAX_QUERIES, ttl = TTL_MS } = {}) {
  const map = new Map(); // `${scope}\u0000${norm(term)}` -> { term, rows, at }
  const key = (scope, term) => `${scope}\u0000${norm(term)}`;
  const fresh = (e) => e && now() - e.at < ttl;
  return {
    get(scope, term) {
      const k = key(scope, term);
      const e = map.get(k);
      if (!fresh(e)) { map.delete(k); return null; }
      map.delete(k);
      map.set(k, e); // (the newest)
      return e;
    },
    prefix(scope, term) {
      const t = norm(term);
      if (t.length < MIN_CHARS) return null;
      const head = `${scope}\u0000`;
      let best = null;
      for (const [k, e] of map) {
        if (!k.startsWith(head) || !fresh(e)) continue;
        const n = norm(e.term);
        if (n !== t && n.startsWith(t) && (!best || e.at >= best.at)) best = e;
      }
      return best;
    },
    put(scope, term, rows) {
      if (!norm(term) || !Array.isArray(rows)) return;
      const k = key(scope, term);
      map.delete(k);
      map.set(k, { term: String(term).trim(), rows, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    size: () => map.size,
  };
}

function createScheduler({ send, shown, cache, scope = '', setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, debounce = DEBOUNCE_MS, minChars = MIN_CHARS } = {}) {
  let timer = null;
  let last = ''; // the term last sent or shown: the same again is not asked twice in a row
  const stop = () => { if (timer !== null) { ct(timer); timer = null; } };
  function fire(text) {
    const term = String(text || '').trim();
    if (!term) return false;
    const hit = cache ? cache.get(scope, term) : null;
    if (hit) { last = norm(term); if (shown) shown(term, hit); return 'cached'; }
    if (norm(term) === last) return false;
    last = norm(term);
    send(term);
    return 'sent';
  }
  return {
    type(text) {
      stop();
      const term = String(text || '').trim();
      if (!term) { last = ''; return 'empty'; }
      if (term.length < minChars) return 'short';
      timer = st(() => { timer = null; fire(term); }, debounce);
      return 'waiting';
    },
    enter(text) {
      stop();
      const term = String(text || '').trim();
      if (!term) return 'empty';
      if (norm(term) === last && !cache?.get(scope, term)) last = ''; // (Enter again for the same words asks again)
      return fire(term);
    },
    cancel() { stop(); },
    pending: () => timer !== null,
    forget() { last = ''; },
  };
}

// fn(value) at most once per `ms`: the first value of a burst goes at once, then only the last one of the rest (a volume drag, held arrow keys on the
// seek bar): the player is told where the drag ended, not every step of it.
function createLatest(fn, ms = 50, { setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, now = Date.now } = {}) {
  let timer = null;
  let has = false;
  let last;
  let sentAt = -1e12;
  const go = () => { timer = null; if (!has) return; has = false; sentAt = now(); fn(last); };
  return {
    push(v) { last = v; has = true; if (timer !== null) return; const wait = ms - (now() - sentAt); if (wait <= 0) go(); else timer = st(go, wait); },
    flush() { if (timer !== null) { ct(timer); timer = null; } go(); }, // (the drag ended: the last value now)
    cancel() { if (timer !== null) { ct(timer); timer = null; } has = false; },
  };
}

function thumbsToAsk(rows, asked, max = THUMB_BATCH) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (out.length >= max) break;
    if (r && typeof r.id === 'string' && !r.thumb && !(asked && asked.has(r.id))) out.push(r.id);
  }
  return out;
}

const api = { DEBOUNCE_MS, MIN_CHARS, MAX_QUERIES, TTL_MS, THUMB_BATCH, norm, createCache, createScheduler, createLatest, thumbsToAsk };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.MusicSearch = api;
})();

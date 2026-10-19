// Pure "has this page gone quiet?" logic for wait_for network_idle (no Electron, unit-tested in test/page-debug-units.js).
// Exported on its own so other waits (navigate / read_urls `wait`) can share it: feed it the start and end of every request of
// a tab and ask idle(now) / describe(now).
//
// What counts as "in flight" (the rules that keep a page with a long-poll, a streamed video or an analytics beacon from
// never going idle):
//   - data: / blob: / about: URLs never count, and neither do known ad and tracker hosts (isNoise);
//   - images, fonts and media count for their first 3 s only (a lazy image still loading must not hold up a wait forever);
//   - any request still open after 10 s is "stuck" (a long-poll, an event stream) and is ignored from then on;
//   - the page is idle once nothing counted is in flight and the last counted start or end was 500 ms ago.

const QUIET_MS = 500;
const MEDIA_GRACE_MS = 3000;
const STUCK_MS = 10000;

// The kinds of resource a page can finish without (see MEDIA_GRACE_MS).
const SOFT_TYPES = new Set(['image', 'font', 'media']);

// Common analytics, ad and tracker hosts. The ad blocker's own list is not reachable from here (its engine answers per
// request and the requests it blocks never start), so this short list covers what slips through or is switched off.
const NOISE_HOSTS = [
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googletagservices.com', 'doubleclick.net',
  'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'connect.facebook.net', 'facebook.net', 'hotjar.com',
  'hotjar.io', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'clarity.ms', 'bat.bing.com', 'fullstory.com',
  'newrelic.com', 'nr-data.net', 'sentry.io', 'datadoghq.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'scorecardresearch.com', 'quantserve.com', 'pinterest.com/ct', 'ads-twitter.com', 'snap.licdn.com',
  'px.ads.linkedin.com', 'tiktok.com/i18n/pixel', 'hubspot.com', 'intercom.io', 'optimizely.com', 'heapanalytics.com',
];

// True for a URL the tracker never waits on. `extra`: more host suffixes (a caller that can read a blocker's list).
function isNoise(url, extra = []) {
  const text = String(url || '');
  if (/^(data|blob|about|chrome-extension|devtools):/i.test(text)) return true;
  let u;
  try { u = new URL(text); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const path = host + u.pathname;
  for (const entry of [...NOISE_HOSTS, ...extra]) {
    const h = String(entry).toLowerCase();
    if (h.includes('/')) { if (path.startsWith(h)) return true; continue; } // "host/path" entries
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

class IdleTracker {
  // opts: quietMs, mediaMs, stuckMs, noise (extra host suffixes)
  constructor({ quietMs = QUIET_MS, mediaMs = MEDIA_GRACE_MS, stuckMs = STUCK_MS, noise = [] } = {}) {
    this.quietMs = quietMs;
    this.mediaMs = mediaMs;
    this.stuckMs = stuckMs;
    this.noise = noise;
    this.open = new Map(); // request id -> { url, type, at }
    this.lastActivity = 0; // when a counted request last started or ended
  }

  // `type` is the lower-case kind ('xhr', 'script', 'image', ...). A noisy URL is not tracked at all.
  start(id, { url = '', type = '', at = Date.now() } = {}) {
    if (isNoise(url, this.noise)) return;
    this.open.set(id, { url, type, at });
    this.lastActivity = at;
  }

  end(id, at = Date.now()) {
    if (this.open.delete(id)) this.lastActivity = at; // (an end with no start: seen before tracking began, ignored)
  }

  clear() { this.open.clear(); }

  // The requests that still hold the page back at `now`.
  pending(now = Date.now()) {
    const out = [];
    for (const r of this.open.values()) {
      const age = now - r.at;
      if (age > this.stuckMs) continue; // stuck: a long-poll or a stream
      if (SOFT_TYPES.has(r.type) && age > this.mediaMs) continue; // a slow image does not hold the page
      out.push(r);
    }
    return out;
  }

  idle(now = Date.now()) {
    return this.pending(now).length === 0 && now - this.lastActivity >= this.quietMs;
  }

  // "3 requests in flight (a.com, b.com)", "" when none.
  describe(now = Date.now()) {
    const list = this.pending(now);
    if (!list.length) return '';
    const hosts = [...new Set(list.map((r) => hostOf(r.url)).filter(Boolean))];
    return `${list.length} request${list.length === 1 ? '' : 's'} in flight${hosts.length ? ` (${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? ', …' : ''})` : ''}`;
  }
}

// ---- wait_for conditions (all that are given must hold at once)

// A glob (any `*`) must match the whole URL; plain text matches anywhere in it.
function urlMatches(pattern, url) {
  const want = String(pattern ?? '');
  if (!want) return true;
  const got = String(url ?? '');
  if (!want.includes('*')) return got.includes(want);
  const re = new RegExp(`^${want.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(got);
}

// Does `gone` name a CSS selector (#id, .class, [attr], tag.class, a > b) rather than text? "Loading..." is text.
function looksLikeSelector(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (/^[#.[:]/.test(s) && !/^\.{2,}/.test(s)) return true;
  if (/^[a-z][\w-]*(?:[.#][\w-]+|\[[^\]]+\])+$/i.test(s)) return true; // div.spinner, input[name=q]
  return /\s[>+~]\s/.test(s); // .a > .b
}

// Which conditions a wait_for call asks for. text: string; url; gone; idle.
function waitConditions(input = {}) {
  const c = {};
  if (typeof input.text === 'string' && input.text !== '') c.text = input.text;
  if (typeof input.url === 'string' && input.url !== '') c.url = input.url;
  if (typeof input.gone === 'string' && input.gone !== '') c.gone = input.gone;
  if (input.network_idle === true) c.idle = true;
  return c;
}

const quote = (s) => `"${String(s).length > 60 ? `${String(s).slice(0, 59)}…` : s}"`;

// "Found "Done"; the page is at /checkout; "spinner" is gone; the network is idle." for the conditions that held.
function successText(c, { url = '' } = {}) {
  const parts = [];
  if (c.text !== undefined) parts.push(`found ${quote(c.text)}`);
  if (c.url !== undefined) parts.push(`the page is at ${url}`);
  if (c.gone !== undefined) parts.push(`${quote(c.gone)} is gone`);
  if (c.idle) parts.push('the network is idle');
  const out = parts.join('; ');
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}

// The state after a timeout, so the model knows what to try next instead of guessing: which conditions held, which did
// not, and what the network was doing. `state`: { text, url, gone, idle } booleans for the conditions asked for;
// `now`: the page's address; `tracker`: an IdleTracker or null; `loading`: the tab is still loading.
function timeoutText(c, state, { seconds, url = '', tracker = null, loading = false, now = Date.now() } = {}) {
  const pending = [];
  const met = [];
  if (c.text !== undefined) (state.text ? met : pending).push(state.text ? `text ${quote(c.text)} found` : `text ${quote(c.text)} not found`);
  if (c.url !== undefined) (state.url ? met : pending).push(state.url ? `URL matches ${quote(c.url)}` : `URL ${url} does not match ${quote(c.url)}`);
  if (c.gone !== undefined) (state.gone ? met : pending).push(state.gone ? `${quote(c.gone)} is gone` : `${quote(c.gone)} is still there`);
  if (c.idle) {
    if (state.idle) met.push('network idle');
    else {
      const d = tracker?.describe(now);
      pending.push(d ? `network busy: ${d}` : loading ? 'the page is still loading' : 'network was not quiet for 500 ms');
    }
  }
  return `Timed out after ${seconds}s; still pending: ${pending.join('; ') || 'nothing (it changed at the last moment: try again)'}.${met.length ? ` Already true: ${met.join('; ')}.` : ''}`;
}

module.exports = { IdleTracker, isNoise, urlMatches, looksLikeSelector, waitConditions, successText, timeoutText, QUIET_MS, MEDIA_GRACE_MS, STUCK_MS, NOISE_HOSTS, hostOf };

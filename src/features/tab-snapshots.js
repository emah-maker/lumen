// Tab snapshots: a small picture of a page as it was last seen, kept on disk so a placeholder or unloaded tab can
// show it at once when switched to, until the real page has painted (main.js does the capturing and showing;
// test/tab-snapshots-units.js runs this). Nothing here touches Electron.
//   - one JPEG per address (named by a hash of it: no address is stored), plus a small .json beside it (when, size,
//     the scroll position); the folder is capped (50 MB by default) and trimmed least recently used first
//   - private windows and research tabs never get one; nor do sign-in, payment or account pages, a page with a
//     password or card field, or an address carrying credentials or a token. Clearing history clears them all.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // an older picture shows a page that has surely changed
const MAX_ENTRY_BYTES = 2 * 1024 * 1024; // a single picture larger than this is not kept

// Hosts whose first label says sign-in / payment / account / bank, and well-known ones.
const SENSITIVE_LABEL = /^(login|log-in|signin|sign-in|sso|auth|oauth|accounts?|myaccount|id|idp|secure|pay|payments?|checkout|billing|bank|banking|wallet|netbanking|ebanking)$/;
const SENSITIVE_HOSTS = ['paypal.com', 'venmo.com', 'stripe.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'coinbase.com', 'binance.com', 'wise.com', 'revolut.com', 'login.microsoftonline.com', 'accounts.google.com'];
const SENSITIVE_PATH = /(^|\/)(log-?in|sign-?(in|on|up)|sso|oauth2?|authori[sz]e|checkout|payments?|billing|password|reset-password|2fa|mfa|verify|wallet|banking|account|my-account)(\/|$|\.|\?)/i;
const SENSITIVE_QUERY = /(^|[?&])(token|access_token|id_token|code|password|passwd|pwd|secret|session|sid|otp|auth|key)=/i;

// Why a page must not be snapshotted, or null. `opts`: { isPrivate, isolated, managerPage, extraHosts: [] }.
function skipReason(url, opts = {}) {
  if (opts.isPrivate) return 'private';
  if (opts.isolated) return 'isolated';
  if (opts.managerPage) return 'internal';
  let u;
  try { u = new URL(String(url)); } catch { return 'address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'internal';
  if (u.username || u.password) return 'credentials';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (SENSITIVE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'sensitive-host';
  if ((opts.extraHosts || []).some((h) => host === h || host.endsWith(`.${h}`))) return 'sensitive-host';
  if (host.split('.').slice(0, -2).some((label) => SENSITIVE_LABEL.test(label))) return 'sensitive-host'; // login.example.com, secure.bank.example
  if (SENSITIVE_PATH.test(u.pathname)) return 'sensitive-path';
  if (SENSITIVE_QUERY.test(u.search) || SENSITIVE_QUERY.test(u.hash.replace(/^#/, '?'))) return 'token';
  return null;
}

// The page's own check, run in an isolated world at capture time: where it is scrolled to, and whether it holds a
// sign-in or payment field (so a page whose address looked harmless is still left out). -> { x, y, sensitive }.
const PAGE_PROBE = `(() => {
  const q = 'input[type=password],input[autocomplete*="cc-"],input[autocomplete="one-time-code"],input[name*="card" i][type=text],input[name*="cvv" i],input[name*="cvc" i]';
  let sensitive = false;
  try { sensitive = Boolean(document.querySelector(q)); } catch (e) { sensitive = true; }
  return { x: Math.round(scrollX), y: Math.round(scrollY), sensitive };
})()`;

// The key a picture is stored under: the address without its fragment, hashed.
const keyOf = (url) => crypto.createHash('sha1').update(String(url).split('#')[0]).digest('hex').slice(0, 24);

function createSnapshotStore({ dir, maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = MAX_AGE_MS, now = Date.now } = {}) {
  let made = false;
  const ensure = () => { if (!made) { fs.mkdirSync(dir, { recursive: true }); made = true; } };
  const img = (k) => path.join(dir, `${k}.jpg`);
  const meta = (k) => path.join(dir, `${k}.json`);

  function entries() {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.jpg')) continue;
      const k = n.slice(0, -4);
      try {
        const st = fs.statSync(path.join(dir, n));
        let mt = 0;
        try { mt = fs.statSync(meta(k)).size; } catch { /* no sidecar */ }
        out.push({ key: k, bytes: st.size + mt, at: st.mtimeMs });
      } catch { /* gone */ }
    }
    return out;
  }
  function remove(k) {
    try { fs.rmSync(img(k), { force: true }); } catch { /* gone */ }
    try { fs.rmSync(meta(k), { force: true }); } catch { /* gone */ }
  }
  // Trim to the cap (down to 80% of it, so the next save does not trim again), oldest first, and drop the too old.
  function prune(limit = maxBytes) {
    const list = entries().sort((a, b) => a.at - b.at);
    let total = list.reduce((n, e) => n + e.bytes, 0);
    const t = now();
    let removed = 0;
    const trimming = total > limit;
    for (const e of list) {
      const old = t - e.at > maxAgeMs;
      if (!old && !(trimming && total > limit * 0.8)) continue;
      remove(e.key);
      total -= e.bytes;
      removed++;
    }
    return removed;
  }
  return {
    key: keyOf,
    // Keeps `jpeg` (a Buffer) for `url`; `info`: { w, h, x, y }. Returns false when it was not kept.
    put(url, jpeg, info = {}) {
      if (!Buffer.isBuffer(jpeg) || !jpeg.length || jpeg.length > MAX_ENTRY_BYTES) return false;
      try {
        ensure();
        const k = keyOf(url);
        fs.writeFileSync(img(k), jpeg);
        fs.writeFileSync(meta(k), JSON.stringify({ at: now(), w: info.w | 0, h: info.h | 0, x: info.x | 0, y: info.y | 0 }));
        try { const t = new Date(now()); fs.utimesSync(img(k), t, t); } catch { /* the write time stands */ }
        if (entries().reduce((n, e) => n + e.bytes, 0) > maxBytes) prune();
        return true;
      } catch { return false; }
    },
    // { jpeg, w, h, x, y, at } or null (none, or older than the age limit). A read counts as a use for the LRU order.
    get(url) {
      const k = keyOf(url);
      try {
        const st = fs.statSync(img(k));
        let m = {};
        try { m = JSON.parse(fs.readFileSync(meta(k), 'utf8')); } catch { /* no sidecar */ }
        if (now() - (m.at || st.mtimeMs) > maxAgeMs) { remove(k); return null; }
        const jpeg = fs.readFileSync(img(k));
        try { const t = new Date(now()); fs.utimesSync(img(k), t, t); } catch { /* order unchanged */ }
        return { jpeg, w: m.w || 0, h: m.h || 0, x: m.x || 0, y: m.y || 0, at: m.at || st.mtimeMs };
      } catch { return null; }
    },
    // The scroll position and size saved with the picture, without reading the picture itself; null when there is none.
    peek(url) { try { const m = JSON.parse(fs.readFileSync(meta(keyOf(url)), 'utf8')); return fs.existsSync(img(keyOf(url))) ? { w: m.w || 0, h: m.h || 0, x: m.x || 0, y: m.y || 0, at: m.at || 0 } : null; } catch { return null; } },
    has: (url) => { try { fs.statSync(img(keyOf(url))); return true; } catch { return false; } },
    forget(url) { remove(keyOf(url)); },
    clear() { const n = entries(); for (const e of n) remove(e.key); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } made = false; return n.length; },
    prune,
    stats() { const e = entries(); return { count: e.length, bytes: e.reduce((n, x) => n + x.bytes, 0), maxBytes }; },
  };
}

module.exports = { DEFAULT_MAX_BYTES, MAX_AGE_MS, MAX_ENTRY_BYTES, PAGE_PROBE, skipReason, keyOf, createSnapshotStore };

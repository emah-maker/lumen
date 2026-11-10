// Sites whose dark mode is only half built, found by looking at the page instead of by a list of names. In a dark theme a page is measured once it has
// loaded: how much of its visible text is drawn in nearly the colour of what is behind it (light text on a card the site left white, dark text on a
// panel it turned dark). When much of it is, the page is told the system is light (browser/chrome-identity.js watcher) and measured again, then
// told dark once more and measured a third time (trial); the host is kept only when the light page reads far better than both dark ones, so a site
// whose own light page is no better keeps the dark theme, and so does a page caught while it was still switching (YouTube reloads itself to change
// theme: one reading taken mid-switch was enough to save youtube.com as half dark for good). Kept hosts are saved and get the light page
// from the start of their next visit, for 30 days, then they are measured again. (Glassdoor was the case that showed it: dark new sections over
// white review and job cards.)
const fs = require('fs');
const path = require('path');

// In the page (an isolated world): { dark, text, unreadable, onLight, onDark } in characters of visible text (onLight: on a light background, onDark: on a
// dark one), read for at most about 80 ms. Colours are read through
// a canvas, so any CSS colour syntax counts (oklch, color-mix). Text over a background image is left out: its colour behind is not known.
const PROBE = `(() => {
  const t0 = performance.now();
  const ctx = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.getContext('2d', { willReadFrequently: true }); } catch { return null; } })();
  if (!ctx || !document.body) return null;
  const seen = new Map();
  const rgba = (s) => {
    if (seen.has(s)) return seen.get(s);
    let v = null;
    try { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = s; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2], d[3] / 255]; } catch {}
    seen.set(s, v);
    return v;
  };
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const rootScheme = getComputedStyle(document.documentElement).colorScheme || '';
  const canvas = dark && /dark/.test(rootScheme) ? [18, 18, 18, 1] : [255, 255, 255, 1];
  const bgs = new Map();
  const bgOf = (el) => {
    const chain = [];
    let found;
    for (let e = el; e; e = e.parentElement) {
      if (bgs.has(e)) { found = bgs.get(e); break; }
      chain.push(e);
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') { found = null; break; }
      const c = rgba(cs.backgroundColor);
      if (c && c[3] >= 0.9) { found = c; break; }
    }
    if (found === undefined) found = canvas;
    for (const e of chain) bgs.set(e, found);
    return found;
  };
  let text = 0;
  let unreadable = 0;
  let onLight = 0;
  let onDark = 0;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const vh = innerHeight * 2;
  for (let n = walk.nextNode(), i = 0; n && i < 5000; n = walk.nextNode(), i++) {
    if ((i & 63) === 0 && performance.now() - t0 > 80) break;
    const s = n.data.trim();
    if (s.length < 2) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || r.bottom < 0 || r.top > vh) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || Number(cs.opacity) < 0.5) continue;
    const fg = rgba(cs.color);
    if (!fg || fg[3] < 0.5) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    const a = lum(fg);
    const b = lum(bg);
    const chars = Math.min(s.length, 200);
    text += chars;
    if (b > 0.45) onLight += chars; else if (b < 0.12) onDark += chars;
    if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.8) unreadable += chars;
  }
  return { dark, text, unreadable, onLight, onDark };
})()`;

// The share of the text on the less common of the two (light and dark backgrounds): 0 for a page of one colour, up to 0.5.
const mixed = (r) => (r && r.text > 0 ? Math.min(r.onLight || 0, r.onDark || 0) / r.text : 0);
const unreadable = (r) => Boolean(r && r.unreadable >= 120 && r.unreadable >= r.text * 0.05);
// A page told dark looks half built: much of its text can't be read (at least 120 characters and 5% of it), or a quarter or more of its text sits on
// light cards and another quarter on dark sections. (A site that keeps light cards on purpose in its dark page, such as a document, is ruled out
// by lightIsBetter: its light page is no more even.)
function halfDark(r) {
  return Boolean(r && r.dark && r.text >= 200 && (unreadable(r) || mixed(r) >= 0.25));
}
// The light page is far better: the unreadable text down to a third or less and the light/dark mix halved, and neither still a problem.
function lightIsBetter(before, after) {
  if (!before || !after || !(after.text > 0)) return false;
  const readable = after.unreadable * 3 <= before.unreadable || !unreadable(before);
  const even = mixed(after) * 2 <= mixed(before) || mixed(before) < 0.25;
  return readable && even && !unreadable(after) && mixed(after) < 0.25;
}

// One page's whole measure. `probe()` reads the page (PROBE); `apply(url)` tells the tab what `store` now says for url (no url: its address);
// `wait()` gives the page time to redraw; `here()` is whether the tab still shows url. Returns 'light' (kept), 'dark', or 'moved' (tried again later).
async function trial({ url, store, probe, apply, wait, here, log = () => {} }) {
  const before = await probe();
  log({ url, before });
  if (!halfDark(before) || !here()) return 'dark';
  store.try(url);
  apply(url);
  await wait();
  const after = here() ? await probe() : null;
  log({ url, before, after });
  const done = (verdict, measured = true) => { store.drop(url, { measured }); apply(); return verdict; };
  if (!here()) return done('moved', false);
  if (!lightIsBetter(before, after)) return done('dark');
  // Dark again: a page that was only between themes (or still drawing) reads whole now, and keeps the theme.
  store.pause(url);
  apply(url);
  await wait();
  const again = here() ? await probe() : null;
  log({ url, before, after, again });
  if (!here()) return done('moved', false);
  if (!halfDark(again) || !lightIsBetter(again, after)) return done('dark');
  store.keep(url);
  apply(url);
  return 'light';
}

function hostOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : ''; } catch { return ''; }
}

const KEEP_FOR = 30 * 24 * 60 * 60 * 1000; // a kept host is measured again after this (a site finishes its dark mode)
// The hosts found so far, saved in `file` as { version: 2, sites: { host: when kept } }. `trying` holds a host while its light page is measured (it is
// told light, not yet kept). A file without a version is from before the third reading (trial) and is left unread: its hosts are measured again.
function createStore({ file, now = Date.now } = {}) {
  const sites = new Map(); // host -> when it was kept
  const live = (h) => sites.has(h) && now() - sites.get(h) < KEEP_FOR;
  const trying = new Set();
  const notBetter = new Set(); // (measured this run and the light page was no better: not tried again until Lumen restarts)
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version === 2) for (const [h, at] of Object.entries(saved.sites || {})) if (h && Number.isFinite(at)) sites.set(h, at);
    } catch { /* none yet */ }
  }
  let saving = Promise.resolve();
  const save = () => {
    if (!file) return saving;
    const data = JSON.stringify({ version: 2, sites: Object.fromEntries([...sites].filter(([h]) => live(h)).sort()) }, null, 2);
    saving = saving.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    }).catch(() => {});
    return saving;
  };
  return {
    isLight: (url) => { const h = hostOf(url); return Boolean(h) && (live(h) || trying.has(h)); },
    known: (url) => live(hostOf(url)),
    try: (url) => { const h = hostOf(url); if (h) trying.add(h); },
    pause: (url) => { const h = hostOf(url); trying.delete(h); }, // (told dark again for the third reading: still not tried twice at once)
    keep: (url) => { const h = hostOf(url); trying.delete(h); if (h) { sites.delete(h); sites.set(h, now()); save(); } },
    drop: (url, { measured = true } = {}) => { const h = hostOf(url); trying.delete(h); if (h && measured) notBetter.add(h); }, // (not measured: the tab moved on)
    worthTrying: (url) => { const h = hostOf(url); return Boolean(h) && !live(h) && !trying.has(h) && !notBetter.has(h); },
    hosts: () => [...sites.keys()].filter(live),
    saved: () => saving,
  };
}

module.exports = { PROBE, mixed, halfDark, lightIsBetter, trial, hostOf, createStore, KEEP_FOR };

// What "Organize" learns from the user, and the small rules around it. Pure logic (no Electron):
//  - a learner: when the user drags a tab into or out of a group, or renames a group, it remembers
//    host -> group name and topic words -> group name (capped, kept in the profile, resettable), and
//    later placement and naming prefer them. It also keeps what a model said a site is for (host ->
//    hint, "Organize with AI"), which local grouping then uses like the built-in site hints;
//  - exact-duplicate detection for "Close Duplicate Tabs" (never automatic);
//  - the rule for "Organize tabs automatically when idle" (the local organizer only, never the AI).
// Nothing here is sent anywhere.
const tg = require('../browser/tab-groups');

const MAX_HOSTS = 200;
const MAX_WORDS = 300;
const MAX_NAMES = 3; // names remembered per host or word
const MAX_RENAMES = 100;
const MAX_AI_HINTS = 300; // hosts a model gave a hint for (or "none"), the oldest dropped first
const AI_HINT_DAYS = 30; // then the host is asked about again
const AI_HINTS = new Set(require('./topic-knowledge').AI_HINTS);
const key = (name) => String(name || '').trim().toLowerCase();
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const wordsOf = (e, k = 3) => tg.tokens(tg.stripSiteSegment(e.title || '', e.url || '')).slice(0, k).map((w) => w.key);

function emptyState() { return { hosts: {}, words: {}, renames: {}, aiHints: {} }; }

// load(): the saved state (or anything); save(state): persists it. Both are optional.
function createLearner({ load = () => null, save = () => {} } = {}) {
  let state = null;
  const get = () => {
    if (!state) {
      const saved = load();
      state = saved && typeof saved === 'object' ? { hosts: { ...saved.hosts }, words: { ...saved.words }, renames: { ...saved.renames }, aiHints: { ...saved.aiHints } } : emptyState();
    }
    return state;
  };
  // votes[k] = { name: count }; drops the weakest names and the oldest keys when over the caps.
  const bump = (table, k, name, by, cap) => {
    if (!k || !name) return;
    const row = (table[k] ||= {});
    row[name] = (row[name] || 0) + by;
    if (row[name] <= 0) delete row[name];
    const names = Object.entries(row).sort((a, b) => b[1] - a[1]);
    for (const [n] of names.slice(MAX_NAMES)) delete row[n];
    if (!Object.keys(row).length) delete table[k];
    const keys = Object.keys(table);
    for (const old of keys.slice(0, Math.max(0, keys.length - cap))) delete table[old];
  };
  const commit = () => save(state);
  const votesFor = (e, name) => {
    const s = get();
    const n = key(name);
    const sum = (row) => Object.entries(row || {}).reduce((t, [k, v]) => t + (key(k) === n ? v : 0), 0);
    return { host: sum(s.hosts[hostOf(e.url)]), word: wordsOf(e).reduce((t, w) => t + sum(s.words[w]), 0) };
  };
  return {
    // The user put this tab in the group `name` (dragged it in, or "Add to group").
    learnPlacement(e, name) {
      const s = get();
      bump(s.hosts, hostOf(e.url), name, 1, MAX_HOSTS);
      for (const w of wordsOf(e)) bump(s.words, w, name, 1, MAX_WORDS);
      commit();
    },
    // The user took this tab out of the group `name`: it is not evidence for that name any more.
    learnRemoval(e, name) {
      const s = get();
      bump(s.hosts, hostOf(e.url), name, -2, MAX_HOSTS);
      for (const w of wordsOf(e)) bump(s.words, w, name, -1, MAX_WORDS);
      commit();
    },
    // The user renamed a group: its tabs' hosts and words point at the new name, and the name the
    // organizer gave it is remembered as meaning the new one.
    learnRename(from, to, entries) {
      const s = get();
      const clean = String(to || '').trim().slice(0, 40);
      if (!clean) return;
      if (from && key(from) !== key(clean)) {
        s.renames[key(from)] = clean;
        const names = Object.keys(s.renames);
        for (const old of names.slice(0, Math.max(0, names.length - MAX_RENAMES))) delete s.renames[old];
      }
      for (const e of entries) {
        bump(s.hosts, hostOf(e.url), clean, 2, MAX_HOSTS);
        for (const w of wordsOf(e)) bump(s.words, w, clean, 1, MAX_WORDS);
      }
      commit();
    },
    // How much placement should prefer the group `name` for this tab: 0 to 0.4 (added to a similarity score).
    affinity(e, name) {
      const { host, word } = votesFor(e, name);
      return Math.min(0.4, 0.15 * Math.min(host, 2) + 0.05 * Math.min(word, 4));
    },
    // The name a cluster should get: the user's own rename of the automatic name, else the name most of
    // its tabs were put under before (enough votes from at least half of them), else the automatic one.
    nameFor(entries, autoName) {
      const s = get();
      const renamed = s.renames[key(autoName)];
      if (renamed) return renamed;
      const votes = new Map();
      for (const e of entries) {
        const seen = new Set();
        for (const [name, v] of Object.entries(s.hosts[hostOf(e.url)] || {})) { seen.add(name); votes.set(name, (votes.get(name) || 0) + v); }
        for (const w of wordsOf(e)) for (const [name, v] of Object.entries(s.words[w] || {})) { seen.add(name); votes.set(name, (votes.get(name) || 0) + v * 0.5); }
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] < 3) return autoName;
      const support = entries.filter((e) => votesFor(e, best[0]).host + votesFor(e, best[0]).word > 0).length;
      return support * 2 >= entries.length ? best[0] : autoName;
    },
    // What a model said this tab's site is for: the hint, '' (it said "none", or the user filed this
    // site under a group of their own: what the user taught wins), or undefined (never asked, or asked
    // more than AI_HINT_DAYS ago: worth asking). The fixed table (tab-groups siteHint) is checked first
    // by every caller, so a model's hint never overrides it either.
    aiHint(url, now = Date.now()) {
      const s = get();
      if (Object.keys(s.hosts[hostOf(url)] || {}).length) return '';
      const row = s.aiHints[tg.hintHost(url)];
      if (!row || !(now - row.t < AI_HINT_DAYS * 864e5)) return undefined;
      return AI_HINTS.has(row.k) ? row.k : '';
    },
    // answers: Map or object of host (tab-groups hintHost) -> hint or "none". Anything else is dropped.
    learnAiHints(answers, now = Date.now()) {
      const s = get();
      let n = 0;
      for (const [host, hint] of answers instanceof Map ? answers : Object.entries(answers || {})) {
        if (typeof host !== 'string' || !/^[a-z0-9.-]{3,80}$/.test(host)) continue;
        s.aiHints[host] = { k: AI_HINTS.has(hint) ? hint : 'none', t: now };
        n++;
      }
      if (!n) return 0;
      const hosts = Object.entries(s.aiHints).sort((a, b) => a[1].t - b[1].t);
      for (const [h] of hosts.slice(0, Math.max(0, hosts.length - MAX_AI_HINTS))) delete s.aiHints[h];
      commit();
      return n;
    },
    reset() { state = emptyState(); commit(); },
    snapshot: () => JSON.parse(JSON.stringify(get())),
    size: () => { const s = get(); return Object.keys(s.hosts).length + Object.keys(s.words).length + Object.keys(s.renames).length; },
  };
}

// ---------- exact duplicates ----------

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_ga|yclid|si)$/i;
// The address of a page for "is this the same page": no fragment (except an app's #/ route), no tracking
// parameters, parameters sorted, no trailing slash, no www.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    const hash = /^#[/!]/.test(u.hash) ? u.hash : '';
    return `${u.protocol}//${u.hostname.replace(/^www\./, '').toLowerCase()}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '') || ''}${query}${hash}`;
  } catch { return ''; }
}

// tabs: [{ id, url, canonical?, pinned?, active? }] in strip order -> [{ keep, close: [ids] }].
// Pinned tabs are never closed; the tab kept is the active one, else a pinned one, else the first.
function findDuplicates(tabs) {
  const byKey = new Map();
  for (const t of tabs) {
    const k = normalizeUrl(t.url) || '';
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const out = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const keep = list.find((t) => t.active) || list.find((t) => t.pinned) || list[0];
    const close = list.filter((t) => t !== keep && !t.pinned).map((t) => t.id);
    if (close.length) out.push({ keep: keep.id, close });
  }
  return out;
}

// ---------- "Organize tabs automatically" ----------
// A few seconds after the tabs change (ORGANIZE_DELAYS, Settings), the loose tabs are grouped on this
// computer, with Undo. Only when the loose tabs are a mix: if they are all one topic (however many),
// there is nothing to sort out and they are left alone. Two related tabs beside an unrelated one are grouped.

const ORGANIZE_DELAYS = [2, 5, 10, 30, 60]; // seconds after the last tab change
const DEFAULT_ORGANIZE_DELAY = 5;
const organizeDelay = (v) => (ORGANIZE_DELAYS.includes(Number(v)) ? Number(v) : DEFAULT_ORGANIZE_DELAY);
// ungrouped: loose tab count; topics: the local topic groups those tabs would form ([[ids]]);
// key: which loose tabs (so an unchanged set isn't organized twice).
// onlyMixed (Settings, default on): off, tabs that are all one topic are grouped too.
function shouldAutoOrganize({ enabled, ungrouped, topics = [], key: setKey, lastKey = null, busy = false, onlyMixed = true }) {
  if (!enabled || busy || setKey === lastKey) return false;
  if (ungrouped < 2 || !topics.length) return false; // nothing would form a group
  const oneTopic = topics.length === 1 && topics[0].length === ungrouped;
  return !onlyMixed || !oneTopic; // by default, organize only when something unrelated is among them
}

module.exports = { createLearner, normalizeUrl, findDuplicates, shouldAutoOrganize, ORGANIZE_DELAYS, DEFAULT_ORGANIZE_DELAY, organizeDelay };

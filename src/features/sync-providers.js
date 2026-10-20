'use strict';
// The kinds of data that Sync through a folder keeps in step (features/sync-core.js says what a provider is). Each factory takes the
// accessors to one of Lumen's stores, so it can be tested with plain objects; main.js wires the real ones (features/sync-folder.js).
// Nothing in here is loaded unless sync is on.

const { SyncError } = require('./sync-core');

// A key that holds a sign-in or a secret never goes into the folder as a value, whatever it is called elsewhere.
const SECRETISH = /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|bearer/i;
function scrub(value, depth = 0) {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!SECRETISH.test(k)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return value;
}
const secretOnly = (value) => {
  const out = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) if (SECRETISH.test(k)) out[k] = v;
  return out;
};

// ---------- bookmarks ----------
// Flat: { url, title, folder? }. The address is the key. The order of the list is not synced: new ones go to the end.
function bookmarks({ read, write }) {
  const clean = (b) => (b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url) && b.url.length <= 2048
    ? { url: b.url, title: String(b.title ?? '').slice(0, 300), ...(b.folder ? { folder: String(b.folder).slice(0, 120) } : {}) } : null);
  return {
    name: 'bookmarks',
    scan() {
      const out = new Map();
      const list = read();
      if (!Array.isArray(list)) return out; // never saved: Lumen shows its starter sites, which are not the person's own
      for (const b of list) { const c = clean(b); if (c && !out.has(c.url)) out.set(c.url, { value: c }); }
      return out;
    },
    apply(changes) {
      const list = (Array.isArray(read()) ? read() : []).map((b) => ({ ...b }));
      for (const { key, value, deleted } of changes) {
        const at = list.findIndex((b) => b?.url === key);
        if (deleted) { if (at >= 0) list.splice(at, 1); continue; }
        const c = clean(value);
        if (!c || c.url !== key) continue;
        if (at >= 0) list[at] = c; else list.push(c);
      }
      write(list);
      return [];
    },
  };
}

// ---------- settings ----------
// A short list of preferences, never a key, a sign-in, a path, a port or what the AI may do. `keys` go through the settings backend
// (which checks each value and does what the change needs); `direct` are the few that have their own validation here.
const SETTING_KEYS = [
  'theme', 'accentColor', 'newTabBackground', 'newTabShuffle', 'newTabWidgetGlass', 'newTabEffect', 'newTabEffectColor', 'newTabEffectAmount',
  'newTabEffectSpeed', 'newTabEffectSize', 'newTabEffectInteract', 'newTabClock', 'newTabClockSize', 'newTabClockStyle', 'newTabClockHours',
  'newTabClockSeconds', 'newTabClockDate', 'newTabClockCard', 'newTabClockShadow', 'newTabGreetingFont', 'newTabSearchWidth', 'newTabName',
  'newTabHeader', 'newTabFavorites', 'newTabFrequent', 'newTabPrivacy', 'newTabMusicReactive', 'newTabWidgetsPacked', 'forceDarkWebsites',
  'defaultZoom', 'fontSize', 'showBookmarkButton', 'showAiOffButton', 'compactTabs', 'startup', 'startupPages',
  'sendDoNotTrack', 'sendGpc', 'stripTrackingParams', 'blockTrackingPings', 'httpsOnly', 'adblock', 'adblockAllow', 'spellcheck',
  'spellcheckLanguages', 'languages', 'reduceMotion', 'minimumFontSize', 'focusRings', 'pdfViewer', 'pinchZoom', 'askWhereToSave',
  'aiInstructionsOn', 'aiInstructionsAbout', 'aiInstructionsStyle',
];
const DIRECT_SETTINGS = {
  searchEngine: (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : null),
  adhdMode: (v) => (typeof v === 'boolean' ? v : null),
};
// 'newTabBackground: image' is a picture file on one computer only.
const device = { newTabBackground: (v) => v === 'image' };

function settings({ read, set, writeDirect, keys = SETTING_KEYS, direct = DIRECT_SETTINGS }) {
  for (const k of [...keys, ...Object.keys(direct)]) if (SECRETISH.test(k) || /dir$|path$|port$|file$|folder$/i.test(k)) throw new Error(`${k} must not be synced`);
  const all = [...keys, ...Object.keys(direct)];
  return {
    name: 'settings',
    tombstones: false, // a preference that is not set is at its default: that is not a deletion
    scan() {
      const s = read() || {};
      const out = new Map();
      for (const k of all) if (s[k] !== undefined && !(device[k] && device[k](s[k]))) out.set(k, { value: s[k] });
      return out;
    },
    async apply(changes) {
      const patch = {};
      for (const { key, value, deleted } of changes) {
        if (deleted || !all.includes(key)) continue;
        if (device[key]?.(value)) continue;
        if (direct[key]) { const v = direct[key](value); if (v !== null) patch[key] = v; continue; }
        try { await set(key, value); } catch { /* a value this Lumen does not accept: left as it is */ }
      }
      if (Object.keys(patch).length) writeDirect(patch);
      return [];
    },
  };
}

// ---------- home-page widgets ----------
// Each card is one record (by its id), so a card moved on one computer and another added on a second both survive. Anything in a card that
// looks like a secret stays out of the folder, and a card's own secrets on this computer are kept when a newer copy arrives.
function widgets({ read, write, refresh = () => {} }) {
  const cards = (s) => (Array.isArray(s.homeWidgets) ? s.homeWidgets.filter((w) => w && typeof w.id === 'string' && w.id) : []);
  return {
    name: 'widgets',
    scan() {
      const s = read() || {};
      const out = new Map();
      for (const w of cards(s)) out.set(`w:${w.id}`, { value: scrub(w) });
      if (s.homeWidgetSizes && Object.keys(s.homeWidgetSizes).length) out.set('sizes', { value: scrub(s.homeWidgetSizes) });
      if (Array.isArray(s.weatherPlaces) && s.weatherPlaces.length) out.set('places', { value: scrub(s.weatherPlaces) });
      return out;
    },
    apply(changes) {
      const s = read() || {};
      const list = Array.isArray(s.homeWidgets) ? s.homeWidgets.map((w) => w) : [];
      const patch = {};
      for (const { key, value, deleted } of changes) {
        if (key.startsWith('w:')) {
          const id = key.slice(2);
          const at = list.findIndex((w) => w?.id === id);
          if (deleted) { if (at >= 0) list.splice(at, 1); continue; }
          if (!value || typeof value !== 'object' || value.id !== id) continue;
          const next = { ...value, ...(at >= 0 ? secretOnly(list[at]) : {}) };
          if (at >= 0) list[at] = next; else list.push(next);
        } else if (key === 'sizes') patch.homeWidgetSizes = deleted ? {} : value;
        else if (key === 'places') patch.weatherPlaces = deleted ? [] : value;
      }
      write({ ...patch, homeWidgets: list });
      refresh();
      return [];
    },
  };
}

// ---------- history ----------
// One record per address, stamped with the time of the last visit. A copy made from both: the later visit's title, the larger count.
function history({ map, ready, save, bump = () => {}, isWorthImporting = () => true, limit = 5000 }) {
  const clean = (h) => (h && typeof h.url === 'string' && h.url.length <= 2048 && /^https?:\/\//i.test(h.url)
    ? { url: h.url, title: String(h.title ?? '').slice(0, 300), visits: Math.max(1, Math.round(Number(h.visits) || 1)), last: Math.round(Number(h.last) || 0) } : null);
  return {
    name: 'history',
    async scan() {
      if (!(await ready())) throw new SyncError('loading', 'History is still loading');
      const out = new Map();
      const rows = [];
      for (const h of map().values()) { const c = clean(h); if (c) rows.push(c); }
      rows.sort((a, b) => b.last - a.last);
      for (const c of rows.slice(0, limit)) out.set(c.url, { value: c, ts: c.last });
      return out;
    },
    has: (url) => map().has(url),
    combine(win, others) {
      const w = clean(win);
      if (!w) return win;
      let visits = w.visits; let last = w.last; let title = w.title;
      for (const o of others) { const c = clean(o); if (!c) continue; visits = Math.max(visits, c.visits); last = Math.max(last, c.last); title = title || c.title; }
      return { ...w, visits, last, title };
    },
    apply(changes) {
      const m = map();
      for (const { key, value, deleted } of changes) {
        if (deleted) { m.delete(key); continue; }
        const c = clean(value);
        if (!c || c.url !== key || !isWorthImporting(c.url)) continue;
        const had = m.get(key);
        m.set(key, had ? { ...had, ...c, visits: Math.max(had.visits || 0, c.visits), last: Math.max(had.last || 0, c.last), title: c.title || had.title } : c);
      }
      bump();
      save();
      return [];
    },
  };
}

// ---------- chats ----------
// One shard (file) per chat, so a long chat never rewrites the others. A record is the chat's saved messages and the few list fields
// (title if the person renamed it, pinned, archived, dates, its project). Projects go in their own records (below). A chat that is open or running here waits.
const MAX_CHAT_BYTES = 24 * 1024 * 1024;
function chats({ store, busy = () => false, maxBytes = MAX_CHAT_BYTES }) {
  const bit = (v) => (v ? 1 : 0);
  return {
    name: 'chats',
    guard: true,
    shardOf: (id) => `chats-${id}`,
    scan() {
      if (!store.usable()) throw new SyncError('unavailable', 'Saved chats cannot be read right now');
      const out = new Map();
      for (const c of store.list()) {
        if (c.missing || c.trashed) continue;
        const sig = [c.updated, c.created, c.msgs, c.sig, c.title, bit(c.renamed), bit(c.pinned), bit(c.archived), c.project || ''].join('|');
        out.set(c.id, {
          sig,
          async read() {
            const snapshot = await store.loadAsync(c.id);
            if (!snapshot) return undefined;
            const value = { meta: { title: c.renamed ? c.title : '', renamed: Boolean(c.renamed), created: c.created, updated: c.updated, pinned: Boolean(c.pinned), archived: Boolean(c.archived), ...(c.project ? { project: c.project } : {}) }, snapshot };
            return JSON.stringify(value).length > maxBytes ? undefined : value;
          },
        });
      }
      return out;
    },
    has: (id) => store.has(id),
    apply(changes) {
      const held = [];
      for (const { key, value, deleted } of changes) {
        if (busy(key)) { held.push(key); continue; }
        if (deleted) { if (store.has(key)) store.trash(key); continue; }
        if (!value?.snapshot || !Array.isArray(value.snapshot.messages) || !value.snapshot.messages.length) continue;
        if (!store.adopt(key, value.snapshot, value.meta || {})) held.push(key);
      }
      return held;
    },
  };
}

// ---------- projects ----------
// A chat project's text and settings: name, instructions, pinned pages and defaults. NOT where this computer keeps the project's folder
// (a path on one computer), and not the memory saved in it. A project removed on another computer is removed here (its chats stay).
function projects({ store, removed = () => {} }) {
  return {
    name: 'projects',
    guard: true,
    scan() {
      if (!store.usable()) throw new SyncError('unavailable', 'Projects cannot be read right now');
      const out = new Map();
      for (const p of store.projects()) out.set(p.id, { value: { name: p.name, instructions: p.instructions || '', created: p.created || 0, ...(p.links ? { links: p.links.map((l) => ({ url: l.url, title: l.title || '' })) } : {}), ...(p.defaults ? { defaults: p.defaults } : {}) } });
      return out;
    },
    has: (id) => store.projects().some((p) => p.id === id),
    apply(changes) {
      const held = [];
      for (const { key, value, deleted } of changes) {
        if (deleted) { if (store.removeProject(key)) removed(key); continue; }
        if (!value || typeof value.name !== 'string') continue;
        if (!store.adoptProject({ id: key, ...value })) held.push(key);
      }
      return held;
    },
  };
}

// ---------- project files ----------
// The text of the files in a project (the AI's knowledge), one shard per file, only up to a size: a larger file stays on the computer it was
// added on (the project page there says so). Like everything here they travel only inside the passphrase-encrypted sync files.
function projectFiles({ store, projectIds, maxChars = 400000 }) {
  const keyOf = (pid, fid) => `${pid}-${fid}`;
  const split = (key) => { const m = /^([a-f0-9]{16})-([a-f0-9]{12})$/.exec(String(key)); return m ? [m[1], m[2]] : null; };
  return {
    name: 'project-files',
    guard: true,
    shardOf: (key) => `project-files-${key}`,
    scan() {
      const out = new Map();
      for (const pid of projectIds()) {
        for (const f of store.list(pid)) {
          if ((f.chars || 0) > maxChars || (f.kind === 'image' && (f.size || 0) > 1024 * 1024)) continue;
          out.set(keyOf(pid, f.id), {
            sig: [f.name, f.kind, f.size, f.chars, f.added].join('|'),
            async read() {
              const value = { meta: { name: f.name, kind: f.kind, size: f.size, summary: f.summary || '', added: f.added, ...(f.cut ? { cut: true } : {}) } };
              if (f.kind === 'image') { const image = await store.readImage(pid, f.id); if (!image) return undefined; value.image = image; } else value.text = await store.readText(pid, f.id);
              return value;
            },
          });
        }
      }
      return out;
    },
    has(key) { const k = split(key); return Boolean(k && store.list(k[0]).some((f) => f.id === k[1])); },
    async apply(changes) {
      const held = [];
      for (const { key, value, deleted } of changes) {
        const k = split(key);
        if (!k) continue;
        if (!projectIds().includes(k[0])) { if (!deleted) held.push(key); continue; } // (its project has not arrived yet)
        if (deleted) { await store.remove(k[0], k[1]).catch(() => {}); continue; }
        if (!value?.meta) continue;
        const r = await store.add(k[0], { id: k[1], name: value.meta.name, kind: value.meta.kind, size: value.meta.size, added: value.meta.added, text: value.text, image: value.image });
        if (!r.ok && !/up to|holds as much/.test(r.error || '')) held.push(key);
      }
      return held;
    },
  };
}

// ---------- saved passwords ----------
// Only when the person turned "Also sync passwords" on. The folder holds them only inside the passphrase-encrypted files.
function passwords({ vault, unavailable }) {
  const keyOf = (site, username) => `${site}\n${username}`;
  return {
    name: 'passwords',
    guard: true,
    scan() {
      const why = unavailable();
      if (why) throw new SyncError('unavailable', typeof why === 'string' ? why : 'Saved passwords cannot be read right now');
      const out = new Map();
      for (const s of vault.list()) {
        const e = vault.get(s.id);
        if (!e) continue;
        out.set(keyOf(e.site, e.username), { value: { site: e.site, username: e.username, password: e.password }, ts: e.updated || undefined });
      }
      return out;
    },
    has: (key) => { const i = key.indexOf('\n'); return Boolean(vault.find(key.slice(0, i), key.slice(i + 1))); },
    apply(changes) {
      for (const { key, value, deleted } of changes) {
        const i = key.indexOf('\n');
        const site = key.slice(0, i); const username = key.slice(i + 1);
        if (deleted) { const e = vault.find(site, username); if (e) vault.remove(e.id); continue; }
        if (!value || value.site !== site || value.username !== username) continue;
        try { vault.upsert({ site, username, password: value.password }); } catch { /* an entry this Lumen refuses */ }
      }
      return [];
    },
  };
}

module.exports = { bookmarks, settings, widgets, history, chats, projects, projectFiles, passwords, scrub, SETTING_KEYS, DIRECT_SETTINGS, SECRETISH, MAX_CHAT_BYTES };

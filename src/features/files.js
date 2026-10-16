// Files: the pinned and recently opened files and folders, for the new-tab page's Files widget, the quick picker (Ctrl+Shift+F),
// Settings > General > Files and the AI's file lookup (list_files find:). This module wires the pure parts (files-store.js, files-fuzzy.js,
// files-index.js and its worker) to Electron through `deps`, so test/files-ai.js can drive it with the real thing and units with fakes.
//
// The calls come from three pages, each with its own channel prefix and its own sender check (main.js):
//   the browser UI        files:<op>           (window.lumenFiles, preload.js)   [files:open is taken by dropped files: files:open-entry]
//   the new-tab page      newtab-files:<op>    (window.lumenFiles, files-newtab-preload.js)
//   Settings              settings:files-<op>  (lumenSettings.files, settings-preload.js)
// Ops: list pin unpin remove clear open show find relocate search attach scan restore. The change event goes to all three:
// files:changed (UI), newtab-files:changed (every new-tab page), settings:files-changed (Settings). A file chosen with Alt+Enter goes to the
// sidebar's composer as files:attach-file { name, type, data (the bytes) } (window.lumenFiles.onAttach).
//
// Nothing here waits on the disk on the main thread: every call is fs.promises, and walking folders, ranking them and looking for a moved
// file are the indexer's worker thread (files-index-worker.js). A missing file is noticed with fs.promises.access, at most every 5 s per
// entry, and only for the entries a list() is about to show.
//
// What is stored is paths, names, sizes and times (files-store.js): never a file's contents.
const fs = require('fs');
const path = require('path');
const store = require('./files-store');
const fuzzy = require('./files-fuzzy');

const OPS = ['list', 'pin', 'unpin', 'remove', 'clear', 'open', 'show', 'find', 'relocate', 'search', 'attach', 'scan', 'restore'];
const channelFor = {
  ui: (op) => (op === 'open' ? 'files:open-entry' : `files:${op}`),
  newtab: (op) => `newtab-files:${op}`,
  settings: (op) => `settings:files-${op}`,
};

const RECHECK_MS = 5000; // a missing file is looked for again no sooner than this
const SEARCH_LIMIT = 30;
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // the composer's own limit for a file it reads
const RESTORE_MS = 30000; // an entry removed or unpinned from a list can be put back (Undo) for this long
const LIST_WAIT_MS = 150; // list() waits this long for the existence checks, then answers with what it knows

// What opens in a tab (Lumen's own viewers, or Chromium's): the same set as File > Open and the AI's file cards.
const TAB_EXTS = new Set(['html', 'htm', 'xhtml', 'shtml', 'mhtml', 'svg', 'pdf', 'pptx', 'eml', 'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'tsv', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'yaml', 'yml', 'toml']);
// Never handed to the system's "open": it would run them (the same list as ai-files.js).
const RUNS_CODE = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'msp', 'scr', 'pif', 'lnk', 'url', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'wsf', 'wsh', 'js', 'jse', 'hta', 'jar', 'reg', 'cpl', 'dll', 'sh', 'bash', 'command', 'app', 'dmg', 'appimage', 'deb', 'rpm', 'apk', 'inf', 'gadget', 'application', 'chm']);
const MIME = { pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', eml: 'message/rfc822', html: 'text/html' };
const extOf = (p) => path.extname(String(p)).slice(1).toLowerCase();
const isAbs = (p) => typeof p === 'string' && p.length < 4096 && path.isAbsolute(p) && !p.includes('\0') && !/^\\\\|^\/\/[^/]/.test(p); // (network paths are not used)
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// deps: { file, encrypt, decrypt, available, remember(), ignore(path), openFile(path), openPath(path), showItem(path), pick(kind), send(channel, payload),
//         broadcast(), scanRoots() -> { roots, blocked(path) }, now, indexer }
function create(deps) {
  const now = deps.now || (() => Date.now());
  const list0 = store.create({ file: deps.file, encrypt: deps.encrypt, decrypt: deps.decrypt, available: deps.available, now });
  const fsp = fs.promises;
  let indexer = deps.indexer || null;
  const ix = () => (indexer ||= require('./files-index').createIndexer());
  const lastCheck = new Map(); // id -> when it was last looked for
  const lastNote = new Map(); // path -> when it was last recorded (a viewer and a tab both report one open)
  const transient = new Map(); // id -> an indexed file the picker showed (it is not in the list until opened)
  const candidates = new Map(); // id -> the paths find() offered (relocate takes only those)
  const undo = new Map(); // id -> { entry, at }: what remove() and unpin() took out (restore() puts it back)
  const stats = { notes: 0, scans: 0, known: 0 };
  let ready = null;
  let timer = null;

  const load = () => (ready ||= list0.load().then(syncRoots));
  const changed = () => { if (timer) return; timer = setTimeout(() => { timer = null; try { deps.broadcast?.(); } catch { /* a closed window */ } }, 50); timer.unref?.(); };
  list0.onChange(changed);

  function syncRoots() {
    try { ix().setRoots(list0.all().filter((e) => e.pinned && e.kind === 'folder' && !e.missing).map((e) => e.path)); } catch { /* no worker here: the list works without the folders' index */ }
  }
  function keep(id) { // (before a removal: its entry as it was, for restore())
    const e = list0.get(id);
    if (!e) return;
    undo.set(id, { entry: e, at: now() });
    for (const [k, v] of undo) if (now() - v.at > RESTORE_MS) undo.delete(k);
    if (undo.size > 20) undo.delete(undo.keys().next().value);
  }
  const resolve = (id) => list0.get(String(id)) || transient.get(String(id)) || null;

  // Looks again for the listed entries that have not been checked for 5 s. -> true when a mark changed.
  async function recheck(entries) {
    const due = entries.filter((e) => now() - (lastCheck.get(e.id) || 0) >= RECHECK_MS);
    if (!due.length) return false;
    let any = false;
    for (const e of due) lastCheck.set(e.id, now());
    if (lastCheck.size > 2000) for (const k of [...lastCheck.keys()].slice(0, 1000)) lastCheck.delete(k);
    await Promise.all(due.map(async (e) => {
      let gone = false;
      try { await fsp.access(e.path); } catch (err) { gone = err?.code === 'ENOENT' || err?.code === 'ENOTDIR'; } // (a drive that is merely slow or locked is not "deleted")
      if (list0.setMissing(e.id, gone)) any = true;
    }));
    return any;
  }

  const api = {
    // { pinned, recent, remember }. The existence checks run in parallel and are waited for 150 ms at most.
    async list() {
      await load();
      const shown = list0.list({ recentLimit: 30 });
      const check = recheck([...shown.pinned, ...shown.recent.slice(0, 20)]).catch(() => false);
      await Promise.race([check, sleep(LIST_WAIT_MS)]);
      const again = list0.list({ recentLimit: 30 });
      return { pinned: again.pinned, recent: again.recent, remember: deps.remember?.() !== false };
    },

    // { path } (the UI's own request, or a tab or download's menu), { id } (a row the page was given by list() or search(): the Files card's
    // Pin on a recent file, no path from the page), or { pick: 'file' | 'folder' } (a dialog) -> Entry | null
    async pin(arg) {
      await load();
      let p = isAbs(arg?.path) ? arg.path : null;
      if (!p && typeof arg?.id === 'string') p = resolve(arg.id)?.path || null;
      if (!p && (arg?.pick === 'file' || arg?.pick === 'folder')) p = await deps.pick?.(arg.pick);
      if (!isAbs(p)) return null;
      let st;
      try { st = await fsp.stat(p); } catch { return null; }
      if (!st.isFile() && !st.isDirectory()) return null;
      const entry = list0.pin(p, st.isDirectory() ? 'folder' : 'file');
      list0.update(entry.id, { size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) });
      if (st.isDirectory()) syncRoots();
      return list0.get(entry.id);
    },
    async unpin(id) { await load(); keep(String(id)); const ok = list0.unpin(String(id)); if (ok) syncRoots(); return ok; },
    async remove(id) { await load(); keep(String(id)); const ok = list0.remove(String(id)); if (ok) syncRoots(); return ok; },
    async clear() { await load(); list0.clear(); transient.clear(); candidates.clear(); lastCheck.clear(); undo.clear(); syncRoots(); await list0.flush(); return true; },
    // Undo of the Files card's Unpin and Remove: the entry comes back as it was (pin, place in Recent), for 30 s after it went. -> Entry | null
    async restore(id) {
      await load();
      const kept = undo.get(String(id));
      if (!kept || now() - kept.at > RESTORE_MS) { undo.delete(String(id)); return null; }
      undo.delete(String(id));
      const back = list0.restore(kept.entry);
      if (back?.kind === 'folder') syncRoots();
      return back;
    },

    // A file in a tab (Lumen's own viewers), the system's program for other safe kinds, a folder in Explorer. -> boolean
    async open(id) {
      await load();
      const e = resolve(id);
      if (!e) return false;
      let st;
      try { st = await fsp.stat(e.path); } catch (err) { if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') list0.setMissing(e.id, true); return false; }
      if (st.isDirectory()) { await deps.openPath?.(e.path); return true; }
      if (list0.get(e.id)) list0.setMissing(e.id, false);
      const ext = extOf(e.path);
      if (TAB_EXTS.has(ext)) { await api.note(e.path, { source: e.source === 'ai' ? 'ai' : 'tab', st }); deps.openFile?.(e.path); return true; }
      if (!RUNS_CODE.has(ext)) { await api.note(e.path, { source: 'tab', st }); await deps.openPath?.(e.path); return true; } // a Word file opens in Word
      deps.showItem?.(e.path); // a program or script: shown in its folder, never run from here
      return true;
    },
    async show(id) {
      await load();
      const e = resolve(id);
      if (!e) return false;
      let dir = e.path;
      let st = null;
      try { st = await fsp.stat(dir); } catch { /* gone: its nearest folder opens instead */ }
      if (st?.isFile()) { deps.showItem?.(e.path); return true; }
      if (st?.isDirectory()) { await deps.openPath?.(e.path); return true; }
      for (let i = 0; i < 8; i++) {
        const up = path.dirname(dir);
        if (up === dir) return false;
        dir = up;
        try { if ((await fsp.stat(dir)).isDirectory()) { await deps.openPath?.(dir); return true; } } catch { /* one more up */ }
      }
      return false;
    },
    // Find it: the same name, or the same size and a similar name, in the old folder, its parent and the folders beside it. -> { candidates }
    async find(id) {
      await load();
      const e = resolve(id);
      if (!e || e.kind === 'folder') return { candidates: [] }; // (the search is for a file's name)
      let found = [];
      try { found = await ix().find({ path: e.path, size: e.size }); } catch { /* the worker is not available */ }
      found = found.filter((c) => c.path !== e.path).slice(0, 8);
      candidates.set(e.id, new Set(found.map((c) => c.path)));
      return { candidates: found.map(({ path: p, name, size, mtime }) => ({ path: p, name, size, mtime })) };
    },
    // Accepts one of the paths find() offered for this entry: the entry follows it (and is no longer missing).
    async relocate(id, newPath) {
      await load();
      const e = list0.get(String(id));
      if (!e || !candidates.get(e.id)?.has(newPath)) return null;
      try { await fsp.access(newPath); } catch { return null; }
      candidates.delete(e.id);
      const moved = list0.relocate(e.id, newPath);
      if (moved?.kind === 'folder') syncRoots();
      return moved;
    },
    // Fuzzy over pinned, recent and the files inside pinned folders. Entries carry `positions` (indexes into name) for highlighting.
    // No query: the pinned files, then the recent ones (the picker's first screen).
    async search(query) {
      await load();
      const q = String(query || '').slice(0, 200).trim();
      if (!q) { const l = list0.list({ recentLimit: SEARCH_LIMIT }); return [...l.pinned, ...l.recent].filter((e) => !e.missing).slice(0, SEARCH_LIMIT); }
      const bonus = (e) => (e.pinned ? 60 : e.openedAt ? 25 + Math.max(0, 10 - (now() - e.openedAt) / 864e5) : 0);
      const here = fuzzy.rank(q, list0.all().filter((e) => !e.missing), { limit: SEARCH_LIMIT, bonus });
      const out = here.map((r) => ({ ...r.item, positions: r.positions, score: r.score }));
      let hits = [];
      try { hits = await ix().search(q, { limit: SEARCH_LIMIT }); } catch { /* the folders' index is not available */ }
      const seen = new Set(out.map((e) => store.keyOf(e.path)));
      for (const h of hits) {
        if (seen.has(store.keyOf(h.path))) continue;
        const m = fuzzy.matchText(q, h.name, { where: h.path.slice(h.root.length) });
        const e = { id: store.idFor(h.path), path: h.path, name: h.name, kind: 'file', size: h.size, mtime: h.mtime, openedAt: 0, pinned: false, missing: false, source: 'pin', positions: m?.positions || [], score: m?.score || 0 };
        transient.set(e.id, e);
        out.push(e);
      }
      if (transient.size > 500) for (const k of [...transient.keys()].slice(0, 250)) transient.delete(k);
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, SEARCH_LIMIT).map(({ score, ...rest }) => rest);
    },
    // Alt+Enter: the file goes to the sidebar's composer the way a dropped file does (the UI shows the sidebar). -> { ok, reason? }
    async attach(id) {
      await load();
      const e = resolve(id);
      if (!e || e.kind === 'folder') return { ok: false, reason: 'folder' };
      let st;
      try { st = await fsp.stat(e.path); } catch { return { ok: false, reason: 'missing' }; }
      if (!st.isFile()) return { ok: false, reason: 'missing' };
      if (st.size > MAX_ATTACH_BYTES) return { ok: false, reason: 'big' };
      let data;
      try { data = await fsp.readFile(e.path); } catch { return { ok: false, reason: 'unreadable' }; }
      deps.send?.('files:attach-file', { name: path.basename(e.path), type: MIME[extOf(e.path)] || '', data }); // (the bytes: the composer makes a File of them, no base64 pass over a big file)
      return { ok: true };
    },

    // ---- recording (main.js, downloads, the AI's tools): a file was opened.
    async note(p, { source = 'tab', st = null } = {}) {
      if (deps.remember?.() === false || !isAbs(p) || deps.ignore?.(p)) return null;
      const at = lastNote.get(p) || 0;
      if (!st && now() - at < 1500) return null;
      lastNote.set(p, now());
      if (lastNote.size > 500) for (const k of [...lastNote.keys()].slice(0, 250)) lastNote.delete(k);
      try { st ||= await fsp.stat(p); } catch { return null; }
      if (!st.isFile()) return null;
      await load();
      stats.notes++;
      return list0.touch(p, { source, size: st.size, mtime: Math.round(st.mtimeMs) });
    },
    // "Pin to Files" on a file tab or a download.
    pinPath(p) { return api.pin({ path: p }); },

    // The picker's "Search Documents, Desktop and Downloads": the AI's lookup below with the walk allowed, for roots the user did not have to grant
    // (they clicked). Async, in the index worker, bounded in depth and time. -> Entry[] (not in the list until opened; the best hit is noted)
    async scan(query) {
      await load();
      const q = String(query || '').slice(0, 200).trim();
      if (!q) return [];
      let cfg = null;
      try { cfg = await deps.scanRoots?.(); } catch { /* no roots */ }
      const roots = [];
      for (const r of Array.isArray(cfg?.roots) ? cfg.roots : []) { try { if (isAbs(r) && (await fsp.stat(r)).isDirectory()) roots.push(r); } catch { /* not there */ } }
      if (!roots.length) return [];
      const { hits } = await api.findFile(q, { scan: true, roots, strict: true, blocked: cfg?.blocked || (() => false) });
      const out = hits.map((h) => {
        const m = fuzzy.matchText(q, h.name, { where: h.path });
        const known = list0.byPath(h.path);
        const e = known ? { ...known } : { id: store.idFor(h.path), path: h.path, name: h.name, kind: 'file', size: h.size, mtime: h.mtime, openedAt: 0, pinned: false, missing: false, source: 'found' };
        if (!known) transient.set(e.id, e);
        return { ...e, positions: m?.positions || [] };
      });
      return out.slice(0, SEARCH_LIMIT);
    },

    // The AI's lookup (list_files find:). Pinned and recent files first, then the pinned folders' index, and only then a bounded fresh
    // walk of `roots` (when the AI may use files). The hit the slow way is remembered, so the next lookup is the first kind.
    // -> { hits: [{ path, name, size, mtime, from: 'known' | 'index' | 'disk' }], scanned }
    async findFile(query, { scan = false, roots = [], blocked = () => false, strict = false } = {}) {
      await load();
      const q = String(query || '').slice(0, 200).trim();
      if (!q) return { hits: [], scanned: false };
      const alive = async (rows, from) => {
        const ok = await Promise.all(rows.map(async (r) => { try { const st = await fsp.stat(r.path); return st.isFile() ? { path: r.path, name: path.basename(r.path), size: st.size, mtime: Math.round(st.mtimeMs), from } : null; } catch { return null; } }));
        return ok.filter((r) => r && !blocked(r.path));
      };
      const known = list0.all().filter((e) => e.kind === 'file' && !e.missing);
      const bonus = (e) => (e.pinned ? 60 : 25);
      let rows = fuzzy.rank(q, known, { limit: 5, bonus }).map((r) => r.item);
      if (!rows.length) rows = fuzzy.rank(q, known, { limit: 5, bonus, loose: true }).map((r) => r.item);
      let hits = await alive(rows, 'known');
      if (hits.length) { stats.known++; return { hits, scanned: false }; }
      try {
        let found = await ix().search(q, { limit: 5 });
        if (!found.length) found = await ix().search(q, { limit: 5, loose: true });
        hits = await alive(found, 'index');
      } catch { /* no index */ }
      if (hits.length) { stats.known++; return { hits, scanned: false }; }
      if (!scan || !roots.length) return { hits: [], scanned: false };
      stats.scans++;
      let slow = [];
      try { slow = await ix().scan({ roots, query: q, loose: !strict }); } catch { /* the walk failed or timed out */ }
      hits = await alive(slow.slice(0, 5), 'disk');
      if (hits[0]) await api.note(hits[0].path, { source: 'found' }); // (only the best: a list of guesses would not be "remembered")
      return { hits, scanned: true };
    },
  };

  return Object.assign(api, {
    store: list0, stats, load, flush: () => list0.flush(), syncRoots,
    get indexer() { return ix(); },
    close() { try { indexer?.close(); } catch { /* gone */ } },
  });
}

module.exports = { OPS, channelFor, create, TAB_EXTS, RUNS_CODE, isAbs, MAX_ATTACH_BYTES };

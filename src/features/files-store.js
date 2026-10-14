// The Files list: files and folders the user pinned, and the files recently opened in Lumen (by the user, or by the AI for them).
// Pure: no Electron, no timers of its own beyond one debounce. The disk is touched only through `file` with fs.promises, and what is
// written is encrypted by the injected encrypt/decrypt (the OS keychain in main, as chat-store.js does).
//
// Only what the list shows is kept: the path, the name, the kind, the size, the modified time and when it was opened or pinned.
// Never a file's contents (an unknown field passed in is dropped, and test/files-store-units.js checks the written text for it).
// At most `cap` entries (500): a new one pushes out the oldest recent one that is not pinned; pins go last.
//
//   create({ file, encrypt, decrypt, available, now, cap, fsp, delay })
//   .load()                       async: reads the file once (a missing or unreadable file is an empty list)
//   .pin(path, kind)              -> Entry (kind 'file' | 'folder'; pinning an entry already in the list pins it)
//   .unpin(id)  .remove(id)  .clear()
//   .touch(path, { source, size, mtime, kind })   a file was opened: it moves to the top of Recent (and is added if new)
//   .list({ recentLimit })        -> { pinned, recent }  (pinned in the order pinned; recent newest first, without the pinned ones)
//   .all()                        every entry (the picker's fuzzy search)
//   .get(id)  .byPath(path)
//   .setMissing(id, bool)  .relocate(id, newPath)  .update(id, { size, mtime })
//   .save()  .flush()             async and debounced; flush writes now; flushSync is for quitting
//   .pending()                    true while a change is not on disk yet
const crypto = require('crypto');
const path = require('path');
const nodeFs = require('fs');

const SOURCES = new Set(['tab', 'download', 'ai', 'pin', 'found']);
const FIELDS = ['id', 'path', 'name', 'kind', 'size', 'mtime', 'openedAt', 'pinnedAt', 'pinned', 'missing', 'source'];

// Windows paths compare without case; the key is only for finding the same file again, the stored path keeps its spelling.
const keyOf = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));
const nameOf = (p) => path.basename(String(p).replace(/[\\/]+$/, '')) || String(p);
// The id of a path: the same wherever it is asked, so the picker can name a file that is not in the list yet.
const idFor = (p) => crypto.createHash('sha1').update(keyOf(p)).digest('hex').slice(0, 12);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

function create({ file, encrypt = (t) => t, decrypt = (t) => t, available = () => true, now = () => Date.now(), cap = 500, fsp = nodeFs.promises, delay = 500 } = {}) {
  const byId = new Map();
  const byKey = new Map();
  let timer = null;
  let dirty = false;
  let writing = Promise.resolve();
  let loaded = null;
  const listeners = new Set();

  const clean = (e) => { const out = {}; for (const f of FIELDS) if (e[f] !== undefined) out[f] = e[f]; return out; }; // nothing outside FIELDS is ever kept or written
  const view = (e) => ({ ...clean(e), pinned: Boolean(e.pinned), missing: Boolean(e.missing) });

  function add(p, kind) {
    const e = { id: idFor(p), path: String(p), name: nameOf(p), kind: kind === 'folder' ? 'folder' : 'file', size: 0, mtime: 0, openedAt: 0, pinnedAt: 0, pinned: false, missing: false, source: 'tab' };
    byId.set(e.id, e); byKey.set(keyOf(e.path), e);
    return e;
  }
  function drop(e) { byId.delete(e.id); byKey.delete(keyOf(e.path)); }
  // Over the cap: the oldest recent entry that is not pinned goes first; only when all are pinned does the oldest pin.
  function trim() {
    while (byId.size > cap) {
      let victim = null;
      for (const e of byId.values()) if (!e.pinned && (!victim || e.openedAt < victim.openedAt)) victim = e;
      if (!victim) for (const e of byId.values()) if (!victim || e.pinnedAt < victim.pinnedAt) victim = e;
      drop(victim);
    }
  }
  const changed = () => {
    dirty = true;
    for (const fn of listeners) { try { fn(); } catch { /* a listener's own error */ } }
    store.save();
  };

  const store = {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    pin(p, kind = 'file') {
      if (typeof p !== 'string' || !p) return null;
      const e = byKey.get(keyOf(p)) || add(p, kind);
      if (!e.pinned) { e.pinned = true; e.pinnedAt = now(); }
      if (!e.openedAt) e.source = 'pin';
      trim(); changed();
      return view(e);
    },
    unpin(id) { const e = byId.get(id); if (!e || !e.pinned) return false; e.pinned = false; e.pinnedAt = 0; if (!e.openedAt) drop(e); changed(); return true; },
    remove(id) { const e = byId.get(id); if (!e) return false; drop(e); changed(); return true; },
    clear() { const had = byId.size > 0; byId.clear(); byKey.clear(); if (had) changed(); return had; },
    touch(p, { source = 'tab', size, mtime, kind } = {}) {
      if (typeof p !== 'string' || !p) return null;
      const e = byKey.get(keyOf(p)) || add(p, kind);
      e.openedAt = now();
      e.source = SOURCES.has(source) ? source : 'tab';
      if (size !== undefined) e.size = num(size);
      if (mtime !== undefined) e.mtime = num(mtime);
      e.missing = false;
      trim(); changed();
      return view(e);
    },
    list({ recentLimit = 30 } = {}) {
      const all = [...byId.values()];
      const pinned = all.filter((e) => e.pinned).sort((a, b) => a.pinnedAt - b.pinnedAt).map(view);
      const recent = all.filter((e) => !e.pinned && e.openedAt).sort((a, b) => b.openedAt - a.openedAt).slice(0, recentLimit).map(view);
      return { pinned, recent };
    },
    all() { return [...byId.values()].map(view); },
    get(id) { const e = byId.get(id); return e ? view(e) : null; },
    byPath(p) { const e = byKey.get(keyOf(p)); return e ? view(e) : null; },
    setMissing(id, missing) { const e = byId.get(id); if (!e || Boolean(e.missing) === Boolean(missing)) return false; e.missing = Boolean(missing); changed(); return true; },
    update(id, { size, mtime } = {}) {
      const e = byId.get(id);
      if (!e) return false;
      const s = size === undefined ? e.size : num(size);
      const m = mtime === undefined ? e.mtime : num(mtime);
      if (s === e.size && m === e.mtime) return false;
      e.size = s; e.mtime = m; changed();
      return true;
    },
    // The file was found elsewhere: the entry keeps its id, pin and place in Recent, and follows the new path. An entry already at
    // the new path is folded in (the pin survives).
    relocate(id, newPath) {
      const e = byId.get(id);
      if (!e || typeof newPath !== 'string' || !newPath) return null;
      const other = byKey.get(keyOf(newPath));
      if (other && other !== e) {
        if (other.pinned && !e.pinned) { e.pinned = true; e.pinnedAt = other.pinnedAt; }
        e.openedAt = Math.max(e.openedAt, other.openedAt);
        drop(other);
      }
      byKey.delete(keyOf(e.path));
      e.path = String(newPath); e.name = nameOf(newPath); e.missing = false; e.source = 'found';
      byKey.set(keyOf(e.path), e);
      changed();
      return view(e);
    },

    load() {
      return (loaded ||= (async () => {
        if (!file) return;
        try {
          const outer = JSON.parse(await fsp.readFile(file, 'utf8'));
          const data = JSON.parse(outer.enc ? decrypt(outer.enc) : JSON.stringify(outer));
          for (const raw of Array.isArray(data.entries) ? data.entries : []) {
            if (!raw || typeof raw.path !== 'string' || !raw.path) continue;
            const e = add(raw.path, raw.kind);
            Object.assign(e, { size: num(raw.size), mtime: num(raw.mtime), openedAt: num(raw.openedAt), pinnedAt: num(raw.pinnedAt), pinned: Boolean(raw.pinned), missing: Boolean(raw.missing), source: SOURCES.has(raw.source) ? raw.source : 'tab' });
          }
          trim();
        } catch { /* no file yet, or one that cannot be read here (another keychain): start empty; the next save replaces it */ }
      })());
    },
    // What goes to disk. Only FIELDS, so a stray property on an entry can never be written.
    serialize() { return JSON.stringify({ v: 1, entries: [...byId.values()].map(clean) }); },
    save() { if (timer) return; timer = setTimeout(() => { timer = null; store.flush().catch(() => {}); }, delay); timer.unref?.(); },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!file || !dirty) return writing;
      dirty = false;
      if (!available()) return writing; // no keychain: the list lives in memory only, never in plain text
      const text = JSON.stringify({ enc: encrypt(store.serialize()) });
      writing = writing.then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, text);
        await fsp.rename(tmp, file);
      }).catch(() => { dirty = true; });
      return writing;
    },
    // Quitting: the last changes go out now, before the process ends (the one place a synchronous write is right).
    flushSync() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!file || !dirty || !available()) return false;
      dirty = false;
      try {
        nodeFs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        nodeFs.writeFileSync(tmp, JSON.stringify({ enc: encrypt(store.serialize()) }));
        nodeFs.renameSync(tmp, file);
        return true;
      } catch { dirty = true; return false; }
    },
    pending() { return dirty || Boolean(timer); },
  };
  return store;
}

module.exports = { create, SOURCES, FIELDS, nameOf, keyOf, idFor };

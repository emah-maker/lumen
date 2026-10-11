// Saved AI chats: the sidebar's history list. Each chat is one file in <userData>/chats/, plus an
// index (titles, dates, usage totals, which chat is open). Everything on disk is encrypted the same
// way the single chat.json was (the OS keychain, through `encrypt`/`decrypt`); with no keychain,
// nothing is kept at all. What goes into a chat file is decided by the caller (main.js strips tool
// results and attached page text first).
//
// The store keeps the newest `limit` chats; older ones are deleted as new ones are saved. An empty
// chat (no messages yet) is never written, so New chat doesn't fill the list with blank entries.
//
// Chat files are only ever deleted one at a time, for a reason (the user deleted the chat, or it fell past the limit),
// after the index on disk has been read again, and never for a chat another writer's index lists (a second Lumen, or a
// test run, on the same profile). Nothing here removes the whole folder: a "clear everything" once ran from a second
// process that quit before the keychain was ready, and took every chat with it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plainScripts } = require('../renderer/markdown.js'); // <sub>/<sup> as clean text in exports

const ID_RE = /^[a-f0-9]{16}$/;

// The history list's title for a chat until the user renames it: features/chat-title.js (no model call).
const { autoTitle, cleanSaved } = require('./chat-title');

const cleanTitle = (title) => String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

function createChatStore({ dir, encrypt, decrypt, available = () => true, limit = 50, legacyFile = null, now = () => Date.now() }) {
  const indexFile = path.join(dir, 'index.json');
  const chatFile = (id) => path.join(dir, `${id}.json`);

  const writeAtomic = (file, data) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ enc: encrypt(JSON.stringify(data)) }));
    fs.renameSync(tmp, file); // never a half-written file
  };
  const readEnc = (file) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.enc ? JSON.parse(decrypt(data.enc)) : data;
  };

  let index = null; // { current, chats: [{ id, title, renamed, created, updated, model, usage }] }
  const known = new Set(); // chat ids in the index as this store last read or wrote it
  const foreign = new Set(); // ids another writer added to the index on disk meanwhile: never pruned or deleted here
  const MAX_PRUNE = 3; // files one save may delete: more than that means something is wrong (a changed limit, a clobbered index), not that the list grew
  // The index can be lost to a half-written file, a locked keychain or another machine's keys. Only a
  // missing file means "no chats yet"; anything else must never become an empty index that the next
  // write would save over the real one (that orphaned every chat file).
  const CHAT_FILE_RE = /^[a-f0-9]{16}\.json$/;
  function rebuildIndex() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => CHAT_FILE_RE.test(n)); } catch { /* no folder: nothing to rebuild */ }
    const chats = [];
    let unreadable = 0;
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        const snapshot = readEnc(chatFile(id));
        if (!snapshot?.messages?.length) { unreadable++; continue; }
        const mtime = fs.statSync(chatFile(id)).mtimeMs;
        chats.push({ id, title: autoTitle(snapshot), renamed: false, created: mtime, updated: mtime, model: snapshot.settings?.model || null, usage: snapshot.settings?.usage || null });
      } catch { unreadable++; }
    }
    return { chats, unreadable };
  }
  function readIndex() {
    if (index) return index;
    let data = null;
    let raw = null;
    try {
      raw = fs.readFileSync(indexFile, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') return { current: null, chats: [], degraded: true }; // locked/unreadable right now: retry next call, never write
    }
    if (raw !== null) {
      try {
        const outer = JSON.parse(raw);
        data = outer.enc ? JSON.parse(decrypt(outer.enc)) : outer;
      } catch {
        // Unparseable or undecryptable: keep the file for inspection and rebuild from the chat files.
        try { fs.renameSync(indexFile, `${indexFile}.corrupt-${Date.now()}`); } catch { return { current: null, chats: [], degraded: true }; }
      }
    }
    if (data) {
      index = { current: ID_RE.test(data.current) ? data.current : null, chats: Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [] };
      remember(index);
      return index;
    }
    // No index (never written, or just set aside as corrupt): rebuild it from the chat files.
    const { chats, unreadable } = rebuildIndex();
    if (!chats.length && unreadable) return { current: null, chats: [], degraded: true }; // chats exist but can't be read now: retry next call
    index = { current: null, chats };
    remember(index);
    if (chats.length && available()) { try { writeAtomic(indexFile, index); } catch { /* retried on the next write */ } }
    return index;
  }
  // The index as it is on disk right now (null: it can't be read: locked, undecryptable, half-written). A missing file is an empty list.
  function readDiskChats() {
    let raw;
    try { raw = fs.readFileSync(indexFile, 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? [] : null; }
    try {
      const outer = JSON.parse(raw);
      const data = outer.enc ? JSON.parse(decrypt(outer.enc)) : outer;
      return Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [];
    } catch { return null; }
  }
  // Another writer on this profile may have added chats to the index since we read it. They join ours (and are never
  // pruned by us) so that our next write doesn't drop them and our prune doesn't delete their files.
  // Returns false when the disk index can't be read: then nothing may be deleted.
  function syncFromDisk(idx) {
    const disk = readDiskChats();
    if (!disk) return false;
    for (const c of disk) {
      if (known.has(c.id) || idx.chats.some((x) => x.id === c.id)) continue;
      idx.chats.push(c);
      known.add(c.id);
      foreign.add(c.id);
    }
    return true;
  }
  const remember = (idx) => { known.clear(); for (const c of idx.chats) known.add(c.id); };
  const writeIndex = () => {
    const idx = readIndex();
    if (idx.degraded || !available()) return;
    syncFromDisk(idx);
    writeAtomic(indexFile, idx);
    remember(idx);
  };

  const newId = () => crypto.randomBytes(8).toString('hex');

  // An entry whose chat file is gone (deleted by something else, a synced folder that lost it) is marked `missing`: the
  // History list must not show a row that opens empty (main.js leaves it out). Checked at most every few seconds per chat; the
  // entry stays in the index, so a file that comes back (a restored backup) or is only held by a scanner shows again. A file missing at one look is looked at again after a moment
  // (Windows can report a file being replaced by a rename as missing).
  const FILE_CHECK_MS = 3000;
  const fileChecks = new Map(); // id -> { at, ok }
  function fileExists(id) {
    const t = Date.now();
    const seen = fileChecks.get(id);
    if (seen && t - seen.at < FILE_CHECK_MS) return seen.ok;
    let ok = fs.existsSync(chatFile(id));
    if (!ok) { pause(25); ok = fs.existsSync(chatFile(id)); }
    fileChecks.set(id, { at: t, ok });
    return ok;
  }

  // Newest first.
  function list() {
    const chats = readIndex().chats;
    // A title saved with a screen capture's markup in it (older chats) is made again from the chat's first real text, once,
    // for display; the saved chat is untouched, and a rename always wins.
    for (const c of chats) {
      if (c.renamed || cleanSaved(c.title) === c.title) continue;
      let fresh = '';
      try { fresh = autoTitle(load(c.id)); } catch { /* unreadable: the cleaned saved title below */ }
      c.title = fresh && fresh !== 'New chat' ? fresh : cleanSaved(c.title) || 'Screen capture';
    }
    return chats.map((c) => (fileExists(c.id) ? c : { ...c, missing: true })).sort((a, b) => b.updated - a.updated);
  }

  // A listed chat is read from disk, and on Windows a file that was just written or replaced can be unreadable for a
  // moment (a virus scanner or indexer holds it: EBUSY/EPERM/EACCES, or ENOENT while a rename replaces it). One failed
  // read must not become "Could not open this chat", so those are tried again briefly. A file that stays unreadable
  // shows the error but keeps its History entry (see load()).
  const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
  const READ_TRIES = 4;
  const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: retry at once */ } };
  function load(id) {
    if (!ID_RE.test(String(id)) || !readIndex().chats.some((c) => c.id === id)) return null;
    for (let attempt = 1; ; attempt++) {
      try { return readEnc(chatFile(id)); } catch (err) {
        if (!TRANSIENT.has(err?.code)) return null; // damaged or undecryptable: retrying will not help
        if (attempt < READ_TRIES) { pause(20 * attempt); continue; }
        // Still unreadable: say so, but keep the entry. Something outside Lumen (a scanner, a sync client) may hand the
        // file back later, and dropping the entry from the index would orphan a chat that still exists.
        return null;
      }
    }
  }

  // Is the chat in the history list (whether or not its file can be read right now)?
  const has = (id) => ID_RE.test(String(id)) && readIndex().chats.some((c) => c.id === id);

  // Writes the chat and its index entry. Returns false when nothing could be kept (no keychain).
  function save(id, snapshot) {
    if (!ID_RE.test(String(id))) throw new Error('bad chat id');
    if (!available()) return false;
    if (!snapshot?.messages?.length) return true; // an empty chat is not worth a list entry
    const idx = readIndex();
    if (idx.degraded) return false; // the index can't be read right now: leave everything on disk as it is
    writeAtomic(chatFile(id), snapshot);
    fileChecks.delete(id);
    let entry = idx.chats.find((c) => c.id === id);
    if (!entry) {
      entry = { id, title: '', renamed: false, created: now() };
      idx.chats.push(entry);
    }
    if (!entry.renamed) entry.title = autoTitle(snapshot);
    entry.updated = now();
    entry.model = snapshot.settings?.model || null;
    entry.usage = snapshot.settings?.usage || null;
    prune(idx);
    writeIndex();
    return true;
  }

  // Oldest chats past the limit go (never the open one, never one another writer's index lists), a few per save at most,
  // and only once the index on disk has been read again: if it can't be, nothing is deleted this time.
  function prune(idx) {
    if (idx.chats.length <= limit) return;
    if (!syncFromDisk(idx)) return;
    const keep = new Set([...idx.chats].sort((a, b) => b.updated - a.updated).slice(0, limit).map((c) => c.id));
    if (idx.current) keep.add(idx.current);
    for (const id of foreign) keep.add(id);
    const doomed = idx.chats.filter((c) => !keep.has(c.id)).sort((a, b) => a.updated - b.updated).slice(0, MAX_PRUNE);
    for (const c of doomed) fs.rmSync(chatFile(c.id), { force: true });
    const gone = new Set(doomed.map((c) => c.id));
    idx.chats = idx.chats.filter((c) => !gone.has(c.id));
  }

  function rename(id, title) {
    const entry = readIndex().chats.find((c) => c.id === id);
    const clean = cleanTitle(title);
    if (!entry || !clean) return false;
    entry.title = clean;
    entry.renamed = true;
    writeIndex();
    return true;
  }

  function remove(id) {
    const idx = readIndex();
    if (!idx.chats.some((c) => c.id === id)) return false;
    idx.chats = idx.chats.filter((c) => c.id !== id);
    if (idx.current === id) idx.current = null;
    fs.rmSync(chatFile(id), { force: true }); // (one file: the chat the user deleted)
    fileChecks.delete(id);
    writeIndex();
    return true;
  }

  function current() { return readIndex().current; }
  function setCurrent(id) {
    readIndex().current = ID_RE.test(String(id)) ? id : null;
    writeIndex();
  }

  // The one chat Lumen kept before there was a history list (chat.json) becomes its first entry.
  function migrate() {
    if (!legacyFile || !fs.existsSync(legacyFile)) return null;
    let snapshot = null;
    try { snapshot = readEnc(legacyFile); } catch { /* can't be decrypted here: drop it, as before */ }
    let id = null;
    if (available() && snapshot?.messages?.length) {
      id = newId();
      save(id, snapshot);
      setCurrent(id);
    }
    fs.rmSync(legacyFile, { force: true });
    return id;
  }

  // The keychain is not available: stop keeping chats, but never delete what is on disk. (This used to remove the whole
  // folder. "Not available" is also what Electron answers before the app is ready, and a second copy of Lumen, or a
  // development run, on the same profile quits in that state: it wiped every chat of the running one.) The chats already
  // on disk stay, unreadable until the keychain is back; save() refuses while it is not.
  function clearAll() {
    index = null; // forgotten in memory only; read again from disk when needed
    known.clear(); foreign.clear(); fileChecks.clear();
  }

  return { list, has, load, save, rename, remove, current, setCurrent, migrate, newId, clearAll };
}

// A chat as Markdown, for Export chat. `items` is transcriptFor()'s output.
// `pictureFile(picture)`: where an exported picture lies relative to the .md (null: only named).
function toMarkdown({ title, created, model, usageLine }, items, { pictureFile = null } = {}) {
  const lines = [`# ${cleanTitle(title) || 'Chat'}`, ''];
  const meta = [];
  if (created) meta.push(new Date(created).toISOString().slice(0, 16).replace('T', ' '));
  if (model) meta.push(`Model: ${model}`);
  if (usageLine) meta.push(`Usage: ${usageLine}`);
  if (meta.length) lines.push(`_${meta.join(' · ')}_`, '');
  for (const item of items) {
    lines.push(item.role === 'user' ? '## You' : '## Assistant', '');
    if (item.role === 'assistant' && item.steps) lines.push(`_Used ${item.steps} browser action${item.steps === 1 ? '' : 's'}_`, '');
    if (item.images?.length) lines.push(`_${item.images.length} image${item.images.length === 1 ? '' : 's'} attached (not included)_`, '');
    if (item.text) lines.push(item.role === 'assistant' ? plainScripts(item.text) : item.text, '');
    for (const picture of item.generated || []) {
      const file = pictureFile ? pictureFile(picture) : null;
      const alt = String(picture.alt || 'Generated picture').replace(/[[\]\n]/g, ' ').slice(0, 200);
      lines.push(file ? `![${alt}](${file})` : `_Picture: ${alt} (not included)_`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = { createChatStore, autoTitle, toMarkdown, cleanTitle };

// Saved AI chats: the sidebar's history list. Each chat is one file in <userData>/chats/, plus an
// index (titles, dates, usage totals, which chat is open). Everything on disk is encrypted the same
// way the single chat.json was (the OS keychain, through `encrypt`/`decrypt`); with no keychain,
// nothing is kept at all. What goes into a chat file is decided by the caller (main.js strips tool
// results and attached page text first).
//
// Nothing falls off the end of the list: past `limit` active chats the oldest unpinned ones are ARCHIVED (still saved, listed
// under Archived, searchable), never deleted. Chats can be pinned and archived; an entry's flags are plain optional fields
// (pinned, archived, autoArchived, trashed, msgs) that older index files simply don't have, so they load as they were.
// Deleting is two steps so it can be undone: trash() hides the chat (its file stays), remove() erases it.
// An empty chat (no messages yet) is never written, so New chat doesn't fill the list with blank entries.
//
// Chat files are only ever deleted one at a time, for a reason (the user deleted the chat and the undo time passed),
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

function createChatStore({ dir, encrypt, decrypt, available = () => true, limit = 500, legacyFile = null, now = () => Date.now() }) {
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
  const TRASH_KEEP_MS = 24 * 3600 * 1000; // a trashed chat nobody undid (the app quit inside the undo time) is erased after this
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
      if (Array.isArray(data.projects)) index.projects = data.projects.filter((p) => ID_RE.test(p?.id) && typeof p.name === 'string'); // (optional: older indexes have none)
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
    const chats = readIndex().chats.filter((c) => !c.trashed);
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
    if (!has(id)) return null;
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
  function has(id) { return ID_RE.test(String(id)) && readIndex().chats.some((c) => c.id === id && !c.trashed); }

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
    const isNew = !entry;
    if (!entry) {
      entry = { id, title: '', renamed: false, created: now() };
      idx.chats.push(entry);
    }
    if (!entry.renamed) entry.title = autoTitle(snapshot);
    // `updated` is the chat's last activity and the list's order. A save that changed nothing (leaving the chat, a research
    // pin, a setting) leaves it alone; new or changed messages move the chat to the top.
    const count = snapshot.messages.length;
    let size = 0; // (the messages' content, not their wrappers: a chat that went through restore() and snapshot() again must match)
    for (const m of snapshot.messages) size += JSON.stringify(m.content).length;
    const sig = `${count}:${size}`;
    // (an entry saved before `sig` existed is compared by message count only)
    if (isNew || (entry.sig === undefined ? entry.msgs !== count : entry.sig !== sig)) entry.updated = now();
    entry.sig = sig;
    entry.model = snapshot.settings?.model || null;
    entry.usage = snapshot.settings?.usage || null;
    // A chat that is used again (more messages than when it was archived) comes back to the main list.
    if (entry.archived && (entry.autoArchived || (entry.msgs !== undefined && count > entry.msgs))) { entry.archived = false; delete entry.autoArchived; }
    entry.msgs = count;
    delete entry.trashed; // (saved again: it was not deleted after all)
    archiveOverflow(idx, id);
    writeIndex();
    purgeExpiredTrash(idx);
    return true;
  }

  // Past `limit` active chats the oldest unpinned ones are archived (never deleted), except the open one, the one just saved
  // and chats another writer added. Only the index changes, so nothing on disk is at risk.
  function archiveOverflow(idx, savedId) {
    const active = idx.chats.filter((c) => !c.archived && !c.trashed);
    if (active.length <= limit) return;
    const candidates = active.filter((c) => !c.pinned && c.id !== idx.current && c.id !== savedId && !foreign.has(c.id)).sort((a, b) => a.updated - b.updated);
    for (const c of candidates.slice(0, active.length - limit)) { c.archived = true; c.autoArchived = true; }
  }
  // A chat trashed long ago (the app quit before its undo time ended) is erased for good, one file at a time, only with the
  // keychain up, and remove() re-reads the index on disk first.
  function purgeExpiredTrash(idx) {
    if (!available()) return;
    const old = idx.chats.filter((c) => c.trashed && now() - c.trashed > TRASH_KEEP_MS && !foreign.has(c.id)).map((c) => c.id);
    for (const id of old) remove(id);
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

  const entryOf = (id) => (ID_RE.test(String(id)) ? readIndex().chats.find((c) => c.id === id) : null);
  // Archive and pin change only the index. False for an unknown or trashed chat.
  function setFlag(id, key, on) {
    const entry = entryOf(id);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (on) entry[key] = true; else delete entry[key];
    delete entry.autoArchived; // (once the user chooses, it is theirs, no longer an automatic archive)
    writeIndex();
    return true;
  }
  // The chat is in use (a message was sent, a reply started): it moves to the top of the list now, before anything is saved.
  // Index only, and only for a chat that is already listed (a new chat is listed by its first save). True when it moved.
  function touch(id, at = now()) {
    const entry = entryOf(id);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (entry.updated >= at) return false;
    entry.updated = at;
    writeIndex();
    return true;
  }
  const setPinned = (id, on) => setFlag(id, 'pinned', Boolean(on));
  const setArchived = (id, on) => setFlag(id, 'archived', Boolean(on));

  // ---- projects: named groups of chats with instructions that go to the AI in each of their chats.
  // Only the index holds them: `projects` ([{ id, name, instructions, created }]) next to `chats`, and an optional `project` id on a
  // chat's entry. Older indexes have neither and load as they were. Removing a project only clears that field on its chats: no chat
  // or chat file is ever touched.
  const MAX_PROJECTS = 60;
  const MAX_NAME = 60;
  const MAX_INSTRUCTIONS = 4000;
  const cleanText = (text, max) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const projectList = () => readIndex().projects || [];
  const projects = () => projectList().map((p) => ({ ...p }));
  const projectById = (id) => projectList().find((p) => p.id === id) || null;
  // New project (no id) or an edit; null for an empty name, a full list, a degraded index or an unknown id.
  function saveProject({ id, name, instructions } = {}) {
    const idx = readIndex();
    const clean = cleanText(name, MAX_NAME).replace(/\s+/g, ' ');
    if (idx.degraded || !clean) return null;
    let project = id ? projectById(id) : null;
    if (id && !project) return null;
    if (!project) {
      if (projectList().length >= MAX_PROJECTS) return null;
      project = { id: newId(), name: clean, instructions: '', created: now() };
      (idx.projects ||= []).push(project);
    }
    project.name = clean;
    if (instructions !== undefined) project.instructions = cleanText(instructions, MAX_INSTRUCTIONS);
    writeIndex();
    return { ...project };
  }
  function removeProject(id) {
    const idx = readIndex();
    if (idx.degraded || !projectById(id)) return false;
    idx.projects = idx.projects.filter((p) => p.id !== id);
    if (!idx.projects.length) delete idx.projects;
    for (const c of idx.chats) if (c.project === id) delete c.project;
    writeIndex();
    return true;
  }
  // Put a chat in a project (null: out of any). False for an unknown chat or project.
  function setProject(chatId, projectId) {
    const entry = entryOf(chatId);
    if (!entry || entry.trashed || readIndex().degraded) return false;
    if (projectId) { if (!projectById(projectId)) return false; entry.project = projectId; } else delete entry.project;
    writeIndex();
    return true;
  }
  // The project a chat is in, or null (a chat whose project was removed, or an index that lost its projects, has none).
  const projectOf = (chatId) => { const entry = entryOf(chatId); return (entry?.project && projectById(entry.project)) || null; };

  // Delete with undo, step 1: the chat leaves the list (and Archived) but its file stays. restore() brings it back; remove()
  // (after the undo time) erases it.
  function trash(id) {
    const entry = entryOf(id);
    const idx = readIndex();
    if (!entry || idx.degraded || !available()) return false;
    entry.trashed = now();
    if (idx.current === id) idx.current = null;
    writeIndex();
    return true;
  }
  function restore(id) {
    const entry = entryOf(id);
    if (!entry?.trashed || readIndex().degraded) return false;
    delete entry.trashed;
    writeIndex();
    return true;
  }
  // Chats waiting out their undo time (also after a restart).
  const trashed = () => readIndex().chats.filter((c) => c.trashed).map((c) => ({ id: c.id, at: c.trashed }));

  // Every message of yours is saved with the context Lumen added around it (<browser_state>, a file list...): whole tagged blocks
  // come out first, so search sees what you typed (cleanSaved alone would cut the message at the first tag).
  const WRAPPED = /<([a-z]+_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>\s*/g;
  // What was said in a chat, for search (never tool results or attached page text), cut at a sane size.
  const SEARCH_CHARS = 200000;
  function textOf(snapshot) {
    const parts = [];
    let n = 0;
    for (const m of snapshot?.messages || []) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type !== 'text' || typeof b.text !== 'string') continue;
        const t = (m.role === 'user' ? cleanSaved(b.text.replace(WRAPPED, '')) : b.text).replace(/\s+/g, ' ').trim();
        if (!t) continue;
        parts.push(t);
        if ((n += t.length) > SEARCH_CHARS) return parts.join('\n').slice(0, SEARCH_CHARS);
      }
    }
    return parts.join('\n');
  }
  const textCache = new Map(); // id -> { updated, text }: a chat is read again only after it changed
  // Chats whose title or messages contain every word of the query: [{ id, snippet }] newest first (snippet: '' when the title matched).
  function search(query, { max = 100 } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return [];
    const out = [];
    for (const c of list()) {
      if (c.missing) continue;
      const title = String(c.title || '').toLowerCase();
      let body;
      const seen = textCache.get(c.id);
      if (seen && seen.updated === c.updated) body = seen.text;
      else {
        try { body = textOf(load(c.id)).toLowerCase(); } catch { body = ''; }
        textCache.set(c.id, { updated: c.updated, text: body });
      }
      if (!words.every((w) => title.includes(w) || body.includes(w))) continue;
      let snippet = '';
      if (!words.every((w) => title.includes(w))) {
        const word = words.find((w) => !title.includes(w));
        const at = Math.max(0, body.indexOf(word));
        snippet = (at > 30 ? '…' : '') + body.slice(Math.max(0, at - 30), at + 90).replace(/\n/g, ' ').trim() + (body.length > at + 90 ? '…' : '');
      }
      out.push({ id: c.id, snippet });
      if (out.length >= max) break;
    }
    return out;
  }

  // Erases a chat for good (one file: the chat the user deleted). The index on disk is read again first; if it can't be, nothing is erased.
  function remove(id) {
    const idx = readIndex();
    if (idx.degraded || !syncFromDisk(idx) || !idx.chats.some((c) => c.id === id)) return false;
    textCache.delete(id);
    idx.chats =idx.chats.filter((c) => c.id !== id);
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

  return { list, has, load, save, projects, saveProject, removeProject, setProject, projectOf, rename, remove, trash, restore, trashed, touch, setPinned, setArchived, search, current, setCurrent, migrate, newId, clearAll };
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

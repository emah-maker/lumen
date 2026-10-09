// Saved AI chats: the sidebar's history list. Each chat is one file in <userData>/chats/, plus an
// index (titles, dates, usage totals, which chat is open). Everything on disk is encrypted the same
// way the single chat.json was (the OS keychain, through `encrypt`/`decrypt`); with no keychain,
// nothing is kept at all. What goes into a chat file is decided by the caller (main.js strips tool
// results and attached page text first).
//
// The store keeps the newest `limit` chats; older ones are deleted as new ones are saved. An empty
// chat (no messages yet) is never written, so New chat doesn't fill the list with blank entries.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { plainScripts } = require('../renderer/markdown.js'); // <sub>/<sup> as clean text in exports

const TITLE_CHARS = 60;
const ID_RE = /^[a-f0-9]{16}$/;

// The first thing the user said, without the browser state, page text or handed-over history that
// Lumen adds to each message. Used as the chat's title until the user renames it.
function autoTitle(snapshot) {
  for (const m of snapshot?.messages || []) {
    if (m.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)
      .replace(/<browser_state>[\s\S]*?<\/browser_state>\s*/g, '')
      .replace(/<untrusted_page_content[\s\S]*?<\/untrusted_page_content>\s*/g, '')
      .replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/g, '') // [uploads] the names and refs of attached files
      .replace(/<earlier_conversation>[\s\S]*?<\/earlier_conversation>\s*/g, '')
      // A skill's message (features/skills.js) is titled by the skill and what was typed after it, not its prompt.
      .replace(/<skill_request name="[^"]*" title="([^"]*)" input="([^"]*)">[\s\S]*?<\/skill_request>\s*/g, (_m, title, input) => `${title}${input ? `: ${input}` : ''} `)).join(' ').replace(/\s+/g, ' ').trim();
    if (text && text !== 'The user attached the image(s) above without a message.' && text !== 'The user attached the file(s) listed below without a message.') {
      return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
    }
    if (blocks.some((b) => b.type === 'image')) return 'Image';
    if (blocks.some((b) => b.type === 'text' && /<attached_files>/.test(String(b.text)))) return 'File';
  }
  return 'New chat';
}

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
      return index;
    }
    // No index (never written, or just set aside as corrupt): rebuild it from the chat files.
    const { chats, unreadable } = rebuildIndex();
    if (!chats.length && unreadable) return { current: null, chats: [], degraded: true }; // chats exist but can't be read now: retry next call
    index = { current: null, chats };
    if (chats.length && available()) { try { writeAtomic(indexFile, index); } catch { /* retried on the next write */ } }
    return index;
  }
  const writeIndex = () => { const idx = readIndex(); if (!idx.degraded && available()) writeAtomic(indexFile, idx); };

  const newId = () => crypto.randomBytes(8).toString('hex');

  // Newest first.
  function list() {
    return [...readIndex().chats].sort((a, b) => b.updated - a.updated);
  }

  // A listed chat is read from disk, and on Windows a file that was just written or replaced can be unreadable for a
  // moment (a virus scanner or indexer holds it: EBUSY/EPERM/EACCES, or ENOENT while a rename replaces it). One failed
  // read must not become "Could not open this chat", so those are tried again briefly. A file that stays missing is gone
  // for good: its entry is dropped, so History stops offering a chat that can never open.
  const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
  const READ_TRIES = 4;
  const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: retry at once */ } };
  function load(id) {
    if (!ID_RE.test(String(id)) || !readIndex().chats.some((c) => c.id === id)) return null;
    for (let attempt = 1; ; attempt++) {
      try { return readEnc(chatFile(id)); } catch (err) {
        if (!TRANSIENT.has(err?.code)) return null; // damaged or undecryptable: retrying will not help
        if (attempt < READ_TRIES) { pause(20 * attempt); continue; }
        if (err.code === 'ENOENT') { // still missing after the retries: the entry points at nothing
          const idx = readIndex();
          if (!idx.degraded && idx.current !== id) { idx.chats = idx.chats.filter((c) => c.id !== id); try { writeIndex(); } catch { /* retried on the next write */ } }
        }
        return null;
      }
    }
  }

  // Writes the chat and its index entry. Returns false when nothing could be kept (no keychain).
  function save(id, snapshot) {
    if (!ID_RE.test(String(id))) throw new Error('bad chat id');
    if (!available()) return false;
    if (!snapshot?.messages?.length) return true; // an empty chat is not worth a list entry
    const idx = readIndex();
    if (idx.degraded) return false; // the index can't be read right now: leave everything on disk as it is
    writeAtomic(chatFile(id), snapshot);
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

  // Oldest chats past the limit go (never the open one).
  function prune(idx) {
    const keep = new Set([...idx.chats].sort((a, b) => b.updated - a.updated).slice(0, limit).map((c) => c.id));
    if (idx.current) keep.add(idx.current);
    for (const c of idx.chats.filter((c) => !keep.has(c.id))) fs.rmSync(chatFile(c.id), { force: true });
    idx.chats = idx.chats.filter((c) => keep.has(c.id));
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
    fs.rmSync(chatFile(id), { force: true });
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

  // Everything off disk (the keychain went away): same as the old chat.json behaviour.
  function clearAll() {
    fs.rmSync(dir, { recursive: true, force: true });
    index = { current: null, chats: [] };
  }

  return { list, load, save, rename, remove, current, setCurrent, migrate, newId, clearAll };
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

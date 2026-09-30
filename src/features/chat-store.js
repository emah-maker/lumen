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
      .replace(/<earlier_conversation>[\s\S]*?<\/earlier_conversation>\s*/g, '')
      // A skill's message (features/skills.js) is titled by the skill and what was typed after it, not its prompt.
      .replace(/<skill_request name="[^"]*" title="([^"]*)" input="([^"]*)">[\s\S]*?<\/skill_request>\s*/g, (_m, title, input) => `${title}${input ? `: ${input}` : ''} `)).join(' ').replace(/\s+/g, ' ').trim();
    if (text && text !== 'The user attached the image(s) above without a message.') {
      return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1).trimEnd()}…` : text;
    }
    if (blocks.some((b) => b.type === 'image')) return 'Image';
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
  function readIndex() {
    if (index) return index;
    try {
      const data = readEnc(indexFile);
      index = { current: ID_RE.test(data.current) ? data.current : null, chats: Array.isArray(data.chats) ? data.chats.filter((c) => ID_RE.test(c?.id)) : [] };
    } catch {
      index = { current: null, chats: [] }; // none yet, or it can't be decrypted on this machine
    }
    return index;
  }
  const writeIndex = () => { if (available()) writeAtomic(indexFile, readIndex()); };

  const newId = () => crypto.randomBytes(8).toString('hex');

  // Newest first.
  function list() {
    return [...readIndex().chats].sort((a, b) => b.updated - a.updated);
  }

  function load(id) {
    if (!ID_RE.test(String(id)) || !readIndex().chats.some((c) => c.id === id)) return null;
    try { return readEnc(chatFile(id)); } catch { return null; }
  }

  // Writes the chat and its index entry. Returns false when nothing could be kept (no keychain).
  function save(id, snapshot) {
    if (!ID_RE.test(String(id))) throw new Error('bad chat id');
    if (!available()) return false;
    if (!snapshot?.messages?.length) return true; // an empty chat is not worth a list entry
    writeAtomic(chatFile(id), snapshot);
    const idx = readIndex();
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
function toMarkdown({ title, created, model, usageLine }, items) {
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
    if (item.text) lines.push(item.text, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = { createChatStore, autoTitle, toMarkdown, cleanTitle };

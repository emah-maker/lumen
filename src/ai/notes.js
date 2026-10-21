// Quick notes: a small notepad kept on this computer (sidebar → More → Notes), and the `notes` tool the AI reads and appends with.
// Electron-free, so test/units/notes-units.js runs it in plain Node; main.js gives it the profile folder.
//
// One file, notes.json: { v: 1, current, notes: [{ id, text, created, updated }] }. A note is plain text (Markdown is drawn by the panel);
// its title is its first line. Every change is written to a temporary file and renamed over the real one, so a crash or a power cut never
// leaves a half-written file. A file that can't be read is set aside as notes.json.bad-<time> and the notepad starts empty; it is never
// written over. Pictures a note holds (a generated image) are files in notes-media/ named by their content, written as
// ![alt](note-image:<name>) in the text; files no note mentions any more are removed the next time the notepad is opened.
//
// The AI may only add to a note (append, create) or read; it never edits, replaces or deletes what the user wrote.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_NOTES = 500;
const MAX_TEXT = 400000; // characters in one note
const MAX_APPEND = 250000; // one add
const MAX_IMAGE = 8 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{8}$/;
const IMAGE_RE = /^[a-f0-9]{16}\.(?:png|jpg|gif|webp)$/;
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(note-image:([a-f0-9]{16}\.(?:png|jpg|gif|webp))\)\s*$/;
const MEDIA_KEEP_MS = 24 * 3600 * 1000; // an unreferenced picture is kept this long (an undone delete, a note just edited)

// Text a note keeps: no control characters but tab and newline, one kind of line end, cut to a size.
const clean = (text, max = MAX_TEXT) => String(text ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .slice(0, max);

// "# Heading" or the first line: what the list shows.
function titleOf(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|```\w*\s*)/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
    if (line) return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  }
  return '';
}

// A few words either side of the first match, on one line.
function snippetOf(text, words) {
  const flat = String(text).replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ');
  const low = flat.toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(w); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return flat.slice(0, 100);
  const from = Math.max(0, at - 30);
  return `${from ? '…' : ''}${flat.slice(from, from + 110)}${from + 110 < flat.length ? '…' : ''}`;
}
const wordsOf = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

// The text the editor sent (`local`), the text it started from (`base`) and what is stored now (`stored`): when something added to the
// end of the note meanwhile (the AI, "Add to notes"), keep both. Any other disagreement: the editor wins.
function mergeAppended(base, local, stored) {
  if (typeof base !== 'string' || stored === base || stored === local) return { text: local, merged: false };
  if (stored.startsWith(base) && !local.endsWith(stored.slice(base.length))) return { text: local + stored.slice(base.length), merged: true };
  return { text: local, merged: false };
}

function createNotesStore({ file, mediaDir = path.join(path.dirname(file), 'notes-media'), now = () => Date.now(), newId = () => crypto.randomBytes(4).toString('hex') }) {
  let data = null; // { current, notes }
  let swept = false;

  function load() {
    if (data) return data;
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    data = { current: null, notes: [] };
    if (raw === null) return data;
    try {
      const j = JSON.parse(raw);
      const seen = new Set();
      data.notes = (Array.isArray(j.notes) ? j.notes : []).filter((n) => n && ID_RE.test(n.id) && typeof n.text === 'string' && !seen.has(n.id) && seen.add(n.id)).slice(0, MAX_NOTES)
        .map((n) => ({ id: n.id, text: clean(n.text), created: Number(n.created) || 0, updated: Number(n.updated) || Number(n.created) || 0 }));
      data.current = data.notes.some((n) => n.id === j.current) ? j.current : null;
    } catch {
      try { fs.renameSync(file, `${file}.bad-${now()}`); } catch { /* kept where it is */ }
    }
    return data;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, current: data.current, notes: data.notes }));
    fs.renameSync(tmp, file); // never a half-written file
  }
  const find = (id) => load().notes.find((n) => n.id === id) || null;
  const view = (n) => ({ id: n.id, text: n.text, title: titleOf(n.text), created: n.created, updated: n.updated });
  const row = (n, extra = {}) => ({ id: n.id, title: titleOf(n.text) || '', preview: snippetOf(n.text, []).slice(0, 100), created: n.created, updated: n.updated, chars: n.text.length, ...extra });
  const uniqueId = () => { for (let i = 0; i < 20; i++) { const id = newId(); if (!find(id)) return id; } throw new Error('Could not make an id.'); };

  function list(query = '') {
    const words = wordsOf(query);
    const out = [];
    for (const n of [...load().notes].sort((a, b) => b.updated - a.updated)) {
      if (words.length) {
        const hay = n.text.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        out.push(row(n, { preview: snippetOf(n.text, words), match: true }));
      } else out.push(row(n));
    }
    return out;
  }
  const get = (id) => { const n = find(id); return n ? view(n) : null; };
  const current = () => { const n = find(load().current); return n ? view(n) : null; };
  function select(id) {
    load();
    if (id !== null && !find(id)) return false;
    if (data.current !== id) { data.current = id; save(); }
    return true;
  }

  function create(text = '') {
    load();
    if (data.notes.length >= MAX_NOTES) throw new Error(`The notepad holds ${MAX_NOTES} notes. Delete some first.`);
    const t = now();
    const n = { id: uniqueId(), text: clean(text), created: t, updated: t };
    data.notes.push(n);
    data.current = n.id;
    save();
    return view(n);
  }
  // base: the text the editor loaded this note with (see mergeAppended). Returns { note, merged } or null.
  function update(id, text, base) {
    const n = find(id);
    if (!n) return null;
    const m = mergeAppended(base, clean(text), n.text);
    const next = m.text.slice(0, MAX_TEXT);
    if (next !== n.text) { n.text = next; n.updated = now(); }
    data.current = n.id;
    save();
    return { note: view(n), merged: m.merged };
  }
  // Add `text` at the end of a note (a blank line between); no id: the open note, or a new one when there is none (or it is full).
  function append(id, text) {
    const add = clean(text, MAX_APPEND).trim();
    if (!add) throw new Error('Nothing to add.');
    let n = id ? find(id) : find(load().current);
    if (id && !n) throw new Error('No note with that id.');
    if (!n || n.text.length + add.length + 2 > MAX_TEXT) return { note: create(add), created: true };
    n.text = n.text.trim() ? `${n.text.replace(/\s+$/, '')}\n\n${add}` : add;
    n.updated = now();
    data.current = n.id;
    save();
    return { note: view(n), created: false };
  }
  function remove(id) {
    const n = find(id);
    if (!n) return null;
    data.notes = data.notes.filter((x) => x !== n);
    if (data.current === id) data.current = null;
    save();
    return { ...n };
  }
  // Put back a note remove() returned (Undo).
  function restore(n) {
    load();
    if (!n || !ID_RE.test(n.id) || typeof n.text !== 'string' || find(n.id) || data.notes.length >= MAX_NOTES) return false;
    data.notes.push({ id: n.id, text: clean(n.text), created: Number(n.created) || now(), updated: Number(n.updated) || now() });
    save();
    return true;
  }

  // ---- pictures
  function addImage(bytes, alt = '') {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buf.length || buf.length > MAX_IMAGE) throw new Error('That picture is too large or empty.');
    const ext = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
      : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(0, 3).toString('latin1') === 'GIF' ? 'gif'
      : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : '';
    if (!ext) throw new Error('Not a picture Lumen can keep (PNG, JPEG, GIF or WebP).');
    const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
    fs.mkdirSync(mediaDir, { recursive: true });
    const target = path.join(mediaDir, name);
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
    }
    return { name, markdown: `![${String(alt || 'Picture').replace(/[[\]\n]/g, ' ').trim().slice(0, 120)}](note-image:${name})` };
  }
  function image(name) {
    if (!IMAGE_RE.test(String(name))) return null;
    try { return { bytes: fs.readFileSync(path.join(mediaDir, name)), type: { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[name.split('.')[1]] }; } catch { return null; }
  }
  // Remove pictures no note mentions, once per run (a day's grace for an undone delete).
  function sweep() {
    if (swept) return 0;
    swept = true;
    let names;
    try { names = fs.readdirSync(mediaDir); } catch { return 0; }
    const used = new Set();
    for (const n of load().notes) for (const m of n.text.matchAll(/note-image:([a-f0-9]{16}\.\w+)/g)) used.add(m[1]);
    let removed = 0;
    for (const name of names) {
      if (used.has(name) || !IMAGE_RE.test(name)) continue;
      try { if (Date.now() - fs.statSync(path.join(mediaDir, name)).mtimeMs > MEDIA_KEEP_MS) { fs.unlinkSync(path.join(mediaDir, name)); removed++; } } catch { /* leave it */ }
    }
    return removed;
  }

  return { list, get, current, select, create, update, append, remove, restore, addImage, image, sweep, count: () => load().notes.length };
}

// ---- the `notes` tool
// ctx: { store, changed(note) }. Short answers: the model pays for every word.
function runTool(input, ctx) {
  const { store } = ctx;
  const action = String(input?.action || '');
  const text = typeof input?.text === 'string' ? input.text : '';
  const short = (rows) => rows.slice(0, 25).map((r) => ({ id: r.id, title: r.title, updated: new Date(r.updated).toISOString().slice(0, 10), ...(r.match ? { match: r.preview } : {}) }));
  if (action === 'list') return { notes: short(store.list()), total: store.count() };
  if (action === 'search') {
    if (!String(input?.query || '').trim()) throw new Error('search needs a query.');
    return { notes: short(store.list(String(input.query))) };
  }
  if (action === 'read') {
    const n = input?.id ? store.get(String(input.id)) : store.current();
    if (!n) throw new Error(input?.id ? 'No note with that id.' : 'No note is open. Use list.');
    return { id: n.id, title: n.title, text: n.text.length > 20000 ? `${n.text.slice(0, 20000)}\n[cut: ${n.text.length - 20000} more characters]` : n.text };
  }
  if (action === 'append' || action === 'create') {
    if (!text.trim()) throw new Error(`${action} needs text.`);
    const r = action === 'create' ? { note: store.create(clean(text, MAX_APPEND)), created: true } : store.append(input?.id ? String(input.id) : null, text);
    try { ctx.changed?.(r.note); } catch { /* the panel is cosmetic */ }
    return { ok: true, id: r.note.id, title: r.note.title, created: r.created };
  }
  throw new Error('Unknown notes action. Use list, search, read, append or create.');
}
const stepLabel = (input) => ({ list: 'Looking at your notes', search: 'Searching your notes', read: 'Reading a note', append: 'Adding to your notes', create: 'Writing a new note' }[input?.action] || 'Using your notes');

module.exports = { createNotesStore, runTool, stepLabel, titleOf, snippetOf, mergeAppended, clean, IMAGE_LINE, MAX_TEXT, MAX_NOTES, MAX_APPEND };

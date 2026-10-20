// Project files (lumen://chat > Projects): documents the user adds to a project, kept as text in the profile so the AI can search and read
// them in every chat of the project. Loaded when a project's files are first used (add, list, read, the index in a chat), never at startup.
//
//   extract(name, bytes)           -> { kind, text } | { kind: 'image', image: { mime, data } } ; throws Error with a plain message
//   createProjectFilesStore(deps)  the store: { list, add, remove, removeProject, readText, readImage, totals, exportProject, importFile, ... }
//
// What is kept: for each project a folder <profile>/project-files/<project id>/ with index.json (names, sizes, summaries) and one file per
// document holding its extracted text (a picture: its bytes). Every file is encrypted the way saved chats are (the system keychain), so
// with no keychain nothing is kept. The original document is NOT copied. Nothing here touches the network: the text reaches an AI provider
// only when the AI reads a file in a chat, as part of what that provider receives for that message (PRIVACY.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../ai/project-context');

const MAX_FILES = 40; // per project
const MAX_TEXT_CHARS = 1500000; // one file's text; the rest is cut and the file says so
const MAX_TOTAL_CHARS = 12000000; // all of a project's text
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 60 * 1024 * 1024; // a file larger than this is refused before it is read
const SYNC_FILE_CHARS = 400000; // a file's text over this stays on this computer (it is not synced)
const ID_RE = /^[a-f0-9]{16}$/;
const FILE_ID_RE = /^[a-f0-9]{12}$/;

const KINDS = [
  [/\.pdf$/i, 'pdf'], [/\.docx$/i, 'docx'], [/\.pptx$/i, 'pptx'], [/\.eml$/i, 'eml'],
  [/\.(png|jpe?g|gif|webp)$/i, 'image'],
  [/\.(txt|md|markdown|csv|tsv|json|log|xml|yaml|yml|html?|rtf|tex|bib|py|js|ts|java|c|cpp|h|cs|go|rs|rb|sql|ini|toml)$/i, 'text'],
];
const kindOf = (name) => (KINDS.find(([re]) => re.test(String(name || ''))) || [null, ''])[1];
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const SUPPORTED_TEXT = 'PDF, Word (.docx), PowerPoint (.pptx), saved email (.eml), text, Markdown, CSV and pictures';

const cleanName = (name) => String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 120) || 'file';
const cutText = (text) => String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT_CHARS);

// ---- reading a file's bytes with Lumen's own readers (the ones the AI's read_pdf, decks and Word files use)
async function extract(name, bytes) {
  const kind = kindOf(name);
  if (!kind) throw new Error(`Lumen can't read this kind of file yet. Add ${SUPPORTED_TEXT}.`);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length) throw new Error('This file is empty.');
  if (buf.length > MAX_INPUT_BYTES) throw new Error(`This file is too large (over ${Math.round(MAX_INPUT_BYTES / 1048576)} MB).`);
  if (kind === 'image') {
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('This picture is too large (over 4 MB).');
    const ext = String(name).split('.').pop().toLowerCase();
    return { kind, image: { mime: IMAGE_MIME[ext] || 'image/png', data: buf.toString('base64') } };
  }
  if (kind === 'pdf') {
    const pdf = require('./pdf-text');
    let pages;
    try { pages = pdf.extractPages(buf); } catch (err) { throw new Error(String(err?.message || 'This PDF could not be read.').slice(0, 200)); }
    const text = pages.map((p, i) => `--- Page ${i + 1} of ${pages.length} ---\n${p}`).join('\n\n');
    if (!pages.some((p) => p.trim())) throw new Error('This PDF has no text Lumen can read (a scan or pictures only).');
    return { kind, text: cutText(text) };
  }
  if (kind === 'docx') return { kind, text: cutText(await require('./docx-text').docxText(buf, { maxChars: MAX_TEXT_CHARS })) };
  if (kind === 'pptx') {
    const slides = await require('./pptx').extractSlideTexts(buf);
    return { kind, text: cutText(slides.map((s, i) => `--- Slide ${i + 1} of ${slides.length} ---\n${s}`).join('\n\n')) };
  }
  if (kind === 'eml') {
    const eml = require('./eml');
    const parsed = await eml.parse(buf);
    return { kind, text: cutText(eml.toText(parsed, { limit: MAX_TEXT_CHARS })) };
  }
  // text: UTF-8 (a BOM dropped); a file full of control characters is binary and refused
  const head = buf.subarray(0, 4096);
  let odd = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd++;
  if (odd > head.length * 0.05) throw new Error('This file does not look like text.');
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/\.html?$/i.test(name)) text = require('./eml').htmlToText(text);
  return { kind: 'text', text: cutText(text) };
}

const newFileId = () => crypto.randomBytes(6).toString('hex');

// deps: { dir, encrypt(text) -> string, decrypt(string) -> text, available() -> boolean, now() }
function createProjectFilesStore({ dir, encrypt, decrypt, available = () => true, now = () => Date.now() }) {
  const metas = new Map(); // project id -> [meta] (cached after the first read)
  const unreadable = new Set(); // projects whose index could not be read: never written over

  const folder = (pid) => { if (!ID_RE.test(String(pid))) throw new Error('Unknown project.'); return path.join(dir, pid); };
  const fileOf = (pid, id) => { if (!FILE_ID_RE.test(String(id))) throw new Error('Unknown file.'); return path.join(folder(pid), `${id}.dat`); };

  function readIndex(pid) {
    if (metas.has(pid)) return metas.get(pid);
    let list = [];
    try {
      const outer = JSON.parse(fs.readFileSync(path.join(folder(pid), 'index.json'), 'utf8'));
      const data = JSON.parse(decrypt(outer.enc));
      list = (Array.isArray(data.files) ? data.files : []).filter((m) => m && FILE_ID_RE.test(m.id) && typeof m.name === 'string').map((m) => ({
        id: m.id, name: cleanName(m.name), kind: m.kind || kindOf(m.name) || 'text', size: Number(m.size) || 0, chars: Number(m.chars) || 0,
        summary: String(m.summary || '').slice(0, 200), added: Number(m.added) || 0, ...(m.cut ? { cut: true } : {}), ...(m.synced ? { synced: true } : {}),
      }));
    } catch (err) {
      if (err?.code !== 'ENOENT') unreadable.add(pid);
    }
    metas.set(pid, list);
    return list;
  }
  async function writeIndex(pid) {
    if (unreadable.has(pid)) throw new Error('This project\'s files can\'t be read on this computer right now, so they can\'t be changed.');
    if (!available()) throw new Error('Project files need your system\'s secure storage (the keychain), which isn\'t available.');
    await fs.promises.mkdir(folder(pid), { recursive: true });
    const file = path.join(folder(pid), 'index.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ enc: encrypt(JSON.stringify({ files: metas.get(pid) || [] })) }));
    await fs.promises.rename(tmp, file);
  }
  const writeBlob = async (pid, id, value) => {
    if (!available()) throw new Error('Project files need your system\'s secure storage (the keychain), which isn\'t available.');
    await fs.promises.mkdir(folder(pid), { recursive: true });
    const file = fileOf(pid, id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ enc: encrypt(JSON.stringify(value)) }));
    await fs.promises.rename(tmp, file);
  };
  const readBlob = async (pid, id) => JSON.parse(decrypt(JSON.parse(await fs.promises.readFile(fileOf(pid, id), 'utf8')).enc));

  const copy = (m) => ({ ...m });
  const list = (pid) => (ID_RE.test(String(pid)) ? readIndex(pid).map(copy) : []);
  const totals = (pid) => { const l = list(pid); return { files: l.length, chars: l.reduce((n, m) => n + (m.chars || 0), 0), bytes: l.reduce((n, m) => n + (m.size || 0), 0) }; };

  // One file in: { name, bytes } or an already read { name, kind, text, size } (a synced file). -> { ok: true, file } | { ok: false, error }
  async function add(pid, input) {
    const name = cleanName(input?.name);
    try {
      const metaList = readIndex(pid);
      if (metaList.length >= MAX_FILES) return { ok: false, name, error: `A project holds up to ${MAX_FILES} files.` };
      const got = input.text !== undefined || input.image ? { kind: input.kind || kindOf(name) || 'text', text: input.text !== undefined ? cutText(input.text) : undefined, image: input.image } : await extract(name, input.bytes);
      const size = Number(input.size) || (input.bytes ? input.bytes.length : 0);
      if (got.kind === 'image') {
        if (metaList.filter((m) => m.kind === 'image').length >= MAX_IMAGES) return { ok: false, name, error: `A project holds up to ${MAX_IMAGES} pictures.` };
      } else {
        const used = metaList.reduce((n, m) => n + (m.chars || 0), 0);
        if (used + got.text.length > MAX_TOTAL_CHARS) return { ok: false, name, error: 'This project\'s files hold as much text as it can keep. Remove one first.' };
        if (!got.text.trim()) return { ok: false, name, error: 'No text was found in this file.' };
      }
      // the same name again replaces the old one (a newer copy of the same document)
      const same = FILE_ID_RE.test(String(input.id)) ? metaList.find((m) => m.id === input.id) : metaList.find((m) => m.name.toLowerCase() === name.toLowerCase());
      const id = same ? same.id : FILE_ID_RE.test(String(input.id)) ? input.id : newFileId();
      const meta = { id, name, kind: got.kind, size, chars: got.text ? got.text.length : 0, summary: got.text ? ctx.summarize(got.text) : '', added: Number(input.added) > 0 ? Math.round(Number(input.added)) : now(), ...(got.text && got.text.length >= MAX_TEXT_CHARS ? { cut: true } : {}) };
      await writeBlob(pid, id, got.kind === 'image' ? { image: got.image } : { text: got.text });
      if (same) metaList.splice(metaList.indexOf(same), 1);
      metaList.push(meta);
      try { await writeIndex(pid); } catch (err) { metaList.pop(); if (same) metaList.push(same); throw err; }
      return { ok: true, file: copy(meta), replaced: Boolean(same) };
    } catch (err) {
      return { ok: false, name, error: String(err?.message || err).slice(0, 240) };
    }
  }
  async function remove(pid, id) {
    const metaList = readIndex(pid);
    const at = metaList.findIndex((m) => m.id === id);
    if (at < 0) return false;
    const [meta] = metaList.splice(at, 1);
    try { await writeIndex(pid); } catch (err) { metaList.splice(at, 0, meta); throw err; }
    await fs.promises.rm(fileOf(pid, id), { force: true }).catch(() => {});
    return true;
  }
  async function readText(pid, id) {
    const data = await readBlob(pid, id);
    return typeof data.text === 'string' ? data.text : '';
  }
  async function readImage(pid, id) {
    const data = await readBlob(pid, id);
    return data.image?.data ? { mime: data.image.mime, data: data.image.data } : null;
  }
  // Every text of a project, for a search: [{ id, name, text }]
  async function texts(pid) {
    const out = [];
    for (const m of readIndex(pid)) { if (m.kind === 'image') continue; try { out.push({ id: m.id, name: m.name, text: await readText(pid, m.id) }); } catch { /* skipped */ } }
    return out;
  }
  // A whole project's files go (the project was deleted and its Undo time is over).
  async function removeProject(pid) {
    metas.delete(pid);
    unreadable.delete(pid);
    await fs.promises.rm(folder(pid), { recursive: true, force: true }).catch(() => {});
  }
  // Folders of projects that no longer exist (a crash before a delete finished): removed. `known` = every project id.
  async function purgeOrphans(known) {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { return 0; }
    let n = 0;
    for (const name of names) if (ID_RE.test(name) && !known.has(name)) { await removeProject(name); n++; }
    return n;
  }
  const forget = (pid) => { metas.delete(pid); unreadable.delete(pid); }; // read again next time (the folder changed elsewhere)
  async function setSynced(pid, id, on) { const m = readIndex(pid).find((x) => x.id === id); if (m) { if (on) m.synced = true; else delete m.synced; await writeIndex(pid); } }

  return { list, add, remove, readText, readImage, texts, removeProject, purgeOrphans, totals, forget, setSynced, get unreadableProjects() { return [...unreadable]; } };
}

module.exports = { extract, kindOf, cleanName, createProjectFilesStore, SUPPORTED_TEXT, MAX_FILES, MAX_TEXT_CHARS, MAX_TOTAL_CHARS, MAX_IMAGES, MAX_INPUT_BYTES, SYNC_FILE_CHARS };

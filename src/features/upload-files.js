// Uploading files for the user: the AI puts files into a web page's file field (an <input type=file>, a
// "Choose file" button, a drop zone) with the upload_file tool. Everything about WHICH files may be used is
// decided here, and none of it comes from the model:
//
//   - A file the user attached in the composer (paperclip, drop or paste) is kept in a per-chat folder
//     (<userData>/uploads/<chat>/<ref>/<name>) and named to the model by an opaque ref ("f_" + 24 hex
//     digits). The model passes refs back; a ref that is not in THIS chat's folder is refused. A path, a
//     file:// address or any other string is never a file: there is no way to name a file on disk.
//   - A file the user has not attached is asked for with a card whose "Choose file…" button opens the OS
//     picker (main.js agent:upload-choose): the user picks, the model only learns the name.
//
// Attached files wait in uploads/pending/ until the message is sent (they then move into the chat's folder)
// or the user removes them. Each file is capped at MAX_FILE_BYTES. A chat's files go when the chat is deleted;
// folders of chats that are gone, and old pending files, are swept at start-up.
//
// Also here, as pure functions so test/upload-files-units.js runs them in plain Node: matching a file against an
// input's `accept`, the single-file rule, what the model is told about attached files, and the element-finding
// logic that runs in the page (resolveUploadTarget).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_FILES_PER_CHAT = 60;
const MAX_UPLOAD_FILES = 10; // one upload_file call
const REF_RE = /^f_[0-9a-f]{24}$/;
const CHAT_RE = /^[a-f0-9]{16}$/;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class UploadError extends Error {}

// ---- names and types
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A name safe as a file name on every system, keeping its extension. The page sees this name.
function cleanName(raw) {
  let name = String(raw ?? '').normalize('NFC').split(/[\\/]/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (RESERVED.test(name.replace(/\..*$/, ''))) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', rtf: 'application/rtf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dot: 'application/msword',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};
const extOf = (name) => (path.extname(String(name || '')).slice(1) || '').toLowerCase();
const mimeOf = (name) => MIME_BY_EXT[extOf(name)] || '';
// The type to use for a file: what the browser reported if it is a plain type, else what the extension says.
const typeOf = (name, reported) => (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(reported || '')) ? String(reported).toLowerCase() : mimeOf(name) || 'application/octet-stream');

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ---- a ref is an opaque id, nothing else
const isRef = (value) => typeof value === 'string' && REF_RE.test(value);

// ---- accept / multiple
// The tokens of an input's accept attribute: ".pdf", "image/*", "application/pdf" (lower case; empty: anything).
function parseAccept(accept) {
  return String(accept ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function acceptMatches(accept, { name = '', type = '' } = {}) {
  const tokens = parseAccept(accept);
  if (!tokens.length) return true;
  const lower = String(name).toLowerCase();
  const mime = String(type || mimeOf(name)).toLowerCase();
  return tokens.some((tok) => {
    if (tok.startsWith('.')) return lower.endsWith(tok);
    if (tok.endsWith('/*')) return mime.startsWith(tok.slice(0, -1));
    if (tok.includes('/')) return mime === tok;
    return false;
  });
}
// "PDF, PNG images" for the cards and messages.
function describeAccept(accept) {
  const tokens = parseAccept(accept);
  if (!tokens.length) return '';
  return tokens.slice(0, 6).map((tok) => (tok.startsWith('.') ? tok.slice(1).toUpperCase() : tok.endsWith('/*') ? `${tok.slice(0, -2)} files` : tok)).join(', ') + (tokens.length > 6 ? ', …' : '');
}
// null when `files` may go into a field with these properties, else the reason (plain words, for the model).
function checkFiles({ accept = '', multiple = false } = {}, files = []) {
  if (!files.length) return 'No file was given.';
  if (files.length > MAX_UPLOAD_FILES) return `At most ${MAX_UPLOAD_FILES} files can be uploaded at once.`;
  if (!multiple && files.length > 1) return `This field takes a single file, and ${files.length} were given. Upload one file per field.`;
  const bad = files.filter((f) => !acceptMatches(accept, f));
  if (bad.length) return `${bad.map((f) => `"${f.name}"`).join(', ')} ${bad.length === 1 ? "isn't" : "aren't"} a type this field accepts (${describeAccept(accept) || accept}). Pick a matching file, or ask the user for one.`;
  return null;
}

// ---- what the model is told about the files a message carries
const FILES_BLOCK = /<attached_files>[\s\S]*?<\/attached_files>\s*/g;
// The message text when files came with no words (saved chats show it as no text).
const FILES_ONLY_TEXT = 'The user attached the file(s) listed below without a message.';
function filesNote(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => isRef(f?.ref));
  if (!list.length) return '';
  // (a name can't close the block: "<" is written as \u003c, which JSON.parse reads back as it was)
  const lines = list.map((f) => `- ${JSON.stringify({ ref: f.ref, name: String(f.name || '').slice(0, 120), type: String(f.type || ''), size: Number(f.size) || 0 }).replace(/</g, '\\u003c')}`);
  return `<attached_files>\nThe user attached these files to this message. You cannot see their contents. To put one into a web page's file upload (an input, a "Choose file" button, a drop zone) call upload_file with its ref in files; that is the only way a file is chosen, and the user sees the names and the site first.\n${lines.join('\n')}\n</attached_files>`;
}
// The files named in the blocks of a text (a saved chat shows them as chips): [{ ref, name, type, size }].
function parseFilesBlock(text) {
  const out = [];
  for (const block of String(text || '').match(FILES_BLOCK) || []) {
    for (const line of block.split('\n')) {
      const m = /^- (\{.*\})$/.exec(line.trim());
      if (!m) continue;
      try {
        const f = JSON.parse(m[1]);
        if (isRef(f.ref)) out.push({ ref: f.ref, name: String(f.name || ''), type: String(f.type || ''), size: Number(f.size) || 0 });
      } catch { /* a damaged line is left out */ }
    }
  }
  return out;
}

// ---- the store
// dir: <userData>/uploads. Files are named as the user's own (the page sees the name), one folder per ref.
function createUploadStore({ dir, now = () => Date.now() } = {}) {
  const pendingDir = path.join(dir, 'pending');
  const chatDir = (chatId) => {
    if (!CHAT_RE.test(String(chatId))) throw new UploadError('There is no chat to keep files for.');
    return path.join(dir, 'chats', String(chatId));
  };
  const newRef = () => `f_${crypto.randomBytes(12).toString('hex')}`;
  const readMeta = (folder) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
      if (path.basename(String(meta.name)) !== meta.name) return null;
      const file = path.join(folder, meta.name);
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      return { name: meta.name, type: meta.type, size: stat.size, path: file };
    } catch { return null; }
  };
  const writeMeta = (folder, meta) => fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ name: meta.name, type: meta.type }));

  // The bytes of a file the user attached (a Buffer): kept as pending until the message is sent. -> { ref, name, type, size }
  function stash({ name, type, data }) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!buffer.length) throw new UploadError(`${cleanName(name)} is empty.`);
    if (buffer.length > MAX_FILE_BYTES) throw new UploadError(`${cleanName(name)} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
    const ref = newRef();
    const clean = cleanName(name);
    const folder = path.join(pendingDir, ref);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, clean), buffer);
    const meta = { name: clean, type: typeOf(clean, type) };
    writeMeta(folder, meta);
    return { ref, name: clean, type: meta.type, size: buffer.length };
  }

  // The user took the chip off before sending.
  function discard(ref) {
    if (!isRef(ref)) return false;
    try { fs.rmSync(path.join(pendingDir, ref), { recursive: true, force: true }); return true; } catch { return false; }
  }

  // Files of a message that is being sent move into its chat's folder. Only refs that are pending are moved;
  // anything else is ignored. -> [{ ref, name, type, size }] (what the model is told about)
  function adopt(chatId, refs) {
    const folderOfChat = chatDir(chatId);
    const have = fs.existsSync(folderOfChat) ? fs.readdirSync(folderOfChat).length : 0;
    const out = [];
    for (const ref of [...new Set(Array.isArray(refs) ? refs : [])].filter(isRef).slice(0, MAX_FILES_PER_MESSAGE)) {
      if (have + out.length >= MAX_FILES_PER_CHAT) break;
      const from = path.join(pendingDir, ref);
      const meta = readMeta(from);
      if (!meta) { // a file this chat already holds (a message asked again): told to the AI again
        const held = readMeta(path.join(folderOfChat, ref));
        if (held) out.push({ ref, name: held.name, type: held.type, size: held.size });
        continue;
      }
      try {
        fs.mkdirSync(folderOfChat, { recursive: true });
        fs.renameSync(from, path.join(folderOfChat, ref));
        out.push({ ref, name: meta.name, type: meta.type, size: meta.size });
      } catch { /* a file that could not be moved is left out */ }
    }
    return out;
  }

  // Files of chat `chatId` by ref. Throws an UploadError (said to the model) for a ref that is not this chat's.
  function resolve(chatId, refs) {
    const list = Array.isArray(refs) ? refs : [];
    const out = [];
    for (const ref of list) {
      if (!isRef(ref)) throw new UploadError(`"${String(ref).slice(0, 60)}" is not a file ref. upload_file only takes the refs of files the user attached to this chat (listed in the message as <attached_files>). A path or address cannot be used. If the user has not attached the file, call upload_file without files and they will be asked to choose one.`);
      let meta = null;
      try { meta = readMeta(path.join(chatDir(chatId), ref)); } catch { /* no chat: no files */ }
      if (!meta) throw new UploadError(`No attached file has the ref ${ref} in this chat. Call upload_file without files and the user will be asked to choose one.`);
      out.push({ ref, name: meta.name, type: meta.type, size: meta.size, path: meta.path });
    }
    return out;
  }

  function list(chatId) {
    let folders;
    try { folders = fs.readdirSync(chatDir(chatId)).filter(isRef); } catch { return []; }
    return folders.flatMap((ref) => { const meta = readMeta(path.join(chatDir(chatId), ref)); return meta ? [{ ref, name: meta.name, type: meta.type, size: meta.size }] : []; });
  }

  function removeChat(chatId) {
    try { fs.rmSync(chatDir(chatId), { recursive: true, force: true }); } catch { /* nothing kept */ }
  }

  // Start-up: pending files older than a day, and folders of chats that no longer exist. `keep`: the ids of chats that do.
  function sweep(keep) {
    const cutoff = now() - PENDING_MAX_AGE_MS;
    try {
      for (const name of fs.readdirSync(pendingDir)) {
        const p = path.join(pendingDir, name);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone already */ }
      }
    } catch { /* no pending folder */ }
    if (!(keep instanceof Set) || !keep.size) return; // (never from an empty list: a history that could not be read must not cost every chat its files)
    try {
      for (const name of fs.readdirSync(path.join(dir, 'chats'))) {
        if (!keep.has(name)) fs.rmSync(path.join(dir, 'chats', name), { recursive: true, force: true });
      }
    } catch { /* no chat folders */ }
  }

  return { stash, discard, adopt, resolve, list, removeChat, sweep, dir };
}

// The OS picker's file-type filters for an input's accept (the extensions it names), plus "All files" so the user is
// never stuck: a pick that does not match is refused with a message on the card (pickUpload). -> [{ name, extensions }]
function dialogFilters(accept, allLabel = 'All files') {
  const exts = new Set();
  for (const tok of parseAccept(accept)) {
    if (tok.startsWith('.')) exts.add(tok.slice(1));
    else for (const [ext, mime] of Object.entries(MIME_BY_EXT)) if (tok.endsWith('/*') ? mime.startsWith(tok.slice(0, -1)) : mime === tok) exts.add(ext);
  }
  const out = [];
  if (exts.size) out.push({ name: describeAccept(accept) || 'Files', extensions: [...exts].filter((e) => /^[a-z0-9]+$/.test(e)) });
  out.push({ name: allLabel, extensions: ['*'] });
  return out;
}

// A file the user picked with the OS picker (a path from the dialog, never from the model): checked, not copied.
// -> { name, type, size, path } or throws an UploadError.
function describePicked(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw new UploadError('That file could not be read.'); }
  if (!stat.isFile()) throw new UploadError('That is not a file.');
  if (!stat.size) throw new UploadError(`${path.basename(file)} is empty.`);
  if (stat.size > MAX_FILE_BYTES) throw new UploadError(`${path.basename(file)} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
  const name = path.basename(file);
  return { name, type: mimeOf(name) || 'application/octet-stream', size: stat.size, path: file };
}

// ---- finding the field, in the page
// Runs in the page (stringified into a script: it must not use anything outside itself). `el`: the element the
// model named. Returns { input, how }: how is 'input' (the element itself), 'label' (a label's control),
// 'inside' (the one file input inside it), 'aria' (aria-controls), 'nearby' (the one file input in the
// closest container that has one) or 'click' (none found: the click should open the page's file chooser,
// which is then answered). input is the file input, or null for 'click'. { ambiguous: true } says several
// candidates were passed over.
function resolveUploadTarget(el) {
  const isFile = (n) => Boolean(n) && n.tagName === 'INPUT' && String(n.type).toLowerCase() === 'file';
  const filesIn = (root) => (root && root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll('input[type=file]')) : []);
  if (isFile(el)) return { input: el, how: 'input' };
  const owner = el.tagName === 'LABEL' ? el : el.closest ? el.closest('label') : null;
  if (owner && isFile(owner.control)) return { input: owner.control, how: 'label' };
  const inside = filesIn(el);
  if (inside.length === 1) return { input: inside[0], how: 'inside' };
  let ambiguous = inside.length > 1;
  const controls = (el.getAttribute && el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
  const doc = el.ownerDocument;
  for (const id of controls) {
    const target = doc && doc.getElementById(id);
    if (isFile(target)) return { input: target, how: 'aria' };
    const within = filesIn(target);
    if (within.length === 1) return { input: within[0], how: 'aria' };
  }
  let node = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  for (let depth = 0; node && depth < 8; depth++) {
    const found = filesIn(node);
    if (found.length === 1) return { input: found[0], how: 'nearby' };
    if (found.length > 1) { ambiguous = true; break; }
    if (node.tagName === 'FORM' || node.tagName === 'BODY') break;
    node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
  }
  return ambiguous ? { input: null, how: 'click', ambiguous: true } : { input: null, how: 'click' };
}

module.exports = {
  MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_FILES_PER_CHAT, MAX_UPLOAD_FILES, REF_RE, UploadError, FILES_BLOCK, FILES_ONLY_TEXT,
  cleanName, mimeOf, typeOf, sizeText, isRef, parseAccept, acceptMatches, describeAccept, checkFiles, dialogFilters,
  filesNote, parseFilesBlock, createUploadStore, describePicked, resolveUploadTarget,
};

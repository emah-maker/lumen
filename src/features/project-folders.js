// Project folders: a chat project (features/chat-store.js) can have a real folder on disk, its chats can be mirrored there as Markdown
// files, and a folder can be the place the AI works in (a project's, or one picked for a single chat).
//
//   safeFolderName(name)            a name Windows (and every other system) accepts as one folder name
//   uniqueName(base, taken)         "Name", then "Name (2)", "Name (3)" ... for whatever `taken(name)` says exists
//   createProjectFolder({...})      makes <parent>/<safe name> (a suffix on a collision), async
//   chatFileName(title, created)    "YYYY-MM-DD <title>.md"
//   chatDocument(meta, markdown)    the Markdown file's text: a front matter header with the Lumen chat id, then the export
//   frontMatterId(text)             the chat id a mirrored file's header names (how a renamed chat's old file is found)
//   isInside(root, target)          async, realpath-based: false for `..` and for a symlink that leaves `root`
//   checkWorkFolder(dir, opts)      async: { ok, real } or { ok: false, reason } (missing, not a folder, a drive root, the home folder)
//   workFolderOf(settings)          the chat's own folder, else its project's, else ''
//   createDebouncer(fn, ms)         keyed trailing debounce (the Markdown writes: about 2 s after the last change)
//   createMirror(deps)              the writer: write / moveOut / trash / writeAll, all async (fs.promises), temp file then rename
//
// Nothing in here is synchronous file work: the app's main thread must never wait on these folders (they can be on a network drive or a
// synced folder that is slow). The mirror writes plain, UNENCRYPTED files: only for chats in a project that has a folder, never for
// any other chat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

// One folder or file name: invalid characters gone, no trailing dot or space, never a reserved device name (CON, NUL, COM1 ...).
function safeFolderName(name, { max = 80, fallback = 'Project' } = {}) {
  let n = String(name ?? '').replace(INVALID, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (n.length > max) n = n.slice(0, max).replace(/[. ]+$/, '');
  if (!n) return fallback;
  if (RESERVED.test(n.split('.')[0])) n = `_${n}`; // "CON" and "con.txt" both name the device
  return n;
}

// `taken(name)` -> boolean (or a promise of one).
async function uniqueName(base, taken) {
  if (!(await taken(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base} (${i})`;
    if (!(await taken(name))) return name;
  }
  return `${base} (${crypto.randomBytes(3).toString('hex')})`;
}

const exists = async (p) => { try { await fs.promises.lstat(p); return true; } catch { return false; } };

// Makes the folder for a new project. A name already taken gets " (2)". mkdir (not recursive) is the claim, so two projects made at the
// same moment never share a folder. Returns the absolute path.
async function createProjectFolder({ parent, name }) {
  await fs.promises.mkdir(parent, { recursive: true });
  const base = safeFolderName(name);
  for (let attempt = 0; attempt < 50; attempt++) {
    const pick = await uniqueName(base, (n) => exists(path.join(parent, n)));
    const dir = path.join(parent, pick);
    try { await fs.promises.mkdir(dir); return dir; } catch (err) { if (err?.code !== 'EEXIST') throw err; }
  }
  throw new Error('Could not find a free folder name.');
}

const dayOf = (ms) => { const d = new Date(Number.isFinite(ms) ? ms : Date.now()); return d.toISOString().slice(0, 10); };

// "2026-10-14 Chat title.md" (the day the chat was created, so the folder sorts by time; the title is made safe and cut short).
function chatFileName(title, created) {
  return `${dayOf(created)} ${safeFolderName(title, { max: 80, fallback: 'Chat' })}.md`;
}

const yamlString = (s) => JSON.stringify(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')); // (JSON strings are valid YAML)
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

function chatDocument({ id, title, created, updated, model }, markdown) {
  const head = ['---', `title: ${yamlString(title)}`, `created: ${iso(created)}`, `updated: ${iso(updated)}`, `model: ${yamlString(model || '')}`, `lumen_chat_id: ${id}`, '---', ''];
  return `${head.join('\n')}\n${markdown}`;
}

// The chat id in a mirrored file's front matter (the first lines only), or null.
function frontMatterId(text) {
  const t = String(text ?? '');
  if (!t.startsWith('---')) return null;
  const end = t.indexOf('\n---', 3);
  const head = end < 0 ? t.slice(0, 600) : t.slice(0, end);
  const m = /^lumen_chat_id:\s*([a-f0-9]{16})\s*$/m.exec(head);
  return m ? m[1] : null;
}

const norm = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));
const within = (root, target) => {
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The real path of `p`, or of its deepest existing ancestor joined with the rest (a file about to be created).
async function realOrAncestor(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(await fs.promises.realpath(cur), ...rest.reverse()); } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const up = path.dirname(cur);
      if (up === cur) throw err;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  throw new Error('path too deep');
}

// Is `target` inside `root` once links are followed? `..` and a symlink (or junction) pointing out both fail. A target that does not exist
// yet is judged by its deepest existing ancestor.
async function isInside(root, target) {
  try {
    const realRoot = await fs.promises.realpath(root);
    const realTarget = await realOrAncestor(path.resolve(root, String(target)));
    return within(realRoot, realTarget);
  } catch { return false; }
}

// May `dir` be the folder the AI works in? Never a drive root or the home folder without an explicit `confirmed`.
async function checkWorkFolder(dir, { home = os.homedir(), confirmed = false } = {}) {
  const raw = String(dir ?? '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw) || /^[\\/]{2}/.test(raw)) return { ok: false, reason: 'invalid' };
  let real;
  try { real = await fs.promises.realpath(raw); } catch { return { ok: false, reason: 'missing' }; }
  let stat;
  try { stat = await fs.promises.stat(real); } catch { return { ok: false, reason: 'missing' }; }
  if (!stat.isDirectory()) return { ok: false, reason: 'not-folder' };
  if (path.parse(real).root === real) return confirmed ? { ok: true, real } : { ok: false, reason: 'root', real };
  let realHome = home;
  try { realHome = await fs.promises.realpath(home); } catch { /* the home folder as named */ }
  if (norm(path.resolve(real)) === norm(path.resolve(realHome)) || norm(path.resolve(raw)) === norm(path.resolve(home))) return confirmed ? { ok: true, real } : { ok: false, reason: 'home', real };
  return { ok: true, real };
}

// A path as the composer shows it: the home folder as ~, and a long one cut in the middle ("C:Usersme…ProjectNotes").
function shortPath(p, { home = os.homedir(), max = 42 } = {}) {
  let t = String(p ?? '');
  const rel = home ? path.relative(home, t) : '';
  if (home && t && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) t = `~${path.sep}${rel}`;
  if (t.length <= max) return t;
  const parts = t.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return `…${t.slice(-(max - 1))}`;
  const tail = parts.slice(-2).join(path.sep);
  const head = /^[A-Za-z]:/.test(parts[0]) || t.startsWith('~') ? parts[0] : '';
  return `${head ? head + path.sep : ''}…${path.sep}${tail}`;
}

// The folder the AI works in for a chat: the one picked for the chat, else its project's working folder, else nothing.
function workFolderOf(settings) {
  const chat = typeof settings?.workFolder === 'string' ? settings.workFolder.trim() : '';
  if (chat) return chat;
  return typeof settings?.projectWorkFolder === 'string' ? settings.projectWorkFolder.trim() : '';
}

// Keyed trailing debounce: schedule(key) runs fn(key) `ms` after the last schedule(key). flush() runs what is pending at once (quitting).
function createDebouncer(fn, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map();
  const fire = (key) => { timers.delete(key); return fn(key); };
  return {
    schedule(key) {
      clearTimer(timers.get(key));
      const t = setTimer(() => { fire(key); }, ms);
      t?.unref?.();
      timers.set(key, t);
    },
    cancel(key) { clearTimer(timers.get(key)); timers.delete(key); },
    pending: () => [...timers.keys()],
    async flush() { const keys = [...timers.keys()]; for (const k of keys) { clearTimer(timers.get(k)); await fire(k); } },
  };
}

const CHATS = 'Chats';
const yieldTurn = () => new Promise((r) => setImmediate(r));

// The Markdown mirror of a project's chats.
//   render(id)        -> { id, title, created, updated, model, markdown } | null (nothing to write yet). May read the chat, so it is kept short.
//   folderOf(id)      -> the folder a chat's file belongs in now (its project's, mirroring on), or '' (none)
//   onError(err)      -> optional
// Files live in <folder>/Chats/<YYYY-MM-DD title>.md. Renaming a chat renames its file (found by the chat id in the header, or by the
// map of what this session wrote); a chat moved out of the project goes to Chats/Removed/, a deleted one to Chats/Deleted/: no file is
// ever deleted. Every write is a temp file renamed over the target.
function createMirror({ render, folderOf, onError = () => {}, fsp = fs.promises }) {
  // folderOf(id, force): `force` writes even where the project's toggle is off (the "Write all now" button)
  const where = new Map(); // chat id -> { folder, file } as last written
  const digests = new Map(); // chat id -> hash of the last text written there
  const scans = new Map(); // folder -> Promise<Map id -> file>: one look at what is already in Chats/ per session

  const chatsDir = (folder) => path.join(folder, CHATS);
  async function readHead(file) {
    let fh;
    try { fh = await fsp.open(file, 'r'); const buf = Buffer.alloc(700); const { bytesRead } = await fh.read(buf, 0, 700, 0); return buf.toString('utf8', 0, bytesRead); } catch { return ''; } finally { await fh?.close().catch(() => {}); }
  }
  function scan(folder) {
    if (!scans.has(folder)) {
      scans.set(folder, (async () => {
        const map = new Map();
        const names = await fsp.readdir(chatsDir(folder)).catch(() => null);
        if (!names) return map;
        for (const n of names) {
          if (!n.toLowerCase().endsWith('.md')) continue;
          const id = frontMatterId(await readHead(path.join(chatsDir(folder), n)));
          if (id) map.set(id, path.join(chatsDir(folder), n));
        }
        return map;
      })());
    }
    return scans.get(folder);
  }
  // The existing file of a chat in a folder, or null.
  async function locate(folder, id) {
    const known = where.get(id);
    if (known && norm(known.folder) === norm(folder) && await exists(known.file)) return known.file;
    const found = (await scan(folder)).get(id);
    return found && await exists(found) ? found : null;
  }
  const remember = async (folder, id, file) => { where.set(id, { folder, file }); (await scan(folder)).set(id, file); };

  // A path in `dir` for `name` that no other chat's file uses.
  async function freePath(dir, name, id, folder) {
    const base = name.replace(/\.md$/i, '');
    return path.join(dir, `${await uniqueName(base, async (n) => {
      const p = path.join(dir, `${n}.md`);
      if (!(await exists(p))) return false;
      const owner = frontMatterId(await readHead(p));
      return owner !== id; // (a file that is this chat's own is not "taken")
    })}.md`);
  }

  async function writeText(file, text) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try { await fsp.writeFile(tmp, text, 'utf8'); await fsp.rename(tmp, file); } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
  }

  // Moves a chat's file in `folder` into Chats/<sub>/ (never deletes). True when there was a file.
  async function shelve(folder, id, sub) {
    const file = await locate(folder, id);
    if (!file) return false;
    const dir = path.join(chatsDir(folder), sub);
    await fsp.mkdir(dir, { recursive: true });
    const dest = await freePath(dir, path.basename(file), id, folder);
    await fsp.rename(file, dest);
    (await scan(folder)).delete(id);
    if (where.get(id)?.folder === folder) where.delete(id);
    digests.delete(id);
    return true;
  }

  // Writes (or updates, or renames) the chat's file in the folder it belongs in now. A chat that was last written to another folder is
  // moved out of that one first. Returns 'written' | 'same' | 'skipped'.
  async function write(id, { from = null, force = false } = {}) {
    try {
      const folder = folderOf(id, force) || '';
      const previous = where.get(id)?.folder;
      for (const old of new Set([previous, from].filter((f) => f && (!folder || norm(f) !== norm(folder))))) await shelve(old, id, 'Removed');
      if (!folder) return 'skipped';
      const doc = await render(id);
      if (!doc) return 'skipped';
      const text = chatDocument(doc, doc.markdown);
      const digest = crypto.createHash('sha1').update(text).digest('base64');
      const dir = chatsDir(folder);
      await fsp.mkdir(dir, { recursive: true });
      const old = await locate(folder, id);
      const wanted = chatFileName(doc.title, doc.created);
      let target = old && path.basename(old) === wanted ? old : null;
      if (old && !target) {
        // The title changed: the file follows it (a collision gets a suffix, as a new file would).
        target = await freePath(dir, wanted, id, folder);
        if (norm(target) !== norm(old)) { try { await fsp.rename(old, target); (await scan(folder)).delete(id); } catch { target = old; } } else target = old;
      }
      if (!target) target = await freePath(dir, wanted, id, folder);
      if (old && target === old && digests.get(id) === digest) return 'same';
      await writeText(target, text);
      digests.set(id, digest);
      await remember(folder, id, target);
      return 'written';
    } catch (err) { onError(err); return 'skipped'; }
  }

  // A chat that left its project: its file goes to Chats/Removed/ in `folder`.
  const moveOut = (folder, id) => shelve(folder, id, 'Removed').catch((err) => { onError(err); return false; });
  // A deleted chat: its file goes to Chats/Deleted/.
  const trash = (folder, id) => shelve(folder, id, 'Deleted').catch((err) => { onError(err); return false; });

  // Every chat of a project (ids), one after another with the main thread free in between. Returns how many files were written or current.
  async function writeAll(ids, { force = false } = {}) {
    let n = 0;
    for (const id of ids) {
      const r = await write(id, { force });
      if (r !== 'skipped') n++;
      await yieldTurn();
    }
    return n;
  }
  // The folder moved on disk (a renamed project): what was learnt about it is forgotten.
  const forgetFolder = (folder) => { scans.delete(folder); for (const [id, w] of [...where]) if (norm(w.folder) === norm(folder)) { where.delete(id); digests.delete(id); } };

  return { write, moveOut, trash, writeAll, forgetFolder, locate, _where: where };
}

module.exports = { shortPath, safeFolderName, uniqueName, createProjectFolder, chatFileName, chatDocument, frontMatterId, isInside, checkWorkFolder, workFolderOf, createDebouncer, createMirror, within, CHATS };

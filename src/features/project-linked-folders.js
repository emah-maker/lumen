// [linked folders] Folders a project points the AI at, as Sources: a folder on this computer, or a Google Drive folder. Kept on the project
// (`folders`, features/chat-store.js); listed in the project's context block; the AI lists and reads a local one with the project_files
// tool (folder_list, folder_read: only inside the folder the user linked, never a hidden file, never through a link out of it, read with
// Lumen's own readers), and a Drive one with the Drive connector (its files action with the folder's id). Nothing is copied or changed:
// the folder stays the user's. Unit-tested in test/units/project-linked-folders-units.js (temp folders).
'use strict';

const fs = require('fs');
const path = require('path');

const MAX = 12;
const MAX_LIST = 200;
const MAX_DEPTH = 6; // how deep a path inside the folder may go
const DRIVE_FOLDER = /\/folders\/([A-Za-z0-9_-]{10,100})/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const line = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => require('crypto').randomBytes(5).toString('hex');

// A Drive folder's id from its address (drive.google.com/drive/folders/<id>, with /u/0/ or ?usp=…) or a bare id; '' when it is neither.
const driveFolderId = (v) => (DRIVE_FOLDER.exec(String(v ?? '')) || /^\s*([A-Za-z0-9_-]{10,100})\s*$/.exec(String(v ?? '')) || [])[1] || ''; // (the same length either way: a list cleaned twice keeps it)

// The list as the store keeps it: { id, kind: 'local', path, name } | { id, kind: 'drive', driveId, name }, no repeats, at most MAX.
function clean(list) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object') continue;
    const id = /^[a-f0-9]{6,16}$/.test(String(f.id)) ? String(f.id) : newId();
    if (f.kind === 'drive') {
      const driveId = driveFolderId(f.driveId);
      if (!driveId || seen.has(`d:${driveId}`)) continue;
      seen.add(`d:${driveId}`);
      out.push({ id, kind: 'drive', driveId, name: line(f.name, 120) || 'Drive folder' });
    } else {
      const p = String(f.path ?? '').replace(CONTROL, '').trim().slice(0, 1000);
      if (!p || !path.isAbsolute(p) || seen.has(`l:${p.toLowerCase()}`)) continue;
      seen.add(`l:${p.toLowerCase()}`);
      out.push({ id, kind: 'local', path: p, name: line(f.name, 120) || path.basename(p) || p });
    }
    if (out.length >= MAX) break;
  }
  return out;
}

// For the context block: one line per folder and how to use it.
function index(folders) {
  const list = clean(folders);
  if (!list.length) return '';
  const rows = list.map((f, i) => (f.kind === 'drive' ? `${i + 1}. ${f.name} (Google Drive folder ${f.driveId}: connector drive files folder_id ${f.driveId}, then read)` : `${i + 1}. ${f.name} (folder on this computer: project_files folder_list / folder_read with folder ${i + 1})`));
  return `Folders linked to this project (the user's own; read them, never change them):\n${rows.join('\n')}`;
}

// The linked folder a call means: its number (1-based, as in the index), its name, or its id. Local folders only for listing and reading.
function pick(folders, which) {
  const list = clean(folders);
  const w = String(which ?? '').trim();
  if (!w) return list.filter((f) => f.kind === 'local').length === 1 ? list.find((f) => f.kind === 'local') : null;
  if (/^\d+$/.test(w)) return list[Number(w) - 1] || null;
  const low = w.toLowerCase();
  return list.find((f) => f.id === w || f.name.toLowerCase() === low) || list.find((f) => f.name.toLowerCase().includes(low)) || null;
}

// A path inside a linked folder, made safe: relative, no "..", no hidden part, at most MAX_DEPTH deep, and (once real) still inside the
// folder's real path. -> { ok, full, rel } | { ok: false, error }
async function inside(folder, rel, fsp = fs.promises) {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..' || x.startsWith('.'))) return { ok: false, error: 'Only files inside the linked folder, and never hidden ones.' };
  if (parts.length > MAX_DEPTH) return { ok: false, error: 'That path is too deep.' };
  let root;
  try { root = await fsp.realpath(folder.path); } catch { return { ok: false, error: `The folder ${folder.name} isn’t there any more (${folder.path}).` }; }
  const full = path.join(root, ...parts);
  let real;
  try { real = await fsp.realpath(full); } catch { return { ok: false, error: `Nothing called ${parts.join('/') || '(the folder)'} in ${folder.name}.` }; }
  const r = path.relative(root, real);
  if (r.startsWith('..') || path.isAbsolute(r)) return { ok: false, error: 'That points outside the linked folder.' };
  return { ok: true, full: real, rel: parts.join('/') };
}

// folder_list: what is in the folder (or a sub-folder), folders first, then files newest first; `match` a name filter ("*.docx", "résumé").
async function list(folder, { sub = '', match = '', limit = 60 } = {}, fsp = fs.promises) {
  const at = await inside(folder, sub, fsp);
  if (!at.ok) throw new Error(at.error);
  let entries;
  try { entries = await fsp.readdir(at.full, { withFileTypes: true }); } catch { throw new Error(`${at.rel || folder.name} is not a folder.`); }
  const want = String(match ?? '').trim().toLowerCase();
  const re = want.includes('*') ? new RegExp(`^${want.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i') : null;
  const ok = (name) => !name.startsWith('.') && !name.startsWith('~$') && (!want || (re ? re.test(name) : name.toLowerCase().includes(want)));
  const dirs = [];
  const files = [];
  for (const e of entries.slice(0, 5000)) {
    if (!ok(e.name)) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) { let st = null; try { st = await fsp.stat(path.join(at.full, e.name)); } catch { /* gone */ } files.push({ name: e.name, size: st?.size || 0, mtime: st?.mtimeMs || 0 }); }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const max = Math.max(1, Math.min(MAX_LIST, Number(limit) || 60));
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const rows = [...dirs.sort().map((d) => `${d}/`), ...files.map((f) => `${f.name}  (${kb(f.size)}, ${f.mtime ? new Date(f.mtime).toISOString().slice(0, 10) : '?'})`)];
  const where = at.rel ? `${folder.name}/${at.rel}` : folder.name;
  if (!rows.length) return `${where} is empty${want ? ` (nothing matches ${JSON.stringify(want)})` : ''}.`;
  return `${where}:\n${rows.slice(0, max).join('\n')}${rows.length > max ? `\n(${rows.length - max} more)` : ''}\nRead a file with folder_read (folder, path: its path inside the folder).`;
}

// folder_read: one file's text with Lumen's readers (features/project-files.js extract: PDF, Word, PowerPoint, email, text). -> { name, text }
async function read(folder, rel, { extract, maxBytes = 30 * 1024 * 1024 } = {}, fsp = fs.promises) {
  if (!String(rel ?? '').trim()) throw new Error('folder_read needs path: the file inside the folder (folder_list shows them).');
  const at = await inside(folder, rel, fsp);
  if (!at.ok) throw new Error(at.error);
  const st = await fsp.stat(at.full);
  if (!st.isFile()) throw new Error(`${at.rel} is a folder: list it with folder_list.`);
  if (st.size > maxBytes) throw new Error(`${at.rel} is too large to read (over ${Math.round(maxBytes / 1048576)} MB).`);
  const got = await extract(path.basename(at.full), await fsp.readFile(at.full));
  if (got.image) throw new Error(`${at.rel} is a picture; open it in a tab to look at it.`);
  return { name: at.rel, text: got.text || '' };
}

module.exports = { MAX, clean, index, pick, inside, list, read, driveFolderId };

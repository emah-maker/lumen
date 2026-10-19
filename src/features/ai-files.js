// Files the AI makes for the user, shown in the chat as a file card (renderer/ai-files.js) instead of "open it in a browser".
// Lumen is the browser, so a page, picture or PDF the AI wrote is shown here: a live preview for HTML and SVG, a thumbnail
// for a picture, one click to the PDF viewer, and Open / Show in folder / Copy path for anything else.
//
//   findPaths(text, opts)        absolute file paths a reply names (backticks, quotes, <...>, markdown links, file:// addresses,
//                                bare Windows and POSIX paths, ~/ paths), possibly with spaces; not checked against the disk
//   resolveFiles(paths, opts)    the ones that are existing regular files: [{ path (real), name, dir, ext, kind, size, mtimeMs }]
//                                (folders, missing files, network (\\server), device and alternate-stream paths are dropped)
//   cardOf(file, trusted)        what the renderer is told: { id, name, dir, path, ext, kind, size, trusted, previewable }
//   createRegistry()             id -> file, filled only by cards Lumen itself sent. The IPC (main.js files:*) acts on ids, never on
//                                a path the renderer or a page supplies. A "trusted" card is a file the AI wrote in this chat
//                                (its own Write/Edit result, or written during the run): it may preview and auto-open. Any other
//                                file a reply names gets a card without a preview, and Open asks first (the local-files rules of #340).
//   previewOf(entry)             { kind: 'html' | 'svg', text } | { kind: 'image', dataUrl } for a trusted card, else null
//   pickMain(files)              the one file of a reply worth opening on its own (a page, picture or PDF the AI wrote)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { sniff, fromFileUrl } = require('./gen-images');

const KINDS = {
  html: ['html', 'htm', 'xhtml'],
  svg: ['svg'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  pdf: ['pdf'],
};
const KIND_OF = new Map();
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) KIND_OF.set(e, kind);
// What Chromium shows in a tab by itself: pages, pictures, PDFs (Lumen's viewer), plain text and code.
const TAB_EXTS = new Set([...KIND_OF.keys(), 'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'yaml', 'yml', 'toml', 'bmp', 'ico', 'avif', 'pptx']);
// Never handed to the system's "open": it would run them.
const RUNS_CODE = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'msp', 'scr', 'pif', 'lnk', 'url', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'wsf', 'wsh', 'js', 'jse', 'hta', 'jar', 'reg', 'cpl', 'dll', 'sh', 'bash', 'command', 'app', 'dmg', 'appimage', 'deb', 'rpm', 'apk', 'inf', 'gadget', 'application', 'chm']);

const PREVIEW_MAX = 2 * 1024 * 1024; // the canvas's own limit (renderer/chat-canvas.js)
const IMAGE_MAX = 8 * 1024 * 1024;
const MAX_FILES = 4; // cards per reply
const MAX_CANDIDATES = 24;

const extOf = (file) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(file)); return m ? m[1].toLowerCase() : ''; };
const kindOf = (ext) => KIND_OF.get(String(ext || '').toLowerCase()) || 'file';
const canOpenInTab = (ext) => TAB_EXTS.has(String(ext || '').toLowerCase());
const canOpenInSystem = (ext) => !RUNS_CODE.has(String(ext || '').toLowerCase());

// ---- finding paths in text
const EXT = '[A-Za-z0-9]{1,8}';
const ROOT = '(?:[A-Za-z]:[\\\\/]|/|~[\\\\/])';
const END = '(?![A-Za-z0-9_\\\\/])'; // the extension ends the name: "C:\a.b\c.html" is not "C:\a.b"
const FILE_URL = /file:\/\/[^\s"'<>`)\]|*?]+/gi;
const QUOTED = new RegExp(`([\`"'])(${ROOT}[^\`"'\\n<>|*?]*?\\.${EXT})\\1`, 'g');
const ANGLE = new RegExp(`<(${ROOT}[^<>\\n|*?]*?\\.${EXT})>`, 'g');
const LINK = new RegExp(`\\]\\(\\s*<?(${ROOT}[^\\n()<>|*?]*?\\.${EXT})>?(?:\\s+"[^"\\n]*")?\\s*\\)`, 'g');
const WIN_SPACED = new RegExp(`(?<![A-Za-z0-9])([A-Za-z]:[\\\\/][^\\n"'<>|*?\`]*?\\.${EXT})${END}`, 'g'); // "C:\My Docs\a.html in a browser"
const WIN_TOKEN = new RegExp(`(?<![A-Za-z0-9])([A-Za-z]:[\\\\/][^\\s"'<>|*?\`]+?\\.${EXT})${END}`, 'g');
const POSIX = new RegExp(`(?:^|[\\s("'\`<])(/[^\\s"'<>|*?\`]+?\\.${EXT})${END}`, 'gm');
const TILDE = new RegExp(`(?:^|[\\s("'\`<])(~[\\\\/][^\\s"'<>|*?\`]+?\\.${EXT})${END}`, 'gm');
const trimEnd = (p) => String(p).replace(/[.,;:!?]+$/, '');

function findPaths(text, { home = require('os').homedir(), platform = process.platform } = {}) {
  const found = new Set();
  const s = String(text || '').slice(0, 200000);
  const native = (p) => {
    if (home && /^~[\\/]/.test(p)) return path.join(home, p.slice(2));
    if (platform === 'win32') return p.replace(/^\/([A-Za-z])\//, (_a, d) => `${d.toUpperCase()}:/`); // Git Bash: /c/Users/me/x.html
    return p;
  };
  const add = (p) => { if (found.size < MAX_CANDIDATES) found.add(native(trimEnd(p))); };
  for (const m of s.matchAll(FILE_URL)) { const p = fromFileUrl(trimEnd(m[0])); if (p) add(p); }
  const plain = s.replace(FILE_URL, ' ');
  for (const re of [QUOTED, ANGLE, LINK, WIN_SPACED, WIN_TOKEN]) for (const m of plain.matchAll(re)) add(re === QUOTED ? m[2] : m[1]);
  for (const m of plain.matchAll(POSIX)) add(m[1]);
  for (const m of plain.matchAll(TILDE)) add(m[1]);
  return [...found];
}

// ---- checking them against the disk
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
const NETWORK = /^[\\/]{2}/; // \\server\share, \\?\ and \\.\ device paths
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\.|$)/i;
const normal = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));

function resolveFiles(paths, { fsImpl = fs, platform = process.platform } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    if (out.length >= MAX_FILES * 2) break;
    try {
      const p = String(raw);
      if (!p || p.includes('\0') || NETWORK.test(p)) continue;
      if (platform === 'win32' ? !WIN_DRIVE.test(p) || p.slice(2).includes(':') : !path.isAbsolute(p)) continue; // (a colon after the drive: an alternate data stream)
      const real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(path.normalize(p)) : fsImpl.realpathSync(path.normalize(p));
      if (NETWORK.test(real) || (platform === 'win32' && (!WIN_DRIVE.test(real) || real.slice(2).includes(':') || real.split(/[\\/]/).some((x) => DEVICE_NAME.test(x))))) continue;
      const stat = fsImpl.statSync(real);
      if (!stat.isFile()) continue; // a folder, a device: no card
      const key = normal(real);
      if (seen.has(key)) continue;
      seen.add(key);
      const ext = extOf(real);
      out.push({ path: real, name: path.basename(real), dir: path.dirname(real), ext, kind: kindOf(ext), size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* not there, or not readable: no card */ }
  }
  return out;
}

const idOf = (file) => crypto.createHash('sha1').update(normal(file)).digest('hex').slice(0, 16);

function cardOf(file, trusted) {
  const previewable = Boolean(trusted) && ((file.kind === 'html' || file.kind === 'svg') ? file.size <= PREVIEW_MAX : file.kind === 'image' ? file.size <= IMAGE_MAX : false);
  return {
    id: idOf(file.path), name: file.name, dir: file.dir, path: file.path, ext: file.ext, kind: file.kind, size: file.size, trusted: Boolean(trusted), previewable,
    canTab: canOpenInTab(file.ext), canSystem: canOpenInSystem(file.ext),
  };
}

// A viewable file the AI made (a page, picture or PDF) outranks a file only named in the text. The last one written wins.
function pickMain(cards) {
  const viewable = cards.filter((c) => c.trusted && (c.kind === 'html' || c.kind === 'svg' || c.kind === 'pdf'));
  return viewable.length ? viewable[viewable.length - 1] : null;
}

// ---- the ids the renderer may act on
function createRegistry() {
  const map = new Map();
  return {
    // A card for `file`: remembered (a trusted card stays trusted), returned for the renderer.
    add(file, trusted) {
      const id = idOf(file.path);
      const was = map.get(id);
      const card = cardOf(file, trusted || was?.trusted === true);
      map.set(id, { path: file.path, kind: file.kind, ext: file.ext, size: file.size, trusted: card.trusted });
      if (map.size > 500) map.delete(map.keys().next().value);
      return card;
    },
    get: (id) => map.get(String(id)) || null,
    clear: () => map.clear(),
  };
}

// The text or picture a trusted card previews with. Read now, from the real path (a file that changed since is shown as it is).
function previewOf(entry, { fsImpl = fs } = {}) {
  if (!entry || !entry.trusted) return null;
  try {
    const stat = fsImpl.statSync(entry.path);
    if (!stat.isFile()) return null;
    if (entry.kind === 'html' || entry.kind === 'svg') {
      if (stat.size > PREVIEW_MAX) return null;
      return { kind: entry.kind, text: fsImpl.readFileSync(entry.path, 'utf8') };
    }
    if (entry.kind === 'image') {
      if (stat.size > IMAGE_MAX || stat.size < 12) return null;
      const buffer = fsImpl.readFileSync(entry.path);
      const type = sniff(buffer);
      return type ? { kind: 'image', dataUrl: `data:${type.mime};base64,${buffer.toString('base64')}` } : null;
    }
  } catch { /* gone */ }
  return null;
}

// The address a tab opens for a file: the PDF viewer and the slide viewer take the file's own address (main.js wraps it).
const fileUrlOf = (file) => pathToFileURL(file).href;

// The registry the chat and the IPC share, and a stored card block ({ type: 'ai_file', path, trusted }) turned back into a card
// for a restored chat: null when the file is gone.
const shared = createRegistry();
function restore(block) {
  const [file] = resolveFiles([block?.path]);
  return file ? shared.add(file, block.trusted === true) : null;
}
// Is `file` (from resolveFiles) inside one of `roots` and written after `since`? (A run that has its own tools: files it made without a Write result.)
function isFresh(file, { roots = [], since = null, until = Date.now() } = {}) {
  if (since === null) return false;
  const key = normal(file.path);
  const inside = roots.some((r) => { try { const k = normal(fs.realpathSync(r)).replace(/[\\/]+$/, ''); return key === k || key.startsWith(k + path.sep) || key.startsWith(`${k}/`); } catch { return false; } });
  return inside && file.mtimeMs >= since && file.mtimeMs <= until + 60000;
}

// Files the AI wrote in a chat (its own Write / Edit tools, noted as the CLI starts them), keyed by the chat's messages array: open_tab may open
// such a file without asking (agent.js ownFileUrl). Nothing else a page or a reply names gets in.
const writtenBy = new WeakMap();
function noteWritten(chat, file) {
  if (!chat || typeof chat !== 'object' || typeof file !== 'string' || !file) return;
  let set = writtenBy.get(chat);
  if (!set) writtenBy.set(chat, (set = new Set()));
  if (set.size < 200) set.add(normal(path.resolve(file)));
}
function wasWritten(chat, file) {
  const set = chat && typeof chat === 'object' ? writtenBy.get(chat) : null;
  return Boolean(set && (set.has(normal(path.resolve(file.path))) || set.has(normal(file.path))));
}

module.exports = { noteWritten, wasWritten, findPaths, resolveFiles, cardOf, createRegistry, previewOf, pickMain, kindOf, extOf, canOpenInTab, canOpenInSystem, fileUrlOf, idOf, shared, restore, isFresh, normal, MAX_FILES, PREVIEW_MAX };

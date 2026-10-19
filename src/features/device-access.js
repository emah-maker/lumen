// [device access] Settings > AI > "Let the AI use files on this computer" (aiDeviceAccess, off by default). With it on:
//
//   - upload_file takes `paths` (a file on this computer, such as ~/Desktop/photo.png) as well as attached refs,
//   - list_files lists a folder (newest first) so the AI can find "the screenshot on my desktop",
//   - clipboard reads or writes the system clipboard's text.
//
// The site still gets a file only through upload_file, so the first upload to a site in a chat still shows its card
// naming the files (unless the user chose Auto-allow or Bypass). Some places are never reachable, whatever the model
// passes: Lumen's own profile (cookies, tokens, saved passwords), ssh/gpg/cloud credentials, the macOS keychains, and
// .env files. Everything here is a plain function of its inputs (plus the file system), so test/device-access-units.js
// runs it in plain Node.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LIST = 200; // entries one list_files call returns
const MAX_CLIP_CHARS = 20000; // clipboard text handed to the model

class DeviceAccessError extends Error {}

const OFF_TEXT = 'Using files on this computer is off. The user can turn on Settings > AI > "Let the AI use files on this computer", or attach the file in the chat instead.';

// Folders under the home folder that hold credentials: never listed, never uploaded.
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.password-store', 'Library/Keychains', 'Library/Cookies'];
// Files that hold credentials wherever they are.
const SECRET_FILE = /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keychain-db))$/i;
const ENV_EXAMPLE = /^\.env\.(example|sample|template)$/i;

// The folder names the model may use as a shorthand: "desktop", "downloads", ...
const NAMED = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', movies: 'Movies', videos: 'Videos', music: 'Music', home: '' };

// An absolute, normalized path for what the model wrote: "~/Desktop/a.png", "/Users/me/a.png", "file:///Users/me/a.png",
// "Desktop/a.png" or "desktop" (relative ones are under the home folder). Throws on anything else.
function resolvePath(raw, { home = os.homedir() } = {}) {
  let text = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw new DeviceAccessError('No path was given.');
  if (/^file:/i.test(text)) {
    try { text = decodeURIComponent(new URL(text).pathname); } catch { throw new DeviceAccessError(`Not a file address: ${raw}`); }
    if (process.platform === 'win32') text = text.replace(/^\/([a-z]:)/i, '$1');
  }
  if (text.includes('\0')) throw new DeviceAccessError('That path is not valid.');
  if (/^\\\\|^\/\/[^/]/.test(text)) throw new DeviceAccessError('Network paths are not used.');
  const named = NAMED[text.toLowerCase()];
  if (named !== undefined) return path.join(home, named);
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(home, text.slice(2));
  else if (!path.isAbsolute(text)) text = path.join(home, text);
  return path.normalize(text);
}

// Why `abs` (already resolved, and through any links) may not be used, or '' when it may. `profile`: Lumen's userData.
function blockedReason(abs, { home = os.homedir(), profile = '' } = {}) {
  const inside = (dir) => { const rel = path.relative(dir, abs); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (profile && inside(profile)) return 'That is Lumen\'s own profile (cookies, sign-ins, saved passwords), which the AI never reads.';
  for (const dir of SECRET_DIRS) if (inside(path.join(home, dir))) return `${path.join('~', dir)} holds credentials, which the AI never reads.`;
  const base = path.basename(abs);
  if (SECRET_FILE.test(base) && !ENV_EXAMPLE.test(base)) return `${base} looks like a credentials file, which the AI never reads.`;
  return '';
}

// The real path (links followed) of an existing file or folder the AI may use. kind: 'file' | 'dir'.
function checkedPath(raw, kind, opts = {}) {
  const abs = resolvePath(raw, opts);
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new DeviceAccessError(`${shown(abs, opts)} does not exist.`); }
  const why = blockedReason(abs, opts) || blockedReason(real, opts);
  if (why) throw new DeviceAccessError(why);
  const stat = fs.statSync(real);
  if (kind === 'file' && !stat.isFile()) throw new DeviceAccessError(`${shown(abs, opts)} is ${stat.isDirectory() ? 'a folder; list_files shows what is in it' : 'not a regular file'}.`);
  if (kind === 'dir' && !stat.isDirectory()) throw new DeviceAccessError(`${shown(abs, opts)} is not a folder.`);
  return real;
}

// A path as the model is shown it: under the home folder as ~/...
function shown(abs, { home = os.homedir() } = {}) {
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : rel === '' ? '~' : abs;
}

// A glob-ish filter: "*.png", "screenshot*", or plain words (all must appear in the name). '' matches everything.
function nameMatcher(pattern) {
  const text = String(pattern ?? '').trim().toLowerCase();
  if (!text) return () => true;
  if (/[*?]/.test(text)) {
    const re = new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return (name) => re.test(name);
  }
  const words = text.split(/\s+/);
  return (name) => { const n = name.toLowerCase(); return words.every((w) => n.includes(w)); };
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// list_files: the folder's entries, newest first (folders marked with a trailing /), hidden ones left out unless asked.
// -> the text the model gets.
function listFiles({ folder = 'desktop', match = '', hidden = false, limit = 50 } = {}, opts = {}) {
  const dir = checkedPath(folder || 'desktop', 'dir', opts);
  const keep = nameMatcher(match);
  const max = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), MAX_LIST);
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { throw new DeviceAccessError(err.code === 'EPERM' || err.code === 'EACCES' ? `macOS did not let Lumen read ${shown(dir, opts)}. The user can allow it in System Settings > Privacy & Security > Files and Folders.` : `Could not read ${shown(dir, opts)}: ${err.message}`); }
  const rows = [];
  for (const name of names) {
    if (!hidden && name.startsWith('.')) continue;
    if (!keep(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      if (blockedReason(full, opts) || blockedReason(fs.realpathSync(full), opts)) continue; // (a link is judged by where it goes)
      stat = fs.statSync(full);
    } catch { continue; } // a broken link
    rows.push({ name: stat.isDirectory() ? `${name}/` : name, size: stat.isDirectory() ? '' : sizeText(stat.size), mtime: stat.mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const head = `${shown(dir, opts)} (${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${match ? ` matching ${JSON.stringify(String(match))}` : ''}, newest first):`;
  if (!rows.length) return `${head}\n(nothing)`;
  const lines = rows.slice(0, max).map((r) => `${when(r.mtime)}  ${r.size.padStart(7)}  ${r.name}`);
  const more = rows.length > max ? `\n… ${rows.length - max} more (pass match or a larger limit).` : '';
  return `${head}\n${lines.join('\n')}${more}\nPass a file as ${shown(path.join(dir, '<name>'), opts)} in upload_file's paths.`;
}

// The clipboard text the model gets, cut to MAX_CLIP_CHARS and marked as untrusted (it may hold anything a page put there).
function clipboardText(text) {
  const value = String(text ?? '');
  if (!value) return 'The clipboard has no text.';
  const cut = value.length > MAX_CLIP_CHARS ? `${value.slice(0, MAX_CLIP_CHARS)}\n… (${value.length - MAX_CLIP_CHARS} more characters)` : value;
  return `<untrusted_page_content>\n${cut}\n</untrusted_page_content>`;
}

module.exports = { DeviceAccessError, OFF_TEXT, MAX_LIST, MAX_CLIP_CHARS, resolvePath, blockedReason, checkedPath, shown, nameMatcher, listFiles, clipboardText };

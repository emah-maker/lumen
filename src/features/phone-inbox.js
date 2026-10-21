// [phone files] The phone inbox: photos and files the user sends to their own Telegram bot (features/telegram.js) are
// saved here, in ~/Downloads/From phone, where Finder shows them and the AI may list them (list_files {folder:"phone"},
// still behind aiDeviceAccess). Lumen's profile is never used: the files are the user's, like a download.
//
// - Names are cleaned (upload-files.js cleanName) and never overwrite: "photo.jpg", then "photo (2).jpg".
// - On macOS a saved file is marked quarantined (com.apple.quarantine), the way a browser download is, so Gatekeeper
//   checks it before it runs. A program or script (isRisky) is only ever shown in Finder: never opened or attached.
// Pure apart from deps (fs and the quarantine call are injected: test/phone-inbox-units.js).
const path = require('path');
const { cleanName } = require('./upload-files');
const { RISKY_TYPES } = require('./downloads');

const FOLDER = 'From phone'; // under the Downloads folder
const MAX_SAVE_BYTES = 50 * 1024 * 1024;
// The macOS ones on top of the downloads list (which is mostly Windows types).
const MAC_RISKY = /^\.(app|dmg|pkg|mpkg|command|sh|bash|zsh|csh|tool|workflow|terminal|scpt|scptd|applescript|osax|kext|prefpane|webloc|inetloc|fileloc|py|pl|rb)$/i;

const isRisky = (name) => { const ext = path.extname(String(name || '')); return RISKY_TYPES.test(ext) || MAC_RISKY.test(ext); };

// "photo.jpg" when free, else "photo (2).jpg", "photo (3).jpg"... `taken(name)` says whether a name is in use.
function uniqueName(name, taken) {
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 10000; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken(next)) return next;
  }
  throw new Error('Too many files with that name.');
}

// The quarantine value macOS expects: flags;hex time;agent;uuid (0081 = downloaded, not yet opened).
const quarantineValue = (nowMs) => `0081;${Math.floor(nowMs / 1000).toString(16)};Lumen;`;

// deps: { dir, fs (node:fs), now?(), platform?, setXattr?(file, name, value) }
function createPhoneInbox(deps) {
  const fs = deps.fs || require('fs');
  const now = deps.now || (() => Date.now());
  const platform = deps.platform || process.platform;
  const dir = deps.dir;

  // -> { path, name, size, mime, risky }
  function save({ name, mime = '', data }) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!buf.length) throw new Error('The file is empty.');
    if (buf.length > MAX_SAVE_BYTES) throw new Error('The file is too big.');
    fs.mkdirSync(dir, { recursive: true });
    const clean = uniqueName(cleanName(name), (n) => fs.existsSync(path.join(dir, n)));
    const file = path.join(dir, clean);
    fs.writeFileSync(file, buf, { flag: 'wx' }); // (wx: never replaces a file that appeared meanwhile)
    mark(file);
    return { path: file, name: clean, size: buf.length, mime: String(mime || ''), risky: isRisky(clean) };
  }

  // [phone wifi] A file that was streamed to `tmp` (a hidden .part file in the inbox, features/wifi-upload.js) takes its name:
  // renamed into place, never over another file. -> the same as save().
  function saveFile(tmp, name, mime = '') {
    const clean = uniqueName(cleanName(name), (n) => fs.existsSync(path.join(dir, n)));
    const file = path.join(dir, clean);
    fs.linkSync(tmp, file); // (a hard link fails when the name was taken meanwhile, where a rename would replace it)
    fs.unlinkSync(tmp);
    mark(file);
    return { path: file, name: clean, size: fs.statSync(file).size, mime: String(mime || ''), risky: isRisky(clean) };
  }
  function mark(file) {
    if (platform === 'darwin' && deps.setXattr) {
      try { deps.setXattr(file, 'com.apple.quarantine', quarantineValue(now())); } catch (err) { console.error('[lumen] phone inbox: could not mark a file quarantined:', err?.message || err); }
    }
  }

  // The newest files first: [{ name, path, size, mtime }].
  function listRecent(limit = 20) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (name.startsWith('.')) continue; // (hidden: an upload still arriving, .incoming-*.part)
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) out.push({ name, path: path.join(dir, name), size: st.size, mtime: st.mtimeMs });
      } catch { /* gone meanwhile */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  return { dir, save, saveFile, listRecent };
}

module.exports = { createPhoneInbox, uniqueName, isRisky, quarantineValue, FOLDER, MAX_SAVE_BYTES };

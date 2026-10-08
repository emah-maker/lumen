// A local PDF the AI may open (navigate / open_tab): only from the AI's own tool call, never from a page. Accepts a path
// (C:\Users\me\My Docs\a.pdf, quoted or not) or a file:///... address, and only if it is an existing regular .pdf file.
// Everything else (other extensions, folders, \\server\share paths, device paths, other file:// addresses) is refused with
// a plain message. Symlinks, .. and 8.3 names are resolved first and the real path is checked again.
// resolve(raw) -> null (not a local reference: the caller treats it as a web address) | { fileUrl, name } | throws Error.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const WIN_DRIVE = /^[a-z]:[\\/]/i;
const NETWORK = /^[\\/]{2}/; // \\server\share, \\?\ and \\.\ device paths, //server/share
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\.|$)/i;
const REFUSED = 'Only .pdf files on this computer can be opened (not folders, network paths or other file types).';

const unquote = (raw) => {
  let s = String(raw ?? '').trim();
  while (s.length > 1 && /^["'`\u201c\u2018].*["'`\u201d\u2019]$/s.test(s)) s = s.slice(1, -1).trim();
  return s;
};

// Does this look like a local file reference (so web handling must not see it)?
function isLocalRef(raw) {
  const s = unquote(raw);
  return WIN_DRIVE.test(s) || NETWORK.test(s) || /^file:/i.test(s) || (process.platform !== 'win32' && s.startsWith('/'));
}

function resolve(raw) {
  const s = unquote(raw);
  if (!isLocalRef(s)) return null;
  let file = s;
  if (/^file:/i.test(s)) {
    try {
      const u = new URL(s);
      if (u.host && u.host.toLowerCase() !== 'localhost') throw new Error(REFUSED); // file://server/share: a network path
      file = fileURLToPath(u);
    } catch { throw new Error(REFUSED); }
  }
  if (file.includes('\0') || !/\.pdf$/i.test(file) || NETWORK.test(file)) throw new Error(REFUSED);
  if (process.platform === 'win32' ? !WIN_DRIVE.test(file) || file.slice(2).includes(':') : !path.isAbsolute(file)) throw new Error(REFUSED); // (a colon after the drive: an alternate data stream)
  let real;
  try {
    real = fs.realpathSync.native(path.normalize(file)); // symlinks, .., short names
    if (!fs.statSync(real).isFile()) throw new Error(REFUSED);
  } catch (err) {
    if (err.message === REFUSED) throw err;
    throw new Error('That PDF could not be found. Check the path with the user.');
  }
  // the real location, checked again
  if (NETWORK.test(real) || !/\.pdf$/i.test(real)) throw new Error(REFUSED);
  if (process.platform === 'win32' && (!WIN_DRIVE.test(real) || real.slice(2).includes(':') || real.split(/[\\/]/).some((p) => DEVICE_NAME.test(p)))) throw new Error(REFUSED);
  return { fileUrl: pathToFileURL(real).href, name: path.basename(real) };
}

module.exports = { resolve, isLocalRef, REFUSED };

// settings.json holds bookmarks, the saved session, permissions and the encrypted API keys, and is
// rewritten every few seconds while tabs change. A crash or power loss in the middle of a plain
// writeFileSync left a half-written file, which the next start read as "no settings" and then
// overwrote for good. So:
// - writes go to a temp file that is renamed over the real one (a rename is all or nothing), and
//   the previous good file is kept as settings.json.bak;
// - a file that won't parse falls back to the .bak, and when neither parses the broken file is
//   moved aside (settings.json.corrupt-<time>) instead of being overwritten, so nothing is lost.
const fs = require('fs');
const path = require('path');

function parse(file) {
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error };
  }
}

function loadJson(file) {
  const main = parse(file);
  if (main.data && typeof main.data === 'object') return main.data;
  const missing = main.error?.code === 'ENOENT';
  const backup = parse(`${file}.bak`);
  if (backup.data && typeof backup.data === 'object') {
    if (!missing) console.error(`[lumen] ${path.basename(file)} was unreadable; restored the backup`);
    return backup.data;
  }
  if (!missing) {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    console.error(`[lumen] ${path.basename(file)} was unreadable and had no backup; it was set aside`);
  }
  return {};
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Keep the last good file: only copy it when it still parses, so a bad file never replaces a good backup.
  if (parse(file).data) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while another program (an antivirus scan, a sync client) has
    // the file open. The data is safely in the .tmp and .bak, so fall back to a direct write.
    fs.writeFileSync(file, text);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { loadJson, writeJsonAtomic };

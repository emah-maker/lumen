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

// What this run last wrote per file, so an unchanged write is skipped and the previous file is copied to .bak without
// being read and parsed again. It is only trusted while the file on disk still has that text's size (else it is parsed).
const lastText = new Map();

function parse(file) {
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error };
  }
}

function loadJson(file) {
  const main = parse(file);
  if (main.data && typeof main.data === 'object') { lastText.delete(file); return main.data; }
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

// The same recovery, off the main thread (a big file such as history.json on the startup path).
async function loadJsonAsync(file) {
  const fsp = fs.promises;
  const read = async (f) => { try { return { data: JSON.parse(await fsp.readFile(f, 'utf8')) }; } catch (error) { return { error }; } };
  const main = await read(file);
  if (main.data && typeof main.data === 'object') { lastText.delete(file); return main.data; }
  const missing = main.error?.code === 'ENOENT';
  const backup = await read(`${file}.bak`);
  if (backup.data && typeof backup.data === 'object') {
    if (!missing) console.error(`[lumen] ${path.basename(file)} was unreadable; restored the backup`);
    return backup.data;
  }
  if (!missing) {
    try { await fsp.rename(file, `${file}.corrupt-${Date.now()}`); } catch {}
    console.error(`[lumen] ${path.basename(file)} was unreadable and had no backup; it was set aside`);
  }
  return {};
}

// `space`: the JSON indent (settings.json is read by people; the big data files pass 0).
function writeJsonAtomic(file, data, space = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, space);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Keep the last good file: only copy it when it still parses, so a bad file never replaces a good backup.
  const known = lastText.has(file) && (() => { try { return fs.statSync(file).size === Buffer.byteLength(lastText.get(file)); } catch { return false; } })();
  if (known || parse(file).data) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} }
  lastText.delete(file); // (set again below once the new text is on disk)
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the rename while another program (an antivirus scan, a sync client) has
    // the file open. The data is safely in the .tmp and .bak, so fall back to a direct write.
    fs.writeFileSync(file, text);
    try { fs.unlinkSync(tmp); } catch {}
  }
  lastText.set(file, text);
}

// The same write off the main thread (the periodic session save): serialised, one at a time, and skipped at the
// rename when `stillLatest()` says a newer write (a synchronous one) has happened meanwhile, so it can never put
// older data over newer. Its temp file is its own, apart from the synchronous writer's.
let chain = Promise.resolve();
function writeJsonAtomicAsync(file, data, stillLatest = () => true, space = 2) {
  // (`data` is a snapshot the caller no longer changes: it is turned into text only if this write still runs.)
  const run = async () => {
    if (!stillLatest()) return; // a newer write is queued: this one has nothing to do
    const text = JSON.stringify(data, null, space);
    const fsp = fs.promises;
    // Identical to what was last written and still on disk: nothing to do (no temp file, copy, fsync or rename).
    if (lastText.get(file) === text) {
      try { if ((await fsp.stat(file)).size === Buffer.byteLength(text)) return; } catch { /* gone: write it again */ }
    }
    const tmp = `${file}.tmp-async`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    if (!stillLatest()) { await fsp.unlink(tmp).catch(() => {}); return; }
    // A file this run wrote (and that still has its size) is known to parse; any other is parsed before it replaces the .bak.
    try {
      if (!(lastText.has(file) && (await fsp.stat(file)).size === Buffer.byteLength(lastText.get(file)))) JSON.parse(await fsp.readFile(file, 'utf8'));
      await fsp.copyFile(file, `${file}.bak`);
    } catch { /* no good file to keep */ }
    if (!stillLatest()) { await fsp.unlink(tmp).catch(() => {}); return; }
    lastText.delete(file);
    let wrote = true;
    try { await fsp.rename(tmp, file); } catch {
      wrote = stillLatest() && await fsp.writeFile(file, text).then(() => true, () => false); // (the fallback write is guarded too)
      await fsp.unlink(tmp).catch(() => {});
    }
    // (a failed write leaves the file unknown, so the next write parses it and writes in full)
    if (wrote) lastText.set(file, text);
  };
  chain = chain.then(run, run).catch(() => {});
  return chain;
}

module.exports = { loadJson, loadJsonAsync, writeJsonAtomic, writeJsonAtomicAsync };

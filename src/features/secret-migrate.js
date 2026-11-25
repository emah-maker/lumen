// [secret migration] Once, on the first start after the update to Electron 45: every secret still saved the old way (one
// safeStorage.encryptString blob each) is saved again in the secret box's format (features/secret-box.js: one key, sealed by the
// keychain with encryptStringAsync). Loaded only when it runs, in the background, from the start-up queue (main.js), never
// on the way to the first window.
//
// Nothing is ever lost. Each value is decrypted (decryptStringAsync, through the box), encrypted again, and decrypted back: only
// when that gives the same text does the new value replace the old one. A value that fails any step is left exactly as it was,
// and the rest carry on; the run reports it, and main.js then leaves `secretsMigrated` unset, so the next start tries again
// (values already moved are in the new format and are skipped). Files are written atomically: settings.json and the stores'
// JSON files through settings-file.js (which keeps the previous file as .bak); a file changed by its store since it was read is
// skipped (its store saves the new format itself). passwords.bin, sync-secret.bin and the per-item files (chats, project files, pictures,
// thumbnails) are written to a temp file and renamed over, with the old file kept as .bak until the new one has been read back from disk
// and checked; a failed check puts the .bak back. (Their stores keep no .bak, so none is left behind: a password or chat deleted later
// must not live on in an old copy.)
//
// deps: { box (secret-box.js), userData, readSettings(), writeSettings(s), chats?() (chat-store, for its chat files), fs?, log? }
// Returns { migrated, failed, skipped, files }.
const nodeFs = require('fs');
const path = require('path');
const { legacyStrings } = require('./secret-box');
const settingsFile = require('../settings/settings-file');

async function migrateSecrets({ box, userData, readSettings, writeSettings, chats = null, fs = nodeFs, log = () => {}, gapMs = 10 }) {
  const out = { migrated: 0, failed: 0, skipped: 0, files: 0 };
  if (!box?.available()) return { ...out, failed: 1, unavailable: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One value: base64 (or a Buffer) in the old format -> the same text in the new format, checked; null when it can't be moved.
  async function moveValue(value, { buffer = false } = {}) {
    try {
      const text = await box.decryptAsync(value);
      const next = buffer ? box.encryptBuffer(text) : box.encrypt(text);
      if (box.decrypt(next) !== text) throw new Error('the new value did not read back');
      return next;
    } catch (err) {
      out.failed++;
      log(`secret migration: a value was left as it was (${err?.message || err})`);
      return null;
    }
  }
  // Replaces every old-format string in a parsed JSON value; returns how many were replaced.
  async function moveStrings(data) {
    const olds = [...new Set(legacyStrings(data))];
    const map = new Map();
    for (const old of olds) { const next = await moveValue(old); if (next) map.set(old, next); }
    if (!map.size) return { data, n: 0 };
    const swap = (v, depth = 0) => {
      if (depth > 12 || v == null) return v;
      if (typeof v === 'string') return map.has(v) ? map.get(v) : v;
      if (Array.isArray(v)) return v.map((x) => swap(x, depth + 1));
      if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, depth + 1)]));
      return v;
    };
    return { data: swap(data), n: map.size };
  }

  // ---- settings.json: apiKeyEnc and keys.* (provider keys, widget:*, telegram, safebrowsing)
  {
    const s = readSettings();
    const found = [];
    if (typeof s.apiKeyEnc === 'string' && box.isLegacy(s.apiKeyEnc)) found.push(['apiKeyEnc', null, s.apiKeyEnc]);
    for (const [k, v] of Object.entries(s.keys || {})) if (typeof v === 'string' && v && box.isLegacy(v)) found.push(['keys', k, v]);
    const moved = [];
    for (const [where, k, old] of found) { const next = await moveValue(old); if (next) moved.push([where, k, old, next]); }
    if (moved.length) {
      // (read again: another change may have landed while the values were decrypted; only a value still the same is replaced)
      const now = readSettings();
      const keys = { ...(now.keys || {}) };
      let n = 0;
      for (const [where, k, old, next] of moved) {
        if (where === 'apiKeyEnc' && now.apiKeyEnc === old) { now.apiKeyEnc = next; n++; } else if (where === 'keys' && keys[k] === old) { keys[k] = next; n++; } else out.skipped++;
      }
      if (n) { writeSettings({ ...now, keys }); out.migrated += n; out.files++; }
    }
  }

  // ---- the stores' JSON files ({ enc }, or tokens inside: MCP servers, connectors, external apps, the Gmail send log)
  const jsonFiles = ['chat.json', path.join('chats', 'index.json'), 'memory.json', 'project-places.json', 'files.json', 'automations.json', 'background-tasks.json',
    'mcp-servers.json', 'connectors.json', 'gmail-send-log.json', 'external-apps.json'].map((f) => path.join(userData, f));
  const projectDir = path.join(userData, 'project-files');
  for (const pid of safeList(fs, projectDir)) jsonFiles.push(path.join(projectDir, pid, 'index.json'));
  for (const file of jsonFiles) {
    let raw;
    try { raw = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; } // (not readable as JSON: its store keeps it as it is)
    const { data: next, n } = await moveStrings(data);
    if (!n) continue;
    try {
      if (fs.readFileSync(file, 'utf8') !== raw) { out.skipped += n; continue; } // its store wrote it meanwhile (in the new format)
      const mode = fs.statSync(file).mode & 0o777;
      settingsFile.writeJsonAtomic(file, next, 0, mode); // (tmp + rename; the previous file is kept as .bak)
      out.migrated += n; out.files++;
    } catch (err) { out.failed += n; log(`secret migration: ${path.basename(file)} was left as it was (${err.message})`); }
    await sleep(gapMs);
  }

  // ---- whole-file blobs: passwords.bin, sync-secret.bin (one old-format blob each)
  for (const name of ['passwords.bin', 'sync-secret.bin']) {
    const file = path.join(userData, name);
    let buf;
    try { buf = await fs.promises.readFile(file); } catch { continue; }
    if (!buf.length || !box.isLegacy(buf)) continue;
    const next = await moveValue(buf, { buffer: true });
    if (!next) continue;
    if (await replaceFile(fs, file, buf, next, (b) => box.decrypt(b) === box.decrypt(next))) { out.migrated++; out.files++; } else out.failed++;
  }

  // ---- per-item files: project files (.dat), pictures (.img), thumbnails (.thumb, base64 text)
  const items = [];
  for (const pid of safeList(fs, projectDir)) for (const f of safeList(fs, path.join(projectDir, pid))) if (f.endsWith('.dat')) items.push({ file: path.join(projectDir, pid, f), kind: 'json' });
  const imgDir = path.join(userData, 'generated-images');
  for (const chat of safeList(fs, imgDir)) for (const f of safeList(fs, path.join(imgDir, chat))) if (f.endsWith('.img')) items.push({ file: path.join(imgDir, chat, f), kind: 'json' });
  const thumbDir = path.join(userData, 'office-thumb-cache');
  for (const f of safeList(fs, thumbDir)) if (f.endsWith('.thumb')) items.push({ file: path.join(thumbDir, f), kind: 'text' });
  for (const { file, kind } of items) {
    let raw;
    try { raw = await fs.promises.readFile(file); } catch { continue; }
    try {
      if (kind === 'text') {
        const enc = raw.toString('utf8').trim();
        if (!enc || !box.isLegacy(enc)) continue;
        const next = await moveValue(enc);
        if (!next) continue;
        if (await replaceFile(fs, file, raw, Buffer.from(next), (b) => box.decrypt(b.toString('utf8')) === box.decrypt(next))) { out.migrated++; out.files++; } else out.failed++;
      } else {
        const data = JSON.parse(raw.toString('utf8'));
        if (typeof data?.enc !== 'string' || !box.isLegacy(data.enc)) continue;
        const next = await moveValue(data.enc);
        if (!next) continue;
        const text = Buffer.from(JSON.stringify({ ...data, enc: next }));
        if (await replaceFile(fs, file, raw, text, (b) => box.decrypt(JSON.parse(b.toString('utf8')).enc) === box.decrypt(next))) { out.migrated++; out.files++; } else out.failed++;
      }
    } catch { /* not readable as its format: left as it is */ }
    await sleep(gapMs);
  }

  // ---- chat files: the chat store writes them itself (its write queue, never over a save: chat-store.js upgradeLegacy)
  if (chats) {
    try {
      const r = await chats().upgradeLegacy({ gapMs, report: true });
      out.migrated += r.done; out.files += r.done; out.failed += r.failed;
    } catch (err) { out.failed++; log(`secret migration: chats were left as they were (${err.message})`); }
  }
  return out;
}

function safeList(fs, dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// Replaces `file` (which held `before`) with `after`: never if it changed meanwhile; the old file is kept as .bak until the new
// one has been read back from disk and passes `check` (then it goes), and is put back if it doesn't.
async function replaceFile(fs, file, before, after, check) {
  const bak = `${file}.bak`;
  const tmp = `${file}.migrate-${process.pid}.tmp`;
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { return false; }
  try {
    await fs.promises.writeFile(tmp, after, { mode });
    if (!fs.readFileSync(file).equals(before)) { await fs.promises.rm(tmp, { force: true }); return false; } // written meanwhile
    fs.copyFileSync(file, bak);
    fs.renameSync(tmp, file);
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
  let ok;
  try { ok = check(await fs.promises.readFile(file)); } catch { ok = false; }
  if (!ok) {
    try { fs.copyFileSync(bak, file); } catch { /* the .bak is still there */ }
    return false;
  }
  await fs.promises.rm(bak, { force: true }).catch(() => {});
  return true;
}

module.exports = { migrateSecrets, replaceFile };

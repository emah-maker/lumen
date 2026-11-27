// Settings → Extensions: turning an extension off and on, and Developer mode's unpacked extensions.
//
// Off: the extension is unloaded from the session and stays installed (its folder and data are kept). settings.json's extensionsOff
// holds { [id]: { name, version, description, path, unpacked } } so the page can list it and Lumen can load it again from `path`;
// main.js setupExtensions skips those folders at start-up.
//
// Unpacked: a folder the user picked with Developer mode on. Its manifest is checked first (validateManifest) and what it asks for is
// shown before it loads. Lumen loads a copy of the folder (userData/Unpacked Extensions/<hash of the folder>), never the folder itself:
// loading writes into an extension's folder (the dialog shim in browser/extension-dialogs.js, the site narrowing in extension-sites.js),
// and the user's source must stay as they wrote it. The copy's path is the same every time for one folder, so its id is too.
// Reload copies the folder again and loads it in place of the running version. settings.json's extensionsUnpacked holds [{ id, source }].
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extensionPermissionLines } = require('./extension-permissions');

const COPIES = 'Unpacked Extensions';
const MAX_FILES = 5000; // a folder bigger than this is not an extension (a whole project picked by mistake)
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// "__MSG_appName__" from the default locale's messages, as Chrome shows it.
function localized(dir, manifest, value) {
  const m = typeof value === 'string' && /^__MSG_(\w+)__$/.exec(value);
  if (!m) return value;
  try {
    const messages = readJson(path.join(dir, '_locales', manifest.default_locale || 'en', 'messages.json'));
    const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
    return hit?.[1]?.message || value;
  } catch { return value; }
}

// The files a manifest names that must be in the folder for it to load and work.
function namedFiles(manifest) {
  const files = [];
  const bg = manifest.background || {};
  if (typeof bg.service_worker === 'string') files.push(bg.service_worker);
  if (Array.isArray(bg.scripts)) files.push(...bg.scripts);
  if (typeof bg.page === 'string') files.push(bg.page);
  for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) files.push(...(cs.js || []), ...(cs.css || []));
  const action = manifest.action || manifest.browser_action || {};
  if (typeof action.default_popup === 'string') files.push(action.default_popup);
  if (typeof manifest.options_page === 'string') files.push(manifest.options_page);
  if (typeof manifest.options_ui?.page === 'string') files.push(manifest.options_ui.page);
  return files.filter((f) => typeof f === 'string' && f).map((f) => f.split(/[?#]/)[0]);
}

// Checks the folder holds an extension Lumen can load. Returns { ok: true, manifest, name, version, lines } (lines: what it asks for,
// in the install prompt's words) or { ok: false, error } with a sentence for the page.
function validateManifest(dir) {
  if (typeof dir !== 'string' || !dir) return { ok: false, error: 'No folder was chosen.' };
  let stat;
  try { stat = fs.statSync(dir); } catch { return { ok: false, error: 'That folder doesn’t exist.' }; }
  if (!stat.isDirectory()) return { ok: false, error: 'Choose the extension’s folder, not a file.' };
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'That folder has no manifest.json. Choose the folder that holds the extension’s manifest.' };
  let manifest;
  try { manifest = readJson(file); } catch (err) { return { ok: false, error: `manifest.json isn’t valid JSON: ${String(err.message).slice(0, 120)}` }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, error: 'manifest.json must be a JSON object.' };
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) return { ok: false, error: 'manifest_version must be 2 or 3.' };
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return { ok: false, error: 'The manifest needs a name.' };
  if (typeof manifest.version !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version) || manifest.version.split('.').some((n) => Number(n) > 65535)) {
    return { ok: false, error: 'The manifest’s version must be one to four numbers separated by dots, such as 1.0.2.' };
  }
  for (const key of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
    if (manifest[key] !== undefined && !Array.isArray(manifest[key])) return { ok: false, error: `${key} must be a list.` };
  }
  const missing = namedFiles(manifest).filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) return { ok: false, error: `The manifest names files that aren’t in the folder: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.` };
  return { ok: true, manifest, name: localized(dir, manifest, manifest.name), version: manifest.version, lines: extensionPermissionLines(manifest) };
}

// Where a source folder's copy lives (the same path, so the same id, every time).
const copyDirOf = (userData, source) => path.join(userData, COPIES, crypto.createHash('sha256').update(path.resolve(source).toLowerCase()).digest('hex').slice(0, 16));

function copyFolder(source, dest) {
  let count = 0;
  const walk = (from) => {
    for (const d of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(d.name)) continue;
      if (++count > MAX_FILES) throw new Error(`The folder has more than ${MAX_FILES} files: choose the extension’s own folder.`);
      if (d.isDirectory()) walk(path.join(from, d.name));
    }
  };
  walk(source);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  // A folder unpacked from a store install keeps its key and update_url: the store's updater (electron-chrome-web-store updateExtensions)
  // would then replace the copy with the store's version. The copy's manifest drops update_url, so it stays the user's build.
  const file = path.join(dest, 'manifest.json');
  const manifest = readJson(file);
  if ('update_url' in manifest) { delete manifest.update_url; fs.writeFileSync(file, JSON.stringify(manifest, null, 2)); }
}

// deps: { ses, userData, readSettings, writeSettings, isLocked(id) (uBlock mode's blocker: managed by Settings → Ad blocker) }
function createManager(deps) {
  const exts = () => deps.ses().extensions;
  const off = () => ({ ...(deps.readSettings().extensionsOff || {}) });
  const unpacked = () => (Array.isArray(deps.readSettings().extensionsUnpacked) ? deps.readSettings().extensionsUnpacked : []).filter((u) => u && typeof u.id === 'string' && typeof u.source === 'string');
  const save = (patch) => deps.writeSettings({ ...deps.readSettings(), ...patch });
  const startWorker = (ext) => {
    if (ext?.manifest?.manifest_version === 3 && ext.manifest.background?.service_worker) deps.ses().serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}`).catch(() => {});
  };
  // A store extension's version folder (Extensions/<id>/<version>_0); one removed by hand falls back to the newest one beside it.
  const storeDirOf = (dir) => {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    const other = fs.existsSync(parent) ? fs.readdirSync(parent).map((d) => path.join(parent, d)).filter((d) => fs.existsSync(path.join(d, 'manifest.json'))).sort().pop() : null;
    return other || dir;
  };
  const unpackedOf = (id) => unpacked().find((u) => u.id === id) || null;

  async function setEnabled(id, on) {
    if (deps.isLocked?.(id)) throw new Error('This extension is your ad blocker: change it in Settings → Privacy and security → Ad blocker.');
    const saved = off();
    if (on) {
      const entry = saved[id];
      if (!entry) return;
      delete saved[id];
      save({ extensionsOff: saved });
      if (exts().getExtension(id)) return;
      const u = unpackedOf(id);
      const ext = u ? await loadUnpackedCopy(u.source) : await exts().loadExtension(storeDirOf(entry.path));
      startWorker(ext);
      return;
    }
    const ext = exts().getExtension(id);
    if (!ext) return;
    saved[id] = { name: ext.name, version: ext.version, description: ext.manifest.description || '', path: ext.path, unpacked: Boolean(unpackedOf(id)) };
    save({ extensionsOff: saved });
    exts().removeExtension(id);
  }

  // Copies the folder again and loads the copy. Throws with a sentence for the page when the manifest isn't valid.
  async function loadUnpackedCopy(source) {
    const check = validateManifest(source);
    if (!check.ok) throw new Error(check.error);
    const dest = copyDirOf(deps.userData, source);
    const loaded = exts().getAllExtensions().find((e) => path.resolve(e.path) === path.resolve(dest));
    if (loaded) exts().removeExtension(loaded.id);
    copyFolder(source, dest);
    return exts().loadExtension(dest);
  }

  async function addUnpacked(source) {
    const ext = await loadUnpackedCopy(source);
    save({ extensionsUnpacked: [...unpacked().filter((u) => u.id !== ext.id), { id: ext.id, source: path.resolve(source) }] });
    const saved = off();
    if (saved[ext.id]) { delete saved[ext.id]; save({ extensionsOff: saved }); }
    startWorker(ext);
    return ext;
  }

  async function reloadUnpacked(id) {
    const u = unpackedOf(id);
    if (!u) throw new Error('Only an unpacked extension can be reloaded from its folder.');
    const ext = await loadUnpackedCopy(u.source);
    if (ext.id !== id) save({ extensionsUnpacked: unpacked().map((x) => (x.id === id ? { ...x, id: ext.id } : x)) });
    const saved = off();
    if (saved[id]) { delete saved[id]; save({ extensionsOff: saved }); }
    startWorker(ext);
    return ext;
  }

  // Removed (Settings → Extensions, the ⋯ menu): forgotten here. An unpacked one's copy is deleted; the user's folder is not touched.
  function forget(id) {
    const saved = off();
    const wasOff = saved[id];
    if (wasOff) { delete saved[id]; save({ extensionsOff: saved }); }
    const u = unpackedOf(id);
    if (!u) return false;
    if (exts().getExtension(id)) exts().removeExtension(id);
    save({ extensionsUnpacked: unpacked().filter((x) => x.id !== id) });
    fs.rmSync(copyDirOf(deps.userData, u.source), { recursive: true, force: true });
    return true;
  }

  // At start-up, after the store's extensions: the unpacked ones that are on, from a fresh copy of their folder (a folder that is gone,
  // or no longer valid, loads its last copy instead, so the extension keeps working while it is being edited).
  async function loadAtStart() {
    const saved = off();
    const out = [];
    for (const u of unpacked()) {
      if (saved[u.id] || exts().getExtension(u.id)) continue;
      const dest = copyDirOf(deps.userData, u.source);
      const ext = await loadUnpackedCopy(u.source).catch(() => (fs.existsSync(path.join(dest, 'manifest.json')) ? exts().loadExtension(dest).catch(() => null) : null));
      if (ext) out.push(ext);
    }
    return out;
  }

  // The extensions that are off, as Settings → Extensions lists them.
  const offList = () => Object.entries(off()).map(([id, e]) => ({ id, name: String(e?.name || id), version: String(e?.version || ''), description: String(e?.description || '') }));

  return { setEnabled, addUnpacked, reloadUnpacked, forget, loadAtStart, offList, unpackedOf };
}

module.exports = { validateManifest, createManager, copyDirOf, COPIES };

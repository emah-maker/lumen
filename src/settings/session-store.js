// The saved session (open tabs, windows, groups, sidebars...) in its own session.json, apart from settings.json.
// It used to be a key of settings.json, so every tab change rewrote the whole settings file and its .bak: heavy, and
// it put bookmarks, permissions and keys at risk on every save. Now:
// - session.json is written the same crash-safe way (settings-file.js: temp file, fsync, rename, the last good file
//   kept as session.json.bak); a background save goes off the main thread, closing and quitting write at once;
// - first run of this version: the old `session` key is copied to session.json, and only once that file is safely on
//   disk is the key taken out of settings.json (a crash between the two writes leaves both copies: the next start
//   finishes the move);
// - settings.json then carries `sessionFile: 'session.json'`. An older version keeps that key when it saves (it writes
//   { ...settings, session }), so a session found next to the marker was saved by an older version after the move
//   and is newer than session.json: it is moved again. So is one in a settings.json written after session.json. Any
//   other session found while session.json exists is a leftover (a crash between the writes, or settings.json restored
//   from a .bak older than the move): session.json wins.
// An older version reading the new layout finds every setting where it was and only no tabs to restore.
const nodeFs = require('fs');
const path = require('path');
const defaultFile = require('./settings-file');

const FILE_NAME = 'session.json';
const MARK = 'sessionFile';

function createSessionStore(deps) {
  const fs = deps.fs || nodeFs;
  const sf = deps.settingsFile || defaultFile;
  const dir = () => (typeof deps.dir === 'function' ? deps.dir() : deps.dir);
  const file = () => path.join(dir(), FILE_NAME);
  let cache; // undefined: not read yet
  let gen = 0; // bumped by every save: a background write that is no longer the latest doesn't land
  let pending = false; // a background write not yet known to be on disk

  const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
  const wrap = (session) => ({ version: 1, session: session ?? null });

  function get() {
    if (cache === undefined) {
      const data = sf.loadJson(file()); // (falls back to session.json.bak; {} when there is neither)
      cache = data && Object.prototype.hasOwnProperty.call(data, 'session') ? data.session : null;
    }
    return cache;
  }

  function writeNow(session) {
    cache = session ?? null;
    pending = false;
    gen++;
    sf.writeJsonAtomic(file(), wrap(cache), 0);
  }

  // `background`: the periodic save (off the main thread). Closing and quitting pass false: on disk before the process can go.
  function save(session, { background = false } = {}) {
    if (!background) { writeNow(session); return Promise.resolve(); }
    cache = session ?? null;
    pending = true;
    const g = ++gen;
    return sf.writeJsonAtomicAsync(file(), wrap(cache), () => g === gen, 0)
      .then(() => { if (g === gen) pending = false; });
  }

  // A background write still on its way lands now (quitting).
  function flush() { if (pending) writeNow(cache); }

  // settings.json itself (not its .bak) holds a session and was written after session.json: it was saved after the move
  // (an older version that dropped the marker, a profile copied in). A crash between the two writes leaves settings.json the older one.
  function writtenAfter(settingsPath) {
    const p = typeof settingsPath === 'function' ? settingsPath() : settingsPath;
    if (!p) return false;
    try {
      if (fs.statSync(p).mtimeMs <= fs.statSync(file()).mtimeMs) return false;
      return Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(p, 'utf8')), 'session');
    } catch { return false; }
  }

  // The settings as loaded from settings.json: a `session` key in them is moved to session.json. `writeSettings(settings)`
  // writes settings.json at once (it is called only after session.json is on disk). Returns the settings without the key.
  function migrate(settings, writeSettings) {
    if (!settings || typeof settings !== 'object' || !Object.prototype.hasOwnProperty.call(settings, 'session')) return settings;
    const { session, ...rest } = settings;
    // (a session.json that can't be read, nor its .bak, holds nothing: the copy in settings.json is better than none)
    const newer = settings[MARK] === FILE_NAME || !(exists(file()) || exists(`${file()}.bak`)) || get() == null || writtenAfter(deps.settingsPath);
    if (newer) writeNow(session); // (throws if it can't be written: settings.json then keeps the key, nothing is lost)
    rest[MARK] = FILE_NAME;
    try { writeSettings(rest); } catch (err) { console.error('[lumen] could not take the session out of settings.json:', err.message); } // (the next start finishes the move)
    return rest;
  }

  // Settings about to be written that carry a `session` key (an older code path, a test's patch): the session goes to
  // session.json and the rest is returned for settings.json.
  function split(settings, { background = false } = {}) {
    if (!settings || typeof settings !== 'object' || !Object.prototype.hasOwnProperty.call(settings, 'session')) return settings;
    const { session, ...rest } = settings;
    save(session, { background });
    return rest;
  }

  return { get, save, flush, migrate, split, file, pending: () => pending };
}

module.exports = { createSessionStore, FILE_NAME, MARK };

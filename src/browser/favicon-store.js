// Favicons for the new-tab page used to live inline in settings.json (main.js cacheFavicon), written
// with a synchronous fs.writeFileSync on every newly-seen site — a blocking disk write on the main
// process for something that's purely decorative and never read back except to render an <img>.
// This keeps them in their own file instead: an in-memory Map, a debounced async write, and a
// temp-file-then-rename so a crash mid-write can never truncate the file (or, before this, settings.json).
const fs = require('fs');
const path = require('path');

const MAX_HOSTS = 300; // small data URLs, but unbounded hosts would still grow the file forever
const WRITE_DELAY_MS = 1000;

// dir: userData directory. legacyFavicons: settings.json's old `favicons` object, if any, migrated
// in once and never read from there again (main.js deletes the key from settings.json after this call).
function createFaviconStore(dir, legacyFavicons) {
  const file = path.join(dir, 'favicons.json');
  let map = new Map(); // host -> data URL; Map iteration order doubles as LRU order (oldest first)
  try {
    map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {
    // First run, or file not written yet — fall through to the legacy migration below.
    if (legacyFavicons && typeof legacyFavicons === 'object') map = new Map(Object.entries(legacyFavicons));
  }

  let timer = null;
  function writeSoon() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const tmp = `${file}.tmp`;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(map)));
        await fs.promises.rename(tmp, file); // atomic on the same volume: readers never see a partial file
      } catch {
        // Best-effort cache; losing an update just means a re-fetched favicon next time.
      }
    }, WRITE_DELAY_MS);
  }
  if (map.size && !fs.existsSync(file)) writeSoon(); // persist the migrated-from-settings.json data

  return {
    has: (host) => map.has(host),
    // Reading counts as use for LRU purposes (it's what "keep the ones the new-tab page actually shows" means).
    get(host) {
      if (!map.has(host)) return undefined;
      const value = map.get(host);
      map.delete(host);
      map.set(host, value);
      return value;
    },
    set(host, dataUrl) {
      map.delete(host);
      map.set(host, dataUrl);
      while (map.size > MAX_HOSTS) map.delete(map.keys().next().value); // drop least-recently-used
      writeSoon();
    },
  };
}

// ---- favicon-cache: icons as files the new-tab page and tab strip load by file: address ----
// Used to be main.js's faviconFileNow (existsSync + mkdirSync + writeFileSync per icon, on the main thread,
// and nothing ever removed a file). Now the address follows from the data's hash, so it is returned at once
// and the file is written in the background (tmp + rename); `prune` (run when idle) bounds the folder.
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_MAX_COUNT = 2000;
const CACHE_FILE_RE = /^[0-9a-f]{20}\.[a-z0-9]+$/;

function createFaviconFiles({ dir, now = () => Date.now(), maxAgeMs = FILE_MAX_AGE_MS, maxFiles = FILE_MAX_COUNT }) {
  const urlOfKey = new Map(); // hash -> file URL
  const byData = new Map(); // data: address -> file URL (no sha1 of 50 KB per lookup)
  const inUse = new Set(); // file names handed out this session: prune never removes them
  const pending = new Map(); // file -> bytes still to write

  async function ensure(file) {
    const fsp = fs.promises;
    try {
      await fsp.utimes(file, new Date(), new Date()); // already there: counts as used, so prune keeps it
    } catch {
      try {
        await fsp.mkdir(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, pending.get(file));
        await fsp.rename(tmp, file);
      } catch { /* best-effort cache: the icon just isn't shown this time */ }
    }
    pending.delete(file);
  }

  function fileFor(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    if (byData.has(dataUrl)) return byData.get(dataUrl);
    const m = dataUrl.match(/^data:image\/([a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return dataUrl; // (not base64: passed as it is)
    const key = crypto.createHash('sha1').update(dataUrl).digest('hex').slice(0, 20);
    let url = urlOfKey.get(key);
    if (!url) {
      const ext = { 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', 'svg+xml': 'svg', jpeg: 'jpg' }[m[1].toLowerCase()] || m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = `${key}.${ext}`;
      const file = path.join(dir, name);
      url = pathToFileURL(file).href;
      urlOfKey.set(key, url);
      inUse.add(name);
      pending.set(file, Buffer.from(m[2], 'base64'));
      ensure(file);
    }
    if (byData.size > 500) byData.clear();
    byData.set(dataUrl, url);
    return url;
  }

  // Files untouched for maxAgeMs go, then the oldest beyond maxFiles. Async and yielding between files, so it
  // never holds the main thread. Returns how many it removed.
  async function prune() {
    const fsp = fs.promises;
    let names;
    try { names = (await fsp.readdir(dir)).filter((n) => CACHE_FILE_RE.test(n) && !inUse.has(n)); } catch { return 0; }
    const stats = [];
    for (const name of names) {
      try { stats.push({ name, mtime: (await fsp.stat(path.join(dir, name))).mtimeMs }); } catch { /* gone already */ }
      await new Promise((r) => setImmediate(r));
    }
    stats.sort((a, b) => b.mtime - a.mtime); // newest first
    const cutoff = now() - maxAgeMs;
    const room = Math.max(0, maxFiles - inUse.size);
    let removed = 0;
    for (let i = 0; i < stats.length; i++) {
      if (stats[i].mtime >= cutoff && i < room) continue;
      try { await fsp.unlink(path.join(dir, stats[i].name)); removed++; } catch { /* gone */ }
    }
    return removed;
  }

  return { fileFor, prune };
}

module.exports = { createFaviconStore, createFaviconFiles };

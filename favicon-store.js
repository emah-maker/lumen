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

module.exports = { createFaviconStore };

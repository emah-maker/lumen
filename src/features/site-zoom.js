// ---------- per-site zoom, remembered across restarts ----------
//
// Chromium keeps one zoom level per host while the browser runs (zooming one tab of a site zooms
// its other tabs too), but forgets it on quit, so a site you always read at 125% came back at the
// default every launch. Now the level you pick by hand (Ctrl+= / Ctrl+-, the ⋯ menu) is kept per
// host in settings.json (`siteZoom`: { host: level }) and applied when that site loads again.
// Actual Size (Ctrl+0, the zoom pill) forgets it, and the site follows Settings → Page zoom again.
// Restore settings to defaults clears the list. At most MAX hosts are kept, the oldest dropped first.
//
// deps: { readSettings(), writeSettings(s) }

const MAX = 500;
const MIN_LEVEL = -8;
const MAX_LEVEL = 9;

const validLevel = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_LEVEL && v <= MAX_LEVEL;
const validHost = (h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && !/[\s/]/.test(h);

// What settings.json holds, cleaned: only valid hosts and levels, at most MAX of them (the newest).
function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw).filter(([host, level]) => validHost(host) && validLevel(level));
  return Object.fromEntries(entries.slice(-MAX));
}

// Chromium's zoom level -> the percentage it shows (each level is a factor of 1.2).
const percentOf = (level) => Math.round(100 * 1.2 ** level);

function createSiteZoom(deps) {
  const read = () => clean(deps.readSettings().siteZoom);
  function write(map) {
    deps.writeSettings({ ...deps.readSettings(), siteZoom: map });
  }
  return {
    levelFor(host) {
      const level = read()[host];
      return validLevel(level) ? level : null;
    },
    set(host, level) {
      if (!validHost(host) || !validLevel(level)) return false;
      const map = read();
      delete map[host]; // re-added last: the newest
      map[host] = level;
      const keys = Object.keys(map);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) delete map[old];
      write(map);
      return true;
    },
    forget(host) {
      const map = read();
      if (!(host in map)) return false;
      delete map[host];
      write(map);
      return true;
    },
    list: () => Object.entries(read()).map(([host, level]) => ({ host, level, percent: percentOf(level) })),
  };
}

module.exports = { createSiteZoom, clean, percentOf, MAX };

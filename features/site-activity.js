// When each site last stored cookies, so "Clear browsing data" can honour a time range for cookies
// and site data. Electron's session can only clear those for all time or per origin, and cookies
// carry no creation time, so Lumen keeps its own record: cookie domain -> last time a cookie was set.
// Kept in userData/site-activity.json (domains and times only, never cookie names or values).
const fs = require('fs');
const path = require('path');

const KEEP_MS = 400 * 86400e3; // older entries can't matter to any time range but "all time"

function createSiteActivity({ userData, now = () => Date.now() }) {
  const file = path.join(userData, 'site-activity.json');
  let seen = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') seen = new Map(Object.entries(saved).filter(([, t]) => Number.isFinite(t)));
  } catch {
    // none yet
  }
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const cutoff = now() - KEEP_MS;
      for (const [d, t] of seen) if (t < cutoff) seen.delete(d);
      fs.promises.writeFile(file, JSON.stringify(Object.fromEntries(seen))).catch(() => {});
    }, 2000);
    timer.unref?.();
  };
  const domainOf = (d) => String(d || '').replace(/^\./, '').toLowerCase();

  function record(domain, at = now()) {
    const d = domainOf(domain);
    if (!d) return;
    if ((seen.get(d) || 0) >= at) return;
    seen.set(d, at);
    save();
  }

  // Watches a session's cookie store: every cookie added or changed stamps its domain.
  function watch(ses) {
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => { if (!removed) record(cookie.domain); });
  }

  const since = (t) => [...seen].filter(([, at]) => at >= t).map(([d]) => d);
  const forget = (domains) => { for (const d of domains) seen.delete(domainOf(d)); save(); };
  const clear = () => { seen.clear(); save(); };

  return { record, watch, since, forget, clear, get: (d) => seen.get(domainOf(d)) };
}

// Does cookie domain `d` belong to host `h` (the same host, or one is a parent domain of the other)?
const related = (d, h) => d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);

module.exports = { createSiteActivity, related };

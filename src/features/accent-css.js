// [look] The accent colour on every page of Lumen's own: the browser window, Settings, the chat page, the PDF viewer, history,
// downloads, the error pages and the small popups. One stylesheet (features/theme-colors.js cssFor: the accent's tokens for light
// and for dark, under prefers-color-scheme) is injected into each of them when its document is ready and swapped when the accent
// changes, so no page needs a script of its own for it and a page added tomorrow follows too. insertCSS is not held back by a
// page's CSP (the popups cannot link tokens.css), and a website is never touched: only file: pages inside renderer/ and the PDF
// viewer's own scheme count. Blue, the default, needs nothing (the pages' own CSS is blue).
const path = require('path');
const { fileURLToPath } = require('url');
const { cssFor } = require('./theme-colors');

// deps: { rendererDir, accent: () => ({ light, dark }) | null, all: () => webContents[] }
function create(deps) {
  const root = path.resolve(deps.rendererDir).toLowerCase() + path.sep;
  const state = new WeakMap(); // contents -> { css, key }
  const isOwnPage = (url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'lumen-pdf:') return u.host === 'app';
      return u.protocol === 'file:' && (path.resolve(fileURLToPath(u)).toLowerCase() + path.sep).startsWith(root);
    } catch { return false; }
  };
  const isDefault = (a) => !a || (a.light === '#007aff' && a.dark === '#0a84ff');
  async function run(contents) {
    try {
      if (!contents || contents.isDestroyed() || !isOwnPage(contents.getURL())) return;
      const a = deps.accent();
      const css = isDefault(a) ? '' : cssFor(a);
      const had = state.get(contents);
      if ((had?.css || '') === css && had?.url === contents.getURL()) return;
      if (had?.key && had.url === contents.getURL()) await contents.removeInsertedCSS(had.key).catch(() => {}); // (a navigation already dropped the old sheet)
      const key = css ? await contents.insertCSS(css) : null;
      state.set(contents, { css, key, url: contents.getURL() });
    } catch { /* the page went away */ }
  }
  // One at a time per page, each reading the accent when it runs: two quick changes cannot leave the older sheet in place over the newer.
  const chains = new WeakMap();
  function apply(contents) {
    if (!contents) return Promise.resolve();
    const done = (chains.get(contents) || Promise.resolve()).then(() => run(contents));
    chains.set(contents, done.catch(() => {}));
    return done;
  }
  const refreshAll = () => { for (const c of deps.all()) apply(c); };
  return { apply, refreshAll, isOwnPage };
}

module.exports = { create };

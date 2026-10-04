// The Bookmarks and Downloads pages (renderer/bookmarks.html, renderer/downloads.html).
// Like the History page, each is a local file in an ordinary tab. Only a tab opened as that page
// gets managers-preload.js, the preload exposes its API only to that page's own document, and
// every call below checks that it came from the top frame of such a tab showing that page. The AI
// agent never sees these tabs (agent.js agentUrl: no file:// pages), so it can't drive them.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const toNetscape = (...a) => require('./bookmark-html').toNetscape(...a); // (bookmark import/export, loaded on first use)
const parseNetscape = (...a) => require('./bookmark-html').parseNetscape(...a);
const chatPage = require('./chat-page'); // lumen://chat opens and is switched to like these pages, with its own preload

const BOOKMARKS_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'bookmarks.html')).href;
const DOWNLOADS_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'downloads.html')).href;
const PAGES = { bookmarks: BOOKMARKS_URL, downloads: DOWNLOADS_URL, chat: chatPage.CHAT_URL };
const PRELOAD = path.join(__dirname, 'managers-preload.js');
const preloadFor = (page) => (page === 'chat' ? chatPage.PRELOAD : PRELOAD);

const pageOf = (url) => {
  const bare = String(url || '').split(/[?#]/)[0];
  return Object.keys(PAGES).find((k) => bare === PAGES[k]) || null;
};

const MAX_TITLE = 500;
const MAX_FOLDER = 100;
const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
const cleanFolder = (f) => String(f ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER);
const webUrl = (u) => {
  try {
    const parsed = new URL(String(u).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
};

// deps: { ipcMain, dialog, win, tabs, alive, openTab, switchTab, bookmarks, saveBookmarks,
//         bookmarksChanged, downloads, hostOf }
function createManagers(deps) {
  // The file pickers, replaceable by tests (test/managers.js): native dialogs can't be clicked there.
  const pickers = {
    save: (w, options) => deps.dialog.showSaveDialog(w, options),
    open: (w, options) => deps.dialog.showOpenDialog(w, options),
  };
  // A manager tab: the tab records which page it was opened as (tab.managerPage).
  const tabFor = (event, page) => deps.tabs().find((t) => t.managerPage === page && deps.alive(t) && t.view.webContents === event.sender);
  const fromPage = (event, page) => Boolean(tabFor(event, page))
    && event.senderFrame === event.sender.mainFrame && pageOf(event.senderFrame?.url) === page;

  // One tab per page: switch to it if it's open.
  function open(page) {
    const existing = deps.tabs().find((t) => t.managerPage === page && deps.alive(t) && pageOf(t.view.webContents.getURL()) === page);
    if (existing) { deps.switchTab(existing.id); return existing.id; }
    return deps.openTab(PAGES[page], { managerPage: page }).id;
  }

  // ---- bookmarks ----
  const list = () => deps.bookmarks().map((b) => ({ url: b.url, title: b.title || '', folder: b.folder || '' }));
  function save(next) {
    deps.saveBookmarks(next.map((b) => ({ url: b.url, title: b.title, ...(b.folder ? { folder: b.folder } : {}) })));
    deps.bookmarksChanged();
    pushBookmarks();
  }
  function add({ url, title, folder } = {}) {
    const href = webUrl(url);
    if (!href) return { ok: false, error: 'Enter a web address (http or https).' };
    const all = list();
    if (all.some((b) => b.url === href)) return { ok: false, error: 'That page is already bookmarked.' };
    all.push({ url: href, title: cleanTitle(title) || deps.hostOf(href) || href, folder: cleanFolder(folder) });
    save(all);
    return { ok: true };
  }
  function update({ url, title, newUrl, folder } = {}) {
    const all = list();
    const entry = all.find((b) => b.url === url);
    if (!entry) return { ok: false, error: 'That bookmark no longer exists.' };
    const href = newUrl === undefined ? entry.url : webUrl(newUrl);
    if (!href) return { ok: false, error: 'Enter a web address (http or https).' };
    if (href !== entry.url && all.some((b) => b.url === href)) return { ok: false, error: 'Another bookmark already has that address.' };
    entry.url = href;
    if (title !== undefined) entry.title = cleanTitle(title) || deps.hostOf(href) || href;
    if (folder !== undefined) entry.folder = cleanFolder(folder);
    save(all);
    return { ok: true };
  }
  function remove(url) {
    const all = list();
    const next = all.filter((b) => b.url !== url);
    if (next.length === all.length) return false;
    save(next);
    return true;
  }
  // Adds bookmarks from a Netscape file, skipping addresses already bookmarked.
  function importHtml(html) {
    const all = list();
    const known = new Set(all.map((b) => b.url));
    let added = 0;
    for (const b of parseNetscape(html)) {
      const href = webUrl(b.url);
      if (!href || known.has(href)) continue;
      known.add(href);
      all.push({ url: href, title: cleanTitle(b.title) || deps.hostOf(href) || href, folder: cleanFolder(b.folder) });
      added++;
    }
    if (added) save(all);
    return added;
  }
  const exportHtml = () => toNetscape(list());

  function pushBookmarks() {
    for (const t of deps.tabs()) if (t.managerPage === 'bookmarks' && deps.alive(t)) t.view.webContents.send('bookmarks:changed');
  }
  function pushDownloads() {
    for (const t of deps.tabs()) if (t.managerPage === 'downloads' && deps.alive(t)) t.view.webContents.send('downloads:changed');
  }

  function setup() {
    const { ipcMain } = deps;
    const on = (channel, page, fn, denied) => ipcMain.handle(channel, (event, ...args) => (fromPage(event, page) ? fn(event, ...args) : denied));
    on('bookmarks:list', 'bookmarks', () => list(), []);
    on('bookmarks:add', 'bookmarks', (_e, b) => add(b), { ok: false, error: 'Not allowed' });
    on('bookmarks:update', 'bookmarks', (_e, b) => update(b), { ok: false, error: 'Not allowed' });
    on('bookmarks:remove', 'bookmarks', (_e, url) => remove(url), false);
    on('bookmarks:open', 'bookmarks', (_e, url) => { const href = webUrl(url); if (href) deps.openTab(href); return Boolean(href); }, false);
    on('bookmarks:export', 'bookmarks', async () => {
      const w = deps.win();
      const { canceled, filePath } = await pickers.save(w, {
        title: 'Export Bookmarks', defaultPath: 'bookmarks.html', filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }],
      });
      if (canceled || !filePath) return { ok: false };
      await fs.promises.writeFile(filePath, exportHtml(), 'utf8');
      return { ok: true, count: list().length };
    }, { ok: false });
    on('bookmarks:import', 'bookmarks', async () => {
      const w = deps.win();
      const { canceled, filePaths } = await pickers.open(w, {
        title: 'Import Bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }],
      });
      if (canceled || !filePaths?.[0]) return { ok: false };
      const stat = await fs.promises.stat(filePaths[0]);
      if (stat.size > 20 * 1024 * 1024) return { ok: false, error: 'That file is too large.' };
      return { ok: true, added: importHtml(await fs.promises.readFile(filePaths[0], 'utf8')) };
    }, { ok: false });

    on('downloads:list', 'downloads', () => deps.downloads.summary(), []);
    on('downloads:act', 'downloads', (_e, id, action) => deps.downloads.act(Number(id), String(action)), false);
    on('downloads:folder', 'downloads', () => { deps.openFolder(); return true; }, false);
  }

  return { setup, open, pageOf, PAGES, PRELOAD, preloadFor, pushDownloads, pushBookmarks, pickers, add, update, remove, importHtml, exportHtml, list };
}

module.exports = { createManagers, pageOf, BOOKMARKS_URL, DOWNLOADS_URL, PRELOAD, preloadFor };

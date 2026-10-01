// ---------- page tools: Save Page As, View Source, Reader mode, Picture in Picture ----------
// View Source and Reader mode are Lumen's own pages (renderer/source.html, renderer/reader.html),
// loaded in the tab like History. They have no preload and no IPC: the main process hands each one
// its data with executeJavaScript once it has loaded, keyed by a random token in its URL. Web pages
// can't navigate to file:// pages, and the AI's tools only open http(s) and only list web pages, so
// neither can reach them. The source is fetched again with the tab's session (as Chrome does when
// it's not cached); Reader mode runs Mozilla Readability (vendor/readability) in an isolated world
// and the reader page strips scripts, handlers and styles from what it gets, under a strict CSP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SOURCE_URL = pathToFileURL(path.join(ROOT, 'renderer', 'source.html')).href;
const READER_URL = pathToFileURL(path.join(ROOT, 'renderer', 'reader.html')).href;
const WORLD = 1002; // isolated world for Readability (1001 is the AI's and the page-text reader's)
const MAX_SOURCE = 5 * 1024 * 1024; // bytes of source shown; the rest is cut off with a note
const KEEP = 50; // source/reader pages remembered (Back and Reload need their data again)

const isWebUrl = (url) => /^https?:\/\//i.test(url || '');
const vendor = (name) => fs.readFileSync(path.join(ROOT, 'vendor', 'readability', name), 'utf8');
let readabilitySrc = null;
let readerableSrc = null;

// A file name from a page title: no characters Windows or macOS refuse, not too long.
function fileNameFor(title, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const base = String(title || host || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (base || 'page').slice(0, 100);
}

// `url` of one of these pages -> 'source' | 'reader' | null, and the web page it shows.
function kindOf(url) {
  if (!url) return null;
  const bare = url.split(/[?#]/)[0].toLowerCase();
  if (bare === SOURCE_URL.toLowerCase()) return 'source';
  if (bare === READER_URL.toLowerCase()) return 'reader';
  return null;
}
function originalUrl(url) {
  try { const u = new URL(url).searchParams.get('u') || ''; return isWebUrl(u) ? u : ''; } catch { return ''; }
}

async function fetchSource(ses, url) {
  const res = await ses.fetch(url, { credentials: 'include', cache: 'force-cache', signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') || '';
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    for await (const chunk of res.body) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (size >= MAX_SOURCE) { truncated = true; break; }
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_SOURCE);
  let text;
  try { text = new TextDecoder(/charset=["']?([\w-]+)/i.exec(type)?.[1] || 'utf-8').decode(bytes); } catch { text = new TextDecoder('utf-8').decode(bytes); }
  return { status: res.status, type, text, truncated };
}

// deps: { win, openTab, sendTabs, downloadDir, showSaveDialog, t }
function createPageTools(deps) {
  const store = new Map(); // token -> { kind, url, data (a promise) }

  function remember(entry) {
    const token = crypto.randomBytes(12).toString('hex');
    store.set(token, entry);
    while (store.size > KEEP) store.delete(store.keys().next().value);
    return token;
  }
  const pageUrl = (base, url, token) => `${base}?${new URLSearchParams({ u: url, t: token })}`;

  // Hands a source/reader page its data. A token that's gone (after a restart, or an old history
  // entry) is rebuilt: the source is fetched again; a reader page goes back to the article.
  async function render(wc, url) {
    const kind = kindOf(url);
    const original = originalUrl(url);
    let entry = store.get(new URL(url).searchParams.get('t') || '');
    if (!entry || entry.kind !== kind) {
      if (kind === 'reader') { if (original) wc.loadURL(original).catch(() => {}); return; }
      if (!original) return;
      entry = { kind, url: original, data: fetchSource(wc.session, original) };
    }
    let data;
    try { data = await entry.data; } catch (err) { data = { error: String(err?.message || err) }; }
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    wc.executeJavaScript(`window.lumenRender(${JSON.stringify({ url: entry.url, ...data })})`).catch(() => {});
  }

  function checkReaderable(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed() || !isWebUrl(wc.getURL())) return;
    readerableSrc ??= vendor('Readability-readerable.js');
    wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `${readerableSrc}\n;isProbablyReaderable(document)` }])
      .then((yes) => {
        if (wc.isDestroyed() || Boolean(yes) === Boolean(tab.readerable)) return;
        tab.readerable = Boolean(yes);
        deps.sendTabs();
      })
      .catch(() => {});
  }

  // Called for every tab's webContents (wireView in main.js).
  function attach(tab) {
    const wc = tab.view.webContents;
    let timer = null;
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !tab.readerable) return;
      tab.readerable = false;
      deps.sendTabs();
    });
    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      if (kindOf(url)) render(wc, url);
      else checkReaderable(tab);
    });
    // Single-page sites change articles without a load.
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (!isMainFrame) return;
      clearTimeout(timer);
      timer = setTimeout(() => checkReaderable(tab), 800);
    });
    wc.once('destroyed', () => clearTimeout(timer));
  }

  // Opens the source of `url` in a new tab, or in `wc` (a typed view-source: address).
  function viewSource(url, { wc = null, openerId = null, session = null } = {}) {
    if (!isWebUrl(url)) return false;
    const ses = session || wc?.session;
    const token = remember({ kind: 'source', url, data: fetchSource(ses, url) });
    const target = pageUrl(SOURCE_URL, url, token);
    if (wc) wc.loadURL(target).catch(() => {});
    else deps.openTab(target, { openerId });
    return true;
  }

  async function extractArticle(wc) {
    readabilitySrc ??= vendor('Readability.js');
    const code = `${readabilitySrc}
;(() => {
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article || !article.content) return null;
  return { title: article.title || document.title, byline: article.byline || '', siteName: article.siteName || '', content: article.content, dir: article.dir || '', lang: article.lang || document.documentElement.lang || '' };
})()`;
    return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  }

  // Reader mode on: the article, cleaned up, in place of the page (Back returns to it). Off: back
  // to the page.
  async function toggleReader(tab) {
    const wc = tab?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    const url = wc.getURL();
    if (kindOf(url) === 'reader') {
      const original = originalUrl(url);
      const history = wc.navigationHistory;
      const index = history.getActiveIndex();
      if (index > 0 && history.getEntryAtIndex(index - 1)?.url === original) history.goBack();
      else if (original) wc.loadURL(original).catch(() => {});
      return true;
    }
    if (!isWebUrl(url)) return false;
    let article = null;
    try { article = await extractArticle(wc); } catch {}
    if (!article || wc.isDestroyed() || wc.getURL() !== url) return false;
    const token = remember({ kind: 'reader', url, data: Promise.resolve(article) });
    wc.loadURL(pageUrl(READER_URL, url, token)).catch(() => {});
    return true;
  }

  async function savePage(wc) {
    if (!wc || wc.isDestroyed() || !isWebUrl(wc.getURL())) return null;
    const { canceled, filePath } = await deps.showSaveDialog({
      title: 'Save Page As',
      defaultPath: path.join(deps.downloadDir(), `${fileNameFor(wc.getTitle(), wc.getURL())}.html`),
      filters: [
        { name: 'Webpage, Complete', extensions: ['html', 'htm'] },
        { name: 'Webpage, Single File', extensions: ['mhtml'] },
      ],
    });
    if (canceled || !filePath || wc.isDestroyed()) return null;
    await wc.savePage(filePath, /\.mht(ml)?$/i.test(filePath) ? 'MHTML' : 'HTMLComplete');
    return filePath;
  }

  // Picture in Picture for the video under (x, y) in `frame`, or its largest video. Run with a user
  // gesture (the menu click), which requestPictureInPicture needs.
  function togglePictureInPicture(frame, x, y) {
    const code = `(() => {
  if (document.pictureInPictureElement) return document.exitPictureInPicture().then(() => 'exited');
  let video = document.elementFromPoint(${Number(x) || 0}, ${Number(y) || 0});
  video = video && video.closest ? video.closest('video') : null;
  if (!video) video = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video) return 'none';
  return video.requestPictureInPicture().then(() => 'entered');
})()`;
    return frame.executeJavaScript(code, true);
  }

  function videoMenuItems(wc, p, { openTab, copy }) {
    if (p.mediaType !== 'video') return [];
    const flags = p.mediaFlags || {};
    const frame = p.frame && !p.frame.isDestroyed?.() ? p.frame : wc.mainFrame;
    const t = deps.t || ((key) => key);
    const items = [{
      label: t('menu.pictureInPicture'),
      type: 'checkbox',
      checked: Boolean(flags.isShowingPictureInPicture),
      enabled: flags.canShowPictureInPicture !== false,
      click: () => togglePictureInPicture(frame, p.x, p.y).catch(() => {}),
    }];
    if (isWebUrl(p.srcURL)) {
      items.push(
        { label: t('menu.openVideoNewTab'), click: () => openTab(p.srcURL) },
        { label: t('menu.copyVideoAddress'), click: () => copy(p.srcURL) },
      );
    }
    items.push({ type: 'separator' });
    return items;
  }

  return {
    attach,
    viewSource,
    toggleReader,
    savePage,
    videoMenuItems,
    togglePictureInPicture,
    isInternal: (url) => Boolean(kindOf(url)),
    page: kindOf,
    // What the address bar shows: view-source:<url>, or the article's own address in Reader mode.
    displayUrl: (url) => (kindOf(url) === 'source' ? `view-source:${originalUrl(url)}` : originalUrl(url)),
    originalUrl,
  };
}

module.exports = { createPageTools, SOURCE_URL, READER_URL, fileNameFor, kindOf };

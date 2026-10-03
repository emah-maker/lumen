// Private windows (Ctrl+Shift+N). Each one is a separate BrowserWindow with its own small UI
// (renderer/private.html) and its own in-memory session: the partition name has no "persist:"
// prefix, so cookies, cache and storage live only in memory, and a fresh random name per window
// means two private windows never share a login. Closing the window clears that session.
//
// Nothing here touches main.js's tab list, so by construction a private tab is never in history,
// session restore, the downloads list, tab groups, the AI's tools (list_tabs, navigate, ...) or the
// automation proxy (automation.js only exposes main.js's tabs). The AI sidebar isn't offered at all:
// its chat is saved to disk and its providers are remote, which a private window shouldn't do.
// Extensions are tied to the default session and don't run here. The protections do: main.js's
// prepareSession gives the session Safe Browsing and the ad blocker, and prepareTab gives each tab
// HTTPS-only, the page settings and the error and certificate warning pages, as a normal tab has.
// Downloads go to the Downloads folder (or where you choose) and are listed in this window only, in
// memory: the list is gone when the window closes. Site permissions are remembered for the window only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const googleAuth = require('../browser/google-auth-identity');
const firefoxProfile = googleAuth.firefoxProfile(process.platform);
const { pathToFileURL } = require('url');

const UI_HTML = path.join(__dirname, '..', 'renderer', 'private.html');
const NEWTAB_HTML = path.join(__dirname, '..', 'renderer', 'private-newtab.html');
const TOP = 78; // tab strip + toolbar height in renderer/private.css
const PROMPTABLE = new Set(['media', 'geolocation', 'notifications', 'clipboard-read']); // permission.<name> in locales/en.json
// As main.js: protected video (mediaKeySystem) plays, and screen sharing's own picker (pickScreen) is the consent.
const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem', 'display-capture']);
const { createBurstLimit } = require('./popup-guard'); // a page opening windows or tabs in a loop
const { RISKY_TYPES } = require('./downloads'); // programs and scripts: never saved without the user choosing to
const FAVICON_MAX = 256 * 1024;
const CLOSED_KEEP = 25; // closed tabs Ctrl+Shift+T can bring back, per window (memory only)
const STRING_PREFIX = 'private.';

const sameFile = (a, b) => {
  try { return new URL(a).pathname.toLowerCase() === new URL(b).pathname.toLowerCase() && new URL(a).protocol === 'file:'; } catch { return false; }
};

// deps: { BrowserWindow, WebContentsView, session, ipcMain, dialog, resolveInput, isWebUrl, iconPath, screenshot(ctx),
//         t, strings(), Menu, clipboard, shell, platform, testBackground, prepareSession(ses), releaseSession(ses),
//         prepareTab(wc), tabWebPreferences(), defaultZoom(), realUrl(wc), securityState(wc), zoom(wc, step), searchFor(text),
//         downloadDir(), askWhereToSave(), permissionDefault(name), pickScreen(request, callback, win),
//         askOpenExternal(wc, details, decisions), openSettings(), onFocusChange() } — all but the first eight optional.
function createPrivateWindows(deps) {
  const { BrowserWindow, WebContentsView, session, ipcMain, dialog, resolveInput, isWebUrl } = deps;
  const t = deps.t || ((key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key));
  const platform = deps.platform || process.platform;
  const UI_URL = pathToFileURL(UI_HTML).href;
  const NEWTAB_URL = pathToFileURL(NEWTAB_HTML).href;
  const windows = new Set(); // { win, partition, ses, tabs: [{ id, view, favicon }], activeId, decisions, closed, downloads, popups }
  const reserved = new Set(); // download paths claimed by downloads still running
  let nextId = 1;
  let downloadSeq = 0;

  const alive = (rec) => rec.win && !rec.win.isDestroyed();
  const recFor = (event) => [...windows].find((rec) => alive(rec) && event.sender === rec.win.webContents
    && event.senderFrame === event.sender.mainFrame && sameFile(event.senderFrame?.url, UI_URL));
  const recById = (windowId) => [...windows].find((r) => alive(r) && r.win.id === windowId);
  const activeTab = (rec) => rec.tabs.find((t) => t.id === rec.activeId);
  const isNewTab = (wc) => sameFile(wc.getURL(), NEWTAB_URL);
  // The address the user is on: an error or HTTPS-only page shows the address that failed (main.js realUrl).
  const shownUrl = (wc) => (isNewTab(wc) ? '' : deps.realUrl ? deps.realUrl(wc) : wc.getURL());
  const titleOf = (wc) => (isNewTab(wc) ? t('private.newTab') : wc.getTitle() || shownUrl(wc) || t('private.newTab'));
  function security(wc) {
    if (!wc || isNewTab(wc)) return '';
    const url = wc.getURL();
    if (/^http:/i.test(url)) return 'insecure';
    if (!/^https:/i.test(url)) return '';
    const state = deps.securityState?.(wc);
    return state === 'broken' || state === 'mixed' ? state : 'secure';
  }

  // Strings for the UI page (renderer/i18n.js) and the new-tab page: only this window's own keys.
  function stringTable() {
    const all = deps.strings?.() || {};
    return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(STRING_PREFIX)));
  }

  function sendState(rec) {
    if (!alive(rec)) return;
    const active = activeTab(rec);
    const wc = active?.view.webContents;
    const zoom = wc && !wc.isDestroyed() ? Math.round(wc.getZoomFactor() * 100) : 100;
    rec.win.webContents.send('private:state', {
      tabs: rec.tabs.map((tab) => ({ id: tab.id, title: titleOf(tab.view.webContents), url: shownUrl(tab.view.webContents), loading: tab.view.webContents.isLoading(), active: tab.id === rec.activeId, favicon: tab.favicon || null, audible: tab.view.webContents.isCurrentlyAudible?.() || false })),
      url: wc ? shownUrl(wc) : '',
      loading: Boolean(wc?.isLoading()),
      canBack: Boolean(wc?.navigationHistory.canGoBack()),
      canForward: Boolean(wc?.navigationHistory.canGoForward()),
      security: security(wc),
      zoom,
      defaultZoom: Math.round((deps.defaultZoom?.() || 1) * 100),
      downloads: downloadsSummary(rec),
    });
    rec.win.setTitle(t('private.windowTitle', { title: wc ? titleOf(wc) : t('private.newTab') }));
  }
  // Many events arrive together (a load starts, its title and icon follow): one redraw per tick.
  function sendStateSoon(rec) {
    if (rec.stateTimer) return;
    rec.stateTimer = setImmediate(() => { rec.stateTimer = null; sendState(rec); });
  }

  function layout(rec) {
    if (!alive(rec)) return;
    const [width, height] = rec.win.getContentSize();
    for (const tab of rec.tabs) {
      // A page in fullscreen (a video's fullscreen button) covers the whole window, strip included.
      const top = tab.fullscreen ? 0 : TOP;
      tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
      tab.view.setVisible(tab.id === rec.activeId);
    }
  }

  function setupSession(rec) {
    const ses = rec.ses;
    // Safe Browsing, the ad blocker, the profile's proxy, Do Not Track / Global Privacy Control, languages and
    // Chrome hints (main.js prepareSession); without it, a private window would connect directly even when a
    // proxy is set, and would load pages Safe Browsing blocks in a normal window.
    if (deps.prepareSession) deps.prepareSession(ses);
    else if (deps.mirrorSession) deps.mirrorSession(ses);
    else if (deps.chromeHintHeaders) {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        let headers = details.requestHeaders;
        if (googleAuth.isAuthUrl(details.url)) {
          headers = googleAuth.firefoxRequestHeaders(headers, firefoxProfile); // Google's sign-in hosts see Firefox
        } else if (/^https:/.test(details.url)) {
          for (const name of Object.keys(headers)) if (/^sec-ch-ua(-mobile|-platform)?$/i.test(name)) delete headers[name];
          Object.assign(headers, deps.chromeHintHeaders);
        }
        callback({ requestHeaders: headers });
      });
    }
    ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return callback(true);
      if (permission === 'openExternal') return callback(Boolean(await deps.askOpenExternal?.(wc, details, rec.externalDecisions)));
      let origin;
      try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return callback(false); }
      if (!PROMPTABLE.has(permission) || !isWebUrl(origin)) return callback(false);
      const key = `${origin}|${permission}`;
      if (rec.decisions.has(key)) return callback(rec.decisions.get(key));
      if (deps.permissionDefault?.(permission) === 'block' || !alive(rec)) return callback(false); // [settings] default: Block
      // Remembered for this window only; nothing is written to settings.json.
      const { response } = await dialog.showMessageBox(rec.win, {
        type: 'question', buttons: [t('permission.deny'), t('permission.allow')], defaultId: 0, cancelId: 0,
        message: t('permission.ask', { host: new URL(origin).host, reason: t(`permission.${permission}`) }), detail: t('private.permission.detail'),
      });
      rec.decisions.set(key, response === 1);
      callback(response === 1);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => ALWAYS_ALLOWED.has(permission) || rec.decisions.get(`${origin}|${permission}`) === true);
    if (deps.pickScreen) ses.setDisplayMediaRequestHandler((request, callback) => deps.pickScreen(request, callback, rec.win));
    ses.on('will-download', (_event, item) => startDownload(rec, item));
  }

  // ---------- downloads: kept in the Downloads folder, listed in this window only ----------
  function freePath(dir, base) {
    const parsed = path.parse(base);
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target) || reserved.has(target.toLowerCase()); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    reserved.add(target.toLowerCase());
    return target;
  }
  function startDownload(rec, item) {
    const base = path.basename(item.getFilename() || 'download');
    const dir = deps.downloadDir?.();
    let target = null;
    if (dir) {
      target = freePath(dir, base);
      // A program or script, or "Ask where to save": the save dialog (with a warning for a program), so nothing that
      // can run code lands in Downloads without the user choosing it. Otherwise straight into the folder.
      if (RISKY_TYPES.test(path.extname(base))) {
        let host = '';
        try { host = new URL(item.getURL()).host; } catch {}
        item.setSaveDialogOptions({ defaultPath: target, title: t('private.download.riskyTitle'), message: t('private.download.risky', { name: base, host: host || t('private.download.theSite') }) });
      } else if (deps.askWhereToSave?.()) item.setSaveDialogOptions({ defaultPath: target });
      else item.setSavePath(target);
    }
    const entry = { id: ++downloadSeq, name: path.basename(target || base), path: target, state: 'progressing', received: 0, total: item.getTotalBytes(), item };
    rec.downloads.unshift(entry);
    const update = () => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      const chosen = item.getSavePath();
      if (chosen) Object.assign(entry, { path: chosen, name: path.basename(chosen) });
      progress(rec);
      sendStateSoon(rec);
    };
    item.on('updated', (_e, state) => { entry.state = state === 'interrupted' ? 'interrupted' : 'progressing'; update(); });
    item.once('done', (_e, state) => {
      if (target) reserved.delete(target.toLowerCase());
      entry.state = state; // completed | cancelled | interrupted
      update();
      if (state === 'completed' && alive(rec)) rec.win.flashFrame(!rec.win.isFocused());
    });
    sendStateSoon(rec);
  }
  function progress(rec) {
    if (!alive(rec)) return;
    const active = rec.downloads.filter((d) => d.state === 'progressing' && d.total > 0);
    const [got, total] = active.reduce((a, d) => [a[0] + d.received, a[1] + d.total], [0, 0]);
    rec.win.setProgressBar(active.length && total ? got / total : -1);
  }
  function downloadsSummary(rec) {
    const running = rec.downloads.filter((d) => d.state === 'progressing');
    const total = running.reduce((n, d) => n + d.total, 0);
    return {
      count: rec.downloads.length,
      running: running.length,
      progress: running.length && total ? running.reduce((n, d) => n + d.received, 0) / total : null,
    };
  }
  const sizeText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
  function downloadStatus(d) {
    if (d.state === 'progressing') return d.total ? t('private.download.percent', { percent: Math.floor((d.received / d.total) * 100) }) : sizeText(d.received);
    if (d.state === 'completed') return d.path && fs.existsSync(d.path) ? sizeText(d.total || d.received) : t('private.download.missing');
    return t(d.state === 'cancelled' ? 'private.download.cancelled' : 'private.download.failed');
  }
  function downloadsMenu(rec) {
    const items = rec.downloads.slice(0, 15).map((d) => {
      const done = d.state === 'completed' && d.path && fs.existsSync(d.path);
      return {
        label: `${d.name} — ${downloadStatus(d)}`,
        submenu: [
          { label: t('private.download.open'), enabled: done, click: () => deps.shell?.openPath(d.path) },
          { label: t('private.download.show'), enabled: done, click: () => deps.shell?.showItemInFolder(d.path) },
          { label: t('private.download.cancel'), enabled: d.state === 'progressing', click: () => { try { d.item.cancel(); } catch {} } },
        ],
      };
    });
    if (!items.length) items.push({ label: t('private.download.none'), enabled: false });
    items.push({ type: 'separator' });
    items.push({ label: t('private.download.clear'), enabled: rec.downloads.some((d) => d.state !== 'progressing'), click: () => { rec.downloads = rec.downloads.filter((d) => d.state === 'progressing'); sendState(rec); } });
    if (deps.downloadDir) items.push({ label: t('private.download.folder'), click: () => deps.shell?.openPath(deps.downloadDir()) });
    items.push({ type: 'separator' }, { label: t('private.download.note'), enabled: false });
    return items;
  }

  // ---------- favicons: fetched in the private session (the UI page's own session must never fetch them) ----------
  function loadFavicon(rec, tab, urls) {
    const url = urls.find((u) => /^(https?:|data:image\/)/i.test(u));
    if (!url) return;
    const cached = rec.icons.get(url);
    if (cached !== undefined) { if (tab.favicon !== cached) { tab.favicon = cached; sendStateSoon(rec); } return; }
    const wc = tab.view.webContents;
    const page = wc.getURL();
    const done = (dataUrl) => {
      rec.icons.set(url, dataUrl);
      if (rec.icons.size > 200) rec.icons.delete(rec.icons.keys().next().value);
      if (!wc.isDestroyed() && wc.getURL() === page && rec.tabs.includes(tab)) { tab.favicon = dataUrl; sendStateSoon(rec); }
    };
    if (/^data:image\//i.test(url)) { done(url.length <= FAVICON_MAX ? url : null); return; }
    if (typeof rec.ses.fetch !== 'function') return;
    rec.ses.fetch(url, { credentials: 'include' }).then(async (res) => {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !/^image\//i.test(type)) return done(null);
      const body = Buffer.from(await res.arrayBuffer());
      done(body.length && body.length <= FAVICON_MAX ? `data:${type};base64,${body.toString('base64')}` : null);
    }).catch(() => done(null));
  }

  function wireTab(rec, tab) {
    const wc = tab.view.webContents;
    const update = () => sendStateSoon(rec);
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate-in-page', 'audio-state-changed']) wc.on(ev, update);
    wc.on('did-navigate', (_e, url) => {
      if (!isWebUrl(url)) tab.favicon = null; // the new-tab and error pages have no icon
      else { try { if (new URL(url).host !== tab.faviconHost) tab.favicon = null; tab.faviconHost = new URL(url).host; } catch {} }
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => loadFavicon(rec, tab, favicons.filter((u) => typeof u === 'string' && u)));
    wc.on('before-input-event', (event, input) => handleShortcut(rec, event, input));
    // Only web pages (and the private new-tab page) in a private tab.
    wc.on('will-navigate', (event) => { if (!isWebUrl(event.url) && !sameFile(event.url, NEWTAB_URL)) event.preventDefault(); });
    deps.chromeIdentity?.(wc);
    deps.googleRefusedGuard?.(wc, { inTab: true, win: () => rec.win });
    deps.prepareTab?.(wc); // HTTPS-only, the default zoom, Safe Browsing and certificate warnings, the error page
    // The new-tab page has no script of its own (and no preload): its words come from locales/ through here.
    wc.on('dom-ready', () => {
      if (!isNewTab(wc)) return;
      wc.executeJavaScript(`(${fillStrings.toString()})(${JSON.stringify(stringTable())})`, false).catch(() => {});
    });
    wc.on('enter-html-full-screen', () => { tab.fullscreen = true; layout(rec); });
    wc.on('leave-html-full-screen', () => { tab.fullscreen = false; layout(rec); });
    wc.on('zoom-changed', (_e, direction) => zoom(wc, direction === 'in' ? 0.5 : -0.5)); // Ctrl+wheel, pinch
    wc.on('found-in-page', (_e, result) => {
      if (tab.id === rec.activeId && alive(rec)) rec.win.webContents.send('private:find-result', { active: result.activeMatchOrdinal, total: result.matches });
    });
    pageMenu(rec, wc);
    wc.setWindowOpenHandler(({ url, disposition }) => popupOrTab(rec, url, disposition));
    wc.on('destroyed', () => closeTab(rec, tab.id, { destroyed: true }));
  }

  // Runs in the private new-tab page (no access to anything but its own document).
  function fillStrings(table) {
    const doc = globalThis.document;
    for (const el of doc.querySelectorAll('[data-i18n]')) {
      const text = table[el.dataset.i18n];
      if (typeof text === 'string' && text) el.textContent = text;
    }
    if (typeof table['private.newTab'] === 'string') doc.title = table['private.newTab'];
  }

  // A right-click menu for private pages and popups: edit, links and images, back/forward/reload, Inspect.
  function pageMenu(rec, wc) {
    if (!deps.Menu) return;
    wc.on('context-menu', (_e, p) => {
      const items = [];
      const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
      if (p.misspelledWord) {
        const words = (p.dictionarySuggestions || []).slice(0, 5);
        items.push(...(words.length ? words.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) })) : [{ label: t('private.menu.noSuggestions'), enabled: false }]));
        sep();
      }
      if (p.linkURL && isWebUrl(p.linkURL)) {
        items.push(
          { label: t('private.menu.openLink'), click: () => openTab(rec, p.linkURL, { background: true }) },
          { label: t('private.menu.copyLink'), click: () => deps.clipboard?.writeText(p.linkURL) },
        );
        sep();
      }
      if (p.mediaType === 'image' && p.srcURL) {
        if (isWebUrl(p.srcURL)) items.push({ label: t('private.menu.openImage'), click: () => openTab(rec, p.srcURL, { background: true }) });
        items.push({ label: t('private.menu.copyImage'), click: () => wc.copyImageAt(p.x, p.y) });
        if (isWebUrl(p.srcURL)) items.push({ label: t('private.menu.copyImageAddress'), click: () => deps.clipboard?.writeText(p.srcURL) });
        sep();
      }
      if (p.isEditable) {
        items.push({ role: 'undo', label: t('private.menu.undo'), enabled: p.editFlags.canUndo }, { role: 'redo', label: t('private.menu.redo'), enabled: p.editFlags.canRedo }, { type: 'separator' },
          { role: 'cut', label: t('private.menu.cut'), enabled: p.editFlags.canCut }, { role: 'copy', label: t('private.menu.copy'), enabled: p.editFlags.canCopy },
          { role: 'paste', label: t('private.menu.paste'), enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: t('private.menu.selectAll') });
        sep();
      } else if (p.selectionText) {
        items.push({ role: 'copy', label: t('private.menu.copy') });
        const search = deps.searchFor?.(p.selectionText.trim());
        const text = p.selectionText.trim();
        if (search) items.push({ label: t('private.menu.searchFor', { engine: search.engine, text: text.length > 30 ? `${text.slice(0, 29)}…` : text }), click: () => openTab(rec, search.url) });
        sep();
      }
      if (!items.length && !wc.isDestroyed()) {
        items.push(
          { label: t('private.menu.back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
          { label: t('private.menu.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
          { label: t('private.menu.reload'), click: () => wc.reload() },
        );
        sep();
      }
      items.push({ label: t('private.menu.inspect'), click: () => wc.inspectElement(p.x, p.y) });
      deps.Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || rec.win });
    });
  }

  // A sign-in or payment popup ("Sign in with Google" on a site) stays a popup, in this window's private session,
  // with window.opener kept so it can report back to the page; a link that opens a tab opens a private tab.
  function popupOrTab(rec, url, disposition) {
    if (!(rec.popupLimit ||= createBurstLimit()).allow()) return { action: 'deny' };
    if (disposition === 'new-window' && (isWebUrl(url) || url === 'about:blank')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: deps.iconPath, backgroundColor: deps.popupBackground?.() || '#1d1530', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(deps.popupWebPreferences?.() || {}) } },
        outlivesOpener: true,
        createWindow: (options) => {
          const child = new BrowserWindow({ ...options, autoHideMenuBar: true, icon: deps.iconPath, backgroundColor: deps.popupBackground?.() || '#1d1530', ...(deps.testBackground ? { show: false } : {}), ...(options?.webContents ? { webContents: options.webContents } : { webPreferences: { session: rec.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, ...(deps.popupWebPreferences?.() || {}) } }) });
          if (deps.testBackground) hideForTests(child);
          const wc = child.webContents;
          deps.chromeIdentity?.(wc); // before anything loads
          if (!options?.webContents) wc.loadURL(url).catch(() => {});
          deps.popupFailPage?.(wc);
          deps.googleRefusedGuard?.(wc);
          // The title bar says which site this is (a popup has no address bar), private and with a lock when secure.
          const retitle = () => {
            if (child.isDestroyed()) return;
            try {
              const u = new URL(wc.getURL());
              child.setTitle(u.host ? `${u.protocol === 'https:' ? '🔒 ' : ''}${u.host} — ${t('private.badge')}${wc.getTitle() ? ` — ${wc.getTitle()}` : ''}` : `${wc.getTitle() || 'Lumen'} — ${t('private.badge')}`); // (an error page has no host)
            } catch { child.setTitle(t('private.windowTitle', { title: 'Lumen' })); }
          };
          wc.on('page-title-updated', (e) => { e.preventDefault(); retitle(); });
          wc.on('did-navigate', retitle);
          wc.on('did-navigate-in-page', retitle);
          pageMenu(rec, wc);
          // It belongs to this private window: it closes with it (whose session is then cleared).
          rec.popups.add(child);
          child.on('closed', () => rec.popups.delete(child));
          wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'w') { e.preventDefault(); child.close(); } });
          wc.setWindowOpenHandler(({ url: u, disposition: d }) => popupOrTab(rec, u, d));
          return wc;
        },
      };
    }
    // A tab: a page's window.open gets that window back (it keeps window.opener), as in normal windows.
    if (alive(rec) && (isWebUrl(url) || url === 'about:blank') && (disposition === 'foreground-tab' || disposition === 'background-tab')) {
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(deps.tabWebPreferences?.() || {}) } },
        createWindow: (options) => (options?.webContents ? openTab(rec, url, { background: disposition === 'background-tab', webContents: options.webContents }) : openTab(rec, url, { background: disposition === 'background-tab' }))?.view.webContents,
      };
    }
    if (isWebUrl(url)) openTab(rec, url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  }

  // webContents: a page that already exists (a window.open), adopted as this tab.
  function openTab(rec, url, { background = false, webContents = null, index = null } = {}) {
    if (!alive(rec)) return null;
    const view = webContents ? new WebContentsView({ webContents }) : new WebContentsView({ webPreferences: { session: rec.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, ...(deps.tabWebPreferences?.() || {}), disableBlinkFeatures: 'AutomationControlled' } });
    view.setBackgroundColor('#1d1530'); // no white flash before the first paint
    const tab = { id: nextId++, view, favicon: null };
    if (Number.isInteger(index)) rec.tabs.splice(Math.max(0, Math.min(index, rec.tabs.length)), 0, tab);
    else rec.tabs.push(tab);
    rec.win.contentView.addChildView(view);
    wireTab(rec, tab);
    if (!background || !rec.activeId) setActive(rec, tab.id);
    layout(rec);
    if (webContents) { /* adopted: already on its way to its address */ } else if (url && isWebUrl(url)) view.webContents.loadURL(url).catch(() => {});
    else view.webContents.loadFile(NEWTAB_HTML).catch(() => {});
    if (rec.activeId === tab.id) focusFor(rec, tab, !url);
    sendState(rec);
    return tab;
  }

  // The keyboard goes where Chrome sends it: the address box on a new tab, the page otherwise.
  function focusFor(rec, tab, address) {
    if (!alive(rec) || !rec.win.isFocused?.()) {
      if (address) rec.win.webContents.send('private:focus-address');
      return;
    }
    if (address) { rec.win.webContents.focus(); rec.win.webContents.send('private:focus-address'); } else if (!tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
  }

  function setActive(rec, id) {
    const before = activeTab(rec);
    if (before && before.id !== id && !before.view.webContents.isDestroyed()) {
      before.view.webContents.stopFindInPage('clearSelection');
      rec.win.webContents.send('private:find-close');
    }
    rec.activeId = id;
  }

  function closeTab(rec, id, { destroyed = false } = {}) {
    const index = rec.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = rec.tabs.splice(index, 1);
    if (!destroyed && alive(rec)) {
      const url = shownUrl(tab.view.webContents);
      if (isWebUrl(url)) { rec.closed.push({ url, index }); if (rec.closed.length > CLOSED_KEEP) rec.closed.shift(); } // memory only: gone with the window
      rec.win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    if (!alive(rec)) return;
    if (!rec.tabs.length) { rec.win.close(); return; }
    if (rec.activeId === id) {
      rec.activeId = rec.tabs[Math.min(index, rec.tabs.length - 1)].id;
      rec.win.webContents.send('private:find-close');
      focusFor(rec, activeTab(rec), isNewTab(activeTab(rec).view.webContents));
    }
    layout(rec);
    sendState(rec);
  }

  function reopenClosed(rec) {
    const last = rec.closed.pop();
    if (last) openTab(rec, last.url, { index: last.index });
  }

  function switchTab(rec, id, { focus = true } = {}) {
    if (!rec.tabs.some((t) => t.id === id) || rec.activeId === id) return; // already in front: nothing to redraw
    setActive(rec, id);
    layout(rec);
    sendState(rec);
    if (focus) focusFor(rec, activeTab(rec), isNewTab(activeTab(rec).view.webContents));
  }

  function moveTab(rec, id, index) {
    const from = rec.tabs.findIndex((t) => t.id === id);
    if (from < 0 || !Number.isInteger(index)) return;
    const [tab] = rec.tabs.splice(from, 1);
    rec.tabs.splice(Math.max(0, Math.min(index, rec.tabs.length)), 0, tab);
    sendState(rec);
  }

  function cycle(rec, step) {
    const i = rec.tabs.findIndex((t) => t.id === rec.activeId);
    if (i < 0 || rec.tabs.length < 2) return;
    switchTab(rec, rec.tabs[(i + step + rec.tabs.length) % rec.tabs.length].id);
  }

  function zoom(wc, step) {
    if (!wc || wc.isDestroyed()) return;
    if (deps.zoom) deps.zoom(wc, step);
    else wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step);
    const rec = [...windows].find((r) => r.tabs.some((tab) => tab.view.webContents === wc));
    if (rec) sendStateSoon(rec);
  }

  // Screenshot (features/screenshot.js) of this window's front tab. Private: copies, never saves on its own.
  function screenshotCtx(rec) {
    const tab = activeTab(rec);
    if (!tab || !alive(rec) || tab.view.webContents.isDestroyed()) return null;
    const wc = tab.view.webContents;
    return { wc, win: rec.win, view: tab.view, isPrivate: true, askAi: null, restoreFocus: () => { if (!wc.isDestroyed()) wc.focus(); } };
  }

  function openFind(rec) {
    rec.win.webContents.focus();
    rec.win.webContents.send('private:find-open');
  }

  // The commands the keyboard, the macOS menu bar and the UI share. Returns false for one this window doesn't have.
  function command(rec, name) {
    const wc = activeTab(rec)?.view.webContents;
    const live = wc && !wc.isDestroyed() ? wc : null;
    switch (name) {
      case 'newTab': openTab(rec); break;
      case 'newWindow': open(); break;
      case 'closeTab': if (rec.activeId) closeTab(rec, rec.activeId); break;
      case 'closeWindow': rec.win.close(); break;
      case 'reopenTab': reopenClosed(rec); break;
      case 'focusAddress': rec.win.webContents.focus(); rec.win.webContents.send('private:focus-address'); break;
      case 'reload': live?.reload(); break;
      case 'forceReload': live?.reloadIgnoringCache(); break;
      case 'stop': live?.stop(); break;
      case 'back': live?.navigationHistory.goBack(); break;
      case 'forward': live?.navigationHistory.goForward(); break;
      case 'nextTab': cycle(rec, 1); break;
      case 'previousTab': cycle(rec, -1); break;
      case 'find': openFind(rec); break;
      case 'findNext': case 'findPrevious': rec.win.webContents.send('private:find-step', name === 'findNext' ? 1 : -1); break;
      case 'zoomIn': zoom(live, 0.5); break;
      case 'zoomOut': zoom(live, -0.5); break;
      case 'actualSize': zoom(live, 0); break;
      case 'print': live?.print({}, () => {}); break;
      case 'devTools': live?.toggleDevTools(); break;
      case 'screenshot': { const ctx = screenshotCtx(rec); if (ctx) deps.screenshot?.(ctx).catch(() => {}); break; }
      case 'settings': deps.openSettings?.(); break;
      case 'fullScreen': rec.win.setFullScreen(!rec.win.isFullScreen()); break;
      default: return false;
    }
    return true;
  }

  function handleShortcut(rec, event, input) {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const mac = platform === 'darwin';
    const key = input.key.toLowerCase();
    let name = null;
    if (mod && input.shift && key === 'n') name = 'newWindow';
    else if (mod && input.shift && key === 't') name = 'reopenTab';
    else if (mod && input.shift && key === 'w') name = 'closeWindow';
    else if (mod && key === 't') name = 'newTab';
    else if (mod && key === 'w') name = 'closeTab';
    else if (mod && key === 'l') name = 'focusAddress';
    else if (mod && input.shift && !input.alt && key === 's') name = 'screenshot';
    else if (mod && key === 'f') name = 'find';
    else if ((mod && key === 'g') || key === 'f3') name = input.shift ? 'findPrevious' : 'findNext';
    else if (mod && /^[1-9]$/.test(key) && !input.shift && !input.alt) {
      const tab = key === '9' ? rec.tabs[rec.tabs.length - 1] : rec.tabs[Number(key) - 1];
      if (tab) switchTab(rec, tab.id);
      event.preventDefault();
      return;
    } else if (mod && input.shift && (key === 'pageup' || key === 'pagedown')) {
      const i = rec.tabs.findIndex((t) => t.id === rec.activeId);
      if (i >= 0) moveTab(rec, rec.activeId, i + (key === 'pageup' ? -1 : 1));
      event.preventDefault();
      return;
    } else if (mod && key === 'tab') name = input.shift ? 'previousTab' : 'nextTab';
    else if (mod && (key === 'pageup' || key === 'pagedown')) name = key === 'pageup' ? 'previousTab' : 'nextTab';
    else if (mac && input.meta && input.alt && (key === 'arrowright' || key === 'arrowleft')) name = key === 'arrowright' ? 'nextTab' : 'previousTab';
    else if (mac && input.meta && input.shift && ['[', ']', '{', '}'].includes(key)) name = key === ']' || key === '}' ? 'nextTab' : 'previousTab';
    else if (mac && input.meta && key === '[') name = 'back';
    else if (mac && input.meta && key === ']') name = 'forward';
    else if (mod && key === 'r') name = input.shift ? 'forceReload' : 'reload';
    else if (key === 'f5') name = input.shift || input.control ? 'forceReload' : 'reload';
    else if (mod && (key === '=' || key === '+')) name = 'zoomIn';
    else if (mod && key === '-') name = 'zoomOut';
    else if (mod && key === '0') name = 'actualSize';
    else if (mod && key === 'p') name = 'print';
    else if (key === 'f12' || (mod && input.alt && key === 'i')) name = 'devTools';
    else if (mod && key === ',') name = 'settings';
    else if (key === 'f11' && !mac) name = 'fullScreen';
    else if (input.alt && !mod && key === 'arrowleft') name = 'back';
    else if (input.alt && !mod && key === 'arrowright') name = 'forward';
    else if (key === 'escape' && activeTab(rec)?.view.webContents.isLoading()) { command(rec, 'stop'); return; } // (the page still gets its Escape)
    if (name && command(rec, name)) event.preventDefault();
  }

  function hideForTests(win) {
    // LUMEN_TEST_BACKGROUND: invisible, click-through and off-screen, as main.js's test windows are.
    win.setOpacity(0); win.setIgnoreMouseEvents(true); win.setPosition(-5000, -5000); win.showInactive();
  }

  function open(url) {
    const partition = `lumen-private-${crypto.randomUUID()}`; // no "persist:" prefix: memory only
    const mac = platform === 'darwin';
    const win = new BrowserWindow({
      width: 1200, height: 820, minWidth: 600, minHeight: 400,
      title: t('private.windowTitle', { title: t('private.newTab') }), icon: deps.iconPath, backgroundColor: '#1d1530',
      ...(deps.testBackground ? { show: false } : {}),
      // The dark private frame reaches the top of the window: the tab strip is the title bar, as in a normal window.
      ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 11 } } : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#ece6ff', height: 36 } }),
      webPreferences: { preload: path.join(__dirname, 'private-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    if (deps.testBackground) hideForTests(win);
    win.setMenuBarVisibility(false);
    const rec = { win, partition, ses: session.fromPartition(partition), tabs: [], activeId: null, decisions: new Map(), externalDecisions: new Map(), closed: [], downloads: [], popups: new Set(), icons: new Map(), stateTimer: null };
    windows.add(rec);
    setupSession(rec);
    // The private UI shows one local file and nothing else.
    win.webContents.on('will-navigate', (event) => { if (!sameFile(event.url, UI_URL)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (event, input) => handleShortcut(rec, event, input));
    win.on('resize', () => layout(rec));
    win.on('enter-full-screen', () => win.webContents.send('private:fullscreen', true));
    win.on('leave-full-screen', () => { win.webContents.send('private:fullscreen', false); for (const tab of rec.tabs) tab.fullscreen = false; layout(rec); });
    win.on('focus', () => deps.onFocusChange?.());
    win.on('blur', () => deps.onFocusChange?.());
    // Closing with downloads still running asks first (they would stop: the window's session goes with it).
    win.on('close', (event) => {
      const running = rec.downloads.filter((d) => d.state === 'progressing');
      if (!running.length || rec.closeAnswered) return;
      event.preventDefault();
      if (rec.asking) return;
      rec.asking = true;
      dialog.showMessageBox(win, {
        type: 'warning', buttons: [t('private.close.keep'), t('private.close.confirm')], defaultId: 0, cancelId: 0,
        message: t(running.length === 1 ? 'private.close.downloadsOne' : 'private.close.downloads', { count: running.length }), detail: t('private.close.detail'),
      }).then(({ response }) => {
        rec.asking = false;
        if (response !== 1 || win.isDestroyed()) return;
        rec.closeAnswered = true;
        win.close();
      }, () => { rec.asking = false; });
    });
    win.on('closed', () => {
      windows.delete(rec);
      clearImmediate(rec.stateTimer);
      for (const d of rec.downloads) if (d.state === 'progressing') { try { d.item.cancel(); } catch {} }
      for (const tab of rec.tabs.splice(0)) { try { tab.view.webContents.close(); } catch {} }
      for (const p of rec.popups) if (!p.isDestroyed()) p.destroy(); // its sign-in popups go with it
      rec.downloads = [];
      rec.closed = [];
      rec.icons.clear();
      rec.decisions.clear();
      rec.externalDecisions.clear();
      // Memory-only already; clear it now so nothing lingers until Lumen quits.
      const ses = rec.ses;
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
      ses.clearAuthCache?.().catch?.(() => {});
      ses.clearHostResolverCache?.().catch?.(() => {});
      ses.closeAllConnections?.().catch?.(() => {});
      deps.releaseSession?.(ses);
      deps.onFocusChange?.();
    });
    win.loadFile(UI_HTML);
    win.webContents.once('did-finish-load', () => openTab(rec, url));
    return rec;
  }

  const handlers = {
    'private:new-tab': (rec) => openTab(rec),
    'private:new-window': () => open(),
    'private:close-tab': (rec, id) => closeTab(rec, Number(id)),
    'private:switch': (rec, id) => switchTab(rec, Number(id)),
    'private:move': (rec, arg) => moveTab(rec, Number(arg?.id), Number(arg?.index)),
    'private:go': (rec, text) => {
      const url = resolveInput(String(text || '').trim());
      const tab = activeTab(rec);
      if (!url || !isWebUrl(url)) return;
      if (tab) { tab.view.webContents.loadURL(url).catch(() => {}); tab.view.webContents.focus(); } else openTab(rec, url);
    },
    'private:back': (rec) => command(rec, 'back'),
    'private:forward': (rec) => command(rec, 'forward'),
    'private:reload': (rec) => command(rec, activeTab(rec)?.view.webContents.isLoading() ? 'stop' : 'reload'),
    'private:zoom-reset': (rec) => command(rec, 'actualSize'),
    'private:focus-page': (rec) => { const wc = activeTab(rec)?.view.webContents; if (wc && !wc.isDestroyed()) wc.focus(); },
    'private:find': (rec, arg) => {
      const wc = activeTab(rec)?.view.webContents;
      const text = String(arg?.text || '');
      if (!wc || wc.isDestroyed()) return;
      if (!text) { wc.stopFindInPage('clearSelection'); rec.win.webContents.send('private:find-result', { active: 0, total: 0 }); return; }
      wc.findInPage(text, { forward: arg?.forward !== false, findNext: !arg?.findNext }); // (Electron's findNext: true starts a new search)
    },
    'private:find-stop': (rec) => { const wc = activeTab(rec)?.view.webContents; if (wc && !wc.isDestroyed()) { wc.stopFindInPage('keepSelection'); wc.focus(); } },
    'private:downloads': (rec, at) => {
      if (!deps.Menu) return;
      const x = Math.round(Number(at?.x) || 0);
      const y = Math.round(Number(at?.y) || 0);
      deps.Menu.buildFromTemplate(downloadsMenu(rec)).popup({ window: rec.win, x, y });
    },
  };
  // Answer only a private window's own UI document (its top frame, showing renderer/private.html).
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.on(channel, (event, arg) => {
      const rec = recFor(event);
      if (!rec) { console.error(`[lumen] refused ${channel} from ${event.sender.getURL?.().slice(0, 80)}`); return; }
      fn(rec, arg);
    });
  }
  ipcMain.on('private:strings', (event) => {
    event.returnValue = recFor(event) ? { locale: deps.locale?.() || 'en', strings: stringTable(), platform } : { locale: 'en', strings: {}, platform };
  });

  const focusedRec = () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused ? [...windows].find((r) => alive(r) && r.win === focused) : null;
  };
  const tabOwner = (wc) => [...windows].find((r) => r.tabs.some((tab) => tab.view.webContents === wc));

  return {
    open,
    count: () => [...windows].filter(alive).length,
    // A private window has the keyboard: the macOS menu bar's commands go to it (and the ones it lacks do nothing).
    focused: () => Boolean(focusedRec()),
    command: (name) => { const rec = focusedRec(); if (!rec) return false; command(rec, name); return true; },
    // One of this module's tabs (Safe Browsing and certificate warnings treat it as a tab).
    ownsTab: (wc) => Boolean(wc && tabOwner(wc)),
    // [passkeys] Is this one of our tabs, the one in front of its window? (features/passkeys.js owns the dialog to that window.)
    tabWindow: (wc) => {
      const rec = wc ? tabOwner(wc) : null;
      if (!rec || !alive(rec)) return null;
      const tab = activeTab(rec);
      return { win: rec.win, active: Boolean(tab && tab.view.webContents === wc) };
    },
    refresh: (wc) => { const rec = tabOwner(wc); if (rec) sendStateSoon(rec); },
    // Test hooks read these; nothing in the app itself needs them.
    list: () => [...windows].filter(alive).map((rec) => ({
      windowId: rec.win.id, partition: rec.partition, activeId: rec.activeId,
      tabs: rec.tabs.map((tab) => ({ id: tab.id, url: tab.view.webContents.getURL(), contentsId: tab.view.webContents.id, favicon: tab.favicon, fullscreen: Boolean(tab.fullscreen) })),
      downloads: rec.downloads.map(({ id, name, path: file, state, received, total }) => ({ id, name, path: file, state, received, total })),
      closed: rec.closed.map((c) => c.url),
      decisions: [...rec.decisions.keys()],
    })),
    screenshotCtx: (windowId) => { const rec = recById(windowId); return rec ? screenshotCtx(rec) : null; },
    shortcut: (windowId, input) => { const rec = recById(windowId); if (rec) handleShortcut(rec, { preventDefault() {} }, { type: 'keyDown', control: false, meta: false, shift: false, alt: false, ...input }); },
    run: (windowId, name) => { const rec = recById(windowId); return rec ? command(rec, name) : false; },
    downloadsMenu: (windowId) => { const rec = recById(windowId); return rec ? downloadsMenu(rec).map((i) => i.label || i.type) : null; },
    find: (windowId) => recById(windowId),
    openTab: (windowId, url) => { const rec = recById(windowId); return rec ? openTab(rec, url)?.id : null; },
  };
}

module.exports = { createPrivateWindows };

// Private windows (Ctrl+Shift+N). Each one is a separate BrowserWindow with its own small UI
// (renderer/private.html) and its own in-memory session: the partition name has no "persist:"
// prefix, so cookies, cache and storage live only in memory, and a fresh random name per window
// means two private windows never share a login. Closing the window clears that session.
//
// Nothing here touches main.js's tab list, so by construction a private tab is never in history,
// session restore, the downloads list, tab groups, the AI's tools (list_tabs, navigate, ...) or the
// automation proxy (automation.js only exposes main.js's tabs). The AI sidebar isn't offered at all:
// its chat is saved to disk and its providers are remote, which a private window shouldn't do.
// Extensions and the ad blocker are tied to the default session and don't run here either.
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const UI_HTML = path.join(__dirname, '..', 'renderer', 'private.html');
const NEWTAB_HTML = path.join(__dirname, '..', 'renderer', 'private-newtab.html');
const TOP = 78; // tab strip + toolbar height in renderer/private.css
const PROMPTABLE = { media: 'use your camera and microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'read your clipboard' };
const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

const sameFile = (a, b) => {
  try { return new URL(a).pathname.toLowerCase() === new URL(b).pathname.toLowerCase() && new URL(a).protocol === 'file:'; } catch { return false; }
};

// deps: { BrowserWindow, WebContentsView, session, ipcMain, dialog, resolveInput, isWebUrl, iconPath, test, screenshot(ctx) }
function createPrivateWindows(deps) {
  const { BrowserWindow, WebContentsView, session, ipcMain, dialog, resolveInput, isWebUrl } = deps;
  const UI_URL = pathToFileURL(UI_HTML).href;
  const NEWTAB_URL = pathToFileURL(NEWTAB_HTML).href;
  const windows = new Set(); // { win, partition, ses, tabs: [{ id, view }], activeId, decisions }
  let nextId = 1;

  const alive = (rec) => rec.win && !rec.win.isDestroyed();
  const recFor = (event) => [...windows].find((rec) => alive(rec) && event.sender === rec.win.webContents
    && event.senderFrame === event.sender.mainFrame && sameFile(event.senderFrame?.url, UI_URL));
  const activeTab = (rec) => rec.tabs.find((t) => t.id === rec.activeId);
  const shownUrl = (wc) => (sameFile(wc.getURL(), NEWTAB_URL) ? '' : wc.getURL());

  function sendState(rec) {
    if (!alive(rec)) return;
    const active = activeTab(rec);
    const wc = active?.view.webContents;
    rec.win.webContents.send('private:state', {
      tabs: rec.tabs.map((t) => ({ id: t.id, title: t.view.webContents.getTitle() || 'New Tab', url: shownUrl(t.view.webContents), loading: t.view.webContents.isLoading(), active: t.id === rec.activeId })),
      url: wc ? shownUrl(wc) : '',
      canBack: Boolean(wc?.navigationHistory.canGoBack()),
      canForward: Boolean(wc?.navigationHistory.canGoForward()),
    });
    rec.win.setTitle(`${active?.view.webContents.getTitle() || 'New Tab'} - Lumen (Private)`);
  }

  function layout(rec) {
    if (!alive(rec)) return;
    const [width, height] = rec.win.getContentSize();
    for (const t of rec.tabs) {
      t.view.setBounds({ x: 0, y: TOP, width, height: Math.max(0, height - TOP) });
      t.view.setVisible(t.id === rec.activeId);
    }
  }

  function setupSession(rec) {
    const ses = rec.ses;
    // The profile's proxy, Do Not Track / Global Privacy Control, languages and Chrome hints (settings-backend.js);
    // without it, a private window would connect directly even when a proxy is set.
    if (deps.mirrorSession) deps.mirrorSession(ses);
    else if (deps.chromeHintHeaders) {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;
        if (/^https:/.test(details.url)) {
          for (const name of Object.keys(headers)) if (/^sec-ch-ua(-mobile|-platform)?$/i.test(name)) delete headers[name];
          Object.assign(headers, deps.chromeHintHeaders);
        }
        callback({ requestHeaders: headers });
      });
    }
    ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return callback(true);
      const reason = PROMPTABLE[permission];
      let origin;
      try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return callback(false); }
      if (!reason || !isWebUrl(origin)) return callback(false);
      const key = `${origin}|${permission}`;
      if (rec.decisions.has(key)) return callback(rec.decisions.get(key));
      if (!alive(rec)) return callback(false);
      // Remembered for this window only; nothing is written to settings.json.
      const { response } = await dialog.showMessageBox(rec.win, {
        type: 'question', buttons: ["Don't Allow", 'Allow'], defaultId: 0, cancelId: 0,
        message: `Allow ${new URL(origin).host} to ${reason}?`, detail: 'Only for this private window.',
      });
      rec.decisions.set(key, response === 1);
      callback(response === 1);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => ALWAYS_ALLOWED.has(permission) || rec.decisions.get(`${origin}|${permission}`) === true);
    // Downloads get the normal save dialog (no savePath set) and never enter Lumen's downloads list.
  }

  function wireTab(rec, tab) {
    const wc = tab.view.webContents;
    const update = () => sendState(rec);
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, update);
    wc.on('before-input-event', (event, input) => handleShortcut(rec, event, input));
    // Only web pages (and the private new-tab page) in a private tab.
    wc.on('will-navigate', (event) => { if (!isWebUrl(event.url) && !sameFile(event.url, NEWTAB_URL)) event.preventDefault(); });
    deps.chromeIdentity?.(wc);
    pageMenu(rec, wc);
    wc.setWindowOpenHandler(({ url, disposition }) => popupOrTab(rec, url, disposition));
    wc.on('destroyed', () => closeTab(rec, tab.id, { destroyed: true }));
  }

  // A sign-in or payment popup ("Sign in with Google" on a site) stays a popup, in this window's private session,
  // with window.opener kept so it can report back to the page; a link that opens a tab opens a private tab.
  // A right-click menu for private pages and popups: edit, and open a link in a new private tab.
  function pageMenu(rec, wc) {
    if (!deps.Menu) return;
    wc.on('context-menu', (_e, p) => {
      const items = [];
      if (p.linkURL && isWebUrl(p.linkURL)) items.push({ label: 'Open Link in New Private Tab', click: () => openTab(rec, p.linkURL, { background: true }) }, { type: 'separator' });
      if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
      else if (p.selectionText) items.push({ role: 'copy' });
      if (!items.length) return;
      deps.Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || rec.win });
    });
  }
  function popupOrTab(rec, url, disposition) {
    if (disposition === 'new-window' && (isWebUrl(url) || url === 'about:blank')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: deps.iconPath, backgroundColor: '#1d1530', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } },
        outlivesOpener: true,
        createWindow: (options) => {
          const child = new BrowserWindow({ ...options, autoHideMenuBar: true, icon: deps.iconPath, backgroundColor: '#1d1530', ...(options?.webContents ? { webContents: options.webContents } : { webPreferences: { session: rec.ses, sandbox: true, contextIsolation: true, nodeIntegration: false } }) });
          const wc = child.webContents;
          if (!options?.webContents) wc.loadURL(url).catch(() => {});
          deps.chromeIdentity?.(wc);
          // The title bar says which site this is (a popup has no address bar), private and with a lock when secure.
          const retitle = () => { if (child.isDestroyed()) return; try { const u = new URL(wc.getURL()); child.setTitle(`${u.protocol === 'https:' ? '🔒 ' : ''}${u.host} — Private${wc.getTitle() ? ` — ${wc.getTitle()}` : ''}`); } catch { child.setTitle('Lumen (Private)'); } };
          wc.on('page-title-updated', (e) => { e.preventDefault(); retitle(); });
          wc.on('did-navigate', retitle);
          wc.on('did-navigate-in-page', retitle);
          pageMenu(rec, wc);
          // It belongs to this private window: it closes with it (whose session is then cleared).
          (rec.popups ||= new Set()).add(child);
          child.on('closed', () => rec.popups?.delete(child));
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
        createWindow: (options) => (options?.webContents ? openTab(rec, url, { background: disposition === 'background-tab', webContents: options.webContents }) : openTab(rec, url, { background: disposition === 'background-tab' }))?.view.webContents,
      };
    }
    if (isWebUrl(url)) openTab(rec, url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  }

  // webContents: a page that already exists (a window.open), adopted as this tab.
  function openTab(rec, url, { background = false, webContents = null } = {}) {
    if (!alive(rec)) return null;
    const view = webContents ? new WebContentsView({ webContents }) : new WebContentsView({ webPreferences: { session: rec.ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tab = { id: nextId++, view };
    rec.tabs.push(tab);
    rec.win.contentView.addChildView(view);
    wireTab(rec, tab);
    if (!background || !rec.activeId) rec.activeId = tab.id;
    layout(rec);
    if (webContents) { /* adopted: already on its way to its address */ } else if (url && isWebUrl(url)) view.webContents.loadURL(url).catch(() => {});
    else view.webContents.loadFile(NEWTAB_HTML).catch(() => {});
    if (rec.activeId === tab.id && !url) rec.win.webContents.send('private:focus-address');
    sendState(rec);
    return tab;
  }

  function closeTab(rec, id, { destroyed = false } = {}) {
    const index = rec.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = rec.tabs.splice(index, 1);
    if (!destroyed && alive(rec)) {
      rec.win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    if (!alive(rec)) return;
    if (!rec.tabs.length) { rec.win.close(); return; }
    if (rec.activeId === id) rec.activeId = rec.tabs[Math.min(index, rec.tabs.length - 1)].id;
    layout(rec);
    sendState(rec);
  }

  function switchTab(rec, id) {
    if (!rec.tabs.some((t) => t.id === id) || rec.activeId === id) return; // already in front: nothing to redraw
    rec.activeId = id;
    layout(rec);
    sendState(rec);
  }

  // Screenshot (features/screenshot.js) of this window's front tab. Private: copies, never saves on its own.
  function screenshotCtx(rec) {
    const tab = activeTab(rec);
    if (!tab || !alive(rec) || tab.view.webContents.isDestroyed()) return null;
    const wc = tab.view.webContents;
    return { wc, win: rec.win, view: tab.view, isPrivate: true, askAi: null, restoreFocus: () => { if (!wc.isDestroyed()) wc.focus(); } };
  }

  function handleShortcut(rec, event, input) {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const wc = activeTab(rec)?.view.webContents;
    let handled = true;
    if (mod && input.shift && key === 'n') open();
    else if (mod && key === 't') openTab(rec);
    else if (mod && key === 'w') { if (rec.activeId) closeTab(rec, rec.activeId); }
    else if (mod && key === 'l') { rec.win.webContents.focus(); rec.win.webContents.send('private:focus-address'); }
    else if (mod && input.shift && !input.alt && key === 's') { const ctx = screenshotCtx(rec); if (ctx) deps.screenshot?.(ctx).catch(() => {}); }
    else if (mod && key === 'tab') {
      const i = rec.tabs.findIndex((t) => t.id === rec.activeId);
      switchTab(rec, rec.tabs[(i + (input.shift ? -1 : 1) + rec.tabs.length) % rec.tabs.length].id);
    } else if ((mod && key === 'r') || key === 'f5') wc?.reload();
    else if (input.alt && key === 'arrowleft') wc?.navigationHistory.goBack();
    else if (input.alt && key === 'arrowright') wc?.navigationHistory.goForward();
    else handled = false;
    if (handled) event.preventDefault();
  }

  function open(url) {
    const partition = `lumen-private-${crypto.randomUUID()}`; // no "persist:" prefix: memory only
    const win = new BrowserWindow({
      width: 1200, height: 820, minWidth: 600, minHeight: 400,
      title: 'Lumen (Private)', icon: deps.iconPath, backgroundColor: '#1d1530',
      webPreferences: { preload: path.join(__dirname, 'private-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    const rec = { win, partition, ses: session.fromPartition(partition), tabs: [], activeId: null, decisions: new Map() };
    windows.add(rec);
    setupSession(rec);
    // The private UI shows one local file and nothing else.
    win.webContents.on('will-navigate', (event) => { if (!sameFile(event.url, UI_URL)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (event, input) => handleShortcut(rec, event, input));
    win.on('resize', () => layout(rec));
    win.on('closed', () => {
      windows.delete(rec);
      for (const t of rec.tabs.splice(0)) { try { t.view.webContents.close(); } catch {} }
      // Memory-only already; clear it now so nothing lingers until Lumen quits.
      for (const p of rec.popups || []) if (!p.isDestroyed()) p.destroy(); // its sign-in popups go with it
      rec.ses.clearStorageData().catch(() => {});
      rec.ses.clearCache().catch(() => {});
      rec.ses.clearAuthCache?.().catch?.(() => {});
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
    'private:go': (rec, text) => {
      const url = resolveInput(String(text || '').trim());
      const tab = activeTab(rec);
      if (!url || !isWebUrl(url)) return;
      if (tab) tab.view.webContents.loadURL(url).catch(() => {});
      else openTab(rec, url);
    },
    'private:back': (rec) => activeTab(rec)?.view.webContents.navigationHistory.goBack(),
    'private:forward': (rec) => activeTab(rec)?.view.webContents.navigationHistory.goForward(),
    'private:reload': (rec) => activeTab(rec)?.view.webContents.reload(),
  };
  // Answer only a private window's own UI document (its top frame, showing renderer/private.html).
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.on(channel, (event, arg) => {
      const rec = recFor(event);
      if (!rec) { console.error(`[lumen] refused ${channel} from ${event.sender.getURL?.().slice(0, 80)}`); return; }
      fn(rec, arg);
    });
  }

  return {
    open,
    count: () => [...windows].filter(alive).length,
    // Test hooks read these; nothing in the app itself needs them.
    list: () => [...windows].filter(alive).map((rec) => ({
      windowId: rec.win.id, partition: rec.partition,
      tabs: rec.tabs.map((t) => ({ id: t.id, url: t.view.webContents.getURL(), contentsId: t.view.webContents.id })),
    })),
    screenshotCtx: (windowId) => { const rec = [...windows].find((r) => alive(r) && r.win.id === windowId); return rec ? screenshotCtx(rec) : null; },
    shortcut: (windowId, input) => { const rec = [...windows].find((r) => alive(r) && r.win.id === windowId); if (rec) handleShortcut(rec, { preventDefault() {} }, { type: 'keyDown', control: false, meta: false, shift: false, alt: false, ...input }); },
    find: (windowId) => [...windows].find((rec) => alive(rec) && rec.win.id === windowId),
    openTab: (windowId, url) => { const rec = [...windows].find((r) => alive(r) && r.win.id === windowId); return rec ? openTab(rec, url)?.id : null; },
  };
}

module.exports = { createPrivateWindows };

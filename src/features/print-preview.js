// ---------- print preview: what Print (Ctrl+P and every Print entry) opens, as in Chrome ----------
//
// A sheet over the window: the pages on the left, the settings on the right (renderer/print-preview.html).
//   - The pages are the tab's own webContents.printToPDF() output, written to a temp file and shown in a second
//     view by Chromium's built-in PDF viewer (the one a PDF tab uses). Every change of a setting renders again.
//   - Destination "Save as PDF" asks for a file with the OS save dialog (the page title as the name) and writes
//     the same bytes; a printer gets webContents.print() with the same settings, silently. "Print using system
//     dialog…" (Ctrl+Shift+P) is the old plain webContents.print({}).
//   - A PDF tab (the viewer) is shown as the document it is: its own bytes, no layout settings, but pages,
//     copies, color and two-sided still apply when printing it.
// The settings page can only send a settings object (checked by print-options.normalize) and click buttons: it
// never names a path, and the only file the preview writes is the one the user confirms in the save dialog.
//
// deps: { t, strings() -> the UI string table, readSettings(), writeSettings(s), win() -> the main window,
//         paths: { preload, html }, restoreFocus(wc), tempDir (default os.tmpdir()), downloadsDir() }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const options = require('./print-options');

const PREF_KEY = 'printPrefs';
const MAX_PDF_BYTES = 300 * 1024 * 1024;

function createPrintPreview(deps) {
  const { BrowserWindow, WebContentsView, ipcMain, dialog } = deps.electron || require('electron');
  // The pickers tests replace: a native save dialog can't be clicked by a test.
  const pickers = { save: (win, opts) => dialog.showSaveDialog(win, opts) };
  let sheet = null; // the one preview on screen

  const isOwn = (event) => Boolean(sheet) && event.sender === sheet.overlay.webContents && event.senderFrame === event.sender.mainFrame;
  const send = (channel, payload) => { if (sheet && !sheet.overlay.webContents.isDestroyed()) sheet.overlay.webContents.send(channel, payload); };

  async function pdfBytesOf(wc) {
    const url = deps.pdfUrlOf?.(wc.getURL()) || wc.getURL();
    if (/^file:/i.test(url)) return fs.promises.readFile(fileURLToPath(url));
    const res = await wc.session.fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES) throw new Error('too large');
    return buf;
  }

  function layout() {
    if (!sheet || sheet.closed || sheet.host.isDestroyed()) return;
    const [width, height] = sheet.host.getContentSize();
    sheet.overlay.setBounds({ x: 0, y: 0, width, height });
    placePdfView();
  }

  function placePdfView() {
    if (!sheet || !sheet.pdfView || !sheet.rect) return;
    const [width, height] = sheet.host.getContentSize();
    const r = sheet.rect;
    const x = Math.max(0, Math.min(width, Math.round(r.x)));
    const y = Math.max(0, Math.min(height, Math.round(r.y)));
    sheet.pdfView.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(r.width))), height: Math.max(0, Math.min(height - y, Math.round(r.height))) });
  }

  // The preview's own view of the PDF: it shows only files this sheet wrote in its own temp folder.
  function ensurePdfView() {
    if (sheet.pdfView && !sheet.pdfView.webContents.isDestroyed()) return sheet.pdfView;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    view.setBackgroundColor('#00000000');
    const dirUrl = pathToFileURL(sheet.dir).href.toLowerCase();
    view.webContents.on('will-navigate', (event) => { if (!event.url.toLowerCase().startsWith(dirUrl)) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close('cancel'); }
    });
    sheet.pdfView = view;
    sheet.host.contentView.addChildView(view);
    placePdfView();
    return view;
  }

  async function showPdf(buffer) {
    const file = path.join(sheet.dir, `preview-${++sheet.serial}.pdf`);
    await fs.promises.writeFile(file, buffer);
    if (!sheet || sheet.closed) return;
    const view = ensurePdfView();
    // The viewer without its own toolbar and side panel, the page fitted to the width.
    view.webContents.loadURL(`${pathToFileURL(file).href}#toolbar=0&navpanes=0&view=FitH`).catch(() => {});
    send('print:pdf-shown', {});
  }

  // printToPDF of a page that is still settling can fail once; asking again a moment later works.
  async function pdfOf(wc, pdfOptions) {
    try { return await wc.printToPDF(pdfOptions); } catch (err) {
      await new Promise((r) => setTimeout(r, 400));
      if (wc.isDestroyed()) throw err;
      return wc.printToPDF(pdfOptions);
    }
  }

  // One preview render at a time; a newer request replaces the one waiting.
  async function render(raw) {
    const mine = sheet;
    const s = options.normalize(raw, { printers: mine.printerNames });
    const reply = (payload) => { if (sheet === mine && !mine.closed) send('print:rendered', { seq: raw?.seq, ...payload }); };
    try {
      if (mine.mode === 'pdf') {
        const pages = options.countPdfPages(mine.original) || null;
        if (s.pages === 'custom') {
          const parsed = options.parseRanges(s.ranges, pages);
          if (!parsed.ok) { reply({ error: parsed.outOf ? 'outOf' : 'range', total: pages }); return; }
        }
        if (!mine.shownOriginal) { mine.shownOriginal = true; await showPdf(mine.original); }
        reply({ pages, total: pages });
        return;
      }
      const wc = mine.wc;
      if (wc.isDestroyed()) return;
      let pdfOptions = options.toPrintToPdfOptions(s);
      if (s.pages === 'custom') {
        const parsed = options.parseRanges(s.ranges);
        if (!parsed.ok) { reply({ error: 'range', total: mine.total }); return; }
        // The page count behind the range: learned from an unranged render whenever the layout changed.
        const layoutKey = JSON.stringify({ ...pdfOptions, pageRanges: undefined });
        if (mine.totalKey !== layoutKey) {
          const all = await pdfOf(wc, { ...pdfOptions, pageRanges: undefined });
          mine.total = options.countPdfPages(all);
          mine.totalKey = layoutKey;
        }
        const checked = options.parseRanges(s.ranges, mine.total);
        if (!checked.ok) { reply({ error: 'outOf', total: mine.total }); return; }
      }
      const buffer = await pdfOf(wc, pdfOptions);
      const pages = options.countPdfPages(buffer);
      if (s.pages !== 'custom') { mine.total = pages; mine.totalKey = JSON.stringify({ ...pdfOptions, pageRanges: undefined }); }
      mine.last = { key: JSON.stringify(pdfOptions), buffer };
      await showPdf(buffer);
      reply({ pages, total: mine.total });
    } catch (err) {
      reply({ error: 'render', detail: String(err?.message || err).slice(0, 200) });
    }
  }

  function requestRender(raw) {
    const mine = sheet;
    mine.pending = raw;
    if (mine.rendering) return;
    mine.rendering = true;
    (async () => {
      while (sheet === mine && !mine.closed && mine.pending) {
        const next = mine.pending;
        mine.pending = null;
        await render(next);
      }
      mine.rendering = false;
    })();
  }

  function remember(s) {
    try { deps.writeSettings({ ...deps.readSettings(), [PREF_KEY]: s }); } catch (err) { console.error('[lumen] could not save print settings:', err.message); }
  }

  // The bytes "Save as PDF" writes: what the preview shows, rendered afresh when the settings moved on.
  async function bytesToSave(s) {
    if (sheet.mode === 'pdf') return sheet.original;
    const pdfOptions = options.toPrintToPdfOptions(s);
    const key = JSON.stringify(pdfOptions);
    if (sheet.last && sheet.last.key === key) return sheet.last.buffer;
    return pdfOf(sheet.wc, pdfOptions);
  }

  async function save(raw) {
    const mine = sheet;
    const s = options.normalize(raw, { printers: mine.printerNames });
    if (s.pages === 'custom' && !options.parseRanges(s.ranges).ok) return;
    try {
      const buffer = await bytesToSave(s);
      const name = `${options.sanitizeFileName(mine.title || mine.wc.getTitle?.() || '', 'page')}.pdf`;
      const result = await pickers.save(mine.host, {
        title: deps.t('print.saveTitle'),
        defaultPath: path.join(deps.downloadsDir ? deps.downloadsDir() : os.homedir(), name),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (sheet !== mine || mine.closed) return;
      if (!result || result.canceled || !result.filePath) return; // back to the sheet: the user may change their mind
      const file = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
      await fs.promises.writeFile(file, buffer);
      remember(s);
      mine.saved = file;
      close('saved');
    } catch (err) {
      send('print:error', { message: deps.t('print.saveFailed', { reason: String(err?.message || err).slice(0, 160) }) });
    }
  }

  function printNow(raw) {
    const mine = sheet;
    const s = options.normalize(raw, { printers: mine.printerNames });
    if (s.destination === options.PDF) return;
    if (s.pages === 'custom' && !options.parseRanges(s.ranges).ok) return;
    const wc = mine.wc;
    if (wc.isDestroyed()) return;
    remember(s);
    send('print:busy', { busy: true });
    try {
      wc.print(options.toPrintOptions(s, { title: mine.title, url: wc.getURL() }), (success, reason) => {
        if (sheet !== mine || mine.closed) return;
        if (success) close('printed');
        else { send('print:busy', { busy: false }); send('print:error', { message: deps.t('print.printFailed', { reason: String(reason || 'unknown').slice(0, 160) }) }); }
      });
    } catch (err) {
      send('print:busy', { busy: false });
      send('print:error', { message: deps.t('print.printFailed', { reason: String(err?.message || err).slice(0, 160) }) });
    }
  }

  function close(action = 'cancel') {
    const mine = sheet;
    if (!mine || mine.closed) return;
    mine.closed = true;
    sheet = null;
    try { mine.host.removeListener('resize', mine.onResize); mine.host.removeListener('closed', mine.onHostClosed); } catch {}
    try { if (!mine.wc.isDestroyed()) { mine.wc.removeListener('did-start-navigation', mine.onNav); mine.wc.removeListener('destroyed', mine.onGone); } } catch {}
    for (const view of [mine.pdfView, mine.overlay]) {
      if (!view) continue;
      try { if (!mine.host.isDestroyed()) mine.host.contentView.removeChildView(view); } catch {}
      try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    }
    try { fs.rmSync(mine.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    if (action === 'system') { try { if (!mine.wc.isDestroyed()) mine.wc.print({}, () => {}); } catch {} }
    else if (!mine.host.isDestroyed()) deps.restoreFocus?.(mine.wc);
    mine.resolve({ action, file: mine.saved || null });
  }

  // Opens the preview over `host` for the tab `wc`. Resolves when it closes: { action: 'cancel'|'saved'|'printed'|'system', file }.
  function open({ wc, host, title = '' }) {
    if (!wc || wc.isDestroyed()) return Promise.resolve({ action: 'cancel', file: null });
    const win = host || BrowserWindow.fromWebContents(wc) || deps.win();
    if (!win || win.isDestroyed()) return Promise.resolve({ action: 'cancel', file: null });
    if (sheet) { try { sheet.overlay.webContents.focus(); } catch {} return Promise.resolve({ action: 'cancel', file: null }); }
    return new Promise((resolve) => {
      const overlay = new WebContentsView({ webPreferences: { preload: deps.paths.preload, sandbox: true, contextIsolation: true } });
      overlay.setBackgroundColor('#00000000');
      const ownUrl = pathToFileURL(deps.paths.html).href.toLowerCase();
      overlay.webContents.on('will-navigate', (event) => { const u = event.url.split(/[?#]/)[0].toLowerCase(); if (u !== ownUrl) event.preventDefault(); });
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const mine = {
        wc, host: win, overlay, pdfView: null, resolve, closed: false, serial: 0, rect: null,
        title: String(title || wc.getTitle?.() || '').slice(0, 300), mode: 'page', dir: fs.mkdtempSync(path.join(deps.tempDir || os.tmpdir(), 'lumen-print-')),
        printerNames: [], total: null, totalKey: null, last: null, pending: null, rendering: false, original: null, shownOriginal: false, saved: null,
      };
      mine.onResize = () => layout();
      mine.onHostClosed = () => close('cancel');
      mine.onNav = (details) => { if (details.isMainFrame && !details.isSameDocument) close('cancel'); };
      mine.onGone = () => close('cancel');
      sheet = mine;
      win.on('resize', mine.onResize);
      win.on('closed', mine.onHostClosed);
      wc.on('did-start-navigation', mine.onNav);
      wc.once('destroyed', mine.onGone);
      win.contentView.addChildView(overlay);
      layout();
      overlay.webContents.loadFile(deps.paths.html);
      overlay.webContents.once('did-finish-load', async () => {
        if (sheet !== mine) return;
        // A PDF tab is printed as the document it is.
        try {
          if (deps.isPdfTab?.(wc)) { mine.original = await pdfBytesOf(wc); mine.mode = 'pdf'; }
        } catch { mine.mode = 'page'; }
        if (sheet !== mine) return;
        const strings = {};
        for (const [key, value] of Object.entries(deps.strings())) if (key.startsWith('print.')) strings[key] = value;
        const printers = await wc.getPrintersAsync().catch(() => []);
        if (sheet !== mine) return;
        mine.printerNames = printers.map((p) => p.name);
        send('print:init', {
          strings,
          mode: mine.mode,
          mac: process.platform === 'darwin',
          title: mine.title,
          printers: printers.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: Boolean(p.isDefault) })),
          settings: options.normalize(deps.readSettings()[PREF_KEY], { printers: mine.printerNames }),
          papers: options.PAPER_NAMES,
        });
        overlay.webContents.focus();
      });
    });
  }

  // Ctrl+Shift+P, "Print using system dialog…": the plain print, no preview.
  function printWithSystemDialog(wc) {
    if (wc && !wc.isDestroyed()) wc.print({}, () => {});
  }

  ipcMain.on('print:rect', (event, rect) => {
    if (!isOwn(event) || !rect || typeof rect !== 'object') return;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    sheet.rect = { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) };
    placePdfView();
  });
  ipcMain.on('print:render', (event, raw) => { if (isOwn(event) && raw && typeof raw === 'object') requestRender(raw); });
  ipcMain.on('print:save', (event, raw) => { if (isOwn(event)) save(raw); });
  ipcMain.on('print:print', (event, raw) => { if (isOwn(event)) printNow(raw); });
  ipcMain.on('print:system', (event) => { if (isOwn(event)) close('system'); });
  ipcMain.on('print:cancel', (event) => { if (isOwn(event)) close('cancel'); });

  return {
    open,
    close,
    printWithSystemDialog,
    layout,
    // A tab view added after the sheet sits above it: back on top.
    raise() {
      if (!sheet || sheet.closed || sheet.host.isDestroyed()) return;
      for (const view of [sheet.overlay, sheet.pdfView]) if (view) sheet.host.contentView.addChildView(view);
    },
    isOpen: () => Boolean(sheet),
    isOwnView: (wc) => Boolean(sheet) && (wc === sheet.overlay.webContents || (sheet.pdfView && wc === sheet.pdfView.webContents)),
    pickers,
    // for tests
    overlayContents: () => sheet?.overlay.webContents ?? null,
    pdfContents: () => sheet?.pdfView?.webContents ?? null,
    PREF_KEY,
  };
}

module.exports = { createPrintPreview, PREF_KEY };

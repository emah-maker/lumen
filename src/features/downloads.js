// ---------- downloads: saved to the Downloads folder, progress on the taskbar ----------
// Each download keeps its Electron DownloadItem, so the Downloads menu can pause, resume, cancel
// and retry it. A program or script (RISKY_TYPES) is held in a private temporary folder, paused,
// until the user agrees; then it finishes there and moves into the Downloads folder. Nothing lands
// in Downloads unanswered, and it isn't downloaded a second time (which failed for one-time links,
// POST responses and blob: URLs).
// The list survives restarts (downloads.json in the profile); the toolbar button opens a panel
// (renderer/downloads.html) with progress, speed and time left, and each finished file can be
// dragged out of it into Finder, Explorer, mail or chat, as in Chrome.
const fs = require('fs');
const path = require('path');
const { hostOf } = require('./adblock');
const { t } = require('./i18n');
const { menuLabel } = require('../browser/menu-label'); // a file name as a menu label (a literal & is written &&)
const settingsFile = require('../settings/settings-file'); // tmp + rename + .bak writes, corrupt-file recovery

// Programs, installers and scripts Windows runs on open, and shortcut/settings files that launch them (a .url, .scf,
// .inf or .diagcab file runs something when opened). Not disk images or documents: those are ordinary downloads.
const RISKY_TYPES = /^\.(exe|msi|msp|mst|msix|msixbundle|bat|cmd|com|scr|pif|cpl|msc|ps1|ps1xml|psm1|psd1|vbs|vbe|vb|js|jse|wsf|wsh|wsc|sct|hta|jar|jnlp|dll|ocx|lnk|url|scf|inf|reg|appx|appxbundle|appinstaller|application|gadget|diagcab|settingcontent-ms)$/i;
const { trailingThrottle } = require('../browser/trailing-throttle');
const PROGRESS_MS = 250; // how often a running download's progress reaches the panel and the page
const KEEP = 1000; // downloads remembered in the list (the Downloads page pages through them; the panel shows the latest PANEL_ROWS, the menu 10)
const PANEL_ROWS = 50;
const UNDO_KEEP = 20; // removed rows held for the page's Undo

// deps: { app, session, dialog, shell, win, ui, panel, fallbackIcon, downloadDir, askWhereToSave, askOnce(urls)?,
//         openInstead(item, contents)? (true: not downloaded, shown instead), onCompleted(entry)? }
function createDownloads(deps) {
  const downloads = []; // { id, name, path, state, received, total, paused, awaitingOk, url, started, endedAt, speed } (+ item, contents: not sent)
  const removed = []; // rows taken off the list a moment ago, { entry, index }: the Downloads page's Undo puts one back
  const reserved = new Set(); // paths claimed by downloads still running, so two same-named files don't collide
  let downloadSeq = 0;
  const icons = new Map(); // path -> { image (nativeImage, for dragging), dataUrl (for the panel) }
  const thumbs = new Map(); // path -> { dataUrl }: the first page of a Word, Excel or PowerPoint file (deps.thumb: features/office-thumb.js)
  const isOffice = (file) => /\.(?:docx|xlsx|pptx)$/i.test(String(file || ''));
  const listFile = () => path.join(deps.app.getPath('userData'), 'downloads.json');
  let saveTimer = null;
  let saveGen = 0; // a write still queued or in flight when flush() runs is superseded
  const keptList = () => downloads.map(({ id, name, path: file, state, received, total, url, started, endedAt, reason }) => ({ id, name, path: file, state, received, total, url, started, endedAt, ...(state === 'interrupted' && reason ? { reason } : {}) }));
  function save() {
    clearTimeout(saveTimer);
    const gen = ++saveGen;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      settingsFile.writeJsonAtomicAsync(listFile(), keptList(), () => gen === saveGen, 0).catch((err) => console.error('[lumen] could not save the downloads list:', err.message));
    }, 500);
  }
  // Quitting: a change from the last half second is written now, synchronously (temp file and rename, so never half a file).
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saveGen++;
    try { settingsFile.writeJsonAtomic(listFile(), keptList(), 0); } catch (err) { console.error('[lumen] could not save the downloads list:', err.message); }
  }
  // Last session's list. A download that was still running when Lumen quit can only be retried.
  function load() {
    let list = [];
    try { list = settingsFile.loadJson(listFile()); } catch (err) { console.error('[lumen] could not read the downloads list:', err.message); } // (an unparseable file is restored from .bak or set aside, never overwritten)
    if (!Array.isArray(list)) return;
    for (const d of list.slice(0, KEEP)) {
      if (!d || typeof d.id !== 'number' || typeof d.name !== 'string') continue;
      const entry = { ...d, state: d.state === 'progressing' ? 'interrupted' : d.state, paused: false, awaitingOk: false, speed: 0 };
      Object.defineProperties(entry, { item: { value: null, writable: true }, contents: { value: null } });
      downloads.push(entry);
      downloadSeq = Math.max(downloadSeq, d.id);
      if (entry.state === 'completed') loadIcon(entry);
    }
  }
  const exists = (d) => Boolean(d.path) && fs.existsSync(d.path);
  // Electron says only that a transfer was interrupted, not why: the reason is read from how far it got and whether it can be resumed
  // (connect: nothing arrived, lost: stopped part way but can resume, stopped: stopped and cannot resume, save: the finished file could not be moved).
  const reasonOf = (d) => (!d.received ? 'connect' : d.item?.canResume?.() ? 'lost' : 'stopped');
  function noteFailed(d) { // once per failure (an interrupted download that resumes and fails again says so again)
    if (d.failToasted) return;
    d.failToasted = true;
    deps.toast?.(t('downloads.toast.failed', { name: d.name }));
  }
  // What the panel shows for one download (no Electron objects, nothing about other tabs).
  const panelEntry = (d) => ({
    id: d.id, name: d.name, state: d.state, received: d.received, total: d.total, paused: Boolean(d.paused), awaitingOk: Boolean(d.awaitingOk),
    speed: Math.round(d.speed || 0), host: hostOf(d.url || ''), endedAt: d.endedAt || null, reason: d.state === 'interrupted' ? d.reason || null : null,
    missing: d.state === 'completed' && !exists(d), canResume: Boolean(d.item && d.state === 'interrupted' && d.item.canResume()),
    icon: icons.get(d.path)?.dataUrl || null,
    office: d.state === 'completed' && isOffice(d.path), thumb: thumbs.get(d.path)?.dataUrl || null, // a finished Word, Excel or PowerPoint file: its first page, and the Preview button
  });
  const pushDownloads = () => {
    deps.ui()?.send('downloads', downloads.slice(0, 10).map(({ id, name, state, received, total, paused }) => ({ id, name, state, received, total, paused })));
    deps.onChange?.(); // the Downloads page (features/managers.js)
    deps.panel?.()?.send('downloads:list', downloads.slice(0, PANEL_ROWS).map(panelEntry)); // the toolbar's panel (the latest rows: each is stat()ed, and the panel is small)
    save();
  };
  // Chromium reports a running download's progress many times a second. Each report rebuilt the whole panel list (and
  // stat()ed every finished file in it), and the panel redraws its rows from scratch, so a click on a button could land
  // on a row that had just been replaced. Progress goes out a few times a second; anything else (a start, a finish,
  // a pause, a removal) goes out at once.
  const sendProgress = trailingThrottle(pushDownloads, PROGRESS_MS);
  const sendDownloads = () => sendProgress.now();
  // The first page of a finished Word, Excel or PowerPoint file, drawn in the background (a failure leaves the system's icon).
  function loadThumb(entry) {
    if (!deps.thumb || !isOffice(entry.path) || thumbs.has(entry.path) || !exists(entry)) return;
    thumbs.set(entry.path, { dataUrl: null }); // (asked once)
    Promise.resolve(deps.thumb(entry.path)).then((t) => { if (t && t.dataUrl) { thumbs.set(entry.path, { dataUrl: t.dataUrl }); sendDownloads(); } }).catch(() => {});
  }
  function loadIcon(entry) {
    loadThumb(entry);
    if (!entry.path || icons.has(entry.path) || !exists(entry)) return;
    deps.app.getFileIcon(entry.path, { size: 'normal' }).then((image) => {
      icons.set(entry.path, { image, dataUrl: image.toDataURL() });
      sendDownloads();
    }).catch(() => {});
  }

  // The first free name in `dir`: "report.pdf", then "report (1).pdf", …
  function freePath(dir, base) {
    const parsed = path.parse(base);
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target) || reserved.has(target.toLowerCase()); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    reserved.add(target.toLowerCase());
    return target;
  }

  // A finished file opens in the system's program, except the kinds Lumen shows itself in a tab (deps.openLocal: an .eml).
  const openFile = (file) => { deps.onOpened?.(file); return deps.openLocal?.(file) ? true : deps.shell.openPath(file); }; // (onOpened: the Files list)

  function progress() {
    const active = downloads.filter((d) => d.state === 'progressing' && d.total > 0);
    const sum = active.reduce((a, d) => [a[0] + d.received, a[1] + d.total], [0, 0]);
    const w = deps.win();
    if (w && !w.isDestroyed()) w.setProgressBar(active.length ? sum[0] / sum[1] : -1);
  }

  function trim() {
    while (downloads.length > KEEP) {
      const index = downloads.map((d) => d.state !== 'progressing').lastIndexOf(true);
      if (index === -1) break;
      downloads.splice(index, 1);
    }
  }

  function setup() {
    deps.session.defaultSession.on('will-download', (event, item, contents) => {
      if (deps.blocked?.(contents)) { event.preventDefault(); try { item.cancel(); } catch {} return; } // [agent window] an outside agent's page
      // A file the browser shows itself instead (a local .pptx opened in a tab: features/slides-viewer.js).
      if (deps.openInstead?.(item, contents)) { event.preventDefault(); return; }
      const dir = deps.downloadDir(); // [settings] Downloads folder unless changed in Settings
      const base = path.basename(item.getFilename() || 'download');
      const url = item.getURL();
      const risky = RISKY_TYPES.test(path.extname(base));
      // [settings] "Ask where to save": Electron shows its save dialog when no path is set. A risky
      // file is asked about first, so it takes the usual folder.
      // Save Link As… / Save Image As… (features/link-menu.js) ask for that one download, by its address.
      const ask = (deps.askWhereToSave() || Boolean(deps.askOnce?.(item.getURLChain?.() || [url]))) && !risky;
      let target = null;
      let holding = null; // risky: the temporary file it downloads to until approved
      if (risky) {
        const tmpDir = fs.mkdtempSync(path.join(deps.app.getPath('temp'), 'lumen-download-'));
        holding = path.join(tmpDir, base);
        item.setSavePath(holding); // must be set synchronously, or Electron shows its own save dialog
        item.pause();
      } else {
        target = freePath(dir, base);
        if (ask) item.setSaveDialogOptions({ defaultPath: target });
        else item.setSavePath(target);
      }
      const entry = { id: ++downloadSeq, name: path.basename(target || base), path: target, state: 'progressing', received: 0, total: item.getTotalBytes(), paused: risky, awaitingOk: risky, started: Date.now(), url, endedAt: null, speed: 0 };
      Object.defineProperties(entry, { item: { value: item, writable: true }, contents: { value: contents }, saveAs: { value: ask } });
      let lastAt = Date.now();
      let lastReceived = 0;
      downloads.unshift(entry);
      trim();
      sendDownloads();
      if (target && !risky) deps.toast?.(t('downloads.toast.started', { name: entry.name })); // (a risky file asks first; a Save As… name is not known yet)
      item.on('updated', (_e, state) => {
        const now = Date.now();
        const received = item.getReceivedBytes();
        // Bytes per second, smoothed. A failed transfer can report fewer bytes than before: no speed then.
        const rate = now > lastAt && received >= lastReceived ? ((received - lastReceived) * 1000) / (now - lastAt) : 0;
        entry.speed = state === 'interrupted' || item.isPaused() ? 0 : entry.speed ? entry.speed * 0.7 + rate * 0.3 : rate;
        lastAt = now;
        lastReceived = received;
        entry.received = received;
        entry.total = item.getTotalBytes();
        entry.paused = item.isPaused() || entry.awaitingOk;
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        if (entry.state === 'progressing') entry.failToasted = false;
        else { entry.reason = reasonOf(entry); noteFailed(entry); }
        progress();
        if (entry.state === 'interrupted') sendDownloads();
        else sendProgress();
      });
      Object.defineProperty(entry, 'holding', { value: holding });
      item.once('done', (_ev, state) => {
        if (target) reserved.delete(target.toLowerCase());
        if (ask && item.getSavePath()) Object.assign(entry, { path: item.getSavePath(), name: path.basename(item.getSavePath()) }); // [settings]
        // A small risky file can finish before the pause takes hold: it stays in the temporary
        // folder, still waiting for the user's answer (askAboutRisky finishes it).
        if (holding && entry.awaitingOk && state === 'completed') { entry.held = true; return; }
        finish(entry, state);
      });
      if (risky) askAboutRisky(entry, base, url, dir);
    });
  }

  function finish(entry, state) {
    entry.state = state; // completed | cancelled | interrupted
    entry.paused = false;
    entry.speed = 0;
    entry.endedAt = Date.now();
    const { holding } = entry;
    if (holding) {
      if (state === 'completed' && entry.path) {
        try {
          fs.renameSync(holding, entry.path);
        } catch {
          try { fs.copyFileSync(holding, entry.path); fs.unlinkSync(holding); } catch { entry.state = 'interrupted'; entry.reason = 'save'; }
        }
      }
      if (entry.path) reserved.delete(entry.path.toLowerCase());
      fs.rm(path.dirname(holding), { recursive: true, force: true }, () => {});
    }
    if (entry.state === 'interrupted') { entry.reason ||= reasonOf(entry); noteFailed(entry); }
    progress();
    sendDownloads();
    if (entry.state === 'completed') loadIcon(entry);
    if (entry.state === 'completed') deps.onCompleted?.(entry); // a downloaded deck opens in the slide viewer (main.js)
    const w = deps.win();
    if (entry.state === 'completed' && w && !w.isDestroyed()) w.flashFrame(!w.isFocused());
  }

  // Programs and scripts can run code: nothing reaches the Downloads folder until the user agrees.
  function askAboutRisky(entry, base, url, dir) {
    const win = deps.win();
    if (!win || win.isDestroyed()) { entry.item.cancel(); return; }
    deps.dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('dialog.cancel'), t('downloads.confirm.button')],
      defaultId: 0,
      cancelId: 0,
      message: t('downloads.confirm', { name: base }),
      detail: hostOf(url) ? t('downloads.confirm.detail', { host: hostOf(url) }) : t('downloads.confirm.detailNoHost'),
    }).then(({ response }) => {
      const { item } = entry;
      if (entry.state !== 'progressing' || (!entry.held && item.getState() !== 'progressing')) return; // cancelled from the menu meanwhile
      entry.awaitingOk = false;
      if (response !== 1) {
        if (entry.held) finish(entry, 'cancelled');
        else item.cancel();
        return;
      }
      entry.path = freePath(dir, base);
      entry.name = path.basename(entry.path);
      if (entry.held) { finish(entry, 'completed'); return; }
      item.resume();
      entry.paused = false;
      sendDownloads();
    });
  }

  function retry(entry) {
    const { contents } = entry;
    const w = deps.win();
    if (entry.state === 'interrupted' && entry.item?.canResume()) { entry.item.resume(); return; }
    if (!entry.url) return;
    (contents && !contents.isDestroyed() ? contents : w && !w.isDestroyed() ? w.webContents : null)?.downloadURL(entry.url);
  }

  function menu() {
    if (!downloads.length) return [{ label: t('downloads.none'), enabled: false }];
    const items = downloads.slice(0, 10).map((d) => {
      const percent = d.total ? `${Math.round((d.received / d.total) * 100)}%` : '';
      if (d.state === 'completed') {
        return { label: menuLabel(d.name, 80), click: () => openFile(d.path) };
      }
      if (d.state === 'progressing') {
        const status = d.awaitingOk ? t('downloads.waitingOk') : d.paused ? (percent ? t('downloads.pausedAt', { percent }) : t('downloads.paused')) : percent || t('downloads.downloading');
        return {
          label: t('downloads.item', { name: menuLabel(d.name, 80), status }),
          submenu: [
            ...(d.awaitingOk ? [] : [d.paused
              ? { label: t('downloads.resume'), click: () => { d.item.resume(); } }
              : { label: t('downloads.pause'), click: () => { d.item.pause(); } }]),
            { label: t('downloads.cancel'), click: () => { if (d.held) finish(d, 'cancelled'); else d.item.cancel(); } },
          ],
        };
      }
      return { // cancelled | interrupted
        label: t('downloads.item', { name: menuLabel(d.name, 80), status: d.state === 'cancelled' ? t('downloads.cancelled') : t('downloads.failed') }),
        submenu: [{ label: d.state === 'interrupted' && d.item?.canResume() ? t('downloads.resume') : t('downloads.retry'), click: () => retry(d) }],
      };
    });
    const done = downloads.filter((d) => d.state === 'completed');
    if (done.length) items.push({ type: 'separator' }, { label: t('downloads.showLatest'), click: () => deps.shell.showItemInFolder(done[0].path) });
    items.push({ type: 'separator' }, { label: t('downloads.openFolder'), click: () => deps.shell.openPath(deps.downloadDir()) });
    return items;
  }

  // The Downloads page: every remembered download, and what its buttons do. Up to a thousand rows are asked about on every
  // progress refresh, so whether a file is still there is remembered for a few seconds.
  const seen = new Map(); // path -> { at, there }
  const stillThere = (d) => {
    const now = Date.now();
    const hit = seen.get(d.path);
    if (hit && now - hit.at < 3000) return hit.there;
    const there = fs.existsSync(d.path);
    seen.set(d.path, { at: now, there });
    if (seen.size > KEEP * 2) seen.clear();
    return there;
  };
  const summary = () => downloads.map((d) => ({
    id: d.id, name: d.name, path: d.path, state: d.state, received: d.received, total: d.total, paused: d.paused,
    awaitingOk: Boolean(d.awaitingOk), started: d.started, endedAt: d.endedAt || null, url: d.url,
    canResume: d.state === 'interrupted' && Boolean(d.item?.canResume?.()),
    exists: d.state === 'completed' && Boolean(d.path) && stillThere(d),
  }));
  function act(id, action) {
    const d = downloads.find((x) => x.id === id);
    if (action === 'restore') return restore(id);
    if (!d) return false;
    if (action === 'open' && d.state === 'completed' && exists(d)) { openFile(d.path); return true; }
    if (action === 'show' && d.state === 'completed' && exists(d)) { deps.shell.showItemInFolder(d.path); return true; }
    if (action === 'preview' && d.state === 'completed' && exists(d) && isOffice(d.path)) { deps.onPreview?.(d.path); return true; } // the panel's Preview button: Lumen's own viewer in a tab
    if (action === 'pin' && d.state === 'completed' && exists(d)) { deps.onPin?.(d.path); return true; } // Pin to Files (the panel's right-click menu)
    if (action === 'pause' && d.state === 'progressing' && d.item && !d.awaitingOk && !d.paused) { d.item.pause(); return true; }
    if (action === 'resume' && d.state === 'progressing' && d.item && !d.awaitingOk && d.paused) { d.item.resume(); return true; }
    if (action === 'cancel' && d.state === 'progressing') { if (d.held) finish(d, 'cancelled'); else d.item?.cancel(); return true; }
    if (action === 'retry' && (d.state === 'cancelled' || d.state === 'interrupted')) { retry(d); return true; }
    if (action === 'remove' && d.state !== 'progressing') { const index = downloads.indexOf(d); downloads.splice(index, 1); removed.push({ entry: d, index }); if (removed.length > UNDO_KEEP) removed.shift(); sendDownloads(); return true; }
    return false;
  }
  // Undo of a removal (the Downloads page): the row goes back where it was.
  function restore(id) {
    const at = removed.findIndex((r) => r.entry.id === id);
    if (at === -1 || downloads.some((x) => x.id === id)) return false;
    const [{ entry, index }] = removed.splice(at, 1);
    downloads.splice(Math.min(index, downloads.length), 0, entry);
    trim();
    sendDownloads();
    return true;
  }

  function clearFinished() {
    for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
    sendDownloads();
  }
  // Drag a finished file out of the panel. startDrag needs an icon right away, so it uses the one
  // loaded when the download finished (or Lumen's own).
  function drag(id, sender) {
    const d = downloads.find((x) => x.id === id);
    if (!d || d.state !== 'completed' || !exists(d)) return;
    const icon = icons.get(d.path)?.image || deps.fallbackIcon();
    sender.startDrag({ file: d.path, icon });
  }

  // A file Lumen wrote itself (a screen recording): listed as a finished download, with Open and Show in folder like any other.
  function addFile(file, name = path.basename(file)) {
    let size;
    try { size = fs.statSync(file).size; } catch { return null; }
    const entry = { id: ++downloadSeq, name, path: file, state: 'completed', received: size, total: size, paused: false, awaitingOk: false, speed: 0, url: '', started: Date.now(), endedAt: Date.now() };
    Object.defineProperties(entry, { item: { value: null, writable: true }, contents: { value: null } });
    downloads.unshift(entry);
    trim();
    loadIcon(entry);
    sendDownloads();
    return entry.id;
  }

  return { list: downloads, addFile, flush, send: sendDownloads, setup, menu, summary, act, load, clearFinished, drag, panelList: () => downloads.slice(0, PANEL_ROWS).map(panelEntry), openFolder: () => deps.shell.openPath(deps.downloadDir()) };
}

module.exports = { createDownloads, RISKY_TYPES };

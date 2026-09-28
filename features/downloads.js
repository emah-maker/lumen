// ---------- downloads: saved to the Downloads folder, progress on the taskbar ----------
// Each download keeps its Electron DownloadItem, so the Downloads menu can pause, resume, cancel
// and retry it. A program or script (RISKY_TYPES) is held in a private temporary folder, paused,
// until the user agrees; then it finishes there and moves into the Downloads folder. Nothing lands
// in Downloads unanswered, and it isn't downloaded a second time (which failed for one-time links,
// POST responses and blob: URLs).
const fs = require('fs');
const path = require('path');
const { hostOf } = require('./adblock');

const RISKY_TYPES = /^\.(exe|msi|msix|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|hta|jar|dll|lnk|reg|appx)$/i;
const KEEP = 50; // downloads remembered in the list (the menu shows the latest 10)

// deps: { app, session, dialog, shell, win, ui, downloadDir, askWhereToSave }
function createDownloads(deps) {
  const downloads = []; // { id, name, path, state, received, total, paused, awaitingOk } (+ item, url, contents: not sent)
  const reserved = new Set(); // paths claimed by downloads still running, so two same-named files don't collide
  let downloadSeq = 0;
  const sendDownloads = () => {
    deps.ui()?.send('downloads', downloads.slice(0, 10).map(({ id, name, state, received, total, paused }) => ({ id, name, state, received, total, paused })));
    deps.onChange?.(); // the Downloads page (features/managers.js)
  };

  // The first free name in `dir`: "report.pdf", then "report (1).pdf", …
  function freePath(dir, base) {
    const parsed = path.parse(base);
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target) || reserved.has(target.toLowerCase()); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    reserved.add(target.toLowerCase());
    return target;
  }

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
    deps.session.defaultSession.on('will-download', (_event, item, contents) => {
      const dir = deps.downloadDir(); // [settings] Downloads folder unless changed in Settings
      const base = path.basename(item.getFilename() || 'download');
      const url = item.getURL();
      const risky = RISKY_TYPES.test(path.extname(base));
      // [settings] "Ask where to save": Electron shows its save dialog when no path is set. A risky
      // file is asked about first, so it takes the usual folder.
      const ask = deps.askWhereToSave() && !risky;
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
      const entry = { id: ++downloadSeq, name: path.basename(target || base), path: target, state: 'progressing', received: 0, total: item.getTotalBytes(), paused: risky, awaitingOk: risky, started: Date.now() };
      Object.defineProperties(entry, { item: { value: item, writable: true }, url: { value: url }, contents: { value: contents } });
      downloads.unshift(entry);
      trim();
      sendDownloads();
      item.on('updated', (_e, state) => {
        entry.received = item.getReceivedBytes();
        entry.total = item.getTotalBytes();
        entry.paused = item.isPaused() || entry.awaitingOk;
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        progress();
        sendDownloads();
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
    const { holding } = entry;
    if (holding) {
      if (state === 'completed' && entry.path) {
        try {
          fs.renameSync(holding, entry.path);
        } catch {
          try { fs.copyFileSync(holding, entry.path); fs.unlinkSync(holding); } catch { entry.state = 'interrupted'; }
        }
      }
      if (entry.path) reserved.delete(entry.path.toLowerCase());
      fs.rm(path.dirname(holding), { recursive: true, force: true }, () => {});
    }
    progress();
    sendDownloads();
    const w = deps.win();
    if (entry.state === 'completed' && w && !w.isDestroyed()) w.flashFrame(!w.isFocused());
  }

  // Programs and scripts can run code: nothing reaches the Downloads folder until the user agrees.
  function askAboutRisky(entry, base, url, dir) {
    const win = deps.win();
    if (!win || win.isDestroyed()) { entry.item.cancel(); return; }
    deps.dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Download'],
      defaultId: 0,
      cancelId: 0,
      message: `Download “${base}”?`,
      detail: `This type of file can run programs on your computer. Only keep it if you trust ${hostOf(url) || 'the site'}.`,
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
    if (entry.state === 'interrupted' && entry.item.canResume()) { entry.item.resume(); return; }
    (contents && !contents.isDestroyed() ? contents : w && !w.isDestroyed() ? w.webContents : null)?.downloadURL(entry.url);
  }

  function menu() {
    if (!downloads.length) return [{ label: 'No downloads yet', enabled: false }];
    const items = downloads.slice(0, 10).map((d) => {
      const percent = d.total ? `${Math.round((d.received / d.total) * 100)}%` : '';
      if (d.state === 'completed') {
        return { label: d.name, click: () => deps.shell.openPath(d.path) };
      }
      if (d.state === 'progressing') {
        const status = d.awaitingOk ? 'waiting for your OK' : d.paused ? `paused${percent ? ` at ${percent}` : ''}` : percent || 'downloading';
        return {
          label: `${d.name} — ${status}`,
          submenu: [
            ...(d.awaitingOk ? [] : [d.paused
              ? { label: 'Resume', click: () => { d.item.resume(); } }
              : { label: 'Pause', click: () => { d.item.pause(); } }]),
            { label: 'Cancel', click: () => { if (d.held) finish(d, 'cancelled'); else d.item.cancel(); } },
          ],
        };
      }
      return { // cancelled | interrupted
        label: `${d.name} — ${d.state === 'cancelled' ? 'cancelled' : 'failed'}`,
        submenu: [{ label: d.state === 'interrupted' && d.item.canResume() ? 'Resume' : 'Retry', click: () => retry(d) }],
      };
    });
    const done = downloads.filter((d) => d.state === 'completed');
    if (done.length) items.push({ type: 'separator' }, { label: 'Show Latest in Folder', click: () => deps.shell.showItemInFolder(done[0].path) });
    items.push({ type: 'separator' }, { label: 'Open Downloads Folder', click: () => deps.shell.openPath(deps.downloadDir()) });
    return items;
  }

  // The Downloads page: every remembered download, and what its buttons do.
  const summary = () => downloads.map((d) => ({
    id: d.id, name: d.name, path: d.path, state: d.state, received: d.received, total: d.total, paused: d.paused,
    awaitingOk: Boolean(d.awaitingOk), started: d.started, url: d.url,
    canResume: d.state === 'interrupted' && Boolean(d.item?.canResume?.()),
    exists: d.state === 'completed' && Boolean(d.path) && fs.existsSync(d.path),
  }));
  function act(id, action) {
    const d = downloads.find((x) => x.id === id);
    if (!d) return false;
    if (action === 'open' && d.state === 'completed' && d.path) { deps.shell.openPath(d.path); return true; }
    if (action === 'show' && d.state === 'completed' && d.path) { deps.shell.showItemInFolder(d.path); return true; }
    if (action === 'pause' && d.state === 'progressing' && !d.awaitingOk && !d.paused) { d.item.pause(); return true; }
    if (action === 'resume' && d.state === 'progressing' && !d.awaitingOk && d.paused) { d.item.resume(); return true; }
    if (action === 'cancel' && d.state === 'progressing') { if (d.held) finish(d, 'cancelled'); else d.item.cancel(); return true; }
    if (action === 'retry' && (d.state === 'cancelled' || d.state === 'interrupted')) { retry(d); return true; }
    if (action === 'remove' && d.state !== 'progressing') { downloads.splice(downloads.indexOf(d), 1); sendDownloads(); return true; }
    return false;
  }

  return { list: downloads, send: sendDownloads, setup, menu, summary, act };
}

module.exports = { createDownloads };

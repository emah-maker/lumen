// ---------- downloads: saved to the Downloads folder, progress on the taskbar ----------
const fs = require('fs');
const path = require('path');
const { hostOf } = require('./adblock');

const RISKY_TYPES = /^\.(exe|msi|msix|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|hta|jar|dll|lnk|reg|appx)$/i;

// deps: { app, session, dialog, shell, win, ui, downloadDir, askWhereToSave }
function createDownloads(deps) {
  const downloads = []; // { id, name, path, state, received, total }
  let downloadSeq = 0;
  const sendDownloads = () => deps.ui()?.send('downloads', downloads.slice(0, 10).map(({ id, name, state, received, total }) => ({ id, name, state, received, total })));

  function setup() {
    const approvedUrls = new Set(); // risky downloads the user said yes to
    deps.session.defaultSession.on('will-download', (event, item, contents) => {
      const win = deps.win();
      const dir = deps.downloadDir(); // [settings] Downloads folder unless changed in Settings
      const parsed = path.parse(item.getFilename() || 'download');
      const url = item.getURL();
      if (RISKY_TYPES.test(parsed.ext) && !approvedUrls.delete(url)) {
        // Programs and scripts can run code: nothing is saved until the user agrees.
        event.preventDefault();
        if (!win || win.isDestroyed()) return;
        deps.dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Cancel', 'Download'],
          defaultId: 0,
          cancelId: 0,
          message: `Download “${parsed.base}”?`,
          detail: `This type of file can run programs on your computer. Only keep it if you trust ${hostOf(url) || 'the site'}.`,
        }).then(({ response }) => {
          if (response !== 1) return;
          approvedUrls.add(url);
          (contents && !contents.isDestroyed() ? contents : win.webContents).downloadURL(url);
        });
        return;
      }
      let target = path.join(dir, parsed.base);
      for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
      // [settings] "Ask where to save": Electron shows its save dialog when no path is set.
      const ask = deps.askWhereToSave();
      if (ask) item.setSaveDialogOptions({ defaultPath: target });
      else item.setSavePath(target); // must be set synchronously, or Electron shows its own save dialog
      const entry = { id: ++downloadSeq, name: path.basename(target), path: target, state: 'progressing', received: 0, total: item.getTotalBytes() };
      downloads.unshift(entry);
      sendDownloads();
      const progress = () => {
        const active = downloads.filter((d) => d.state === 'progressing' && d.total > 0);
        const sum = active.reduce((a, d) => [a[0] + d.received, a[1] + d.total], [0, 0]);
        const w = deps.win();
        if (w && !w.isDestroyed()) w.setProgressBar(active.length ? sum[0] / sum[1] : -1);
      };
      item.on('updated', () => {
        entry.received = item.getReceivedBytes();
        entry.total = item.getTotalBytes();
        progress();
        sendDownloads();
      });
      item.once('done', (_ev, state) => {
        if (ask && item.getSavePath()) Object.assign(entry, { path: item.getSavePath(), name: path.basename(item.getSavePath()) }); // [settings]
        entry.state = state; // completed | cancelled | interrupted
        progress();
        sendDownloads();
        const w = deps.win();
        if (state === 'completed' && w && !w.isDestroyed()) w.flashFrame(!w.isFocused());
      });
    });
  }

  function menu() {
    if (!downloads.length) return [{ label: 'No downloads yet', enabled: false }];
    const items = downloads.slice(0, 10).map((d) => {
      const status = d.state === 'progressing'
        ? (d.total ? `${Math.round((d.received / d.total) * 100)}%` : 'downloading')
        : d.state === 'completed' ? '' : d.state;
      return {
        label: status ? `${d.name} — ${status}` : d.name,
        enabled: d.state === 'completed',
        click: () => deps.shell.openPath(d.path),
      };
    });
    items.push({ type: 'separator' }, { label: 'Open Downloads Folder', click: () => deps.shell.openPath(deps.app.getPath('downloads')) });
    return items;
  }

  return { list: downloads, send: sendDownloads, setup, menu };
}

module.exports = { createDownloads };

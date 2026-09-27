// ---------- dialogs: one Lumen-styled overlay standing in for every native message box ----------
//
// Electron's dialog.showMessageBox draws a stock OS window (grey on Windows); prompt() doesn't
// work in Electron at all. This keeps a single transparent WebContentsView on top of the window
// (the same pattern as suggestView in main.js) and renders a calm card in it instead. Only one
// dialog is shown at a time; more requests queue (FIFO) and are drawn once the current one closes.
//
// deps: { win: () => BrowserWindow|null, paths: { preload, html }, switchToContents(webContents),
//         restoreFocus() }
const { WebContentsView } = require('electron');

function createDialogs(deps) {
  let overlay = null;
  let seq = 0;
  const queue = []; // items waiting to be shown; queue[0] is the one on screen once `showing` is set
  let showing = null;

  // The window the overlay is in: the browser window, or a popup whose own page asked. A popup's
  // alert() is drawn in the popup, where the user is looking, not behind it in the main window.
  let host = null;
  const hostFor = (item) => (item.owner && !item.owner.isDestroyed() && deps.windowFor?.(item.owner)) || deps.win();

  function ensureOverlay() {
    if (overlay && !overlay.webContents.isDestroyed()) return overlay;
    overlay = new WebContentsView({
      webPreferences: { preload: deps.paths.preload, sandbox: true, contextIsolation: true },
    });
    overlay.setBackgroundColor('#00000000');
    overlay.webContents.loadFile(deps.paths.html);
    return overlay;
  }

  function layout() {
    if (!overlay) return;
    const win = host && !host.isDestroyed() ? host : deps.win();
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    overlay.setBounds({ x: 0, y: 0, width, height });
  }

  function hide() {
    if (overlay) overlay.setVisible(false);
  }

  // A dialog tied to a tab (`owner`) is cancelled the moment that tab navigates away or is closed,
  // whether it is on screen yet or still waiting in the queue.
  function watchOwner(item) {
    const wc = item.owner;
    if (!wc || wc.isDestroyed()) return;
    const onNav = (details) => { if (details.isMainFrame && !details.isSameDocument) cancel(item); };
    const onDestroyed = () => cancel(item);
    wc.on('did-start-navigation', onNav);
    wc.once('destroyed', onDestroyed);
    item._cleanup = () => { if (!wc.isDestroyed()) wc.removeListener('did-start-navigation', onNav); };
  }

  function cancel(item) {
    if (item._done) return;
    finish(item, item.cancelledResult());
  }

  function present(item) {
    const win = hostFor(item);
    if (!win || win.isDestroyed()) { finish(item, item.cancelledResult()); return; }
    const popup = win !== deps.win();
    if (!popup && item.owner && !item.owner.isDestroyed()) deps.switchToContents?.(item.owner);
    const view = ensureOverlay();
    if (host && host !== win && !host.isDestroyed()) host.contentView.removeChildView(view);
    if (popup && host !== win) {
      // The popup may close with the overlay still in it; take it back out first.
      win.once('close', () => { if (host === win) { win.contentView.removeChildView(view); host = null; } });
    }
    host = win;
    win.contentView.addChildView(view); // re-adding raises it to the top, above the active tab
    layout();
    view.setVisible(true);
    const send = () => { if (!item._done) { view.webContents.send('dialog:show', item.payload); view.webContents.focus(); } };
    if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send);
    else send();
  }

  function presentNext() {
    if (showing) return;
    const item = queue[0];
    if (!item) {
      hide();
      if (host && host !== deps.win() && !host.isDestroyed()) host.webContents.focus(); // back to the popup
      else deps.restoreFocus?.();
      return;
    }
    showing = item;
    present(item);
  }

  function enqueue(item) {
    queue.push(item);
    watchOwner(item);
    presentNext();
  }

  function finish(item, result) {
    if (item._done) return;
    item._done = true;
    item._cleanup?.();
    const index = queue.indexOf(item);
    if (index !== -1) queue.splice(index, 1);
    if (showing === item) showing = null;
    item.resolve(result);
    if (!showing) presentNext();
  }

  function respond(rawResult) {
    const item = showing;
    if (!item || !rawResult || rawResult.id !== item.payload.id) return; // stale response from a dialog already closed
    const checkboxChecked = Boolean(rawResult.checkboxChecked);
    if (item.kind === 'ask') {
      finish(item, { response: rawResult.response, values: rawResult.response === item.payload.cancelId ? null : (rawResult.values || null), checkboxChecked });
    } else {
      finish(item, { response: rawResult.response, checkboxChecked });
    }
  }

  function baseOptions(opts, defaultButtons) {
    const buttons = opts.buttons && opts.buttons.length ? opts.buttons.map(String) : defaultButtons;
    const cancelId = Number.isInteger(opts.cancelId) ? opts.cancelId : 0;
    const defaultId = Number.isInteger(opts.defaultId) ? opts.defaultId : Math.max(0, buttons.length - 1);
    return { buttons, cancelId, defaultId };
  }

  // Drop-in for electron.dialog.showMessageBox: same option names, resolves { response, checkboxChecked }.
  // An extra `owner` (a WebContents) ties the dialog to a tab so it's cancelled if that tab navigates
  // away or closes, and brings that tab to the front if it's in the background.
  function showMessageBox(_win, opts = {}) {
    return new Promise((resolve) => {
      const { buttons, cancelId, defaultId } = baseOptions(opts, ['OK']);
      const item = {
        kind: 'message',
        owner: opts.owner || null,
        resolve,
        payload: {
          id: ++seq,
          kind: 'message',
          type: opts.type || 'none',
          title: opts.title || '',
          message: String(opts.message || ''),
          detail: opts.detail ? String(opts.detail) : '',
          buttons,
          defaultId,
          cancelId,
          checkboxLabel: opts.checkboxLabel || '',
          checkboxChecked: Boolean(opts.checkboxChecked),
        },
        cancelledResult: () => ({ response: cancelId, checkboxChecked: Boolean(opts.checkboxChecked) }),
      };
      enqueue(item);
    });
  }

  // Text input (prompt(), HTTP auth): { message, detail, fields: [{ name, label, type, value }],
  // buttons, owner } -> Promise<{ response, values, checkboxChecked }>. `values` is null on cancel.
  function ask(opts = {}) {
    return new Promise((resolve) => {
      const { buttons, cancelId, defaultId } = baseOptions(opts, ['Cancel', 'OK']);
      const fields = (opts.fields || []).map((f) => ({
        name: f.name,
        label: f.label || '',
        type: f.type === 'password' ? 'password' : 'text',
        value: f.value != null ? String(f.value) : '',
      }));
      const item = {
        kind: 'ask',
        owner: opts.owner || null,
        resolve,
        payload: {
          id: ++seq,
          kind: 'ask',
          title: opts.title || '',
          message: String(opts.message || ''),
          detail: opts.detail ? String(opts.detail) : '',
          buttons,
          defaultId,
          cancelId,
          fields,
          checkboxLabel: opts.checkboxLabel || '',
          checkboxChecked: Boolean(opts.checkboxChecked),
        },
        cancelledResult: () => ({ response: cancelId, values: null, checkboxChecked: Boolean(opts.checkboxChecked) }),
      };
      enqueue(item);
    });
  }

  return {
    showMessageBox,
    ask,
    layout,
    isOwnView: (wc) => Boolean(overlay) && wc === overlay.webContents,
    respond, // called from the ipcMain 'dialog:respond' listener main.js wires up
  };
}

module.exports = { createDialogs };

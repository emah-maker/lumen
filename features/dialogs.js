// ---------- dialogs: one Lumen-styled overlay standing in for every native message box ----------
//
// Electron's dialog.showMessageBox draws a stock OS window (grey on Windows); prompt() doesn't
// work in Electron at all. This keeps a single transparent WebContentsView on top of the window
// (the same pattern as suggestView in main.js) and renders a calm card in it instead. Only one
// dialog is shown at a time; more requests queue (FIFO) and are drawn once the current one closes.
//
// A dialog owned by a tab is tab-modal, as in Chrome: it shows only while that tab is in front. A
// background tab's alert waits (its tab gets a badge, see pendingFor) instead of pulling the user
// over to it; switching to that tab shows it, and switching away puts it back in the queue.
// `bringToFront: true` (the user's own "close this tab" asking "Leave site?") switches to the tab.
//
// deps: { win: () => BrowserWindow|null, paths: { preload, html }, switchToContents(webContents),
//         isInFront(webContents) -> bool (false only for a tab that isn't the active one),
//         onPendingChange(), restoreFocus() }
const { WebContentsView } = require('electron');

function createDialogs(deps) {
  let overlay = null;
  let seq = 0;
  const queue = []; // items waiting to be shown; queue[0] is the one on screen once `showing` is set
  let showing = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = new WebContentsView({
      webPreferences: { preload: deps.paths.preload, sandbox: true, contextIsolation: true },
    });
    overlay.setBackgroundColor('#00000000');
    overlay.webContents.loadFile(deps.paths.html);
    return overlay;
  }

  function layout() {
    if (!overlay) return;
    const win = deps.win();
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
    item._cleanup = () => {
      if (wc.isDestroyed()) return;
      wc.removeListener('did-start-navigation', onNav);
      wc.removeListener('destroyed', onDestroyed);
    };
  }

  function cancel(item) {
    if (item._done) return;
    finish(item, { ...item.cancelledResult(), cancelled: true });
  }

  const inFront = (item) => !item.owner || item.owner.isDestroyed() || deps.isInFront?.(item.owner) !== false;

  function present(item) {
    const win = deps.win();
    if (!win || win.isDestroyed()) { finish(item, item.cancelledResult()); return; }
    const view = ensureOverlay();
    win.contentView.addChildView(view); // re-adding raises it to the top, above the active tab
    layout();
    view.setVisible(true);
    const send = () => { if (!item._done) { view.webContents.send('dialog:show', item.payload); view.webContents.focus(); } };
    if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send);
    else send();
  }

  // `afterDialog`: a dialog just closed, so the keyboard goes back to the page when nothing follows.
  // (Not after a tab switch: the user is busy elsewhere, and the switch handles focus itself.)
  function presentNext({ afterDialog = true } = {}) {
    if (showing) return;
    const item = queue.find(inFront);
    deps.onPendingChange?.();
    if (!item) { hide(); if (afterDialog) deps.restoreFocus?.(); return; }
    showing = item;
    present(item);
  }

  function enqueue(item) {
    queue.push(item);
    watchOwner(item);
    if (item.bringToFront && item.owner && !item.owner.isDestroyed()) deps.switchToContents?.(item.owner);
    presentNext();
  }

  // The active tab changed: a dialog that belongs to the tab just left goes back in the queue, and
  // one waiting for the new tab comes up.
  function refresh() {
    if (showing && !inFront(showing)) showing = null;
    presentNext({ afterDialog: false });
  }

  // A tab with a dialog waiting for it (the tab strip shows a badge).
  const pendingFor = (wc) => queue.some((item) => item.owner === wc && item !== showing);

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
        bringToFront: Boolean(opts.bringToFront),
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
        bringToFront: Boolean(opts.bringToFront),
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
    refresh,
    pendingFor,
    currentId: () => showing?.payload.id ?? null, // for tests
    isOwnView: (wc) => Boolean(overlay) && wc === overlay.webContents,
    respond, // called from the ipcMain 'dialog:respond' listener main.js wires up
  };
}

module.exports = { createDialogs };

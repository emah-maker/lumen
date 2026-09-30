// The toolbar's update prompt (features/updates.js), a pill next to Downloads. The same words for
// every kind of copy that can update itself:
//   "Downloading Lumen vX…"            staging the zip (also automatic downloads)
//   "Lumen vX is ready · Restart to update"
//   "Couldn't update to vX · Try again"  the download, checksum or unpacking failed
//   "Lumen vX is available · Download"   automatic downloads off, or a copy that can't swap itself
//                                        (the button fetches the zip, dmg or opens the releases page)
// Closing it hides it for this version until Lumen restarts; Settings → About keeps the details.
(() => {
  const api = window.lumenUpdates;
  const end = document.querySelector('.toolbar-end');
  if (!api || !end) return;

  const pill = Object.assign(document.createElement('div'), { id: 'update-pill', className: 'update-pill', hidden: true });
  pill.setAttribute('role', 'status');
  const text = Object.assign(document.createElement('span'), { className: 'update-text' });
  const action = Object.assign(document.createElement('button'), { type: 'button', id: 'update-action' });
  const close = Object.assign(document.createElement('button'), { type: 'button', id: 'update-dismiss', className: 'update-dismiss', title: window.t('updates.notNow'), textContent: '×' });
  close.setAttribute('aria-label', window.t('updates.hide'));
  pill.append(text, action, close);
  end.insertBefore(pill, document.getElementById('downloads') || end.firstChild);

  function render(u) {
    const ready = u.status === 'downloaded' && u.canSelfUpdate;
    const busy = u.status === 'downloading' && u.canSelfUpdate;
    const failed = u.status === 'error' && u.canSelfUpdate && Boolean(u.version);
    // A copy with automatic downloads on says nothing until the update is downloading or ready.
    // (A misplaced Mac copy, run from the dmg, stays quiet here: Settings has its Move to Applications button.)
    const offer = u.status === 'available' && !u.misplaced && (!u.canSelfUpdate || !u.autoDownload);
    pill.hidden = Boolean(u.disabled) || u.dismissed || !(ready || busy || failed || offer);
    if (pill.hidden) return;
    const key = ready ? 'updates.ready' : busy ? 'updates.downloading' : failed ? 'updates.failed' : 'updates.available';
    text.textContent = window.t(key, { version: u.version, progress: u.progress || 0 });
    action.hidden = busy;
    action.textContent = ready ? window.t('updates.restart') : failed ? window.t('updates.retry') : window.t('updates.download');
    action.title = ready ? window.t('updates.restart.title') : failed ? window.t('updates.retry') : u.canSelfUpdate ? window.t('updates.download') : u.asset ? window.t('updates.downloadAsset', { name: u.asset.name }) : window.t('updates.releases');
  }
  action.addEventListener('click', async () => render(await api.apply()));
  close.addEventListener('click', async () => render(await api.dismiss()));
  api.onState(render);
  api.state().then(render).catch(() => {});
})();

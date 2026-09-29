// The toolbar's update prompt (features/updates.js), a pill next to Downloads:
//   "Restart to update to vX"          an installed or zip Windows copy that has downloaded vX
//   "Lumen vX is available · Download" automatic downloads off, a zip/portable copy, or macOS
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
    // An installed copy with automatic downloads on says nothing until the update is ready.
    const offer = u.status === 'available' && (!u.canAutoInstall || !u.autoDownload);
    pill.hidden = Boolean(u.disabled) || u.dismissed || !(ready || offer);
    if (pill.hidden) return;
    text.textContent = window.t(ready ? 'updates.ready' : 'updates.available', { version: u.version });
    action.textContent = ready ? window.t('updates.restart') : window.t('updates.download');
    action.title = ready ? window.t('updates.restart.title') : u.canSelfUpdate ? window.t('updates.download') : u.asset ? window.t('updates.downloadAsset', { name: u.asset.name }) : window.t('updates.releases');
  }
  action.addEventListener('click', async () => render(await api.apply()));
  close.addEventListener('click', async () => render(await api.dismiss()));
  api.onState(render);
  api.state().then(render).catch(() => {});
})();

// The toolbar's update prompt (features/updates.js), a pill next to Downloads. One button, the same
// words for every kind of copy that can update itself:
//   "Downloading Lumen vX… n%"           staging the zip (automatic), with "Restart to update": clicking
//                                        it early queues the update ("… restarts when ready")
//   "Lumen vX is ready · Restart to update"  one click applies it and relaunches
//   "Couldn't update to vX · Try again"  the download, checksum or unpacking failed ("Couldn't install vX"
//                                        when the swap itself failed); the reason is the pill's title and aria-description
//   "Move to Applications to update · Lumen vX · Move and update"  a Mac copy running from the dmg or
//                                        Downloads (or a standard user's /Applications, ~/Applications):
//                                        one click installs the update into Applications and relaunches
//   "Lumen vX is available · Download"   automatic downloads off, or a copy that can't swap itself
//                                        (the button fetches the zip, dmg, Setup exe or opens the releases page)
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

  let applying = false; // a click's apply() is still running: a double click must not start a second
  function render(u) {
    // Copies that install the update themselves: swapping in place, or installing into Applications (relocate).
    const own = u.canSelfUpdate || Boolean(u.relocate);
    const ready = u.status === 'downloaded' && own;
    const busy = u.status === 'downloading' && own;
    const failed = u.status === 'error' && own && (Boolean(u.version) || Boolean(u.installFailed)); // a swap that failed without naming its version counts
    const moveFailed = Boolean(u.moveError) && Boolean(u.relocate); // the move or install couldn't go ahead: say why
    // A copy with automatic downloads on says nothing until the update is downloading or ready; a relocating
    // copy says so quietly as soon as there is one (it downloads only once the user clicks).
    const offer = u.status === 'available' && (u.relocate || !u.canSelfUpdate || !u.autoDownload);
    pill.hidden = Boolean(u.disabled) || (u.dismissed && !moveFailed) || !(ready || busy || failed || offer || moveFailed);
    if (pill.hidden) return;
    const key = moveFailed ? '' : ready ? 'updates.ready' : busy ? (u.queued ? 'updates.downloadingQueued' : 'updates.downloading') : failed ? (u.installFailed ? (u.version ? 'updates.installFailedVersion' : 'updates.installFailed') : 'updates.failed')
      : u.relocate === 'user' ? 'updates.moveToUserApps' : u.relocate ? 'updates.moveToUpdate' : 'updates.available';
    text.textContent = moveFailed ? u.moveError : window.t(key, { version: u.version, progress: u.progress || 0 });
    // The short reason: on hover (title) and for keyboard, touch and screen-reader users (aria-description). A failed
    // swap reads as the same sentence Settings shows.
    const why = failed && u.error ? (u.installFailed ? window.t(u.version ? 'updates.installFailedWhy' : 'updates.installFailedNoVersionWhy', { version: u.version, reason: u.error.replace(/[.\s]+$/, '') }) : window.t('updates.failedWhy', { reason: u.error })) : '';
    pill.title = why || text.textContent; // (the words are only the title in a narrow window)
    if (why) pill.setAttribute('aria-description', why); else pill.removeAttribute('aria-description');
    action.hidden = busy && u.queued; // queued: nothing left to click
    action.disabled = applying || Boolean(u.checking); // a re-check (Try again) is running: the old status stays underneath
    action.textContent = u.checking ? window.t('updates.checking') : ready || busy ? window.t('updates.restart') : failed || moveFailed ? window.t('updates.retry') : u.relocate ? window.t('updates.moveAndUpdate') : window.t('updates.download');
    action.title = ready || busy ? window.t('updates.restart.title') : failed || moveFailed ? window.t('updates.retry') : u.relocate ? window.t('updates.moveAndUpdate') : u.canSelfUpdate ? window.t('updates.download') : u.asset ? window.t('updates.downloadAsset', { name: u.asset.name }) : window.t('updates.releases');
  }
  action.addEventListener('click', async () => {
    if (applying) return;
    applying = true;
    action.disabled = true;
    let next = null;
    try { next = await api.apply(); } catch {} finally { applying = false; }
    if (!next) next = await api.state().catch(() => null);
    if (next) render(next); else action.disabled = false;
  });
  close.addEventListener('click', async () => render(await api.dismiss()));
  api.onState(render);
  api.state().then(render).catch(() => {});
})();

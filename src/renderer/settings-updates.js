// About Lumen → Updates (features/updates.js): the version, "Check for updates", what was found,
// and "Download updates automatically". Uses settings.js's row helpers; settings.js calls
// buildUpdates(card) while it builds the About section. Every string is an updates.settings.* key
// (locales/en.json), looked up with the page's window.t (renderer/i18n.js) like the toolbar pill's.
const ut = (key, vars) => window.t(`updates.settings.${key}`, vars);

function updateAgo(ms) {
  if (!ms) return ut('never');
  const min = Math.round((Date.now() - ms) / 60e3);
  if (min < 1) return ut('justNow');
  if (min < 60) return ut(min === 1 ? 'minuteAgo' : 'minutesAgo', { n: min });
  return ut('checkedAt', { when: new Date(ms).toLocaleString() });
}

// Why a swap failed, as a fragment for "Couldn’t install Lumen X: <cause>.": the helper writes a short
// lowercase cause; a stray capital or full stop (an older message) is tidied so the sentence reads once.
const cause = (error) => String(error || '').trim().replace(/[.\s]+$/, '') || ut('unknownError');

// What the status line says and what the action button does, for one state.
// One button for a copy that installs its own updates: "Restart to update" (also while it is still
// downloading, which queues it), or for a Mac copy outside Applications "Move and update".
function updateView(u) {
  if (u.disabled) return { note: ut(`disabled.${['dev', 'test', 'mcp'].includes(u.disabled) ? u.disabled : 'other'}`), cls: '' };
  const own = u.canSelfUpdate || Boolean(u.relocate); // swaps in place, or installs into Applications
  const moveTo = ut('action.moveToApplications');
  // A failed move or install comes before everything else: the reason, and a way to retry.
  if (u.moveError && u.relocate) return { note: u.moveError, cls: 'err', action: u.version ? window.t('updates.retry') : moveTo };
  const why = u.misplaced === 'unwritable' ? ut('misplaced.unwritable') : ut('misplaced.temporary');
  // A misplaced copy with no update to install yet: the plain move (the native Move to Applications).
  const plainMove = u.relocate === 'misplaced' ? { note: ut('misplaced.move', { why }), cls: 'ok', action: moveTo } : null;
  switch (u.status) {
    case 'checking': return { note: ut('checking'), cls: '' };
    case 'up-to-date': return plainMove ? { ...plainMove, note: `${ut('upToDate')} ${plainMove.note}` } : { note: ut('upToDate'), cls: 'ok' };
    case 'downloading': return u.queued
      ? { note: ut('downloadingQueued', { version: u.version, progress: u.progress || 0 }), cls: '' }
      : { note: ut('downloading', { version: u.version, progress: u.progress || 0 }), cls: '', action: own ? window.t('updates.restart') : undefined };
    case 'downloaded': return { note: ut('ready', { version: u.version }), cls: 'ok', action: window.t('updates.restart') };
    case 'available': {
      const head = ut('available', { version: u.version });
      // A Mac copy outside Applications (or a standard user's /Applications): one click installs the update there and restarts.
      if (u.relocate) {
        const user = u.relocate === 'user';
        return { note: `${head} ${user ? ut('relocate.user') : why} ${ut('relocate.install', { where: ut(user ? 'relocate.whereUser' : 'relocate.whereApps') })}`, cls: 'ok', action: window.t('updates.moveAndUpdate') };
      }
      if (u.canSelfUpdate) return { note: head, cls: 'ok', action: window.t('updates.download') };
      const hint = u.kind === 'mac' ? ut('manual.mac') : u.asset?.name.endsWith('.exe') ? ut('manual.exe') : u.asset ? ut('manual.zip') : '';
      return { note: `${head} ${ut('manual.cantReplace')}${hint ? ` ${hint}` : ''}`, cls: 'ok', action: u.asset ? window.t('updates.downloadAsset', { name: u.asset.name }) : ut('action.releases') };
    }
    case 'error':
      // A failed swap says what couldn't be installed and that nothing was lost (its version is unknown when no marker named it).
      if (u.installFailed) return { note: window.t(u.version ? 'updates.installFailedWhy' : 'updates.installFailedNoVersionWhy', { version: u.version, reason: cause(u.error) }), cls: 'err', action: window.t('updates.retry') };
      return u.version && own
        ? { note: ut('updateFailed', { version: u.version, reason: cause(u.error) }), cls: 'err', action: window.t('updates.retry') }
        : { note: ut('checkFailed', { reason: cause(u.error) }), cls: 'err', action: u.relocate === 'misplaced' ? moveTo : undefined };
    default: return plainMove || { note: '', cls: '' };
  }
}

async function buildUpdates(card) {
  const U = S.updates;
  let u = await U.state();
  const note = status('updates-status');
  // `busy` covers the click itself: the 1-second render below must not re-enable a button whose call is still running.
  let busy = false;
  const click = async (fn) => {
    if (busy) return;
    busy = true;
    render();
    try { u = await fn(); } finally { busy = false; u = await U.state(); render(); }
  };
  const action = h('button', { class: 'primary', id: 'updates-apply', hidden: true, onclick: () => click(() => U.apply()) });
  const checkBtn = h('button', { id: 'updates-check', text: ut('action.check'), onclick: () => click(() => U.check()) });
  const r = row(ut('row.title'), '', action, checkBtn);
  const desc = h('span', { class: 'desc', id: 'updates-desc' });
  r.querySelector('.text').append(desc, note);
  r.dataset.search += ' update version check download';
  const auto = toggle('autoDownloadUpdates', ut('auto.title'), ut(u.canSelfUpdate ? 'auto.descOwn' : 'auto.descManual'));
  auto.querySelector('input').disabled = !u.canSelfUpdate;

  function render() {
    const v = updateView(u);
    desc.textContent = ut('version', { version: u.current, checked: updateAgo(u.lastChecked) });
    note.textContent = v.note;
    note.className = `note ${v.cls}`.trim();
    action.hidden = !v.action;
    action.textContent = v.action || '';
    // A check with an update already known keeps the old status underneath; the buttons just say so.
    action.disabled = busy || Boolean(u.checking);
    checkBtn.textContent = u.checking || u.status === 'checking' ? window.t('updates.checking') : ut('action.check');
    checkBtn.disabled = busy || Boolean(u.disabled) || Boolean(u.checking) || ['checking', 'downloading'].includes(u.status);
  }
  // Follows a check or a download (also one started from the toolbar) while About is showing.
  const timer = setInterval(async () => {
    if (!visibleNow(checkBtn) || document.hidden) return;
    u = await U.state();
    render();
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  render();
  // What's new (features/whats-new.js): the release notes once after an update, and on demand.
  const notes = toggle('showWhatsNew', ut('whatsNew.toggle'), ut('whatsNew.toggleDesc'));
  const openNotes = h('button', { id: 'whats-new-open', text: ut('whatsNew.open'), onclick: () => S.whatsNew() });
  const notesRow = row(ut('whatsNew.row'), ut('whatsNew.rowDesc', { version: u.current }), openNotes);
  notesRow.dataset.search += ' whats new release notes changelog';
  card.append(r, auto, notes, notesRow);
}

// About Lumen → Updates (features/updates.js): the version, "Check for updates", what was found,
// and "Download updates automatically". Uses settings.js's row helpers; settings.js calls
// buildUpdates(card) while it builds the About section.
const UPDATE_DISABLED = {
  dev: 'Updates are off in development runs (electron .).',
  test: 'Updates are off in test mode.',
  mcp: 'Updates are off in MCP bridge mode.',
};

function updateAgo(ms) {
  if (!ms) return 'Never checked';
  const min = Math.round((Date.now() - ms) / 60e3);
  if (min < 1) return 'Checked just now';
  if (min < 60) return `Checked ${min} minute${min === 1 ? '' : 's'} ago`;
  return `Checked ${new Date(ms).toLocaleString()}`;
}

// What the status line says and what the action button does, for one state.
// One button for a copy that installs its own updates: "Restart to update" (also while it is still
// downloading, which queues it), or for a Mac copy outside Applications "Move and update".
function updateView(u) {
  if (u.disabled) return { note: UPDATE_DISABLED[u.disabled] || 'Updates are off.', cls: '' };
  const own = u.canSelfUpdate || Boolean(u.relocate); // swaps in place, or installs into Applications
  // A failed move or install comes before everything else: the reason, and a way to retry.
  if (u.moveError && u.relocate) return { note: u.moveError, cls: 'err', action: u.version ? 'Try again' : 'Move to Applications' };
  // A misplaced copy with no update to install yet: the plain move (the native Move to Applications).
  const plainMove = u.relocate === 'misplaced' ? { note: `${u.misplaced === 'unwritable' ? 'Lumen is somewhere it can’t update itself.' : 'Lumen is running from the disk image or a temporary location, so it can’t update itself.'} Move it to Applications and updates will download and install on their own.`, cls: 'ok', action: 'Move to Applications' } : null;
  switch (u.status) {
    case 'checking': return { note: 'Checking for updates…', cls: '' };
    case 'up-to-date': return plainMove ? { ...plainMove, note: `Lumen is up to date. ${plainMove.note}` } : { note: 'Lumen is up to date.', cls: 'ok' };
    case 'downloading': return u.queued
      ? { note: `Downloading Lumen ${u.version}… ${u.progress || 0}%. Lumen restarts by itself when it is ready.`, cls: '' }
      : { note: `Downloading Lumen ${u.version}… ${u.progress || 0}%`, cls: '', action: own ? 'Restart to update' : undefined };
    case 'downloaded': return { note: `Lumen ${u.version} is ready. Restart to update${u.blocked ? '.' : ', or it installs when you quit.'} Your settings and tabs are kept.`, cls: 'ok', action: 'Restart to update' };
    case 'available':
      // A Mac copy outside Applications (or a standard user's /Applications): one click installs the update there and restarts.
      if (u.relocate) return { note: `Lumen ${u.version} is available. ${u.relocate === 'user' ? 'Lumen can’t update itself in /Applications without an administrator.' : u.misplaced === 'unwritable' ? 'Lumen is somewhere it can’t update itself.' : 'Lumen is running from the disk image or a temporary location, so it can’t update itself.'} One click installs the update in ${u.relocate === 'user' ? 'your own Applications folder (~/Applications)' : 'Applications'} and restarts, and after that updates install on their own.`, cls: 'ok', action: 'Move and update' };
      if (u.canSelfUpdate) return { note: `Lumen ${u.version} is available.`, cls: 'ok', action: 'Download' };
      return { note: `Lumen ${u.version} is available. This copy can't replace itself where it is installed.${u.kind === 'mac' ? ' Open the downloaded disk image and drag Lumen to Applications.' : u.asset?.name.endsWith('.exe') ? ' Run the downloaded setup to update.' : u.asset ? ' Unzip it over this copy.' : ''}`, cls: 'ok', action: u.asset ? `Download ${u.asset.name}` : 'Open releases page' };
    case 'error': if (u.installFailed && !u.version) return { note: `Lumen couldn’t install the last update: ${u.error || 'unknown error'}`, cls: 'err', action: 'Try again' }; // the swap failed and left no version to name
      return u.version && own
      ? { note: `Couldn’t update to Lumen ${u.version}: ${u.error || 'unknown error'}`, cls: 'err', action: 'Try again' }
      : { note: `Couldn’t check for updates: ${u.error || 'unknown error'}`, cls: 'err', action: u.relocate === 'misplaced' ? 'Move to Applications' : undefined };
    default: return plainMove || { note: '', cls: '' };
  }
}

async function buildUpdates(card) {
  const U = S.updates;
  let u = await U.state();
  const note = status('updates-status');
  const action = h('button', { class: 'primary', id: 'updates-apply', hidden: true, onclick: async () => { u = await U.apply(); render(); } });
  const checkBtn = h('button', { id: 'updates-check', text: 'Check for updates', onclick: async () => { checkBtn.disabled = true; u = await U.check(); render(); } });
  const r = row('Updates', '', action, checkBtn);
  const desc = h('span', { class: 'desc', id: 'updates-desc' });
  r.querySelector('.text').append(desc, note);
  r.dataset.search += ' update version check download';
  const auto = toggle('autoDownloadUpdates', 'Download updates automatically',
    u.canSelfUpdate ? 'New versions download in the background; Lumen asks you to restart when one is ready. Off: Lumen asks before downloading.'
      : 'This copy can’t replace itself where it is installed (a portable exe, a folder that needs administrator rights, a Mac app outside Applications, or Linux). It tells you when a new version is out and downloads it when you ask (a Mac copy outside Applications installs the update there in one click).');
  auto.querySelector('input').disabled = !u.canSelfUpdate;

  function render() {
    const v = updateView(u);
    desc.textContent = `Lumen ${u.current} · ${updateAgo(u.lastChecked)}`;
    note.textContent = v.note;
    note.className = `note ${v.cls}`.trim();
    action.hidden = !v.action;
    action.textContent = v.action || '';
    // A check with an update already known keeps the old status underneath; the buttons just say so.
    action.disabled = Boolean(u.checking);
    checkBtn.textContent = u.checking || u.status === 'checking' ? 'Checking…' : 'Check for updates';
    checkBtn.disabled = Boolean(u.disabled) || Boolean(u.checking) || ['checking', 'downloading'].includes(u.status);
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
  const notes = toggle('showWhatsNew', 'Show what’s new after updates',
    'After Lumen updates, the release notes for the new version come up once. They ship with Lumen, so this needs no network.');
  const openNotes = h('button', { id: 'whats-new-open', text: 'Show what’s new', onclick: () => S.whatsNew() });
  const notesRow = row('What’s new', `The release notes for Lumen ${u.current} and the versions just before it.`, openNotes);
  notesRow.dataset.search += ' whats new release notes changelog';
  card.append(r, auto, notes, notesRow);
}

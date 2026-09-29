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
function updateView(u) {
  if (u.disabled) return { note: UPDATE_DISABLED[u.disabled] || 'Updates are off.', cls: '' };
  switch (u.status) {
    case 'checking': return { note: 'Checking for updates…', cls: '' };
    case 'up-to-date': return { note: 'Lumen is up to date.', cls: 'ok' };
    case 'downloading': return { note: `Downloading Lumen ${u.version}… ${u.progress || 0}%`, cls: '' };
    case 'downloaded': return { note: `Lumen ${u.version} is ready. Restart to update, or it installs when you quit. Your settings and tabs are kept.`, cls: 'ok', action: 'Restart to update' };
    case 'available':
      if (u.canSelfUpdate) return { note: `Lumen ${u.version} is available.`, cls: 'ok', action: 'Download' };
      return { note: `Lumen ${u.version} is available. This copy can't replace itself where it is installed.${u.kind === 'mac' ? ' Open the downloaded disk image and drag Lumen to Applications.' : u.asset ? ' Unzip it over this copy.' : ''}`, cls: 'ok', action: u.asset ? `Download ${u.asset.name}` : 'Open releases page' };
    case 'error': return u.version && u.canSelfUpdate
      ? { note: `Couldn’t update to Lumen ${u.version}: ${u.error || 'unknown error'}`, cls: 'err', action: 'Try again' }
      : { note: `Couldn’t check for updates: ${u.error || 'unknown error'}`, cls: 'err' };
    default: return { note: '', cls: '' };
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
      : 'This copy can’t replace itself where it is installed (a portable exe, a folder that needs administrator rights, or Linux). It tells you when a new version is out and downloads it when you ask.');
  auto.querySelector('input').disabled = !u.canSelfUpdate;

  function render() {
    const v = updateView(u);
    desc.textContent = `Lumen ${u.current} · ${updateAgo(u.lastChecked)}`;
    note.textContent = v.note;
    note.className = `note ${v.cls}`.trim();
    action.hidden = !v.action;
    action.textContent = v.action || '';
    checkBtn.disabled = Boolean(u.disabled) || ['checking', 'downloading'].includes(u.status);
  }
  // Follows a check or a download (also one started from the toolbar) while About is showing.
  const timer = setInterval(async () => {
    if (!visibleNow(checkBtn) || document.hidden) return;
    u = await U.state();
    render();
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  render();
  card.append(r, auto);
}

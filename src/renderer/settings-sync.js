// Settings → General → Sync: "Sync through a folder" (features/sync-folder.js, docs/sync.md). Off by default. The person picks a folder
// their own cloud drive syncs and a sync passphrase; Lumen keeps bookmarks, history, chats, home widgets and preferences in step through
// encrypted files in it. Uses settings.js's row helpers (h, row, tr, status, flash); settings.js calls buildSync(card) from its builder list.
// The passphrase is typed here once and sent to the main process; it is never shown again and never kept in this page.

const SYNC_KINDS = ['bookmarks', 'history', 'chats', 'widgets', 'settings'];
const syncKindText = (kind) => ({
  bookmarks: [tr('settings.sync.kind.bookmarks', 'Bookmarks'), tr('settings.sync.kind.bookmarksDesc', 'Your bookmarks and their folders.')],
  history: [tr('settings.sync.kind.history', 'History'), tr('settings.sync.kind.historyDesc', 'The pages you visited, for the address bar’s suggestions and the History page.')],
  chats: [tr('settings.sync.kind.chats', 'Chats'), tr('settings.sync.kind.chatsDesc', 'Your saved AI chats, with their titles, pins and archive. A chat that is open on a computer waits until you leave it.')],
  widgets: [tr('settings.sync.kind.widgets', 'Home page widgets'), tr('settings.sync.kind.widgetsDesc', 'Which cards are on the new tab page, and where. Sign-ins and keys of a card stay on the computer.')],
  settings: [tr('settings.sync.kind.settings', 'Settings'), tr('settings.sync.kind.settingsDesc', 'Look and feel and everyday choices: theme, accent color, search engine, privacy switches. Never API keys, sign-ins, folders or what the AI may do.')],
}[kind]);

function syncAgo(ms) {
  if (!ms) return tr('settings.sync.never', 'not yet');
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 45) return tr('settings.sync.justNow', 'just now');
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
    if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
    return rtf.format(-Math.round(sec / 86400), 'day');
  } catch { return new Date(ms).toLocaleString(); }
}

// What went wrong, in words (the code comes from features/sync-core.js SyncError).
function syncError(err) {
  const code = err?.code || 'error';
  const known = {
    'no-folder': tr('settings.sync.err.noFolder', 'That folder isn’t there. Choose it again, or check that your cloud drive is running.'),
    'not-writable': tr('settings.sync.err.notWritable', 'Lumen can’t write in that folder.'),
    'bad-folder': tr('settings.sync.err.badFolder', 'Choose a folder outside Lumen’s own data.'),
    'wrong-passphrase': tr('settings.sync.err.wrongPassphrase', 'That isn’t the passphrase this folder was set up with. Use the one you chose on your first computer.'),
    'short-passphrase': tr('settings.sync.err.shortPassphrase', 'Use a passphrase of at least 8 characters.'),
    'bad-meta': tr('settings.sync.err.badMeta', 'The setup file in that folder is damaged. Move the “Lumen Sync” folder away to start again.'),
    newer: tr('settings.sync.err.newer', 'That folder was set up by a newer Lumen. Update Lumen first.'),
    'no-keychain': tr('settings.sync.err.noKeychain', 'This computer has no secure storage to keep the passphrase in, so sync can’t be turned on.'),
    'no-passphrase': tr('settings.sync.err.noPassphrase', 'The passphrase isn’t saved on this computer any more. Enter it again below.'),
    'passwords-off': tr('settings.sync.err.passwordsOff', 'Turn on Save passwords first (Privacy and security), then come back to this switch.'),
  }[code];
  return known || err?.message || tr('settings.sync.err.other', 'Something went wrong.');
}

async function buildSync(card) {
  const slot = card.at('sync');
  const box = h('div', { class: 'sync-box', id: 'sync-box' });
  slot.append(box);
  let state = await S.sync.state();
  let formOpen = false;
  let busy = false;
  const draft = { folder: '', kinds: Object.fromEntries(SYNC_KINDS.map((k) => [k, true])), passwords: false };

  const switchRow = (id, label, desc, checked, onchange, disabled = false) => {
    const input = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', 'aria-label': label });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => onchange(input));
    const el = row(label, desc, input);
    el.classList.add('sub-row');
    el.querySelector('.label').addEventListener('click', () => { if (!input.disabled) input.click(); });
    return el;
  };

  // The passwords switch: only when Save passwords is on here, and a plain warning beside it.
  const passwordsRow = (checked, onchange, id) => {
    const canUse = state.passwordsOn;
    const el = switchRow(id, tr('settings.sync.passwords', 'Also sync saved passwords'),
      tr('settings.sync.passwordsDesc', 'Off unless you turn it on. Passwords go into the folder only inside the passphrase-encrypted files, like everything else, but anyone who gets your passphrase and your cloud drive could read them, so use a strong passphrase. A password changed on one computer replaces the one on the others.'),
      checked && canUse, onchange, !canUse);
    if (!canUse) el.querySelector('.text').append(h('span', { class: 'note', text: tr('settings.sync.passwordsNeedOn', 'Turn on Save passwords (Privacy and security) to use this.') }));
    return el;
  };

  // ---- the form: folder + passphrase + what syncs
  function setupForm({ again } = {}) {
    const folder = h('input', { type: 'text', class: 'grow', id: 'sync-folder-path', readonly: true, placeholder: tr('settings.sync.noFolder', 'No folder chosen'), 'aria-label': tr('settings.sync.folder', 'Folder'), value: draft.folder || state.path || '' });
    const pick = h('button', { id: 'sync-pick', type: 'button', text: tr('settings.sync.choose', 'Choose folder…'), onclick: async () => { const p = await S.sync.pick().catch(() => null); if (p) { draft.folder = p; folder.value = p; } } });
    const pass = h('input', { type: 'password', class: 'grow', id: 'sync-passphrase', autocomplete: 'off', spellcheck: 'false', placeholder: tr('settings.sync.passphrasePlaceholder', 'Sync passphrase'), 'aria-label': tr('settings.sync.passphrase', 'Sync passphrase') });
    const note = status('sync-form-status');
    note.setAttribute('role', 'status');
    const go = h('button', { id: 'sync-enable', type: 'button', class: 'primary', text: again ? tr('settings.sync.save', 'Save passphrase') : tr('settings.sync.turnOn', 'Turn on sync') });
    go.addEventListener('click', async () => {
      const folderPath = draft.folder || state.path;
      if (!folderPath) { flash(note, tr('settings.sync.err.noFolder', 'That folder isn’t there. Choose it again, or check that your cloud drive is running.'), 'err'); return; }
      go.disabled = true;
      flash(note, tr('settings.sync.working', 'Connecting to the folder…'), '');
      const r = await S.sync.enable({ folder: folderPath, passphrase: pass.value, kinds: draft.kinds, passwords: draft.passwords }).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      go.disabled = false;
      if (!r.ok) { flash(note, syncError(r), 'err'); return; }
      pass.value = '';
      formOpen = false;
      state = r.state;
      render();
    });
    const cancel = h('button', { id: 'sync-cancel', type: 'button', text: tr('settings.sync.cancel', 'Cancel'), onclick: () => { formOpen = false; render(); } });
    const wrap = h('div', { class: 'stack sync-form', id: 'sync-form' },
      h('div', { class: 'controls' }, folder, pick),
      h('div', { class: 'controls' }, pass),
      h('span', { class: 'note', text: tr('settings.sync.passphraseHelp', 'Use the same passphrase on every computer. Lumen keeps it on this computer only (in your system’s secure storage) and can’t recover it for you. At least 8 characters when you set up a new folder.') }),
      again ? null : h('div', { class: 'sync-kinds' },
        ...SYNC_KINDS.map((k) => switchRow(`sync-new-${k}`, syncKindText(k)[0], syncKindText(k)[1], draft.kinds[k], (i) => { draft.kinds[k] = i.checked; })),
        passwordsRow(draft.passwords, (i) => { draft.passwords = i.checked; }, 'sync-new-passwords')),
      h('div', { class: 'controls' }, go, again ? null : cancel), note);
    return wrap;
  }

  // ---- on: status, Sync now, what syncs, Turn off
  function onView() {
    const parts = [];
    const err = state.error;
    const statusNote = status('sync-status');
    statusNote.setAttribute('role', 'status');
    if (err) flash(statusNote, syncError(err), 'err');
    else if (state.running) flash(statusNote, tr('settings.sync.syncing', 'Syncing…'), '');
    else flash(statusNote, tr('settings.sync.last', 'Last synced {when}.', { when: syncAgo(state.lastSynced) }), state.lastSynced ? 'ok' : '');
    const others = (state.devices || []).filter((d) => !d.self);
    const devices = h('span', { class: 'note', id: 'sync-devices', text: others.length
      ? tr('settings.sync.devices', 'Other computers seen in this folder: {names}.', { names: others.map((d) => `${d.name || tr('settings.sync.unnamed', 'a computer')} (${syncAgo(d.seen)})`).join(', ') })
      : tr('settings.sync.noDevices', 'No other computer has used this folder yet.') });
    const extra = [];
    if (state.damaged) extra.push(h('span', { class: 'note warn', id: 'sync-damaged', text: tr(state.damaged === 1 ? 'settings.sync.damagedOne' : 'settings.sync.damagedMany', state.damaged === 1 ? '1 file in the folder couldn’t be read (damaged, still downloading, or made with another passphrase). Lumen skips it.' : '{n} files in the folder couldn’t be read (damaged, still downloading, or made with another passphrase). Lumen skips them.', { n: state.damaged }) }));
    if (state.newer) extra.push(h('span', { class: 'note warn', text: tr('settings.sync.newerFiles', 'Some files were written by a newer Lumen and are skipped until you update.') }));
    for (const s of state.skipped || []) {
      const text = s.reason === 'mass-delete'
        ? tr('settings.sync.massDelete', 'Many {what} went missing at once, so Lumen did not copy those deletions to your other computers. If you meant that, press Sync now.', { what: s.provider })
        : tr('settings.sync.skipped', '{what} could not be read just now and was left alone.', { what: s.provider });
      extra.push(h('span', { class: 'note warn', text }));
    }
    const nowBtn = h('button', { id: 'sync-now', type: 'button', class: 'primary', text: tr('settings.sync.now', 'Sync now'), disabled: state.running || busy || err?.code === 'no-passphrase' });
    nowBtn.addEventListener('click', async () => {
      busy = true; nowBtn.disabled = true; flash(statusNote, tr('settings.sync.syncing', 'Syncing…'), '');
      const r = await S.sync.now().catch((e) => ({ ok: false, message: String(e?.message || e) }));
      busy = false;
      if (r.state) state = r.state; else if (!r.ok) flash(statusNote, syncError(r), 'err');
      render();
    });
    const off = armedButton(tr('settings.sync.off', 'Turn off'), tr('settings.sync.offSure', 'Turn off? Click again'), async () => {
      const r = await S.sync.off().catch(() => null);
      if (r?.state) state = r.state; else state = await S.sync.state();
      formOpen = false;
      render();
    }, 'danger', 'sync-off');
    const head = row(tr('settings.sync.on', 'Sync is on'),
      tr('settings.sync.onDesc', 'Folder: {path}', { path: state.folderName || state.path }),
      nowBtn, off);
    head.id = 'sync-head';
    head.querySelector('.text').append(statusNote, devices, ...extra);
    parts.push(head);
    if (err?.code === 'no-passphrase') parts.push(setupForm({ again: true }));
    parts.push(...SYNC_KINDS.map((k) => switchRow(`sync-kind-${k}`, syncKindText(k)[0], syncKindText(k)[1], state.kinds[k] !== false, async (input) => {
      input.disabled = true;
      const r = await S.sync.set({ kinds: { [k]: input.checked } }).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      if (r.state) state = r.state; else { input.checked = !input.checked; flash(statusNote, syncError(r), 'err'); }
      render();
    })));
    const pw = passwordsRow(state.passwords, async (input) => {
      input.disabled = true;
      const r = await S.sync.set({ passwords: input.checked }).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      if (r.state) state = r.state; else { input.checked = !input.checked; flash(statusNote, syncError(r), 'err'); }
      render();
    }, 'sync-passwords');
    parts.push(pw);
    parts.push(h('div', { class: 'row sub-row sync-note' }, h('div', { class: 'text' }, h('span', { class: 'desc', text: tr('settings.sync.offHelp', 'Turning sync off stops this computer and forgets the passphrase here. Your data stays on every computer, and the files stay in the folder: delete the “Lumen Sync” folder yourself if you want them gone.') }))));
    return parts;
  }

  function offView() {
    const setup = h('button', { id: 'sync-setup', type: 'button', class: 'primary', text: tr('settings.sync.setup', 'Set up…'), onclick: () => { formOpen = !formOpen; render(); } });
    const head = row(tr('settings.sync.title', 'Sync through a folder'),
      tr('settings.sync.desc', 'Keep your bookmarks, history, chats, home page widgets and settings the same on your computers. Choose a folder that your own cloud drive (OneDrive, Dropbox, Google Drive, iCloud Drive) already syncs. Lumen has no server and no account: nothing leaves this computer except into that folder, and everything in it is encrypted with a passphrase only you know. Off by default.'),
      setup);
    head.id = 'sync-head';
    withKeywords(head, 'sync syncing account devices phone cloud backup transfer move onedrive dropbox google drive icloud computers share');
    if (!state.keychain) head.querySelector('.text').append(h('span', { class: 'note warn', id: 'sync-nokeychain', text: syncError({ code: 'no-keychain' }) }));
    return [head, ...(formOpen ? [setupForm()] : [])];
  }

  function render() {
    box.replaceChildren(...(state.on ? onView() : offView()));
    for (const el of box.querySelectorAll('.row')) { if (!el.dataset.search) el.dataset.search = (el.textContent || '').toLowerCase(); }
  }
  render();
  if (S.sync.onChanged) S.sync.onChanged(async () => { if (busy || document.activeElement?.id === 'sync-passphrase') return; state = await S.sync.state().catch(() => state); if (!(formOpen && !state.on)) render(); });
  // The relative times move on while the page is open.
  setInterval(() => { if (state.on && !busy && !document.hidden) S.sync.state().then((s) => { state = s; if (!box.querySelector('#sync-passphrase')) render(); }).catch(() => {}); }, 60000).unref?.();
}

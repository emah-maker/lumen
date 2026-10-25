// Settings → AI → "Let other apps use Lumen": Claude Desktop, Cursor, VS Code and Claude Code (outside Lumen) using Lumen's browser tools.
// Loaded before settings.js and mounted by its buildAi() with one line; it uses that file's h(), row(), stackRow(), armedButton() and tr()
// helpers. The backend is features/external-apps.js (through external-apps-ipc.js). A token is shown once, when "Add app" makes it: only
// its copy lives in this page, and it is gone when the page is closed or the note dismissed.

function buildExternalApps() {
  const X = window.lumenSettings.ai.externalApps;
  const CLIENTS = [['claude-desktop', 'Claude Desktop'], ['cursor', 'Cursor'], ['vscode', 'VS Code'], ['claude-code', 'Claude Code']];
  let info = null;
  let current = 'claude-desktop';
  let fresh = null; // { app, setup, added } the app whose setup text is showing (after Add app or "Show setup")

  const root = h('div', { class: 'external-apps', id: 'external-apps' });
  const switchInput = h('input', { type: 'checkbox', class: 'switch', id: 'ea-switch', role: 'switch', 'aria-label': tr('settings.ea.switch', 'Let other apps use Lumen'), onchange: async (e) => { draw(await X.enable(e.target.checked)); } });
  const statusLine = h('span', { class: 'note', id: 'ea-status', role: 'status' });
  const requireInput = h('input', { type: 'checkbox', class: 'switch', id: 'ea-require', role: 'switch', 'aria-label': tr('settings.ea.require', 'Require a token for every app'), onchange: async (e) => { draw(await X.setRequireToken(e.target.checked)); } });
  const warning = h('p', { class: 'note err', id: 'ea-warning', role: 'status', hidden: true });
  const requireNow = h('button', { type: 'button', id: 'ea-require-now', class: 'primary', text: tr('settings.ea.requireNow', 'Require a token for every app'), onclick: async () => draw(await X.setRequireToken(true)) });
  const setupBox = h('div', { class: 'list', id: 'ea-setup' });
  const appsBox = h('div', { class: 'list', id: 'ea-apps' });

  const ago = (t) => {
    if (!t) return tr('settings.ea.neverUsed', 'Not used yet');
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return tr('settings.ea.usedNow', 'Used just now');
    if (s < 3600) return tr('settings.ea.usedMin', 'Used {n} min ago', { n: Math.round(s / 60) });
    if (s < 86400) return tr('settings.ea.usedHour', 'Used {n} h ago', { n: Math.round(s / 3600) });
    return tr('settings.ea.usedOn', 'Used {date}', { date: new Date(t).toLocaleDateString() });
  };
  const copyButton = (text, label = tr('settings.ea.copy', 'Copy')) => {
    const b = h('button', { type: 'button', class: 'ea-copy', text: label, onclick: async () => { await navigator.clipboard.writeText(text()).catch(() => {}); b.textContent = tr('settings.ea.copied', 'Copied'); setTimeout(() => { b.textContent = label; }, 1400); } });
    return b;
  };

  function drawStatus() {
    const n = info.connected;
    statusLine.textContent = !info.enabled ? tr('settings.ea.off', 'Off') : n ? tr(n === 1 ? 'settings.ea.on.one' : 'settings.ea.on.other', n === 1 ? 'On · 1 app connected' : 'On · {n} apps connected', { n }) : tr('settings.ea.on.none', 'On · no apps connected');
    statusLine.dataset.state = info.enabled ? 'on' : 'off';
  }

  function drawSetup() {
    const tabs = h('div', { class: 'ea-tabs', role: 'tablist', 'aria-label': tr('settings.ea.tabs', 'App to set up') }, CLIENTS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: `ea-tab-${id}`, class: 'ea-tab', 'aria-selected': String(id === current), 'aria-controls': 'ea-panel', tabindex: id === current ? '0' : '-1', 'data-client': id, text: label,
      onclick: () => { current = id; drawSetup(); },
      onkeydown: (e) => {
        const i = CLIENTS.findIndex(([c]) => c === current);
        const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? CLIENTS.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        current = CLIENTS[(next + CLIENTS.length) % CLIENTS.length][0];
        drawSetup();
        $(`ea-tab-${current}`).focus();
      },
    })));
    const setup = (fresh ? fresh.setup : info.setup)[current];
    const shownApp = fresh ? fresh.app : null;
    const label = CLIENTS.find(([id]) => id === current)[1];
    const nameInput = h('input', { type: 'text', id: 'ea-name', maxlength: '60', value: label, 'aria-label': tr('settings.ea.name', 'Name for this app') });
    const note = h('span', { class: 'note', id: 'ea-add-note', role: 'status' });
    const add = h('button', { type: 'button', id: 'ea-add', class: 'primary', text: tr('settings.ea.add', 'Add app'), onclick: async () => {
      add.disabled = true;
      const r = await X.add({ name: nameInput.value, app: current }).catch((err) => ({ ok: false, error: err.message }));
      add.disabled = false;
      if (!r.ok) return flash(note, r.error, 'err');
      info = r.info;
      fresh = { app: r.app, setup: r.setup, added: true };
      draw(info);
    } });
    const openBtn = info.paths[current] ? h('button', { type: 'button', id: 'ea-open', text: tr('settings.ea.openConfig', 'Open the config file'), onclick: async () => {
      const r = await X.openConfig(current).catch(() => ({ ok: false }));
      flash(openNote, r.ok ? (r.missing ? tr('settings.ea.noFile', 'That file doesn’t exist yet; its folder is open. Create the file there.') : '') : tr('settings.ea.noFolder', 'Couldn’t find that app’s folder. Is it installed?'), r.ok ? 'ok' : 'err');
    } }) : null;
    const openNote = h('span', { class: 'note', id: 'ea-open-note', role: 'status' });
    setupBox.replaceChildren(
      tabs,
      h('div', { class: 'snippet', id: 'ea-panel', role: 'tabpanel', 'aria-labelledby': `ea-tab-${current}` },
        fresh
          ? h('div', { class: 'ea-fresh', id: 'ea-fresh' },
            h('p', { class: 'note ok', text: tr(fresh.added ? 'settings.ea.fresh' : 'settings.ea.shown', fresh.added ? '“{name}” is added. Its token is in a file only you can read; the text below names that file, so it holds no secret.' : 'Setup text for “{name}”. It names the token file; it holds no secret.', { name: shownApp.name }) }),
            h('div', { class: 'item' }, h('button', { type: 'button', id: 'ea-done', text: tr('settings.ea.done', 'Add another app'), onclick: () => { fresh = null; drawSetup(); } })))
          : h('div', { class: 'item' }, h('span', { class: 'grow' }, nameInput), add, note),
        h('p', { class: 'note', text: `${setup.where}.` }),
        setup.warning ? h('p', { class: 'note err', id: 'ea-config-warning', text: setup.warning }) : null,
        h('pre', { class: 'mono code', id: 'ea-snippet', text: setup.text }),
        h('div', { class: 'item' }, copyButton(() => setup.text), openBtn, openNote),
        fresh ? null : h('p', { class: 'note', text: tr('settings.ea.placeholder', 'Add app first: it makes the token file and puts its path in this text. Without it the text carries a placeholder.') })));
  }

  function drawApps() {
    if (!info.apps.length) { appsBox.replaceChildren(h('p', { class: 'note', id: 'ea-none', text: tr('settings.ea.none', 'No apps yet.') })); return; }
    appsBox.replaceChildren(...info.apps.map((a) => {
      const unverified = a.kind !== 'token';
      const always = a.kind === 'remembered'; // an unverified client the user said "Always allow" to: kept until revoked
      const ask = unverified ? null : h('input', { type: 'checkbox', 'aria-label': tr('settings.ea.askBefore', 'Ask before {name} acts', { name: a.name }), checked: a.ask, onchange: async (e) => draw((await X.setAsk(a.id, e.target.checked)).info) });
      const revoke = armedButton(unverified && !always ? tr('settings.ea.disconnect', 'Disconnect') : tr('settings.ea.revoke', 'Revoke'), unverified && !always ? tr('settings.ea.disconnectSure', 'Click again to disconnect') : tr('settings.ea.revokeSure', 'Click again to revoke'), async () => { if (fresh?.app.id === a.id) fresh = null; draw((await X.revoke(a.id)).info); });
      const show = unverified ? null : h('button', { type: 'button', class: 'ea-show', text: tr('settings.ea.show', 'Show setup'), onclick: async () => { const r = await X.setup(a.id); if (r.ok) { fresh = { app: r.app, setup: r.setup, added: false }; drawSetup(); } } });
      const state = a.paused ? tr('settings.ea.paused', 'Paused') : a.busy ? tr('settings.ea.working', 'Working now') : a.connected ? tr('settings.ea.connected', 'Connected') : tr('settings.ea.idle', 'Not connected');
      return h('div', { class: 'snippet ea-app', 'data-app': a.name, 'data-app-id': a.id },
        h('div', { class: 'item' },
          h('span', { class: 'grow' }, h('strong', { text: a.name }), h('span', { class: 'note', text: ` · ${state} · ${ago(a.lastUsed)}${unverified ? ` · ${always ? tr('settings.ea.always', 'Unverified: no token, always allowed on this computer') : tr('settings.ea.unverified', 'Unverified: no token, allowed for this session')}` : ''}` })),
          ask ? h('label', { class: 'note' }, ask, ` ${tr('settings.ea.ask', 'Ask before it acts')}`) : null, show, revoke));
    }));
  }

  function draw(next) {
    if (next) info = next;
    if (!info) return;
    switchInput.checked = info.enabled;
    requireInput.checked = info.requireToken;
    const open = info.enabled && !info.requireToken;
    warning.hidden = !open;
    requireNow.hidden = !open;
    warning.textContent = open ? tr('settings.ea.warning', 'Apps without a token can connect after you click Allow, and any program on this computer can claim to be one of your apps. Turn on “Require a token for every app”.') : '';
    drawStatus();
    // (A redraw while the name field has focus or the token note is up would take them away: only the status and the list follow the poll.)
    drawSetup();
    drawApps();
  }

  root.append(
    row(tr('settings.ea.switch', 'Let other apps use Lumen'), tr('settings.ea.switchDesc', 'Lets Claude Desktop, Cursor, VS Code and Claude Code (outside Lumen) read and use pages in a Lumen window of their own. Each app gets a token of its own that you can revoke.'), switchInput),
    h('div', { class: 'row' }, statusLine),
    row(tr('settings.ea.require', 'Require a token for every app'), tr('settings.ea.requireDesc', 'On: an app without a token is refused. Off: it waits for your Allow each time it connects, as an “unverified app”; Allow lasts that session (unless you pick Always allow), never asks less, and can’t use the name of an app you set up.'), requireInput),
    h('div', { class: 'row' }, warning, requireNow),
    stackRow(tr('settings.ea.setup', 'Set up an app'), tr('settings.ea.setupDesc', 'Pick the app, give it a name, and paste the text into its settings. Sites you’ve turned the AI off for, Lumen’s own pages, and “ask before acting” apply to these apps as they do to Lumen’s AI.'), setupBox),
    stackRow(tr('settings.ea.apps', 'Apps that can use Lumen'), tr('settings.ea.appsDesc', 'Revoke deletes an app’s token and cuts it off at once.'), appsBox));

  X.info().then((i) => draw(i)).catch(() => {});
  // The list follows what happens (an app connects, is used or is stopped) while the page is open.
  const timer = setInterval(async () => {
    if (!root.isConnected) { if (root.dataset.seen) clearInterval(timer); return; }
    root.dataset.seen = '1';
    if (document.hidden || !info) return;
    const next = await X.info().catch(() => null);
    if (!next) return;
    info = next;
    switchInput.checked = info.enabled;
    drawStatus();
    if (!appsBox.contains(document.activeElement)) drawApps(); // (not under a click in progress)
  }, 2500);
  return root;
}

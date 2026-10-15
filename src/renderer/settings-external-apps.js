// Settings → AI → "Let other apps use Lumen": Claude Desktop, Cursor, VS Code and Claude Code (outside Lumen) using Lumen's browser tools.
// Loaded before settings.js and mounted by its buildAi() with one line; it uses that file's h(), row(), stackRow(), armedButton() and tr()
// helpers. The backend is features/external-apps.js (through external-apps-ipc.js). A token is shown once, when "Add app" makes it: only
// its copy lives in this page, and it is gone when the page is closed or the note dismissed.

function buildExternalApps() {
  const X = window.lumenSettings.ai.externalApps;
  const CLIENTS = [['claude-desktop', 'Claude Desktop'], ['cursor', 'Cursor'], ['vscode', 'VS Code'], ['claude-code', 'Claude Code']];
  let info = null;
  let current = 'claude-desktop';
  let fresh = null; // { app, token, setup } right after Add app

  const root = h('div', { class: 'external-apps', id: 'external-apps' });
  const switchInput = h('input', { type: 'checkbox', class: 'switch', id: 'ea-switch', role: 'switch', 'aria-label': tr('settings.ea.switch', 'Let other apps use Lumen'), onchange: async (e) => { draw(await X.enable(e.target.checked)); } });
  const statusLine = h('span', { class: 'note', id: 'ea-status', role: 'status' });
  const promptInput = h('input', { type: 'checkbox', class: 'switch', id: 'ea-prompt', role: 'switch', 'aria-label': tr('settings.ea.prompt', 'Ask me when an unknown app connects'), onchange: async (e) => { draw(await X.setPrompt(e.target.checked)); } });
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
    const label = CLIENTS.find(([id]) => id === current)[1];
    const nameInput = h('input', { type: 'text', id: 'ea-name', maxlength: '60', value: label, 'aria-label': tr('settings.ea.name', 'Name for this app') });
    const note = h('span', { class: 'note', id: 'ea-add-note', role: 'status' });
    const add = h('button', { type: 'button', id: 'ea-add', class: 'primary', text: tr('settings.ea.add', 'Add app'), onclick: async () => {
      add.disabled = true;
      const r = await X.add({ name: nameInput.value, app: current }).catch((err) => ({ ok: false, error: err.message }));
      add.disabled = false;
      if (!r.ok) return flash(note, r.error, 'err');
      info = r.info;
      fresh = { app: r.app, token: r.token, setup: r.setup };
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
            h('p', { class: 'note ok', text: tr('settings.ea.fresh', '“{name}” is added. Copy this now: Lumen can’t show the token again. If you lose it, revoke the app and add it again.', { name: fresh.app.name }) }),
            h('div', { class: 'item' }, h('button', { type: 'button', id: 'ea-done', text: tr('settings.ea.done', 'I’ve copied it'), onclick: () => { fresh = null; drawSetup(); } })))
          : h('div', { class: 'item' }, h('span', { class: 'grow' }, nameInput), add, note),
        h('p', { class: 'note', text: `${setup.where}.` }),
        h('pre', { class: 'mono code', id: 'ea-snippet', text: setup.text }),
        h('div', { class: 'item' }, copyButton(() => setup.text), openBtn, openNote),
        fresh ? null : h('p', { class: 'note', text: tr('settings.ea.placeholder', 'Add app first: it makes the token and puts it in this text. Without it the text carries a placeholder.') })));
  }

  function drawApps() {
    if (!info.apps.length) { appsBox.replaceChildren(h('p', { class: 'note', id: 'ea-none', text: tr('settings.ea.none', 'No apps yet.') })); return; }
    appsBox.replaceChildren(...info.apps.map((a) => {
      const ask = h('input', { type: 'checkbox', 'aria-label': tr('settings.ea.askBefore', 'Ask before {name} acts', { name: a.name }), checked: a.ask, onchange: async (e) => draw((await X.setAsk(a.id, e.target.checked)).info) });
      const revoke = armedButton(tr('settings.ea.revoke', 'Revoke'), tr('settings.ea.revokeSure', 'Click again to revoke'), async () => draw((await X.revoke(a.id)).info));
      const state = a.paused ? tr('settings.ea.paused', 'Paused') : a.busy ? tr('settings.ea.working', 'Working now') : a.connected ? tr('settings.ea.connected', 'Connected') : tr('settings.ea.idle', 'Not connected');
      return h('div', { class: 'snippet ea-app', 'data-app': a.name, 'data-app-id': a.id },
        h('div', { class: 'item' },
          h('span', { class: 'grow' }, h('strong', { text: a.name }), h('span', { class: 'note', text: ` · ${state} · ${ago(a.lastUsed)}${a.kind === 'name' ? ` · ${tr('settings.ea.byName', 'allowed by name, no token')}` : ''}` })),
          h('label', { class: 'note' }, ask, ` ${tr('settings.ea.ask', 'Ask before it acts')}`), revoke));
    }));
  }

  function draw(next) {
    if (next) info = next;
    if (!info) return;
    switchInput.checked = info.enabled;
    promptInput.checked = info.prompt;
    drawStatus();
    // (A redraw while the name field has focus or the token note is up would take them away: only the status and the list follow the poll.)
    drawSetup();
    drawApps();
  }

  root.append(
    row(tr('settings.ea.switch', 'Let other apps use Lumen'), tr('settings.ea.switchDesc', 'Lets Claude Desktop, Cursor, VS Code and Claude Code (outside Lumen) read and use pages in a Lumen window of their own. Each app gets a token of its own that you can revoke. Off by default.'), switchInput),
    h('div', { class: 'row' }, statusLine),
    row(tr('settings.ea.prompt', 'Ask me when an unknown app connects'), tr('settings.ea.promptDesc', 'An app without a token (set up the older way) waits for your Allow or Deny, in Lumen’s window, the first time it connects.'), promptInput),
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

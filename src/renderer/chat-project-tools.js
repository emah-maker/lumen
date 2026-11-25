// [project tools] A project's tools, in lumen://chat: which connected apps, MCP servers and skills its chats get (features/project-tools.js).
// Loaded the first time a project's Tools view or the New project dialog needs it (chat-project-page.js and chat-projects.js add this file
// and its stylesheet, marked data-later). Two parts:
//   view(holder, opts)   the Tools view: Apps and connections (each with its status, a switch, and Connect when it isn't connected yet),
//                        MCP servers and Skills. Every switch saves at once.
//   picker(holder, opts) the New project dialog's "Tools" step: the template's apps ticked, the rest a tick away, Connect inline.
// Theme tokens only (styles.css): light and dark and the user's accent follow on their own.
(() => {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const SHOWN = 8; // apps listed before "Show all apps"
  const openSettings = (section) => window.lumenPrefs?.openSettingsPage?.(section);

  // A connector's mark: its letter on its colour (registry.js icon), else the first letter on the accent.
  function mark(app) {
    const m = el('span', { className: 'ptl-mark', textContent: String(app.icon?.text || app.name || '?').slice(0, 1) });
    m.setAttribute('aria-hidden', 'true');
    if (/^#[0-9a-f]{3,8}$/i.test(String(app.icon?.color || ''))) m.style.setProperty('--ptl-mark', app.icon.color);
    return m;
  }
  // A switch: a button with role "switch" (Space and Enter work as on any button).
  function toggle(on, label, run) {
    const b = el('button', { type: 'button', className: `ptl-switch${on ? ' on' : ''}` });
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('aria-label', label);
    b.onclick = () => run(!on, b);
    return b;
  }
  const STATUS = (tr) => ({ connected: tr('projecttools.status.connected', 'Connected'), off: tr('projecttools.status.off', 'Not connected'), 'needs-signin': tr('projecttools.status.signin', 'Needs sign-in'), 'bad-token': tr('projecttools.status.token', 'Token refused'), error: tr('projecttools.status.error', 'Couldn’t connect') });

  // One app's row. `state`: { on, busy, error }. onToggle(on), onConnect().
  function appRow(app, tr, { onToggle, onConnect, connecting = false }) {
    const status = STATUS(tr)[app.status] || app.status;
    const row = el('li', { className: `ptl-row${app.on ? ' on' : ''}` });
    row.dataset.key = `apps:${app.id}`;
    const text = el('div', { className: 'ptl-row-main' }, el('span', { className: 'ptl-row-name', textContent: app.name }), el('span', { className: `ptl-row-status ${app.connected ? 'ok' : app.on ? 'warn' : ''}`.trim(), textContent: app.connected ? status : app.on ? tr('projecttools.needsConnect', '{status} · connect it to use it here', { status }) : status }));
    row.append(mark(app), text);
    if (!app.connected) {
      const c = el('button', { type: 'button', className: `btn small ptl-connect${app.on ? ' primary' : ''}`, textContent: connecting ? tr('projecttools.connecting', 'Connecting…') : app.connect === 'click' ? tr('projecttools.connect', 'Connect') : tr('projecttools.connectSettings', 'Connect…') });
      c.disabled = connecting;
      c.title = app.connect === 'click' ? tr('projecttools.connect.tip', 'Signs in with {name} in your browser', { name: app.name }) : tr('projecttools.connectSettings.tip', 'Opens Settings → Apps and connections: {name} needs a token or an address', { name: app.name });
      c.onclick = onConnect;
      row.append(c);
    }
    row.append(toggle(app.on, tr('projecttools.useIn', 'Use {name} in this project', { name: app.name }), onToggle));
    return row;
  }
  const keepFocus = (root, draw) => { const key = document.activeElement?.closest?.('[data-key]')?.dataset.key; const cls = document.activeElement?.classList?.contains('ptl-connect') ? '.ptl-connect' : '.ptl-switch'; draw(); if (key) root.querySelector(`[data-key="${CSS.escape(key)}"] ${cls}, [data-key="${CSS.escape(key)}"] .ptl-switch`)?.focus(); };

  // ---- the Tools view of a project's page
  function view(holder, { api, id, tr, onSaved = () => {} }) {
    let cat = null;
    let failed = false;
    let showAll = false;
    const connecting = new Set();
    const say = el('p', { className: 'ptl-status' });
    say.setAttribute('role', 'status');
    const root = el('div', { className: 'ptl' });
    holder.replaceChildren(root);

    const card = (title, tip, ...actions) => {
      const c = el('section', { className: 'pjp-card ptl-card' });
      const head = el('div', { className: 'pjp-card-head' }, el('h2', { className: 'pjp-h', textContent: title }), el('span', { className: 'pjp-grow' }), ...actions);
      c.append(head);
      if (tip) c.append(el('p', { className: 'pjp-note', textContent: tip }));
      return c;
    };
    const link = (label, run) => { const b = el('button', { type: 'button', className: 'pjp-link', textContent: label }); b.onclick = run; return b; };

    async function change(kind, itemId, on) {
      say.textContent = '';
      const out = await api.projectTools(id, { kind, id: itemId, on }).catch(() => null);
      if (!out?.catalog) { say.textContent = tr('chatpage.project.failed', 'Could not save the project.'); return; }
      cat = out.catalog;
      if (out.project) onSaved(out.project);
      keepFocus(root, draw);
    }
    async function connect(app) {
      say.textContent = '';
      connecting.add(app.id);
      keepFocus(root, draw);
      const out = await api.projectConnect(id, app.id).catch((err) => ({ error: String(err?.message || err) }));
      connecting.delete(app.id);
      if (out?.settings) say.textContent = tr('projecttools.settingsOpened', '{name} is set up in Settings → Apps and connections, opened in a tab. Come back here when it says Connected.', { name: app.name });
      else if (out?.error) say.textContent = tr('projecttools.connectFailed', 'Couldn’t connect {name}: {error}', { name: app.name, error: out.error });
      else if (out?.catalog) { cat = out.catalog; if (out.project) onSaved(out.project); say.textContent = tr('projecttools.connected', '{name} is connected and on in this project.', { name: app.name }); }
      keepFocus(root, draw);
    }

    function appsCard() {
      const all = cat.all.apps;
      const c = card(tr('projecttools.apps', 'Apps and connections'), all ? tr('projecttools.apps.all', 'Every app you connect is on here, including ones you connect later. Switch one off to choose.') : tr('projecttools.apps.some', 'Only the apps switched on here. An app you connect later stays off here until you switch it on.'),
        ...(all ? [] : [link(tr('projecttools.useAll', 'Use every app'), () => change('apps', 'all', true))]), link(tr('projecttools.manage', 'Settings'), () => openSettings('connectors')));
      const sorted = [...cat.apps].sort((a, b) => (b.on - a.on) || (b.connected - a.connected) || a.name.localeCompare(b.name));
      const top = sorted.filter((a) => a.on || a.connected);
      const rest = sorted.filter((a) => !a.on && !a.connected);
      const list = el('ul', { className: 'ptl-list' });
      list.setAttribute('aria-label', tr('projecttools.apps', 'Apps and connections'));
      const shown = showAll ? sorted : [...top, ...rest.slice(0, Math.max(0, SHOWN - top.length))];
      for (const app of shown) list.append(appRow(app, tr, { onToggle: (on) => change('apps', app.id, on), onConnect: () => connect(app), connecting: connecting.has(app.id) }));
      if (!top.length) c.append(el('p', { className: 'ptl-empty', textContent: tr('projecttools.apps.none', 'No apps on here yet. Switch one on, or connect one: Gmail, Canvas, Google Drive, GitHub…') }));
      c.append(list);
      if (shown.length < sorted.length) c.append(link(tr('projecttools.showAll', 'Show all apps ({n})', { n: sorted.length }), () => { showAll = true; keepFocus(root, draw); }));
      return c;
    }
    function listCard(kind, title, emptyText, section, rows) {
      const all = cat.all[kind];
      const items = cat[kind];
      const c = card(title, items.length ? (all ? tr(`projecttools.${kind}.all`, kind === 'servers' ? 'Every MCP server you add is on here.' : 'Every skill the AI may use on its own is listed in this project’s chats.') : tr(`projecttools.${kind}.some`, kind === 'servers' ? 'Only the servers switched on here; their tools are sent with every message of this project’s chats.' : 'Only the skills switched on here are listed to the AI in this project’s chats.')) : '',
        ...(!all && items.length ? [link(tr('projecttools.useAllOf', 'Use all'), () => change(kind, 'all', true))] : []), link(tr('projecttools.manage', 'Settings'), () => openSettings(section)));
      if (!items.length) { c.append(el('p', { className: 'ptl-empty', textContent: emptyText })); return c; }
      const list = el('ul', { className: 'ptl-list' });
      list.setAttribute('aria-label', title);
      for (const it of items) {
        const row = el('li', { className: `ptl-row${it.on ? ' on' : ''}` });
        row.dataset.key = `${kind}:${it.id}`;
        row.append(el('span', { className: 'ptl-mark ptl-mark-plain', textContent: it.name.slice(0, 1).toUpperCase(), ariaHidden: 'true' }), el('div', { className: 'ptl-row-main' }, el('span', { className: 'ptl-row-name', textContent: rows.name(it) }), el('span', { className: 'ptl-row-status', textContent: rows.detail(it) })), toggle(it.on, tr('projecttools.useIn', 'Use {name} in this project', { name: rows.name(it) }), (on) => change(kind, it.id, on)));
        list.append(row);
      }
      c.append(list);
      return c;
    }
    function draw() {
      if (failed) { root.replaceChildren(el('p', { className: 'ptl-empty', textContent: tr('projecttools.failed', 'Could not read your apps and tools.') }), el('button', { type: 'button', className: 'btn small', textContent: tr('projecttools.retry', 'Try again'), onclick: load })); return; }
      if (!cat) { root.replaceChildren(el('p', { className: 'pjp-note', textContent: tr('projecttpl.apps.loading', 'Loading…') })); return; }
      const state = (s) => (s.needsAuth ? tr('projecttools.status.signin', 'Needs sign-in') : !s.enabled ? tr('projecttools.server.off', 'Turned off in Settings') : s.state === 'ready' ? tr('projecttools.server.tools', '{n} tools', { n: s.tools }) : s.state === 'error' ? tr('projecttools.status.error', 'Couldn’t connect') : tr('projecttools.server.starts', 'Starts when a chat needs it'));
      root.replaceChildren(
        appsCard(),
        el('div', { className: 'ptl-pair' },
          listCard('servers', tr('projecttools.servers', 'MCP servers'), tr('projecttools.servers.none', 'No MCP servers of your own yet. Add one in Settings → AI → MCP servers.'), 'mcp-servers', { name: (s) => s.name, detail: state }),
          listCard('skills', tr('projecttools.skills', 'Skills'), tr('projecttools.skills.none', 'No skills the AI may use on its own yet. Make or import one in Settings → Skills.'), 'skills', { name: (s) => s.title || s.name, detail: (s) => s.description || (s.source === 'claude-code' ? tr('projecttools.skill.cc', 'Claude Code skill') : '') })),
        say);
    }
    async function load() {
      failed = false;
      const out = await api.projectTools(id).catch(() => null);
      if (!holder.isConnected) return;
      if (!out?.catalog) failed = true; else cat = out.catalog;
      draw();
    }
    draw();
    load();
    return { refresh: load };
  }

  // A line for the Overview's card, from a catalog: "Gmail, Google Sheets and 2 more · 1 MCP server · All skills".
  function summary(cat, tr) {
    const names = cat.apps.filter((a) => a.on).map((a) => a.name);
    const apps = cat.all.apps ? (names.length ? tr('projecttools.sum.allApps', 'Every connected app ({n})', { n: names.length }) : tr('projecttools.sum.noneConnected', 'No apps connected yet'))
      : !names.length ? tr('projecttools.sum.noApps', 'No apps') : names.length <= 3 ? names.join(', ') : tr('projecttools.sum.more', '{names} and {n} more', { names: names.slice(0, 2).join(', '), n: names.length - 2 });
    const count = (kind, one, many, allText) => { const n = cat[kind].filter((x) => x.on).length; return cat.all[kind] ? (cat[kind].length ? allText : '') : `${n} ${n === 1 ? one : many}`; };
    return [apps, count('servers', tr('projecttools.sum.server', 'MCP server'), tr('projecttools.sum.servers', 'MCP servers'), tr('projecttools.sum.allServers', 'All MCP servers')), count('skills', tr('projecttools.sum.skill', 'skill'), tr('projecttools.sum.skills', 'skills'), tr('projecttools.sum.allSkills', 'All skills'))].filter(Boolean).join(' · ');
  }

  // ---- the New project dialog's Tools step. setTemplate(id) shows that template's apps ticked; value() is what to save with the project:
  // { apps } (the ticked apps; null for "every one" when nothing was changed on Blank). Connect works here too (the project isn't made yet,
  // so the app is only ticked).
  function picker(holder, { api, tr }) {
    let template = '';
    let picked = null; // Set of app ids once a template or a tick chose; null: every app (Blank, untouched)
    let cat = null;
    let open = false;
    const connecting = new Set();
    const say = el('p', { className: 'ptl-status' });
    say.setAttribute('role', 'status');
    const head = el('button', { type: 'button', className: 'ptl-pick-head' });
    head.setAttribute('aria-expanded', 'false');
    const body = el('div', { className: 'ptl-pick-body', hidden: true });
    const root = el('div', { className: 'ptl ptl-pick' }, head, body);
    holder.replaceChildren(root);
    head.onclick = () => { open = !open; head.setAttribute('aria-expanded', String(open)); body.hidden = !open; };
    const onIds = () => (picked ? [...picked] : cat ? cat.apps.filter((a) => a.connected).map((a) => a.id) : []);
    function drawHead() {
      const names = cat ? cat.apps.filter((a) => onIds().includes(a.id)).map((a) => a.name) : [];
      const line = !cat ? tr('projecttpl.apps.loading', 'Loading…') : picked === null ? tr('projecttools.pick.all', 'Every app you connect') : !names.length ? tr('projecttools.sum.noApps', 'No apps') : names.length <= 3 ? names.join(', ') : tr('projecttools.sum.more', '{names} and {n} more', { names: names.slice(0, 2).join(', '), n: names.length - 2 });
      const missing = cat && picked ? cat.apps.filter((a) => picked.has(a.id) && !a.connected).length : 0;
      head.replaceChildren(el('span', { className: 'ptl-pick-title', textContent: tr('projecttools.pick.title', 'Tools and connections') }), el('span', { className: 'ptl-pick-line', textContent: line }), ...(missing ? [el('span', { className: 'ptl-pick-warn', textContent: tr('projecttools.pick.missing', '{n} to connect', { n: missing }) })] : []), el('span', { className: 'ptl-chev', textContent: '▾', ariaHidden: 'true' }));
    }
    function drawBody() {
      if (!cat) { body.replaceChildren(el('p', { className: 'pjp-note', textContent: tr('projecttpl.apps.loading', 'Loading…') })); return; }
      const ids = onIds();
      const list = el('ul', { className: 'ptl-list' });
      list.setAttribute('aria-label', tr('projecttools.apps', 'Apps and connections'));
      const sorted = [...cat.apps].sort((a, b) => (ids.includes(b.id) - ids.includes(a.id)) || (b.connected - a.connected) || a.name.localeCompare(b.name));
      for (const app of sorted) {
        const row = appRow({ ...app, on: ids.includes(app.id) }, tr, {
          connecting: connecting.has(app.id),
          onToggle: (on) => { picked = new Set(ids); if (on) picked.add(app.id); else picked.delete(app.id); draw(); },
          onConnect: async () => {
            connecting.add(app.id);
            draw();
            const out = await api.projectConnect(null, app.id).catch((err) => ({ error: String(err?.message || err) }));
            connecting.delete(app.id);
            if (out?.settings) say.textContent = tr('projecttools.settingsOpened', '{name} is set up in Settings → Apps and connections, opened in a tab. Come back here when it says Connected.', { name: app.name });
            else if (out?.error) say.textContent = tr('projecttools.connectFailed', 'Couldn’t connect {name}: {error}', { name: app.name, error: out.error });
            else if (out?.catalog) { cat = { ...cat, apps: out.catalog.apps }; if (picked) picked = new Set([...picked, app.id]); /* ("every app": it is on already) */ say.textContent = tr('projecttools.pick.connected', '{name} is connected.', { name: app.name }); }
            draw();
          },
        });
        list.append(row);
      }
      body.replaceChildren(el('p', { className: 'pjp-note', textContent: tr('projecttools.pick.note', 'The apps this project’s chats can use. You can change them later on the project’s Tools tab.') }), list, say);
    }
    const draw = () => keepFocus(root, () => { drawHead(); drawBody(); });
    async function load() {
      const out = await api.projectTools(null, { template }).catch(() => null);
      if (!holder.isConnected) return;
      cat = out?.catalog || { apps: [], servers: [], skills: [], all: { apps: true, servers: true, skills: true } };
      picked = cat.all.apps ? null : new Set(cat.apps.filter((a) => a.on).map((a) => a.id));
      draw();
    }
    drawHead();
    load();
    return {
      setTemplate(id) { template = String(id || ''); load(); },
      value: () => (picked === null ? null : { apps: [...picked] }),
    };
  }

  window.chatProjectTools = { view, picker, summary };
})();

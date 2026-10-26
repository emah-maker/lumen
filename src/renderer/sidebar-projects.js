// Projects in the browser's AI sidebar: the same projects, with the same rules, as lumen://chat. Loaded by chats.js (with chat-projects.js and
// sidebar-projects.css) the first time a project exists or the user asks for one: it is not in the startup bundle (test/e2e/perf-budget.js).
//   window.sidebarProjects.set({ id, project, count })  the open chat and its project (chats.js calls it on every change)
//   window.sidebarProjects.block({ projects, chats, current, open, rerender, close })  the history panel's Projects block (an element)
//   window.sidebarProjects.moveButton(chat, { projects, rerender })  a chat row's "Move to project" button
//   window.sidebarProjects.startChat(projectId)  a new chat that starts in the project (its instructions, files and defaults)
//   window.sidebarProjects.newProject()  the project editor, for a first project
// What it shows: a strip under the header that says which project the open chat is in and picks one (a chat that has no messages yet moves
// into it as a new chat, which gives it the project's default model and plan setting; a chat that has messages is moved, with Undo); in the
// history panel the Projects block of the chat page's rail (rows open the project's own page in lumen://chat; + starts a chat there, ⋯ has the
// rest; the chevron lists its chats); and "Move to project" on each chat row. Main keeps it all, so both views stay in step.
(() => {
  const api = window.assistant?.chats;
  const pj = window.chatProjects;
  if (!api || !pj || window.sidebarProjects) return;
  const tr = (key, english, vars) => { const out = window.chatTr ? window.chatTr(key, english) : english; return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';
  const OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 3.5h-2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/></svg>';
  const expanded = new Set(); // projects shown open in the history panel
  let state = { id: null, project: null, count: 0 };
  let projects = []; // the last list the panel or a picker was given
  let strip = null;
  let pick = null;
  let open = null;

  const toast = (text, undo) => { const t = window.chatListTools; if (undo) return t.undoToast(text, 8000, undo); document.querySelector('.chat-undo-toast')?.remove(); const bar = el('div', { className: 'chat-undo-toast' }, el('span', { textContent: text })); bar.setAttribute('role', 'status'); document.body.append(bar); setTimeout(() => bar.remove(), 2500); return bar; };
  const isEmpty = () => !document.getElementById('empty')?.hidden;
  const fresh = async () => { const r = await api.list().catch(() => null); projects = r?.projects || projects; return r; };

  // ---- the strip under the header
  function draw() {
    if (!strip) {
      pick = el('button', { type: 'button', className: 'sbp-pick' });
      pick.setAttribute('aria-haspopup', 'menu');
      pick.append(el('span', { className: 'sbp-icon' }), el('span', { className: 'sbp-name' }), el('span', { className: 'sbp-caret' }));
      pick.querySelector('.sbp-icon').innerHTML = FOLDER;
      pick.querySelector('.sbp-caret').innerHTML = CHEVRON;
      open = el('button', { type: 'button', className: 'icon-btn sbp-open', title: tr('projectws.chip.open', 'Open the project’s page') });
      open.setAttribute('aria-label', open.title);
      open.innerHTML = OPEN;
      strip = el('div', { className: 'sbp-strip', id: 'sbp-strip' }, pick, open);
      pick.onclick = () => choose(pick);
      open.onclick = () => { if (state.project) window.assistant.openFullPage(state.project.id); };
      document.getElementById('chat-usage')?.before(strip);
    }
    const p = state.project;
    strip.hidden = !state.count && !p;
    strip.classList.toggle('in', Boolean(p));
    pick.querySelector('.sbp-name').textContent = p ? p.name : tr('chatpage.project.none.label', 'No project');
    pick.title = p ? tr('projectws.strip.in', 'Project: {name}. Pick another for this chat.', { name: p.name }) : tr('projectws.strip.none', 'Put this chat in a project: it then uses the project’s instructions and files.');
    pick.setAttribute('aria-label', p ? tr('projectws.strip.in', 'Project: {name}. Pick another for this chat.', { name: p.name }) : tr('projectws.strip.none', 'Put this chat in a project: it then uses the project’s instructions and files.'));
    open.hidden = !p;
  }
  function set(next) {
    state = { id: next?.id ?? state.id, project: next?.project || null, count: next?.count ?? state.count };
    draw();
  }

  // ---- picking a project for the open chat
  async function choose(anchor) {
    const r = await fresh();
    const id = (await api.currentProject().catch(() => null))?.id || r?.current || state.id;
    if (!id) return;
    pj.picker({
      api, chat: { id, project: state.project?.id || null }, projects, anchor,
      onPick: (pid) => put(id, pid),
      onDone() {},
      onNew: () => newProject((saved) => put(id, saved.id)),
      onClose: () => { if (!document.activeElement || document.activeElement === document.body) anchor.focus(); },
    });
  }
  // The open chat into a project (null: out of any). Before its first message it is started again in the project, so the project's default
  // model and plan setting apply; with messages it is moved, and a toast offers Undo.
  async function put(id, pid) {
    if (pid === (state.project?.id || null)) return;
    if (pid && isEmpty()) { startChat(pid); return; }
    const out = await api.moveToProject([id], pid).catch(() => null);
    if (!out) { toast(tr('chatpage.project.moveFailed', 'Could not move the chat.')); return; }
    await refresh();
    if (!out.moves.length) return;
    const name = projects.find((p) => p.id === pid)?.name || '';
    toast(pid ? tr('chatpage.project.moved', 'Moved to {name}', { name }) : tr('chatpage.project.removed', 'Removed from its project'), async () => {
      const back = await api.restoreProjects(out.moves).catch(() => 0);
      await refresh();
      window.chatList?.refreshOpen?.();
      return back > 0;
    });
    window.chatList?.refreshOpen?.();
  }
  // A new chat in the project: main starts it (the project's model and plan default, its instructions and files), and this view shows it.
  async function startChat(pid) {
    const view = await api.newInProject(pid).catch(() => null);
    if (!view) return false;
    applySync(view); // (chat-core.js: the empty chat drawn, the box kept as it is when this was an empty chat)
    await refresh();
    window.chatList?.refreshOpen?.();
    prompt.focus();
    return true;
  }
  async function refresh() {
    const r = await api.currentProject().catch(() => null);
    if (r) set(r);
    return r;
  }
  function newProject(then) {
    pj.editor({ api, project: null, onDone: async (r) => {
      await refresh();
      if (r.saved) { expanded.add(r.saved.id); then?.(r.saved); }
      window.chatList?.refreshOpen?.();
    } });
  }

  // ---- the history panel's Projects block, as the chat page's rail has it
  function block({ projects: list, chats, current, open: openChat, rerender, close }) {
    projects = list;
    const host = el('div', { className: 'cp-projects sbp-projects' });
    pj.render({
      host, projects: list, chats, active: null, expanded, current,
      onToggle: (id) => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); rerender(); },
      onOpen: (id) => openChat(id),
      onAdd: () => newProject(),
      onEdit: (p) => pj.editor({ api, project: p, onDone: async () => { await refresh(); rerender(); } }),
      onPage: (p) => { close?.(); window.assistant.openFullPage(p.id); },
      onInstructions: (p) => { close?.(); window.assistant.openFullPage(p.id, 'instructions'); },
      onNewChat: async (p) => { if (await startChat(p.id)) close?.(); },
    });
    return host;
  }
  function moveButton(chat, { projects: list, rerender }) {
    const b = window.chatIconButton('project', tr('chatpage.project.move', 'Move to project'));
    b.setAttribute('aria-haspopup', 'menu');
    b.onclick = (e) => {
      e.stopPropagation();
      pj.picker({
        api, chat, projects: list, anchor: b.closest('.chat-item') || b,
        onPick: async (pid) => {
          const out = await api.moveToProject([chat.id], pid).catch(() => null);
          if (!out) { toast(tr('chatpage.project.moveFailed', 'Could not move the chat.')); return; }
          await refresh();
          await rerender();
          if (!out.moves.length) return;
          const name = list.find((p) => p.id === pid)?.name || '';
          toast(pid ? tr('chatpage.project.moved', 'Moved to {name}', { name }) : tr('chatpage.project.removed', 'Removed from its project'), async () => { const back = await api.restoreProjects(out.moves).catch(() => 0); await refresh(); await rerender(); return back > 0; });
        },
        onDone() {},
        onNew: (c) => newProject(async (saved) => { const out = await api.moveToProject([c.id], saved.id).catch(() => null); if (out) { await refresh(); await rerender(); } }),
      });
    };
    return b;
  }

  // The open chat's project follows a chat that another view started, opened or moved (applySync in chat-core.js calls chatHost.synced).
  const before = window.chatHost?.synced;
  if (window.chatHost) window.chatHost.synced = (view) => { before?.(view); set({ id: view?.id, project: view?.project || null }); };

  window.sidebarProjects = { set, block, moveButton, startChat, newProject: () => newProject(), refresh };
  draw();
  refresh();
})();

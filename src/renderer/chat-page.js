// lumen://chat: the sidebar's conversation as a page. chat-core.js is the conversation itself (the
// same code the sidebar runs); this script adds what only the page has: the chat list on the left (a rail that folds
// away, and is a drawer on a narrow window), the header's "working on" tab, Export / Home / "Back to sidebar", the greeting
// of an empty chat, and pulling the current chat from main when it opens.
// Loaded after chat-core.js and chat-items.js.
(() => {
  const api = window.assistant?.chats;
  if (!api) return;
  const items = $('cp-items');
  const empty = $('cp-empty');
  const usageLine = $('chat-usage');
  const rail = $('cp-rail');
  const body = document.body;
  const tr = window.chatTr;
  const trv = (key, english, vars) => tr(key, english).replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)); // (tr with {name} values)
  const pageTools = window.chatPageTools;
  let userName = '';
  let viewProject = null; // [project workspace] the project of the view last shown ({ id, name }): a chat not saved yet has no list entry

  // ---- hooks into the shared chat
  chatHost.running = (on) => {
    $('messages').setAttribute('aria-busy', String(on));
    // The list's title and usage change with a reply; refresh once it ends.
    if (!on) setTimeout(renderList, 400);
  };
  // A screen reader says who each message is from: every message is a labelled group ("You", "Assistant").
  const labelMsg = (el) => { if (el.nodeType !== 1 || !el.classList.contains('msg') || el.getAttribute('role')) return; const mine = el.classList.contains('user'); if (!mine && el.classList.contains('reply-actions-only')) return; el.setAttribute('role', 'group'); el.setAttribute('aria-label', t(mine ? 'chatpage.who.you' : 'chatpage.who.ai')); };
  new MutationObserver((list) => { for (const m of list) m.addedNodes.forEach(labelMsg); }).observe($('messages'), { childList: true });
  chatHost.chatChanged = () => renderList();
  chatHost.synced = (view) => { window.chatPageTools.setTemporary(view?.temporary); viewProject = view?.project || null; showProjectChip(); }; // another view started or left a temporary chat, or moved to a chat of a project
  // The empty chat greets by the name set for the new-tab page ("Good evening, Sam"), or asks what it can help with.
  const greeting = () => {
    if (!userName) return t('chatpage.greeting.none');
    const h = new Date().getHours();
    return t(h < 12 ? 'chatpage.greeting.morning' : h < 18 ? 'chatpage.greeting.afternoon' : 'chatpage.greeting.evening', { name: userName });
  };
  chatHost.emptyText = () => greeting();
  const greet = () => { const el = document.querySelector('#empty .empty-title'); if (el) el.textContent = greeting(); };

  function refreshUsage(text) {
    usageLine.dataset.usage = text || '';
    usageLine.textContent = text ? t('chats.usage.line', { usage: text }) : '';
    usageLine.hidden = !text;
    usageLine.title = text ? t('chats.usage.title') : '';
  }
  window.chatList = { refreshUsage, open: () => $('cp-items').querySelector('.chat-open')?.focus(), close() {} };
  api.onUsage(refreshUsage);

  // ---- the rail: always there on a wide window, folded with its button or Ctrl+Shift+S, a drawer below 800px
  const narrowQuery = window.matchMedia('(max-width: 799px)');
  const RAIL_KEY = 'lumen.chatpage.rail';
  const store = { get() { try { return localStorage.getItem(RAIL_KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(RAIL_KEY, v); } catch { /* not kept */ } } };
  let collapsed = store.get() === 'collapsed'; // the user's choice on a wide window
  let autoCollapsed = false; // folded to make room for the canvas, and opened again when it closes
  let drawerOpen = false; // the narrow window's drawer
  let canvasOpen = false;
  const railHidden = () => (narrowQuery.matches ? !drawerOpen : collapsed || autoCollapsed);
  function applyRail() {
    const hidden = railHidden();
    body.classList.toggle('cp-narrow', narrowQuery.matches);
    body.classList.toggle('cp-rail-hidden', hidden);
    rail.inert = hidden; // (a folded rail is out of the tab order and the accessibility tree)
    $('cp-scrim').hidden = !(narrowQuery.matches && drawerOpen);
    $('cp-rail-open').hidden = !hidden;
    $('cp-rail-open').setAttribute('aria-expanded', String(!hidden));
    $('cp-rail-close').setAttribute('aria-expanded', String(!hidden));
  }
  function toggleRail(force) {
    const show = typeof force === 'boolean' ? force : railHidden();
    if (narrowQuery.matches) drawerOpen = show;
    else { collapsed = !show; autoCollapsed = false; store.set(collapsed ? 'collapsed' : 'open'); }
    applyRail();
    if (show) (items.querySelector('.chat-item.current .chat-open') || $('new-chat')).focus();
    else prompt.focus();
  }
  $('cp-rail-open').onclick = () => toggleRail(true);
  $('cp-rail-close').onclick = () => toggleRail(false);
  $('cp-scrim').onclick = () => toggleRail(false);
  narrowQuery.addEventListener('change', () => { drawerOpen = false; applyRail(); });
  // The canvas takes the right side: on a window that is not wide, the list folds so the conversation keeps its room.
  const canvasRoom = () => {
    const wasAuto = autoCollapsed;
    if (canvasOpen && !narrowQuery.matches && !collapsed && window.innerWidth < 1280) autoCollapsed = true;
    else if (!canvasOpen) autoCollapsed = false;
    if (wasAuto !== autoCollapsed) applyRail();
  };
  new MutationObserver(() => { canvasOpen = Boolean(document.querySelector('.cp-main .cv:not([hidden])')); canvasRoom(); })
    .observe(document.querySelector('.cp-main'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', canvasRoom);
  const newChat = () => { $('new-chat').click(); };
  const shortcut = (what) => { if (what === 'rail') toggleRail(); else if (what === 'new') newChat(); };
  document.addEventListener('cp:shortcut', (e) => shortcut(e.detail)); // main hands these two keys over (main.js handleShortcut)
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); shortcut('rail'); }
    else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); shortcut('new'); }
    else if (e.key === 'Escape' && narrowQuery.matches && drawerOpen && rail.contains(document.activeElement)) { e.preventDefault(); toggleRail(false); }
  });
  $('cp-new-kbd').textContent = document.documentElement.classList.contains('platform-darwin') ? '⌘⇧O' : t('chatpage.newChat.shortcut');

  // ---- the list
  const makeItem = window.createChatItems({
    api,
    open: (id) => openChat(id),
    share: (id) => openChat(id, { share: true }), // "Also show in this tab"
    jump: false, // a click on a row shows that chat here (the page keeps its own chat); "Open chat in its tab" is still its own button
    menu: true, // Rename / Pin / Archive / Export / Delete behind the row's ⋯
    rerender: () => renderList(),
    cleared: () => { clearChatView(); refreshUsage(''); },
    extra: (chat) => [moveToProject(chat)],
  });
  const tools = window.chatListTools;
  let view = 'chats'; // or 'archived'
  let lastProjects = [];
  let searchBox = null;
  const search = tools.searcher(api, () => drawItems());
  let lastChats = [];
  let lastCurrent = null;
  const expanded = new Set(); // projects shown open in the rail (their chats listed under them)
  let dirtyDuringDrag = false;
  // Drag chats onto a project, and pick several with Ctrl/Shift+click (renderer/chat-project-drag.js).
  const drag = window.chatProjectDrag.create({
    items, host: $('cp-projects'),
    chats: () => lastChats, projects: () => lastProjects,
    isExpanded: (id) => expanded.has(id),
    expand: (id) => { expanded.add(id); drawProjects(); },
    announce: (text) => window.announce?.(text),
    move: (ids, projectId) => moveChats(ids, projectId),
    onEnd: () => { drag.selection.paint(); if (dirtyDuringDrag) { dirtyDuringDrag = false; renderList(); } },
  });
  const live = tools.liveOrder(items, () => { if (!items.querySelector('.chat-rename-input')) renderList(); });
  function drawItems() {
    const query = search.query;
    const play = live.flip();
    let shown = tools.pick(live.order(lastChats), { query, view, hits: search.hits });
    const rows = [];
    for (const g of tools.group(shown, Date.now(), { months: true })) rows.push(tools.heading(g.label), ...g.chats.map((chat) => makeItem(chat, chat.id === lastCurrent)));
    items.replaceChildren(...rows);
    drag.selection.paint();
    play();
    if (!shown.length && (query || view === 'archived')) items.append(Object.assign(document.createElement('li'), { className: 'chat-list-empty', textContent: query ? t('chats.noMatch') : tr('chats.noArchived', 'No archived chats') }));
  }
  // The tab's title is the chat's.
  function showTitle() {
    const mine = lastChats.find((c) => c.id === (shownChatId || lastCurrent));
    document.title = pageTools.isTemporary() ? tr('chatpage.temp', 'Temporary chat') : mine?.title || t('chatpage.title.new');
    pageTools.setTitle(mine?.title || '');
  }
  async function renderList() {
    if (drag.active()) { dirtyDuringDrag = true; return; } // (the rows under the pointer stay put until the drop)
    const focusedRow = document.activeElement?.closest?.('.chat-item');
    const focused = focusedRow?.dataset.id;
    const focusedAt = focused ? [...items.querySelectorAll('.chat-item')].indexOf(focusedRow) : -1;
    const { current, chats, projects } = await api.list();
    lastChats = chats;
    lastProjects = Array.isArray(projects) ? projects : [];
    for (const id of [...expanded]) if (!lastProjects.some((p) => p.id === id)) expanded.delete(id);
    drag.selection.prune();
    lastCurrent = current;
    if (!searchBox) { searchBox = tools.search((q) => search.set(q)); items.before(searchBox); }
    searchBox.hidden = !chats.length;
    if (searchBox.hidden) { search.clear(); searchBox.value = ''; }
    // Archived is a row at the foot of the rail (shown once something is archived, or while looking at them).
    const archivedCount = chats.filter((c) => c.archived).length;
    if (!archivedCount && view === 'archived') view = 'chats';
    const foot = $('cp-archived');
    foot.hidden = !archivedCount && view !== 'archived';
    foot.setAttribute('aria-pressed', String(view === 'archived'));
    $('cp-archived-label').textContent = view === 'archived' ? t('chatpage.allChats') : t('chatpage.archived') + (archivedCount ? ` (${archivedCount})` : '');
    drawProjects();
    drawItems();
    showTitle();
    showProjectChip();
    window.chatProjectPage?.refresh();
    empty.hidden = chats.length > 0;
    if (focused) {
      const rows = [...items.querySelectorAll('.chat-item')];
      const row = rows.find((r) => r.dataset.id === focused) || rows[Math.min(focusedAt, rows.length - 1)];
      (row?.querySelector('.chat-open') || (searchBox && !searchBox.hidden ? searchBox : null) || prompt)?.focus();
    }
  }
  // ---- projects (renderer/chat-projects.js): the rail's block, and "Move to project" in a row's menu
  const pj = window.chatProjects;
  function drawProjects() {
    const host = $('cp-projects');
    if (!lastProjects.length && !lastChats.length) { host.hidden = true; return; }
    pj.render({
      host, projects: lastProjects, chats: lastChats, active: window.chatProjectPage?.id() || null, expanded, current: lastCurrent,
      onToggle: (id) => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); drawProjects(); },
      onOpen: (id) => openChat(id),
      onAdd: () => editProject(null),
      onEdit: (p) => editProject(p),
      onPage: (p) => { view = 'chats'; openProjectPage(p.id); },
      onInstructions: (p) => { view = 'chats'; openProjectPage(p.id, { focus: 'instructions' }); },
      onNewChat: (p) => newChatInProject(p),
    });
    drag.refresh();
  }
  async function newChatInProject(p, text = '') {
    const next = await api.newInProject(p.id).catch(() => null);
    if (!next) return;
    closeProjectPage();
    clearChatView();
    pageTools.setTemporary(false);
    shownChatId = next.id || null;
    viewProject = next.project || null;
    window.planModeUI?.chatShown(next, false); // (the project's plan default)
    refreshUsage('');
    await renderList();
    if (narrowQuery.matches && drawerOpen) toggleRail(false);
    prompt.focus();
    if (text.trim()) { prompt.value = text; prompt.dispatchEvent(new Event('input')); $('composer').requestSubmit(); } // (typed in the project page's box)
  }
  // ---- [project workspace] a project's own page (chat-project-page.js, loaded the first time), the name chip in a project chat's header, and
  // "Add this tab to the project" in the + menu
  let pageLoading = null;
  function loadProjectPage() {
    if (window.chatProjectPage) return Promise.resolve();
    return (pageLoading ||= new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'chat-project-page.css' });
      const js = Object.assign(document.createElement('script'), { src: 'chat-project-page.js' });
      js.onload = () => resolve();
      js.onerror = () => { pageLoading = null; reject(new Error('project page')); };
      document.head.append(css);
      document.body.append(js);
    }));
  }
  const closeProjectPage = () => window.chatProjectPage?.close(false);
  async function openProjectPage(id, { focus = '' } = {}) {
    try { await loadProjectPage(); } catch { toast(tr('chatpage.project.failed', 'Could not save the project.')); return; }
    if (narrowQuery.matches && drawerOpen) toggleRail(false);
    const shown = await window.chatProjectPage.open({
      api, id, focus,
      host: {
        chats: () => lastChats, projects: () => lastProjects,
        openChat: (cid) => openChat(cid), newChat: (p, text) => newChatInProject(p, text), editFolder: (p) => editProject(p), moveChats: (ids, pid) => moveChats(ids, pid),
        moveToNewProject: (chat) => editProject(null, async (saved) => { await moveChats([chat.id], saved.id); }),
        undoToast: (text, ms, undo) => tools.undoToast(text, ms, undo), toast: (text) => toast(text),
        models: () => [...document.querySelectorAll('#model option')].map((o) => ({ value: o.value, label: o.textContent })),
        cleared: () => { clearChatView(); refreshUsage(''); }, closed: () => { prompt.focus(); drawProjects(); }, refresh: () => renderList(),
      },
    });
    if (shown) drawProjects(); // (the row of the project on show is marked)
  }
  const projectChip = $('cp-project-chip');
  const addTabItem = Object.assign(document.createElement('button'), { type: 'button', className: 'cm-item', id: 'add-tab-to-project', hidden: true });
  addTabItem.setAttribute('role', 'menuitem');
  addTabItem.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg><span class="cm-label"></span>';
  addTabItem.querySelector('.cm-label').textContent = tr('projectws.addTab', 'Add this tab to the project');
  $('composer-menu')?.append(addTabItem);
  let chipProject = null;
  function showProjectChip() {
    const mine = lastChats.find((c) => c.id === (shownChatId || lastCurrent));
    const id = mine ? mine.project || null : viewProject?.id || null;
    chipProject = id ? lastProjects.find((p) => p.id === id) || (viewProject?.id === id ? viewProject : null) : null;
    projectChip.hidden = !chipProject;
    projectChip.textContent = chipProject ? chipProject.name : '';
    projectChip.title = chipProject ? trv('projectws.chip', 'Project: {name}. Click to open its page.', { name: chipProject.name }) : '';
    projectChip.setAttribute('aria-label', projectChip.title);
    addTabItem.hidden = !chipProject;
    document.body.classList.toggle('cp-in-project', Boolean(chipProject));
  }
  projectChip.onclick = () => { if (chipProject) openProjectPage(chipProject.id); };
  addTabItem.onclick = async () => {
    if (!chipProject) return;
    const out = await api.projectAddTab(chipProject.id).catch(() => null);
    toast(out?.ok ? (out.already ? tr('projectws.pages.already', 'That page is already pinned.') : trv('projectws.tabAdded', 'Added to {name}', { name: chipProject.name })) : out?.reason === 'full' ? tr('projectws.pages.full', 'A project holds up to 25 pages.') : tr('projectws.pages.notweb', 'The tab you are looking at is not a web page.'));
    window.chatProjectPage?.isOpen() && openProjectPage(window.chatProjectPage.id());
  };
  function editProject(project, then) {
    pj.editor({ api, project, onDone: async (r) => {
      if (r.removed) {
        const gone = lastProjects.find((p) => p.id === r.removed);
        if (window.chatProjectPage?.id() === r.removed) closeProjectPage();
        if (gone) tools.undoToast(trv('projectws.deleted', 'Deleted “{name}”', { name: gone.name }), 10000, async () => { const back = await api.restoreProject(gone.id).catch(() => null); await renderList(); return Boolean(back); });
      }
      if (r.saved && !project && !then) { expanded.add(r.saved.id); view = 'chats'; } // (made with +: it opens in the rail; made from a chat's menu: it stays shut)
      await renderList();
      if (r.saved && then) then(r.saved);
    } });
  }
  // The chats a row's menu acts on: the picked ones when this row is among several, else just this one.
  const idsFor = (chat) => (drag.selection.has(chat.id) && drag.selection.size > 1 ? drag.selection.ids() : [chat.id]);
  function moveToProject(chat) {
    const b = window.chatIconButton('project', tr('chatpage.project.move', 'Move to project'));
    b.setAttribute('aria-haspopup', 'menu');
    b.onclick = () => {
      const row = b.closest('.chat-item');
      const id = chat.id;
      pj.picker({
        api, chat, projects: lastProjects, anchor: row || b,
        onPick: (projectId) => moveChats(idsFor(chat), projectId),
        onDone: () => {},
        onNew: (c) => editProject(null, async (saved) => { await moveChats(idsFor(c), saved.id); }),
        onClose: () => { if (!document.activeElement || document.activeElement === document.body) items.querySelector(`.chat-item[data-id="${id}"] .chat-more`)?.focus(); },
      });
    };
    return b;
  }
  // One or several chats into a project (null: out of any). The rows move at once, main keeps it and tells every list, and a toast
  // offers Undo. Moving is not activity, so nothing is reordered. Dropping on the project a chat is already in changes nothing.
  async function moveChats(ids, projectId) {
    const target = projectId || null;
    const changing = ids.filter((id) => (lastChats.find((c) => c.id === id)?.project || null) !== target);
    if (!changing.length) return false;
    const name = lastProjects.find((p) => p.id === target)?.name || '';
    for (const c of lastChats) if (changing.includes(c.id)) { if (target) c.project = target; else delete c.project; }
    drawProjects();
    drawItems();
    const out = await api.moveToProject(changing, target).catch(() => null);
    if (!out) { toast(tr('chatpage.project.moveFailed', 'Could not move the chat.')); await renderList(); return false; }
    drag.selection.clear();
    if (out.moves.length) {
      const n = out.moves.length;
      const text = target
        ? (n === 1 ? tr('chatpage.project.moved', 'Moved to {name}') : tr('chatpage.project.movedMany', 'Moved {n} chats to {name}')).replace('{name}', name).replace('{n}', n)
        : (n === 1 ? tr('chatpage.project.removed', 'Removed from its project') : tr('chatpage.project.removedMany', 'Removed {n} chats from their projects')).replace('{n}', n);
      const bar = tools.undoToast(text, 8000, async () => {
        const back = await api.restoreProjects(out.moves);
        await renderList();
        if (back) window.announce?.(tr('chatpage.project.undone', 'Move undone'));
        return back > 0;
      });
      bar.dataset.projectMove = '1';
      window.announce?.(text);
    }
    await renderList();
    return true;
  }
  $('cp-archived').onclick = () => { view = view === 'archived' ? 'chats' : 'archived'; renderList(); };
  async function openChat(id, { share = false } = {}) {
    const opened = await (share ? api.share(id) : api.open(id));
    if (!opened) return false; // gone: the row says so, then the list redraws (chat-items.js moveHere) (deleted, or unreadable on this machine)
    closeProjectPage();
    viewProject = opened.project || null;
    clearChatView();
    pageTools.setTemporary(Boolean(opened.temporary));
    shownChatId = opened.id || null;
    showHistory(opened.items);
    resumeLive(opened.live); // still running: its reply goes on here
    refreshUsage(opened.usage);
    await renderList();
    if (narrowQuery.matches && drawerOpen) toggleRail(false); // (a drawer closes on its choice; focus goes to the message box)
    prompt.focus();
    if (search.query) setTimeout(() => pageTools.jump(search.query), 80); // a search hit opens at the message that matched
    return true;
  }
  tools.arrows(items); // Up/Down between chats, Home/End to the ends
  // New chat is the shared #new-chat button (chat-core.js resets the chat and empties the view).
  $('new-chat').addEventListener('click', () => { closeProjectPage(); viewProject = null; pageTools.setTemporary(false); setTimeout(renderList, 50); if (narrowQuery.matches && drawerOpen) toggleRail(false); });
  api.onChanged?.(() => { if (!items.querySelector('.chat-rename-input')) renderList(); }); // running, needs an OK, finished unseen

  // ---- the tab the AI works in
  function showTarget(info) {
    const text = $('cp-target-text');
    const icon = $('cp-target-icon');
    $('cp-target').hidden = !info; // [working-on chip] only while a reply is acting on a tab
    if (info) {
      const label = info.title || info.url || t('chatpage.target.untitled');
      text.textContent = t('chatpage.target', { title: label });
      $('cp-target').title = info.url ? `${label}
${info.url}` : label; // the full name, when the pill shows it cut short
      icon.hidden = !info.favicon;
      if (info.favicon && icon.getAttribute('src') !== info.favicon) icon.src = info.favicon;
    } else {
      text.textContent = '';
      $('cp-target').title = '';
      icon.hidden = true;
    }
  }
  window.assistant.onTarget?.(showTarget);
  showTarget(null);

  // ---- the header: export, home, the ⋯ menu (Back to sidebar, AI settings)
  const toast = (text) => {
    document.querySelector('.chat-undo-toast')?.remove();
    const bar = Object.assign(document.createElement('div'), { className: 'chat-undo-toast' });
    bar.setAttribute('role', 'status');
    bar.append(Object.assign(document.createElement('span'), { textContent: text }));
    document.body.append(bar);
    setTimeout(() => bar.remove(), 2500);
  };
  pageTools.init({ api, id: () => shownChatId || lastCurrent, refresh: () => renderList(), toast: (text) => toast(text) });
  $('cp-export').onclick = async () => {
    const id = shownChatId || lastCurrent;
    if (!id) { toast(t('chatpage.exportEmpty')); return; }
    try {
      const out = await api.exportChat(id);
      if (out?.ok) toast(t('chatpage.exported'));
      else if (out?.reason === 'empty') toast(t('chatpage.exportEmpty'));
      else if (out?.reason !== 'canceled') toast(t('chatpage.exportFailed'));
    } catch { toast(t('chatpage.exportFailed')); }
  };
  const moreBtn = $('cp-more');
  const moreMenu = $('cp-more-menu');
  function closeMore(refocus = false) {
    if (moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (refocus) moreBtn.focus();
  }
  moreBtn.onclick = () => {
    if (!moreMenu.hidden) { closeMore(); return; }
    moreMenu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    moreMenu.querySelector('button')?.focus();
  };
  moreMenu.addEventListener('click', () => closeMore());
  moreMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMore(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...moreMenu.querySelectorAll('button')];
      e.preventDefault();
      rows[(rows.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.cp-more-wrap')) closeMore(); });
  $('cp-back').onclick = () => window.assistant.backToSidebar();
  $('cp-home').onclick = () => window.assistant.home(); // this tab becomes the new-tab page

  // ---- keep the window's own drops (files, links) from navigating the page; images go to the composer
  const editable = (el) => Boolean(el?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
  document.addEventListener('dragover', (e) => { if (!e.defaultPrevented && !(editable(e.target) && !hasFiles(e.dataTransfer))) e.preventDefault(); });
  document.addEventListener('drop', (e) => { if (!e.defaultPrevented && !(editable(e.target) && !hasFiles(e.dataTransfer))) e.preventDefault(); });

  // A model connected or removed while this tab was in the background shows up when it is looked at again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadModels(); refreshSetup(); renderList(); } });
  window.addEventListener('focus', () => { loadModels(); refreshSetup(); });

  // ---- start: what main holds now (the sidebar's chat, a run in progress)
  chatHost.identity = () => {};
  applyRail();
  startChat();
  window.assistant.state().then(async (first) => {
    if (!first?.fresh || !first.view?.items?.length) return first;
    $('new-chat').click(); // [ask ai new chat] Ask AI with nothing typed: the page opens on a new chat (a reply still running in the old one goes on, in History)
    return (await window.assistant.state().catch(() => null)) || first;
  }).then(({ view: now, target, name, draft, send, images }) => {
    userName = typeof name === 'string' ? name.trim() : '';
    greet();
    shownChatId = now?.id || null;
    viewProject = now?.project || null;
    pageTools.setTemporary(Boolean(now?.temporary));
    showHistory(now?.items);
    refreshUsage(now?.usage || '');
    showTarget(target);
    // Opened mid-reply: the events that follow belong to it. `view.live` is the open chat's own run
    // (a chat left running elsewhere is not this one).
    resumeLive(now?.live);
    // Text typed in the new-tab page's box before Ask AI: asked in a new chat (Enter there), or it waits here as a draft, after any
    // draft this chat already had (never sent).
    // Pictures from that box (newtab-ai:ask) join the same message, through the composer's own attach path.
    const ext = (type) => type.split('/')[1].split('+')[0].replace('jpeg', 'jpg');
    const pictures = (Array.isArray(images) ? images : []).filter((p) => p && typeof p.type === 'string' && p.data).map((p, n) => new File([p.data], p.name || `image-${n + 1}.${ext(p.type)}`, { type: p.type }));
    const words = typeof draft === 'string' ? draft.trim() : '';
    if (words || pictures.length) setTimeout(() => { // (after the box has taken back the draft this chat had)
      if (send === true) { askInNewChat(words, pictures); prompt.focus(); return; } // chat-core's own: a fresh chat, the old one stays in the list
      if (pictures.length) addFiles(pictures);
      prompt.value = [prompt.value.trimEnd(), draft.trim()].filter(Boolean).join('\n');
      prompt.dispatchEvent(new Event('input')); // chat-core's own handler: sizes the box and saves the draft
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    });
  }).catch(() => {}).finally(async () => {
    await renderList();
    void body.offsetWidth; // the first layout is final: from here on the composer's move down (the first message) is animated
    body.classList.remove('cp-booting');
  });
  greet();
  prompt.focus();
})();

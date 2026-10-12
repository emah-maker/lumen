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
  const pageTools = window.chatPageTools;
  let userName = '';

  // ---- hooks into the shared chat
  chatHost.running = (on) => {
    $('messages').setAttribute('aria-busy', String(on));
    // The list's title and usage change with a reply; refresh once it ends.
    if (!on) setTimeout(renderList, 400);
  };
  chatHost.chatChanged = () => renderList();
  chatHost.synced = (view) => window.chatPageTools.setTemporary(view?.temporary); // another view started or left a temporary chat
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
  let projectView = null; // a project's id: the list shows only its chats (Projects, in the rail)
  let lastProjects = [];
  let searchBox = null;
  const search = tools.searcher(api, () => drawItems());
  let lastChats = [];
  let lastCurrent = null;
  function drawItems() {
    const query = search.query;
    let shown = tools.pick(lastChats, { query, view, hits: search.hits });
    if (projectView && !query && view !== 'archived') shown = shown.filter((c) => c.project === projectView);
    const rows = [];
    for (const g of tools.group(shown, Date.now(), { months: true })) rows.push(tools.heading(g.label), ...g.chats.map((chat) => makeItem(chat, chat.id === lastCurrent)));
    items.replaceChildren(...rows);
    if (!shown.length && (query || view === 'archived' || projectView)) items.append(Object.assign(document.createElement('li'), { className: 'chat-list-empty', textContent: query ? t('chats.noMatch') : projectView ? tr('chatpage.project.empty', 'No chats in this project yet. Start one here, or move a chat in from its ⋯ menu.') : tr('chats.noArchived', 'No archived chats') }));
  }
  // The tab's title is the chat's.
  function showTitle() {
    const mine = lastChats.find((c) => c.id === (shownChatId || lastCurrent));
    document.title = pageTools.isTemporary() ? tr('chatpage.temp', 'Temporary chat') : mine?.title || t('chatpage.title.new');
    pageTools.setTitle(mine?.title || '');
  }
  async function renderList() {
    const focusedRow = document.activeElement?.closest?.('.chat-item');
    const focused = focusedRow?.dataset.id;
    const focusedAt = focused ? [...items.querySelectorAll('.chat-item')].indexOf(focusedRow) : -1;
    const { current, chats, projects } = await api.list();
    lastChats = chats;
    lastProjects = Array.isArray(projects) ? projects : [];
    if (projectView && !lastProjects.some((p) => p.id === projectView)) projectView = null;
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
      host, projects: lastProjects, chats: lastChats, active: projectView,
      onSelect: (id) => { projectView = id; if (id) view = 'chats'; renderList(); },
      onAdd: () => editProject(null),
      onEdit: (p) => editProject(p),
      onNewChat: async (p) => {
        if (running) return;
        const next = await api.newInProject(p.id).catch(() => null);
        if (!next) return;
        clearChatView();
        pageTools.setTemporary(false);
        shownChatId = next.id || null;
        refreshUsage('');
        await renderList();
        if (narrowQuery.matches && drawerOpen) toggleRail(false);
        prompt.focus();
      },
    });
  }
  function editProject(project, then) {
    pj.editor({ api, project, onDone: async (r) => {
      if (r.removed && projectView === r.removed) projectView = null;
      if (r.saved && !project && !then) projectView = r.saved.id; // (made with +: its list opens; made from a chat's menu: the list stays)
      await renderList();
      if (r.saved && then) then(r.saved);
    } });
  }
  function moveToProject(chat) {
    const b = window.chatIconButton('project', tr('chatpage.project.move', 'Move to project'));
    b.onclick = () => pj.picker({
      api, chat, projects: lastProjects, anchor: b.closest('.chat-item') || b,
      onDone: () => renderList(),
      onNew: (c) => editProject(null, async (saved) => { await api.setProject(c.id, saved.id).catch(() => false); renderList(); }),
    });
    return b;
  }
  $('cp-archived').onclick = () => { view = view === 'archived' ? 'chats' : 'archived'; renderList(); };
  async function openChat(id, { share = false } = {}) {
    const opened = await (share ? api.share(id) : api.open(id));
    if (!opened) return false; // gone: the row says so, then the list redraws (chat-items.js moveHere) (deleted, or unreadable on this machine)
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
  $('new-chat').addEventListener('click', () => { pageTools.setTemporary(false); setTimeout(renderList, 50); if (narrowQuery.matches && drawerOpen) toggleRail(false); });
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
  window.assistant.state().then(({ view: now, target, name, draft }) => {
    userName = typeof name === 'string' ? name.trim() : '';
    greet();
    shownChatId = now?.id || null;
    pageTools.setTemporary(Boolean(now?.temporary));
    showHistory(now?.items);
    refreshUsage(now?.usage || '');
    showTarget(target);
    // Opened mid-reply: the events that follow belong to it. `view.live` is the open chat's own run
    // (a chat left running elsewhere is not this one).
    resumeLive(now?.live);
    // Text typed in the new-tab page's box before its Chat button: waits here as a draft, after any draft this chat already had (never sent).
    if (typeof draft === 'string' && draft.trim()) setTimeout(() => { // (after the box has taken back the draft this chat had)
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

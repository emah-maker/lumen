// lumen://chat: the sidebar's conversation as a page. chat-core.js is the conversation itself (the
// same code the sidebar runs); this script adds what only the page has: the chat list on the left, the
// header's "working on" tab, "Back to sidebar", and pulling the current chat from main when it opens.
// Loaded after chat-core.js and chat-items.js.
(() => {
  const api = window.assistant?.chats;
  if (!api) return;
  const items = $('cp-items');
  const empty = $('cp-empty');
  const usageLine = $('chat-usage');

  // ---- hooks into the shared chat
  chatHost.running = (on) => {
    $('messages').setAttribute('aria-busy', String(on));
    // The list's title and usage change with a reply; refresh once it ends.
    if (!on) setTimeout(renderList, 400);
  };
  chatHost.chatChanged = () => renderList();
  chatHost.emptyText = (name) => t('chatpage.empty', { name });

  function refreshUsage(text) {
    usageLine.textContent = text || '';
    usageLine.hidden = !text;
    usageLine.title = text ? t('chats.usage.title') : '';
  }
  window.chatList = { refreshUsage, open: () => $('cp-items').querySelector('.chat-open')?.focus(), close() {} };
  api.onUsage(refreshUsage);

  // ---- the list
  const makeItem = window.createChatItems({
    api,
    open: (id) => openChat(id),
    rerender: () => renderList(),
    cleared: () => { clearChatView(); refreshUsage(''); },
  });
  const tools = window.chatListTools;
  let query = '';
  let searchBox = null;
  let lastChats = [];
  let lastCurrent = null;
  function drawItems() {
    const shown = lastChats.filter((c) => tools.matches(c, query));
    const rows = [];
    for (const g of tools.group(shown)) rows.push(tools.heading(g.label), ...g.chats.map((chat) => makeItem(chat, chat.id === lastCurrent)));
    items.replaceChildren(...rows);
    if (query && !shown.length) items.append(Object.assign(document.createElement('li'), { className: 'chat-list-empty', textContent: t('chats.noMatch') }));
  }
  async function renderList() {
    const focusedRow = document.activeElement?.closest?.('.chat-item');
    const focused = focusedRow?.dataset.id;
    const focusedAt = focused ? [...items.querySelectorAll('.chat-item')].indexOf(focusedRow) : -1;
    const { current, chats } = await api.list();
    lastChats = chats;
    lastCurrent = current;
    if (chats.length > 6 && !searchBox) { searchBox = tools.search((q) => { query = q; drawItems(); }); items.before(searchBox); }
    if (searchBox) searchBox.hidden = chats.length <= 6;
    if (searchBox?.hidden) { query = ''; searchBox.value = ''; }
    drawItems();
    empty.hidden = chats.length > 0;
    if (focused) {
      const rows = [...items.querySelectorAll('.chat-item')];
      const row = rows.find((r) => r.dataset.id === focused) || rows[Math.min(focusedAt, rows.length - 1)];
      (row?.querySelector('.chat-open') || searchBox || prompt)?.focus();
    }
  }
  async function openChat(id) {
    const view = await api.open(id);
    if (!view) { await renderList(); return; } // gone (deleted, or unreadable on this machine)
    clearChatView();
    showHistory(view.items);
    resumeLive(view.live); // still running: its reply goes on here
    refreshUsage(view.usage);
    await renderList();
    prompt.focus();
  }
  tools.arrows(items); // Up/Down between chats, Home/End to the ends
  // New chat is the shared #new-chat button (chat-core.js resets the chat and empties the view).
  $('new-chat').addEventListener('click', () => setTimeout(renderList, 50));
  api.onChanged?.(() => { if (!items.querySelector('.chat-rename-input')) renderList(); }); // running, needs an OK, finished unseen

  // ---- the tab the AI works in
  function showTarget(info) {
    const text = $('cp-target-text');
    const icon = $('cp-target-icon');
    if (info) {
      const label = info.title || info.url || t('chatpage.target.untitled');
      text.textContent = t('chatpage.target', { title: label });
      $('cp-target').title = info.url || '';
      icon.hidden = !info.favicon;
      if (info.favicon && icon.getAttribute('src') !== info.favicon) icon.src = info.favicon;
    } else {
      text.textContent = t('chatpage.target.none');
      $('cp-target').title = '';
      icon.hidden = true;
    }
  }
  window.assistant.onTarget?.(showTarget);
  showTarget(null);

  // ---- back to the sidebar
  $('cp-back').onclick = () => window.assistant.backToSidebar();

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
  startChat();
  window.assistant.state().then(({ view, target }) => {
    showHistory(view?.items);
    refreshUsage(view?.usage || '');
    showTarget(target);
    // Opened mid-reply: the events that follow belong to it. `view.live` is the open chat's own run
    // (a chat left running elsewhere is not this one).
    resumeLive(view?.live);
  }).catch(() => {}).finally(renderList);
  prompt.focus();
})();

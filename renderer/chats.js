// The sidebar's chat history (features/chat-store.js keeps the chats): open an earlier chat, or
// rename, export or delete one. Also keeps the usage line under the header current (tokens and
// estimated cost of the open chat, features/chat-usage.js).
// Uses chat-core.js's $, clearChatView, showHistory and prompt, and chat-items.js (same page, loaded before this file).

(() => {
  const api = window.assistant?.chats;
  if (!api) return;
  const button = $('chat-history');
  const panel = $('chat-list');
  const usageLine = $('chat-usage');

  function refreshUsage(text) {
    usageLine.textContent = text || '';
    usageLine.hidden = !text;
    usageLine.title = text ? window.chatTr('chats.usage.title', 'Tokens and estimated cost of this chat') : '';
  }

  const iconButton = window.chatIconButton;
  const item = window.createChatItems({
    api,
    open: (id) => openChat(id),
    rerender: () => render(),
    cleared: () => { clearChatView(); refreshUsage(''); },
  });

  const tools = window.chatListTools;
  let query = '';
  let searchBox = null;
  async function render() {
    const { current, chats } = await api.list();
    const head = document.createElement('div');
    head.className = 'chat-list-head';
    const title = Object.assign(document.createElement('h2'), { textContent: window.chatTr('chats.title', 'Chats') });
    const close = iconButton('close', window.chatTr('chats.close', 'Close'));
    close.onclick = () => closePanel(true);
    head.append(title, close);

    // A search once there are enough chats to need one; what was typed survives a redraw.
    const typing = document.activeElement === searchBox;
    searchBox = chats.length > 6 ? tools.search((q) => { query = q; drawList(); }) : null;
    if (!searchBox) query = ''; // (few chats left: no box, so no filter either)
    if (searchBox) searchBox.value = query;
    const list = document.createElement('ul');
    list.className = 'chat-items';
    function drawList() {
      const shown = chats.filter((c) => tools.matches(c, query));
      const rows = [];
      for (const g of tools.group(shown)) rows.push(tools.heading(g.label), ...g.chats.map((chat) => item(chat, chat.id === current)));
      list.replaceChildren(...rows);
      if (query && !shown.length) list.append(Object.assign(document.createElement('li'), { className: 'chat-list-empty', textContent: window.chatTr('chats.noMatch', 'No chats match') }));
    }
    drawList();
    panel.replaceChildren(head, ...(searchBox ? [searchBox] : []), list);
    if (typing && searchBox) searchBox.focus();
    if (!chats.length) panel.append(Object.assign(document.createElement('p'), { className: 'chat-list-empty', textContent: window.chatTr('chats.empty', 'No saved chats yet. Chats appear here after the first reply.') }));
  }
  tools.arrows(panel);

  async function openChat(id) {
    const view = await api.open(id);
    if (!view) { await render(); return false; } // gone (deleted, or unreadable on this machine)
    clearChatView();
    showHistory(view.items);
    resumeLive(view.live); // still running: its reply goes on here
    refreshUsage(view.usage);
    window.chatUsageMeter?.refresh(); // the context bar follows the chat that is open now
    closePanel(false);
    prompt.focus();
    return true;
  }

  async function openPanel() {
    await render();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    (panel.querySelector('.chat-item.current .chat-open') || panel.querySelector('.chat-open') || panel.querySelector('.chat-close'))?.focus();
  }
  function closePanel(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    if (refocus) button.focus();
  }

  button.onclick = () => (panel.hidden ? openPanel() : closePanel(true));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(true); }
  });
  $('new-chat').addEventListener('click', () => closePanel(false));

  api.onUsage(refreshUsage);
  api.list().then((r) => refreshUsage(r.currentUsage)).catch(() => {});
  // A chat started or stopped running, needs an OK, or finished unseen: its row's mark changes.
  api.onChanged?.(() => { if (!panel.hidden && !panel.querySelector('.chat-rename-input')) render(); });

  // openChat(id): a notification was clicked (app.js), or a message moves back to the last chat
  // (chat-core.js askOnNewTopic). The chat already open stays as it is. True when that chat is open.
  window.chatList = { refreshUsage, open: openPanel, close: closePanel, openChat: async (id) => { if (!id) return false; const { current } = await api.list(); return id === current ? true : openChat(id); } };
})();

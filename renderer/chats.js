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
    usageLine.title = text ? 'Tokens and estimated cost of this chat' : '';
  }

  const iconButton = window.chatIconButton;
  const item = window.createChatItems({
    api,
    open: (id) => openChat(id),
    rerender: () => render(),
    cleared: () => { clearChatView(); refreshUsage(''); },
  });

  async function render() {
    const { current, chats } = await api.list();
    const head = document.createElement('div');
    head.className = 'chat-list-head';
    const title = Object.assign(document.createElement('h2'), { textContent: 'Chats' });
    const close = iconButton('close', 'Close');
    close.onclick = () => closePanel(true);
    head.append(title, close);

    const list = document.createElement('ul');
    list.className = 'chat-items';
    for (const chat of chats) list.append(item(chat, chat.id === current));
    panel.replaceChildren(head, list);
    if (!chats.length) panel.append(Object.assign(document.createElement('p'), { className: 'chat-list-empty', textContent: 'No saved chats yet. Chats appear here after the first reply.' }));
  }

  async function openChat(id) {
    const view = await api.open(id);
    if (!view) { await render(); return false; } // gone (deleted, or unreadable on this machine)
    clearChatView();
    showHistory(view.items);
    refreshUsage(view.usage);
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

  window.chatList = { refreshUsage, open: openPanel, close: closePanel, openChat };
})();

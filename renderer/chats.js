// The sidebar's chat history (features/chat-store.js keeps the chats): open an earlier chat, or
// rename, export or delete one. Also keeps the usage line under the header current (tokens and
// estimated cost of the open chat, features/chat-usage.js).
// Uses app.js's $, clearChatView, showHistory and prompt (same page, loaded before this file).

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

  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  }

  const ICONS = {
    rename: '<svg viewBox="0 0 16 16"><path d="M3 13h2.5L12.5 6 10 3.5 3 10.5z"/></svg>',
    export: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M5 5.5l3-3 3 3M3.5 10.5v3h9v-3"/></svg>',
    delete: '<svg viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 9h5l.5-9"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };
  const iconButton = (name, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn chat-${name}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = ICONS[name];
    return b;
  };

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

  function item(chat, isCurrent) {
    const li = document.createElement('li');
    li.className = `chat-item${isCurrent ? ' current' : ''}`;
    li.dataset.id = chat.id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    if (isCurrent) open.setAttribute('aria-current', 'true');
    const name = Object.assign(document.createElement('span'), { className: 'chat-title', textContent: chat.title || 'Chat' });
    const meta = Object.assign(document.createElement('span'), { className: 'chat-meta', textContent: [when(chat.updated), chat.usage].filter(Boolean).join(' · ') });
    open.append(name, meta);
    open.onclick = () => openChat(chat.id);

    const actions = document.createElement('div');
    actions.className = 'chat-actions';
    const rename = iconButton('rename', 'Rename');
    rename.onclick = () => startRename(li, chat);
    const exportBtn = iconButton('export', 'Export as Markdown');
    exportBtn.onclick = async () => {
      const out = await api.exportChat(chat.id);
      if (out?.ok) meta.textContent = 'Exported';
    };
    const del = iconButton('delete', 'Delete');
    let armed = null;
    del.onclick = async () => {
      if (!armed) { // two clicks: the first asks, the second deletes
        del.classList.add('armed');
        del.title = 'Click again to delete';
        del.setAttribute('aria-label', 'Click again to delete');
        armed = setTimeout(() => { armed = null; del.classList.remove('armed'); del.title = 'Delete'; del.setAttribute('aria-label', 'Delete'); }, 3000);
        return;
      }
      clearTimeout(armed);
      const out = await api.remove(chat.id);
      if (out?.cleared) {
        clearChatView();
        refreshUsage('');
      }
      await render();
    };
    actions.append(rename, exportBtn, del);
    li.append(open, actions);
    return li;
  }

  function startRename(li, chat) {
    const open = li.querySelector('.chat-open');
    const input = Object.assign(document.createElement('input'), { className: 'chat-rename-input', value: chat.title || '', maxLength: 120 });
    input.setAttribute('aria-label', 'Chat name');
    open.hidden = true;
    li.insertBefore(input, open);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== chat.title) await api.rename(chat.id, input.value);
      await render();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    input.onblur = () => finish(true);
  }

  async function openChat(id) {
    const view = await api.open(id);
    if (!view) { await render(); return; } // gone (deleted, or unreadable on this machine)
    clearChatView();
    showHistory(view.items);
    refreshUsage(view.usage);
    closePanel(false);
    prompt.focus();
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

  window.chatList = { refreshUsage, open: openPanel, close: closePanel };
})();

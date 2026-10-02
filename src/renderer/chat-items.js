// One row of the chat list: open, rename, export (Markdown) and delete (two clicks) an earlier chat.
// Shared by the sidebar's history panel (chats.js) and the full-page chat's list (chat-page.js).
//   window.createChatItems({ api, open(id), rerender(), cleared() }) -> item(chat, isCurrent)
//     api       window.assistant.chats
//     open      the row was chosen
//     rerender  the list changed (renamed, deleted): draw it again
//     cleared   the open chat was deleted: empty the conversation view
//   window.chatIconButton(name, label), window.chatTr(key, english)
(() => {
  // The page's language table, with the English written here as the fallback.
  const tr = (key, english) => { const text = window.t ? window.t(key) : key; return text && text !== key ? text : english; };
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return tr('chats.yesterday', 'Yesterday');
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  }

  const ICONS = {
    rename: '<svg viewBox="0 0 16 16"><path d="M3 13h2.5L12.5 6 10 3.5 3 10.5z"/></svg>',
    export: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M5 5.5l3-3 3 3M3.5 10.5v3h9v-3"/></svg>',
    delete: '<svg viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 9h5l.5-9"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    showtab: '<svg viewBox="0 0 16 16"><path d="M2.5 6.5h11M2.5 6.5v6h11v-6M2.5 6.5V4.5h4l1 2"/><path d="M8 9.5h3M10 8l1.5 1.5L10 11"/></svg>',
    movehere: '<svg viewBox="0 0 16 16"><path d="M2.5 6.5h11M2.5 6.5v6h11v-6M2.5 6.5V4.5h4l1 2"/><path d="M8 11V8.5M6.5 10L8 11.5 9.5 10"/></svg>',
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

  window.chatIconButton = iconButton;
  // A long history stays usable: grouped by when it was last used (Today, Yesterday, Previous 7 days, Earlier),
  // filtered by a search over titles, and walked with Up/Down/Home/End. Shared by the sidebar and lumen://chat.
  window.chatListTools = {
    // chats -> [{ label, chats }] in order; empty groups are left out.
    group(chats, now = Date.now()) {
      const day = new Date(now); day.setHours(0, 0, 0, 0);
      const start = day.getTime();
      const bands = [
        { label: window.chatTr('chats.today', 'Today'), test: (t) => t >= start },
        { label: window.chatTr('chats.yesterday', 'Yesterday'), test: (t) => t >= start - 864e5 },
        { label: window.chatTr('chats.week', 'Previous 7 days'), test: (t) => t >= start - 7 * 864e5 },
        { label: window.chatTr('chats.earlier', 'Earlier'), test: () => true },
      ];
      const out = bands.map((b) => ({ label: b.label, chats: [] }));
      for (const c of chats) out[bands.findIndex((b) => b.test(c.updated || c.created || 0))].chats.push(c);
      return out.filter((g) => g.chats.length);
    },
    matches: (chat, q) => !q || String(chat.title || '').toLowerCase().includes(q.toLowerCase()),
    heading(label) {
      const li = Object.assign(document.createElement('li'), { className: 'chat-group', textContent: label });
      li.setAttribute('role', 'presentation');
      return li;
    },
    search(onInput) {
      const input = Object.assign(document.createElement('input'), { type: 'search', className: 'chat-search', placeholder: window.chatTr('chats.search', 'Search chats'), autocomplete: 'off', spellcheck: false });
      input.setAttribute('aria-label', window.chatTr('chats.search', 'Search chats'));
      input.addEventListener('input', () => onInput(input.value.trim()));
      input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); input.closest('.chat-list, #cp-list, body')?.querySelector('.chat-open')?.focus(); } });
      return input;
    },
    // Up and Down move between chats, Home and End jump to the ends; Tab still leaves the list.
    arrows(container) {
      container.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.target.closest('input')) return;
        const rows = [...container.querySelectorAll('.chat-open')];
        if (!rows.length) return;
        const at = rows.indexOf(e.target.closest('.chat-item')?.querySelector('.chat-open'));
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        e.preventDefault();
        rows[next].focus();
      });
    },
  };
  window.chatTr = tr;
  window.createChatItems = ({ api, open: onOpen, rerender, cleared }) => {
    function startRename(li, chat) {
      const openBtn = li.querySelector('.chat-open');
      const input = Object.assign(document.createElement('input'), { className: 'chat-rename-input', value: chat.title || '', maxLength: 120 });
      input.setAttribute('aria-label', tr('chats.name', 'Chat name'));
      openBtn.hidden = true;
      const stopLink = li.querySelector('.chat-stop-wait');
      if (stopLink) stopLink.hidden = true; // (the rename field has the row)
      li.insertBefore(input, openBtn);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() && input.value.trim() !== chat.title) await api.rename(chat.id, input.value);
        await rerender();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      };
      input.onblur = () => finish(true);
    }

    // The tab strip's glyphs (app.js CHAT_MARKS), so a list row and its tab show the same mark.
    const GLYPHS = {
      running: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="2"/><path class="cm-spin" d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><g class="cm-still"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="6" r="2" fill="currentColor"/></g></svg>',
      queued: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      unread: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="cm-on" cx="6" cy="6" r="6"/><path class="cm-glyph" d="M3.4 6.2l1.8 1.8 3.4-3.8"/></svg>',
      approval: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="cm-on" cx="6" cy="6" r="6"/><path class="cm-glyph" d="M6 3v3.4M6 8.7v.1"/></svg>',
    };
    return function item(chat, isCurrent) {
      const li = document.createElement('li');
      li.className = `chat-item${isCurrent ? ' current' : ''}`;
      li.dataset.id = chat.id;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'chat-open';
      if (isCurrent) openBtn.setAttribute('aria-current', 'true');
      const name = Object.assign(document.createElement('span'), { className: 'chat-title', textContent: chat.title || tr('chats.untitled', 'Chat') });
      // Which tab it lives in (every tab has its own chat), when that is not the tab in front.
      const elsewhere = chat.tab && !chat.tab.here ? chat.tab : null;
      const inTab = elsewhere ? tr('chats.inTab', 'In tab: {title}').replace('{title}', elsewhere.title || tr('chats.tabUntitled', 'another tab')) + (['running', 'queued', 'approval'].includes(chat.badge) ? '' : tr('chats.clickMoves', ' · click moves it here')) : '';
      const meta = Object.assign(document.createElement('span'), { className: 'chat-meta' });
      const metaText = Object.assign(document.createElement('span'), { className: 'chat-meta-text', textContent: [when(chat.updated), chat.usage].filter(Boolean).join(' · ') }); // (the state word sits beside it)
      meta.append(metaText);
      if (chat.tab?.here) li.classList.add('in-this-tab');
      openBtn.append(name, meta);
      // The place line: the tab it lives in, or "This tab" for the chat bound to the tab in front.
      const place = inTab || (chat.tab?.here ? tr('chats.thisTab', 'This tab') : '');
      if (place) openBtn.append(Object.assign(document.createElement('span'), { className: `chat-place${chat.tab?.here ? ' here' : ''}`, textContent: place }));
      // Still running (it was left mid-reply), waiting for an OK, or finished and not seen yet.
      if (chat.badge) {
        const label = { running: tr('chats.badge.running', 'Working'), queued: tr('chats.badge.queued', 'Waiting for its turn'), approval: tr('chats.badge.approval', 'Needs your OK'), unread: tr('chats.badge.unread', 'New reply') }[chat.badge];
        if (label) {
          const badge = Object.assign(document.createElement('span'), { className: `chat-badge ${chat.badge === 'approval' ? 'needs-ok' : chat.badge}`, title: label });
          badge.innerHTML = GLYPHS[chat.badge] || '';
          badge.setAttribute('aria-hidden', 'true'); // the state word in the meta line says it for screen readers
          name.prepend(badge);
          // The state in words as well (not colour or shape alone).
          const word = { running: tr('chats.state.running', 'Working'), queued: tr('chats.state.queued', 'Waiting'), approval: tr('chats.state.approval', 'Needs OK'), unread: tr('chats.state.unread', 'Done') }[chat.badge];
          if (word) meta.prepend(Object.assign(document.createElement('span'), { className: 'chat-state', textContent: word }), document.createTextNode(metaText.textContent ? ' \u00b7 ' : ''));
          li.classList.add(`has-${chat.badge}`);
        }
      }
      // A chat that is working in another tab is shown where it works; moving it unasked would pull its work to this tab.
      const working = ['running', 'queued', 'approval'].includes(chat.badge);
      openBtn.onclick = async () => {
        if (!(elsewhere && working && api.showTab)) { onOpen(chat.id); return; }
        try { await api.showTab(chat.id); window.chatList?.close?.(false); } catch { say(tr('chats.tabFailed', 'Could not open the tab')); }
      };

      const actions = document.createElement('div');
      actions.className = 'chat-actions';
      const rename = iconButton('rename', tr('chats.rename', 'Rename'));
      rename.onclick = () => startRename(li, chat);
      const exportBtn = iconButton('export', tr('chats.export', 'Export as Markdown'));
      const original = metaText.textContent;
      let metaTimer = null;
      const say = (text) => { clearTimeout(metaTimer); metaText.textContent = text; metaTimer = setTimeout(() => { metaText.textContent = original; }, 2500); }; // a passing note, then the usual line
      exportBtn.onclick = async () => {
        try {
          const out = await api.exportChat(chat.id);
          if (out?.ok) say(tr('chats.exported', 'Exported'));
          else if (out?.reason === 'empty') say(tr('chats.exportEmpty', 'Nothing to export yet')); // (main.js chats:export: reason 'canceled' = the Save dialog was dismissed: no note)
          else if (out?.reason !== 'canceled') say(tr('chats.exportFailed', 'Could not export'));
        } catch { say(tr('chats.exportFailed', 'Could not export')); }
      };
      const del = iconButton('delete', tr('chats.delete', 'Delete'));
      let armed = null;
      del.onclick = async () => {
        if (!armed) { // two clicks: the first asks, the second deletes
          const again = tr('chats.deleteAgain', 'Click again to delete');
          del.classList.add('armed');
          del.dataset.confirm = tr('chats.deleteConfirm', 'Delete?');
          del.title = again;
          del.setAttribute('aria-label', again);
          armed = setTimeout(() => { armed = null; del.classList.remove('armed'); delete del.dataset.confirm; del.title = tr('chats.delete', 'Delete'); del.setAttribute('aria-label', tr('chats.delete', 'Delete')); }, 3000);
          return;
        }
        clearTimeout(armed);
        del.disabled = true; // pending: a second click cannot delete twice
        try {
          const out = await api.remove(chat.id);
          if (out?.cleared) cleared();
          await rerender();
        } catch {
          del.disabled = false;
          armed = null; del.classList.remove('armed'); delete del.dataset.confirm; del.title = tr('chats.delete', 'Delete'); del.setAttribute('aria-label', tr('chats.delete', 'Delete'));
          say(tr('chats.deleteFailed', 'Could not delete'));
        }
      };
      // In another tab: a click on the row already goes there (a working chat) or moves it here (an idle one), so the narrow
      // list drops that button: "open in its tab" for a working chat, "move here" for an idle one.
      const dropsOne = Boolean(elsewhere && api.showTab);
      if (dropsOne) li.classList.add('drops-one');
      const tabActions = [];
      if (elsewhere && api.showTab) {
        const show = iconButton('showtab', tr('chats.showTab', 'Open chat in its tab'));
        show.classList.add('chat-act-tab');
        if (working) show.classList.add('chat-act-drop');
        show.onclick = async () => { try { await api.showTab(chat.id); window.chatList?.close?.(false); } catch { say(tr('chats.tabFailed', 'Could not open the tab')); } };
        const move = iconButton('movehere', tr('chats.moveHere', 'Move chat to this tab'));
        move.classList.add('chat-act-move');
        if (!working) move.classList.add('chat-act-drop');
        move.onclick = () => onOpen(chat.id);
        tabActions.push(show, move);
      }
      actions.append(...tabActions, rename, exportBtn, del);
      li.style.setProperty('--actions-w', `${actions.children.length * 24 + 8}px`); // the title leaves room for the floating buttons
      li.style.setProperty('--actions-w-narrow', `${(actions.children.length - (dropsOne ? 1 : 0)) * 24 + 8}px`); // (and for one fewer in a narrow list)
      li.append(openBtn);
      // Waiting for its turn: it can be taken out of the line from here.
      if (chat.badge === 'queued' && api.stopChat) {
        const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'chat-stop-wait', textContent: tr('chats.stopWaiting', 'Stop waiting') });
        const stopBack = () => { stop.disabled = false; stop.textContent = tr('chats.stopWaiting', 'Stop waiting'); };
        stop.onclick = async (e) => {
          e.stopPropagation();
          stop.disabled = true;
          stop.textContent = tr('chats.stopping', 'Stopping…');
          const wait = window.chatItemsStopMs || 4000; // (a test shortens it)
          const fail = () => { stopBack(); say(tr('chats.stopFailed', 'Could not stop it')); };
          const lost = setTimeout(fail, wait); // no answer at all: never stuck on "Stopping…"
          try {
            if ((await api.stopChat(chat.id)) === false) { clearTimeout(lost); fail(); return; } // (the chat had already moved on)
            // Stopped. The list redraws when the run leaves; if it cannot (a rename field is open, the panel is hidden) the
            // button stays on "Stopping…" unless the chat is still waiting a while later.
            clearTimeout(lost);
            setTimeout(async () => {
              if (!stop.disabled) return;
              try { const now = await api.list?.(); if (now?.chats?.find((c) => c.id === chat.id)?.badge === 'queued') fail(); } catch { /* keep the note */ }
            }, wait);
          } catch { clearTimeout(lost); fail(); }
        };
        li.append(stop);
      }
      li.append(actions);
      return li;
    };
  };
})();

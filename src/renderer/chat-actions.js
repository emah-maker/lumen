// What sits on and under each chat message, shared by the sidebar and the full-page chat (loaded after chat-core.js, whose
// globals it uses when something is clicked, never while loading):
//   your messages    a row under the bubble on hover: the time, Copy, Edit; a long message is cut short with "Show more"
//   replies          a strip under the reply: the ‹ 2/3 › switch between versions, which model wrote it, the time and the
//                    thumbs up / down (kept with the chat on this computer)
//   a reopened chat  its thinking (collapsed) and the steps it took, as they were when it ran
// Versions come from main (features/chat-branches.js): Regenerate and Edit keep what they replace, and the chosen version is the
// chat that goes on. Messages are named to main by their place among your messages in the view (their "ordinal").
(() => {
  const ICONS = {
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
    up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 7.5v5.5h-2a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1h2Zm0 0 2.2-4.4a1.3 1.3 0 0 1 2.4.9L9.7 6.5h2.8a1.3 1.3 0 0 1 1.3 1.6l-.9 3.8a2 2 0 0 1-1.9 1.5H5.5"/></svg>',
    note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h6.5L13 5v8.5H4zM10.5 2.5V5H13M6 8h5M6 10.5h3"/></svg>',
    down: '<svg viewBox="0 0 16 16" aria-hidden="true"><g transform="rotate(180 8 8)"><path d="M5.5 7.5v5.5h-2a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1h2Zm0 0 2.2-4.4a1.3 1.3 0 0 1 2.4.9L9.7 6.5h2.8a1.3 1.3 0 0 1 1.3 1.6l-.9 3.8a2 2 0 0 1-1.9 1.5H5.5"/></g></svg>',
  };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const button = (className, label, html, onclick) => {
    const b = el('button', { type: 'button', className, title: label });
    b.setAttribute('aria-label', label);
    b.innerHTML = html;
    b.onclick = onclick;
    return b;
  };

  // "2:41 PM", or "Oct 9, 2:41 PM" for another day. The tooltip has the whole date.
  function timeLabel(at) {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return null;
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const text = d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
    return el('time', { className: 'msg-time', textContent: text, title: d.toLocaleString(), dateTime: d.toISOString() });
  }

  const userBubbles = () => [...messages.querySelectorAll('.msg.user')];
  const ordinalOf = (bubble) => userBubbles().indexOf(bubble);
  // The user bubble that opens the exchange `node` (a reply) belongs to.
  function exchangeUser(node) {
    for (let n = node.previousElementSibling; n; n = n.previousElementSibling) if (n.classList?.contains('msg') && n.classList.contains('user')) return n;
    return null;
  }
  // The reply that closes the exchange a user bubble opens (its last text bubble), or null when it has none.
  function finalReplyOf(bubble) {
    let last = null;
    for (let n = bubble.nextElementSibling; n && !n.classList.contains('user'); n = n.nextElementSibling) {
      if (n.classList.contains('assistant') && !n.classList.contains('gen-pics') && !n.classList.contains('reply-actions-only') && n.classList.contains('msg')) last = n;
    }
    return last;
  }

  // ---- the version switch
  async function switchTo(at, target) {
    if (running || !Number.isInteger(at)) return;
    const view = await window.assistant.switchVersion?.(at, target).catch(() => null);
    if (view) applySync(view);
  }
  function versionSwitch(versions) {
    const { at, n, cur } = versions;
    const box = el('span', { className: 'msg-versions' });
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('chat.versions'));
    const prev = button('msg-version-step', t('chat.versionPrev'), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3.5-4.5 4.5 4.5 4.5"/></svg>', () => switchTo(at, cur - 2));
    const next = button('msg-version-step', t('chat.versionNext'), '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5-4.5 4.5"/></svg>', () => switchTo(at, cur));
    prev.disabled = cur <= 1;
    next.disabled = cur >= n;
    box.append(prev, el('span', { className: 'msg-version-count', textContent: t('chat.versionOf', { n: cur, total: n }) }), next);
    return box;
  }

  // ---- long messages of yours
  const LONG_CHARS = 700;
  const LONG_LINES = 10;
  // Returns the Show more / Show less button (it goes in the row under the bubble), or null for a message that is not long.
  function clampLong(bubble, text) {
    if (!text || (text.length <= LONG_CHARS && text.split(/\n/).length <= LONG_LINES)) return null;
    bubble.classList.add('clamped');
    const more = el('button', { type: 'button', className: 'msg-more', textContent: t('chat.showMore') });
    more.setAttribute('aria-expanded', 'false');
    more.onclick = () => {
      const open = bubble.classList.toggle('expanded');
      more.textContent = t(open ? 'chat.showLess' : 'chat.showMore');
      more.setAttribute('aria-expanded', String(open));
    };
    return more;
  }

  // ---- under your message
  async function copyText(text, b) {
    try {
      await navigator.clipboard.writeText(text);
      b.innerHTML = ICONS.check;
      b.classList.add('copied');
      setTimeout(() => { b.innerHTML = ICONS.copy; b.classList.remove('copied'); }, 1400);
    } catch { b.title = t('chat.copyFailed'); }
  }
  // info: { at, versions }. One row per message of yours; a message asked again with different words shows its switch here.
  const ask0 = (bubble) => clampLong(bubble, askOf(bubble)?.text);
  function userRow(bubble, info = {}) {
    if (!bubble) return;
    bubble.nextElementSibling?.classList.contains('msg-user-actions') && bubble.nextElementSibling.remove();
    const row = el('div', { className: 'msg-user-actions' });
    const tools = el('div', { className: 'msg-user-tools' });
    const more = ask0(bubble);
    if (more) tools.append(more);
    if (info.versions && info.versions.same === false && info.versions.n > 1) tools.append(versionSwitch(info.versions));
    const hover = el('span', { className: 'msg-hover' });
    const time = info.at ? timeLabel(info.at) : null;
    if (time) hover.append(time);
    const ask = askOf(bubble);
    if (ask?.text) hover.append(button('msg-copy', t('chat.copyMessage'), ICONS.copy, (e) => copyText(ask.text, e.currentTarget)));
    if (ask && !bubble.dataset.skill) {
      const edit = el('button', { type: 'button', className: 'msg-edit', textContent: t('chat.editMessage'), title: t('chat.editMessage.title') });
      edit.onclick = () => editBubble(bubble);
      hover.append(edit);
    }
    tools.append(hover);
    row.append(tools);
    bubble.after(row);
  }

  // ---- under a reply
  // info: { at, feedback, versions }. Safe to call again for the same reply: it fills in what is new.
  function replyMeta(bubble, info = {}) {
    if (!bubble || !bubble.classList.contains('assistant')) return;
    let strip = bubble.querySelector(':scope > .reply-meta');
    if (!strip) {
      strip = el('div', { className: 'reply-meta' });
      bubble.append(strip);
    }
    const model = bubble.querySelector(':scope > .reply-model');
    if (model && model.parentElement !== strip) { const v = strip.querySelector('.msg-versions'); if (v) v.after(model); else strip.prepend(model); }
    if (info.versions && info.versions.same !== false && info.versions.n > 1 && !strip.querySelector('.msg-versions')) strip.prepend(versionSwitch(info.versions));
    if (info.at && !strip.querySelector('.msg-time')) {
      const time = timeLabel(info.at);
      if (time) { time.classList.add('msg-hover'); strip.append(time); }
    }
    if (!strip.querySelector('.reply-thumbs') && bubble.querySelector('.reply-copy')) strip.append(thumbs(bubble, info.feedback));
    const note = strip.querySelector('.reply-note');
    if (note && note !== strip.lastElementChild) strip.append(note); // ("Add to notes" stays last) // (a reply of only a picture has no text to rate)
  }
  // "Add to notes" under a reply: its Markdown (a diagram it drew comes along as a picture) goes to the notepad (features/notes-hub.js).
  // finishReply calls this once the reply is whole; the button sits in the strip with the thumbs.
  function noteButton(bubble, source) {
    if (!bubble || !window.assistant?.notes || !source || !String(source).trim() || bubble.querySelector(':scope > .reply-meta .reply-note')) return;
    let strip = bubble.querySelector(':scope > .reply-meta');
    if (!strip) { strip = el('div', { className: 'reply-meta' }); bubble.append(strip); }
    const b = button('reply-thumb reply-note', t('notes.add'), ICONS.note, async () => {
      const r = await window.assistant.notes.act('add', { text: String(source) }).catch(() => null);
      b.title = t(r?.ok ? 'notes.added' : 'notes.addFailed');
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('done', Boolean(r?.ok));
      b.innerHTML = r?.ok ? ICONS.check : ICONS.note;
      setTimeout(() => { b.title = t('notes.add'); b.setAttribute('aria-label', b.title); b.classList.remove('done'); b.innerHTML = ICONS.note; }, 2200);
    });
    strip.append(b);
  }
  function thumbs(bubble, current = null) {
    const box = el('span', { className: 'reply-thumbs' });
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('chat.rateReply'));
    let value = current === 'up' || current === 'down' ? current : null;
    const sync = () => { for (const b of box.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value)); box.classList.toggle('rated', Boolean(value)); };
    const make = (v, label, icon) => {
      const b = button('reply-thumb', label, icon, async () => {
        const user = exchangeUser(bubble);
        const next = value === v ? null : v;
        const ok = user ? await window.assistant.feedback?.(ordinalOf(user), next).catch(() => false) : false;
        if (ok) { value = next; sync(); }
      });
      b.dataset.value = v;
      return b;
    };
    box.append(make('up', t('chat.goodReply'), ICONS.up), make('down', t('chat.badReply'), ICONS.down));
    sync();
    return box;
  }

  // ---- a reopened chat: what the reply did before its answer
  // item: a transcript item of an assistant reply. Returns the nodes to put above its bubble (thinking, then the steps).
  function details(item) {
    const out = [];
    if (item.thinking) {
      const box = el('details', { className: 'thinking restored' });
      const summary = el('summary', { textContent: item.thinkingMs ? t('chat.thoughtFor', { n: Math.max(1, Math.round(item.thinkingMs / 1000)) }) : t('chat.thought') });
      box.append(summary, el('div', { textContent: item.thinking }));
      out.push(box);
    }
    const tools = Array.isArray(item.tools) ? item.tools : [];
    if (tools.length && item.cards && window.stepUI) out.push(...window.stepUI.restoreNodes(item)); // [step labels] cards for the browser and the shell, readable lines, details on demand
    else if (item.steps || tools.length) {
      const count = item.steps || tools.length;
      const label = t(count === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count });
      if (!tools.length) {
        const line = el('div', { className: 'step done restored' });
        line.innerHTML = '<span class="step-detail"></span>';
        line.firstChild.textContent = label;
        out.push(line);
      } else {
        const group = el('details', { className: 'step-group restored' });
        const summary = el('summary', { className: 'step done restored' });
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = label;
        const list = el('div', { className: 'step-items' });
        for (const tool of tools) {
          const text = (tool.input && window.stepUI?.labelFor({ name: tool.name, input: tool.input })) || tool.label || (typeof TOOL_LABELS !== 'undefined' && TOOL_LABELS[tool.name] ? safeLabel(tool) : plainUnknown(tool)); // (an older chat keeps its rows; a command it still has is named plainly)
          const row = el('div', { className: tool.ok === false ? 'step failed restored' : 'step done restored', title: text });
          row.innerHTML = '<span class="step-detail"></span>';
          row.firstChild.textContent = text;
          list.append(row);
        }
        group.append(summary, list);
        out.push(group);
      }
    }
    return out;
  }
  function plainUnknown(tool) { try { return window.stepLabels?.defaults?.generic(tool.name, tool.input || {}) || t('step.tool'); } catch { return t('step.tool'); } }
  function safeLabel(tool) { try { return TOOL_LABELS[tool.name](tool.input || {}); } catch { return plainUnknown(tool); } }

  // ---- Ctrl+Shift+C: copy the latest reply
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return;
    const copy = [...messages.querySelectorAll('.reply-copy')].pop();
    if (!copy) return;
    e.preventDefault();
    copy.click();
  });

  window.chatActions = { noteButton, userRow, replyMeta, details, clampLong, finalReplyOf, versionSwitch, timeLabel, ordinalOf };
})();

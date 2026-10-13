// lumen://chat only: the extras that sit on the conversation of the full page, in the order a reader meets them.
//   the header        the chat's title, edited in place; the "Temporary" badge and its note
//   the ⋯ menu        Temporary chat, Copy chat as Markdown, Export chat as PDF
//   under a reply     Read aloud, and Retry with another model (the latest reply)
//   after Stop        "Edit message" puts your message back in the box when nothing had been answered
//   a search hit      the chat opens at the message that matched, highlighted
// It uses the conversation's own globals (messages, prompt, running, lastAsk, ask, askAgain, loadModels: chat-core.js), only when
// something happens, never while loading. Loaded before chat-page.js, which calls init() and the helpers below.
(() => {
  const tr = (key, english) => (window.chatTr ? window.chatTr(key, english) : english);
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let host = null; // { api, id(), refresh(), toast(text) } from chat-page.js
  let temporary = false;

  // ---- the title
  const titleBtn = () => document.getElementById('cp-title');
  function setTitle(text) {
    const btn = titleBtn();
    if (!btn) return;
    const shown = temporary ? tr('chatpage.temp', 'Temporary chat') : text || '';
    btn.textContent = shown;
    btn.hidden = !shown;
    btn.disabled = temporary; // (a temporary chat has no saved name to change)
    btn.title = temporary ? '' : tr('chatpage.rename', 'Rename chat');
  }
  function editTitle() {
    const btn = titleBtn();
    const id = host?.id();
    if (!btn || btn.hidden || temporary || !id) return;
    const input = el('input', { className: 'cp-title-input', type: 'text', value: btn.textContent, maxLength: 120 });
    input.setAttribute('aria-label', tr('chatpage.rename', 'Rename chat'));
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      input.replaceWith(btn);
      if (save && next && next !== btn.textContent) {
        btn.textContent = next; // (at once; the list confirms it a moment later)
        await host.api.rename(id, next).catch(() => false);
        host.refresh();
      }
      btn.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    btn.replaceWith(input);
    input.focus();
    input.select();
  }

  // ---- temporary chat
  function setTemporary(on) {
    on = Boolean(on);
    if (on === temporary) return;
    temporary = on;
    document.body.classList.toggle('cp-temporary', on);
    document.getElementById('cp-temp-badge').hidden = !on;
    let note = document.getElementById('cp-temp-note');
    if (on && !note) {
      note = el('p', { id: 'cp-temp-note', className: 'cp-temp-note', textContent: tr('chatpage.temp.note', 'Temporary chat. It is not saved and will not appear in your chat list; it disappears when you leave it.') });
      note.setAttribute('role', 'note');
      document.getElementById('messages').before(note);
    }
    if (note) note.hidden = !on;
    setTitle('');
    if (on) document.title = tr('chatpage.temp', 'Temporary chat');
  }
  async function startTemporary() {
    if (running) return;
    const view = await host.api.temporary().catch(() => null);
    if (!view) return;
    clearChatView();
    shownChatId = view.id || null;
    setTemporary(true);
    window.chatList?.refreshUsage('');
    host.refresh();
    prompt.focus();
  }

  // ---- copy and export
  async function copyMarkdown() {
    const id = host.id();
    const out = id ? await host.api.markdown(id).catch(() => null) : null;
    if (!out?.ok) { host.toast(tr('chatpage.exportEmpty', 'Nothing to export yet')); return; }
    try { await navigator.clipboard.writeText(out.markdown); host.toast(tr('chatpage.copiedMd', 'Chat copied as Markdown')); } catch { host.toast(tr('chat.copyFailed', 'Could not copy')); }
  }
  async function exportPdf() {
    const id = host.id();
    if (!id) { host.toast(tr('chatpage.exportEmpty', 'Nothing to export yet')); return; }
    try {
      const out = await host.api.exportChat(id, 'pdf');
      if (out?.ok) host.toast(tr('chatpage.exported', 'Chat exported'));
      else if (out?.reason === 'empty') host.toast(tr('chatpage.exportEmpty', 'Nothing to export yet'));
      else if (out?.reason !== 'canceled') host.toast(tr('chatpage.exportFailed', 'Could not export'));
    } catch { host.toast(tr('chatpage.exportFailed', 'Could not export')); }
  }

  // ---- read aloud (speechSynthesis: the voices of the computer, nothing is sent anywhere)
  const SPEAK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8"/></svg>';
  const STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/></svg>';
  let speaking = null; // the button of the reply being read
  // What a reply says: its text without the buttons, code headers, steps and thinking around it.
  function replyText(bubble) {
    const clone = bubble.cloneNode(true);
    for (const n of clone.querySelectorAll('.reply-meta, .reply-copy, .reply-regen, .reply-retry, .code-head, .thinking, .step, .step-group, button, .reply-model, svg, math')) n.remove();
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }
  // Long text in sentences of a sensible size: some voices stop after about fifteen seconds of one utterance.
  const chunks = (text) => {
    const out = [];
    for (const sentence of text.match(/[^.!?\n]+[.!?]*\s*/g) || [text]) {
      const last = out[out.length - 1];
      if (last && last.length + sentence.length < 220) out[out.length - 1] = last + sentence; else out.push(sentence);
    }
    return out.map((s) => s.trim()).filter(Boolean);
  };
  function stopSpeaking() {
    try { window.speechSynthesis.cancel(); } catch { /* none */ }
    if (speaking) { speaking.innerHTML = SPEAK; speaking.classList.remove('on'); speaking.setAttribute('aria-pressed', 'false'); speaking.setAttribute('aria-label', tr('chatpage.readAloud', 'Read aloud')); }
    speaking = null;
  }
  function speak(button, bubble) {
    const was = speaking === button;
    stopSpeaking();
    if (was) return;
    const parts = chunks(replyText(bubble));
    if (!parts.length) return;
    speaking = button;
    button.innerHTML = STOP;
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', tr('chatpage.stopReading', 'Stop reading')); // (the tooltip is drawn from the label, as on the other reply buttons)
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = document.documentElement.lang || navigator.language || 'en-US';
      if (i === parts.length - 1) { u.onend = u.onerror = () => { if (speaking === button) stopSpeaking(); }; }
      window.speechSynthesis.speak(u);
    });
  }
  function readAloudButton(bubble) {
    const label = tr('chatpage.readAloud', 'Read aloud');
    const b = el('button', { type: 'button', className: 'reply-speak' });
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = SPEAK;
    b.onclick = () => speak(b, bubble);
    return b;
  }

  // ---- retry with another model (the latest reply)
  function retryButton(bubble) {
    const label = tr('chatpage.retryWith', 'Retry with another model');
    const b = el('button', { type: 'button', className: 'reply-retry', title: label });
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-haspopup', 'menu');
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h10.5"/><path d="M10.5 2.5 13 5l-2.5 2.5"/><path d="M13.5 11H3"/><path d="M5.5 8.5 3 11l2.5 2.5"/></svg>';
    b.onclick = () => openRetryMenu(b);
    return b;
  }
  function openRetryMenu(anchor) {
    document.querySelector('.cp-retry-menu')?.remove();
    if (running) return;
    const select = document.getElementById('model');
    const current = select.value;
    const menu = el('div', { className: 'cp-retry-menu' });
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', tr('chatpage.retryWith', 'Retry with another model'));
    let count = 0;
    for (const o of select.options) {
      if (!o.value || o.value === current || o.value.endsWith(':__more') || o.disabled) continue;
      const group = o.parentElement?.label;
      const name = o.dataset.name || o.textContent;
      const b = el('button', { type: 'button', className: 'cp-retry-item' }, el('span', { textContent: name }), el('span', { className: 'cp-retry-group', textContent: group && group !== 'Claude' ? group : '' }));
      b.setAttribute('role', 'menuitem');
      b.onclick = async () => {
        close();
        const ok = await window.assistant.setModel(o.value).catch(() => false);
        if (!ok) return;
        await loadModels(); // (the picker shows the model that answers now)
        askAgain(true);
      };
      menu.append(b);
      if (++count >= 40) break;
    }
    if (!count) return;
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const h = Math.min(menu.offsetHeight, 300);
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6}px`;
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); anchor.focus(); };
    const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
    const key = (e) => {
      const list = [...menu.querySelectorAll('button')];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true));
    document.addEventListener('keydown', key, true);
    menu.querySelector('button')?.focus();
  }

  // ---- Stop, then edit: when nothing was answered, the message goes back in the box
  function editStopped(notice) {
    const users = messages.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    if (!last || !lastAsk) return;
    for (let n = last.nextElementSibling; n; n = n.nextElementSibling) if (n.classList.contains('assistant') && n.classList.contains('msg') && n.textContent.trim()) return; // it answered: Continue is the way on
    const button = el('button', { type: 'button', className: 'btn notice-edit', textContent: tr('chatpage.editStopped', 'Edit message') });
    button.onclick = async () => {
      if (running || !lastAsk) return;
      button.disabled = true;
      const again = lastAsk;
      const result = await window.assistant.rewind?.(again.text);
      if (result !== 'rewound' && result !== 'absent') { button.disabled = false; return; }
      const bubbles = messages.querySelectorAll('.msg.user');
      const from = bubbles[bubbles.length - 1];
      if (from) { while (from.nextSibling) from.nextSibling.remove(); from.remove(); }
      prompt.value = [again.text, prompt.value].filter(Boolean).join(prompt.value ? '\n' : '');
      if (again.images?.length) { attachments = [...attachments, ...again.images].slice(0, MAX_ATTACH); renderAttachments(); }
      lastAsk = null;
      autosize();
      updateSend();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    };
    notice.append(' ', button);
  }

  // ---- what appears in the conversation: add the buttons to each reply and each Stop notice as they arrive
  function decorate(node) {
    if (node.nodeType !== 1) return;
    // Read aloud joins Copy, Regenerate and Retry in the corner row under the reply (not the model label's row).
    for (const strip of node.matches?.('.reply-meta') ? [node] : node.querySelectorAll?.('.reply-meta') || []) {
      const bubble = strip.closest('.msg.assistant');
      if (!bubble || !bubble.querySelector('.reply-copy')) continue;
      if ('speechSynthesis' in window && !bubble.querySelector(':scope > .reply-speak')) bubble.append(readAloudButton(bubble));
    }
    for (const regen of node.matches?.('.reply-regen') ? [node] : node.querySelectorAll?.('.reply-regen') || []) {
      if (!regen.parentElement.querySelector('.reply-retry')) regen.after(retryButton(regen.parentElement));
    }
    for (const notice of node.matches?.('.notice.stopped:not(.restored)') ? [node] : node.querySelectorAll?.('.notice.stopped:not(.restored)') || []) {
      if (!notice.dataset.editOffered) { notice.dataset.editOffered = '1'; setTimeout(() => editStopped(notice), 0); } // (after the Continue button is added)
    }
  }

  // ---- a search hit: the chat opens at the message that matched
  function jump(query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return false;
    const bubbles = [...messages.querySelectorAll('.msg.user, .msg.assistant')];
    const textOf = (b) => (b.textContent || '').toLowerCase();
    const hit = bubbles.find((b) => words.every((w) => textOf(b).includes(w))) || bubbles.find((b) => words.some((w) => textOf(b).includes(w)));
    if (!hit) return false;
    messages.querySelectorAll('mark.cp-hit-word').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    // The words themselves (text nodes only, so the markup of the message stays as it is).
    const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('button, .reply-meta, .code-head, .msg-user-actions, svg, math') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    for (const node of nodes) {
      const parts = node.nodeValue.split(pattern);
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => frag.append(i % 2 ? el('mark', { className: 'cp-hit-word', textContent: part }) : document.createTextNode(part)));
      node.replaceWith(frag);
    }
    hit.classList.add('cp-hit');
    hit.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    setTimeout(() => {
      hit.classList.remove('cp-hit');
      hit.querySelectorAll('mark.cp-hit-word').forEach((m) => { m.replaceWith(document.createTextNode(m.textContent)); });
      hit.normalize();
    }, 4500);
    return true;
  }

  function init(options) {
    host = options;
    const msgs = document.getElementById('messages');
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) decorate(n);
      if (speaking && !speaking.isConnected) stopSpeaking(); // (its reply left: another chat, or a new one)
    }).observe(msgs, { childList: true, subtree: true });
    titleBtn().onclick = editTitle;
    document.getElementById('cp-temp').onclick = startTemporary;
    document.getElementById('cp-copy-md').onclick = copyMarkdown;
    document.getElementById('cp-export-pdf').onclick = exportPdf;
    window.addEventListener('pagehide', stopSpeaking);
  }

  if (typeof window !== 'undefined') window.chatPageTools = { init, setTitle, setTemporary, jump, isTemporary: () => temporary, chunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = { chunks };
})();

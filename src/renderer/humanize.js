// [humanize] The chat's side of Humanize, loaded with the first use (renderer/chat-actions.js loadHumanize), in the sidebar and on the
// chat page alike. The rewrite itself is main's (agent:humanize, features/humanize-page.js, ai/humanize.js).
//   reply(bubble, source, button)  the "Humanize" action under a reply: the reply's text is rewritten on the chat's AI and shown in
//                                  place of the reply, with "Show original" to switch back; Copy then copies the version on screen.
//                                  The chat's history keeps the reply as it was written (what the AI reads next is unchanged).
//   paste(text)                    /humanize <text> or "humanize this" with text: a card under the conversation with the rewrite and
//                                  Copy. The card is not part of the chat.
(() => {
  if (window.humanizeUI) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    const s = text && text !== key ? text : fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : s;
  };
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
  const render = (md) => (window.renderMarkdown ? window.renderMarkdown(md) : null);
  const decorate = (node) => { try { window.decorateCode?.(node); } catch { /* plain text is fine */ } }; // (chat-core.js: code blocks' Copy, tab chips, tables)

  function errorText(r) {
    const code = r?.error;
    if (code === 'no-provider') return tr('humanize.noProvider', 'No AI can rewrite this. Add an API key in Settings → AI, or install Claude Code and sign in.');
    if (code === 'too-long') return tr('humanize.tooLong', 'That’s too long to rewrite at once (more than {max} characters). Select less.', { max: Number(r.max || 12000).toLocaleString() });
    if (code === 'timeout') return tr('humanize.timeout', 'That took too long. Try again.');
    if (code === 'no-answer') return tr('humanize.noAnswer', 'The AI sent back no text. Try again.');
    if (code === 'stopped') return '';
    return tr('humanize.failed', 'Humanize failed: {error}', { error: String(code || '').slice(0, 200) });
  }
  const noteText = (r) => [r.name ? tr('humanize.note', 'Humanized by {model}', { model: r.name }) : tr('humanize.noteOnly', 'Humanized'), r.unchanged ? tr('humanize.unchanged', 'It already reads as written by a person.') : r.removed?.length ? tr('humanize.removed', 'Took out: {list}', { list: r.removed.join(', ') }) : ''].filter(Boolean).join(' · ');
  const missingText = (r) => (r.missing?.length ? tr('humanize.missing', 'Check the rewrite: it no longer has {list}.', { list: r.missing.slice(0, 6).join(', ') }) : '');

  // The reply's own words (what renderMarkdown drew), not its buttons and strip.
  const contentOf = (bubble) => [...bubble.childNodes].filter((n) => !(n.nodeType === 1 && (/(?:^|\s)(?:reply-|hz-)/.test(n.className || '') || n.tagName === 'BUTTON')));

  async function reply(bubble, source, button) {
    if (!bubble || !source || button?.getAttribute('aria-busy') === 'true') return;
    if (bubble.hzState) { toggle(bubble); return; } // (already humanized: the button switches between the two)
    const idle = button.innerHTML;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('hz-busy');
    button.title = tr('humanize.action.working', 'Humanizing…');
    let r;
    try { r = await window.assistant.humanize(source, 'reply'); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
    button.removeAttribute('aria-busy');
    button.classList.remove('hz-busy');
    button.innerHTML = idle;
    if (!bubble.isConnected) return;
    if (!r?.ok) {
      button.title = tr('humanize.action.title', 'Rewrite this reply so it reads like a person wrote it');
      const msg = errorText(r);
      if (msg) flash(bubble, msg);
      return;
    }
    const original = el('div', 'hz-original');
    original.hidden = true;
    original.append(...contentOf(bubble));
    const fresh = el('div', 'hz-text');
    const html = render(r.text);
    if (html != null) fresh.innerHTML = html; else fresh.textContent = r.text;
    decorate(fresh);
    const note = el('div', 'hz-note');
    note.setAttribute('role', 'status');
    const label = el('span', 'hz-note-text', noteText(r));
    const swap = el('button', 'hz-swap', tr('humanize.original', 'Show original'));
    swap.type = 'button';
    swap.addEventListener('click', () => toggle(bubble));
    note.append(label, swap);
    const warn = missingText(r);
    if (warn) note.append(el('span', 'hz-warn', warn));
    bubble.prepend(note, fresh, original);
    bubble.hzState = { on: true, text: r.text, source, fresh, original, swap, button };
    bubble.hzSource = r.text; // (the reply's Copy takes the version on screen: chat-core.js finishReply)
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    button.title = tr('humanize.original', 'Show original');
    button.setAttribute('aria-label', button.title);
  }

  function toggle(bubble) {
    const st = bubble.hzState;
    if (!st) return;
    st.on = !st.on;
    st.fresh.hidden = !st.on;
    st.original.hidden = st.on;
    bubble.hzSource = st.on ? st.text : null;
    const word = st.on ? tr('humanize.original', 'Show original') : tr('humanize.showHumanized', 'Show humanized');
    st.swap.textContent = word;
    st.button.classList.toggle('on', st.on);
    st.button.setAttribute('aria-pressed', String(st.on));
    st.button.title = word;
    st.button.setAttribute('aria-label', word);
  }

  function flash(bubble, text) {
    bubble.querySelector(':scope > .hz-error')?.remove();
    const line = el('div', 'hz-note hz-error', text);
    line.setAttribute('role', 'alert');
    bubble.prepend(line);
    setTimeout(() => line.remove(), 8000);
  }

  // A card under the conversation with the rewrite of pasted text. `append`: chat-core's way to add a node to the messages list.
  async function paste(text, append) {
    const card = el('div', 'hz-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', tr('humanize.title', 'Humanize'));
    card.setAttribute('aria-busy', 'true');
    const head = el('div', 'hz-card-head', tr('humanize.title', 'Humanize'));
    const body = el('div', 'hz-card-body hz-waiting', tr('humanize.working', 'Rewriting with your AI…'));
    const foot = el('div', 'hz-card-foot');
    card.append(head, body, foot);
    append(card);
    let r;
    try { r = await window.assistant.humanize(text, 'paste'); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
    card.setAttribute('aria-busy', 'false');
    body.classList.remove('hz-waiting');
    if (!r?.ok) { body.textContent = errorText(r) || tr('humanize.timeout', 'That took too long. Try again.'); body.classList.add('hz-error'); return card; }
    const html = render(r.text);
    if (html != null) body.innerHTML = html; else body.textContent = r.text;
    decorate(body);
    const copy = el('button', 'btn hz-copy', tr('humanize.copy', 'Copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.text); copy.textContent = tr('humanize.copied', 'Copied.'); } catch { copy.textContent = tr('humanize.copyFailed', 'Couldn’t copy.'); }
      setTimeout(() => { copy.textContent = tr('humanize.copy', 'Copy'); }, 1600);
    });
    const close = el('button', 'btn hz-close', tr('humanize.close', 'Close'));
    close.type = 'button';
    close.addEventListener('click', () => card.remove());
    foot.append(el('span', 'hz-note-text', [noteText(r), missingText(r)].filter(Boolean).join(' · ')), copy, close);
    card.hzText = r.text;
    return card;
  }

  window.humanizeUI = { reply, toggle, paste };
})();

// [reply suggestions] Chips under the reply that just ended, each sent as the next message when clicked:
//  - Yes / No, at once, when the reply ends on a yes/no question (ai/reply-suggest.js yesNoQuestion), as Claude Code's own buttons;
//  - a few short follow-ups, a moment later, from the chat's own provider's cheaper model (main: agent:reply-suggest).
// Shown only for a reply that ended on its own (not stopped, failed or followed by a queued message) with the chat box empty. They go
// as soon as anything is typed, a message is sent, the chat changes, or the next reply starts. Off in Settings → AI (main then says 'off';
// Yes / No follow the same switch). Loaded after chat-core.js and ../ai/reply-suggest.js.
(function () {
  const lib = window.replySuggest;
  const messages = document.getElementById('messages');
  const prompt = document.getElementById('prompt');
  const form = document.getElementById('composer');
  if (!lib || !messages || !prompt || !form) return;
  const tr = (key, fallback) => { const text = window.t ? window.t(key) : key; return text && text !== key ? text : fallback; };
  let row = null;
  let seq = 0;
  let on = true; // (main said 'off': no row at all until the next reply asks again)

  const clear = () => { seq++; if (row) { row.remove(); row = null; } };
  function send(text) {
    clear();
    prompt.value = text;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  }
  function chip(text, kind) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `chip reply-chip${kind ? ` ${kind}` : ''}`, textContent: text });
    b.addEventListener('click', () => send(text));
    return b;
  }
  function ensureRow() {
    if (row?.isConnected) return row;
    row = Object.assign(document.createElement('div'), { className: 'reply-suggest' });
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', tr('chat.suggest.label', 'Suggested replies'));
    messages.append(row);
    return row;
  }
  const askable = () => !prompt.value.trim();

  document.addEventListener('lumen:reply-done', async (e) => {
    clear();
    const { clean, text, chatId } = e.detail || {};
    if (!clean || !text || !askable()) return;
    const mine = seq;
    const yesNo = lib.yesNoQuestion(text);
    // Yes / No show at once only while the switch is known on; main's answer below says.
    if (yesNo && on) ensureRow().append(chip(tr('chat.suggest.yes', 'Yes'), 'yes'), chip(tr('chat.suggest.no', 'No'), 'no'));
    let r;
    try { r = await window.assistant?.replySuggest?.(chatId); } catch { r = null; }
    if (mine !== seq) return; // (cleared meanwhile: typed, sent, another reply)
    if (r?.error === 'off') { on = false; clear(); return; }
    on = true;
    if (yesNo && !row) ensureRow().append(chip(tr('chat.suggest.yes', 'Yes'), 'yes'), chip(tr('chat.suggest.no', 'No'), 'no')); // (the switch is back on)
    const have = row ? [...row.querySelectorAll('.reply-chip')].map((b) => b.textContent) : [];
    const items = lib.parseList((r?.items || []).join('\n'), have);
    if (!items.length || !askable()) return;
    const box = ensureRow();
    for (const item of items) box.append(chip(item, 'follow'));
  });
  // Anything typed or sent, or the conversation changing under the row (a new message, another chat drawn): the chips go. A row the reply
  // adds a moment later (a Claude Code reply's late 'done': Undo, the AI tabs row) only moves the chips below it.
  prompt.addEventListener('input', () => { if (prompt.value.trim()) clear(); });
  form.addEventListener('submit', clear, { capture: true });
  new MutationObserver(() => {
    if (!row) return;
    if (!row.isConnected) { clear(); return; }
    let next = row.nextElementSibling;
    if (!next) return;
    for (; next; next = next.nextElementSibling) if (next.matches('.msg.user, .msg.assistant.streaming, .working')) { clear(); return; }
    messages.append(row); // (moved to the end; the observer then finds nothing after it)
  }).observe(messages, { childList: true });
})();

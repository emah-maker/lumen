// The chat's own "/" commands (skills add theirs in skills.js). Loaded after slash.js, in the sidebar and
// on the chat page alike. Names here are reserved for skills (features/skills.js RESERVED).
//   /clear     starts a fresh conversation, like the New chat button: the current one stays in the chat
//              history, so nothing is lost.
//   /compact   [context] summarizes the conversation so far to free up the context window (optional: what to
//              keep). Main answers it for every AI (agent.js commandTurn): Claude Code runs its own /compact.
//   /context   how full the chat's context window is (Claude Code: its own breakdown).
//   /cost      this chat's tokens and estimated cost; /usage opens Settings → Usage.
//   /model     opens the model picker (with a search: /model sonnet).
//   /btw       <question>: a side question, answered at once beside the running task by one model call with no tools, in a
//              dismissible card above the composer. Never part of the chat's history (ai/btw.js, agent.js btw).
//   /help      lists every command.
/* global shownChatId */ // renderer/chat-core.js: the chat the view shows
(() => {
  const slash = window.slashCommands;
  const newChat = document.getElementById('new-chat');
  if (!slash || !newChat) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text && text !== key ? text : (vars ? fallback.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : fallback);
  };
  const note = (node) => (typeof window.append === 'function' ? window.append(node) : null);
  const notice = (text) => note(Object.assign(document.createElement('div'), { className: 'notice', textContent: text }));
  slash.register({
    name: 'clear',
    label: tr('slash.clear', 'Clear chat'),
    description: tr('slash.clear.description', 'Start a fresh conversation. This one stays in your chat history.'),
    takesInput: false,
    run() {
      newChat.click();
      return { ok: true };
    },
  });

  // ---------- [context] commands main answers (features/chat-compact.js): sent like a message ----------
  slash.register({
    name: 'compact',
    label: tr('slash.compact', 'Compact the conversation'),
    description: tr('slash.compact.description', 'Shrink the chat so far into a short recap to free up context. Tab: say what to keep.'),
    hint: tr('slash.compact.hint', 'What the summary should keep (optional), then press Enter'),
    takesInput: false,
    run({ input, ask }) {
      ask(input ? `/compact ${input}` : '/compact');
      return { ok: true };
    },
  });
  slash.register({
    name: 'context',
    label: tr('slash.context', 'Context usage'),
    description: tr('slash.context.description', 'How full this chat’s context window is.'),
    takesInput: false,
    run({ ask }) {
      ask('/context');
      return { ok: true };
    },
  });

  // ---------- [auto model] /think, /deep and /fast: this message only, as a hint to Auto (ai/auto-model.js hintOf) ----------
  // The message goes on as typed ("/think why is the sky blue"); main takes the command off and, with Auto picked, chooses the
  // strongest ("/think", "/deep") or the quickest ("/fast") model for it. With a model picked by hand they say so and send nothing.
  for (const [name, label, description] of [
    ['think', tr('slash.think', 'Think harder'), tr('slash.think.description', 'Strongest model for this message. Needs Auto; type your question after it.')],
    ['deep', tr('slash.deep', 'Deep research'), tr('slash.deep.description', 'Strongest model, thorough answer. Needs Auto.')],
    ['fast', tr('slash.fast', 'Quick answer'), tr('slash.fast.description', 'Quickest model for this message. Needs Auto.')],
  ]) {
    slash.register({
      name, label, description,
      hint: tr('slash.auto.hint', 'Your message, then press Enter'),
      takesInput: false,
      run({ input, ask }) {
        if (!document.getElementById('model')?.selectedOptions?.[0]?.dataset.auto) return { ok: false, message: tr('slash.auto.needAuto', 'Pick Auto in the model menu first (the top row, or the Auto row of a provider): /think, /deep and /fast ask Auto for a model.') };
        if (!input) return { ok: false, message: tr('slash.auto.needText', 'Type your message after the command, for example /{name} why is the sky blue', { name }) };
        ask(`/${name} ${input}`);
        return { ok: true };
      },
    });
  }

  // ---------- /btw: a side question in a card of its own, answered while the task (if any) keeps going ----------
  // It never goes through ask() or the queue: slash.js runs a command on Enter even while a reply is running. The question and its
  // answer live in the card only (main keeps them out of the chat's history); × or Esc dismisses it and cancels the call. Several
  // cards can be open at once.
  const btwApi = window.assistant && window.assistant.btw ? window.assistant : null;
  const tray = Object.assign(document.createElement('div'), { id: 'btw-tray', className: 'btw-tray', hidden: true });
  tray.setAttribute('role', 'region');
  tray.setAttribute('aria-label', tr('btw.region', 'Side questions'));
  const composerEl = document.getElementById('composer');
  if (composerEl) composerEl.prepend(tray);
  const btwCards = new Map(); // id -> { el, body, foot, text, chatId, done }
  let btwSeq = 0;
  const currentChat = () => (typeof shownChatId !== 'undefined' ? shownChatId : null);
  const btwSync = () => { tray.hidden = btwCards.size === 0; };
  function btwDismiss(id, { focus = false } = {}) {
    const card = btwCards.get(id);
    if (!card) return;
    btwCards.delete(id);
    if (!card.done) btwApi?.btwCancel(id);
    card.el.remove();
    btwSync();
    if (focus) document.getElementById('prompt')?.focus();
  }
  const btwClear = () => { for (const id of [...btwCards.keys()]) btwDismiss(id); };
  btwApi?.onBtw?.((e) => {
    const card = btwCards.get(e?.id);
    if (!card || e.type !== 'text') return;
    card.text += e.text;
    card.body.textContent = card.text; // (plain while it streams; rendered once it is whole)
    card.body.classList.remove('btw-waiting');
    tray.scrollTop = tray.scrollHeight;
  });
  function btwFinish(id, r) {
    const card = btwCards.get(id);
    if (!card) return;
    card.done = true;
    card.body.classList.remove('btw-waiting');
    card.el.removeAttribute('aria-busy');
    if (!r || !r.ok) {
      const code = r?.error;
      const reason = code === 'no-provider' ? tr('btw.noProvider', 'No API model is connected for /btw. Add an API key in Settings → AI: Claude Code and the other engines can’t answer a side question mid-task.')
        : code === 'timeout' ? tr('btw.timeout', 'That took too long. Try again.')
          : code === 'busy' ? tr('btw.busy', 'Too many side questions are open. Dismiss one first.')
            : tr('btw.failed', 'That side question failed: {error}', { error: String(code || '').slice(0, 200) });
      card.body.classList.add('btw-error');
      card.body.textContent = card.text ? `${card.text}\n\n${reason}` : reason;
      return;
    }
    card.text = r.text || card.text;
    if (typeof window.renderMarkdown === 'function') card.body.innerHTML = window.renderMarkdown(card.text); else card.body.textContent = card.text;
    const model = r.name || r.model || '';
    const engine = r.engineName || r.engine || '';
    card.foot.textContent = !model ? ''
      : engine ? (r.viaDefault
        ? tr('btw.via.engineDefault', 'Answered by {model} (your default API model), not {engine}: it can’t take a side question mid-task.', { model, engine })
        : tr('btw.via.engine', 'Answered by {model}, not {engine}: it can’t take a side question mid-task.', { model, engine }))
        : tr('btw.via', 'Answered by {model}', { model });
    card.foot.hidden = !card.foot.textContent;
  }
  function btwStart(question) {
    if (!btwApi) return { ok: false, message: tr('btw.unavailable', '/btw is not available here.') };
    const id = `btw-${Date.now().toString(36)}-${++btwSeq}`;
    const el = Object.assign(document.createElement('div'), { className: 'btw-card', tabIndex: -1 });
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', tr('btw.card', 'Side question'));
    el.setAttribute('aria-busy', 'true');
    const head = Object.assign(document.createElement('div'), { className: 'btw-head' });
    const tag = Object.assign(document.createElement('span'), { className: 'btw-tag', textContent: tr('btw.tag', 'btw') });
    const q = Object.assign(document.createElement('span'), { className: 'btw-q', textContent: question, title: question });
    const x = Object.assign(document.createElement('button'), { type: 'button', className: 'btw-x', textContent: '×', title: tr('btw.dismiss', 'Dismiss (Esc)') });
    x.setAttribute('aria-label', tr('btw.dismiss', 'Dismiss (Esc)'));
    x.addEventListener('click', () => btwDismiss(id, { focus: true }));
    head.append(tag, q, x);
    const body = Object.assign(document.createElement('div'), { className: 'btw-body btw-waiting' });
    body.setAttribute('aria-live', 'polite');
    body.append(Object.assign(document.createElement('span'), { className: 'btw-spinner' }), Object.assign(document.createElement('span'), { className: 'btw-thinking', textContent: tr('btw.thinking', 'Thinking…') }));
    const foot = Object.assign(document.createElement('div'), { className: 'btw-foot', hidden: true });
    el.append(head, body, foot);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); btwDismiss(id, { focus: true }); } });
    btwCards.set(id, { el, body, foot, text: '', chatId: currentChat(), done: false });
    tray.append(el);
    btwSync();
    tray.scrollTop = tray.scrollHeight;
    Promise.resolve(btwApi.btw(id, question)).then((r) => btwFinish(id, r), (err) => btwFinish(id, { ok: false, error: String(err?.message || err) }));
    return { ok: true };
  }
  // Esc in an empty composer dismisses the newest card first (the next Esc stops a running reply, as before).
  document.getElementById('prompt')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || !btwCards.size || e.target.value) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    btwDismiss([...btwCards.keys()].pop());
  }, true);
  newChat.addEventListener('click', btwClear); // a card belongs to the chat it was asked in
  window.assistant?.onSync?.((payload) => { const id = payload?.view?.id; if (id) for (const [key, card] of btwCards) if (card.chatId && card.chatId !== id) btwDismiss(key); });
  slash.register({
    name: 'btw',
    label: tr('slash.btw', 'Side question'),
    description: tr('slash.btw.description', 'Ask a quick side question without interrupting the task: /btw what was that link?'),
    hint: tr('slash.btw.hint', 'Your side question, then press Enter'),
    takesInput: true,
    run({ input }) {
      if (!input) return { ok: false, message: tr('btw.needQuestion', 'Type your question after /btw, for example /btw what was that last link?') };
      return btwStart(input);
    },
  });

  // ---------- commands answered here ----------
  const extras = window.lumenExtras || {};
  slash.register({
    name: 'cost',
    label: tr('slash.cost', 'Cost of this chat'),
    description: tr('slash.cost.description', 'Tokens and estimated cost of this chat.'),
    takesInput: false,
    run() {
      const line = document.getElementById('chat-usage');
      const used = line && !line.hidden ? (line.dataset.usage || line.textContent).trim() : '';
      const box = notice(used ? tr('slash.cost.line', 'This chat: {usage}.', { usage: used }) : tr('slash.cost.none', 'Nothing used yet in this chat.'));
      if (box && extras.openUsage) {
        const open = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: tr('slash.cost.open', 'Open Usage') });
        open.onclick = () => extras.openUsage();
        box.append(' ', open);
      }
      return { ok: true };
    },
  });
  slash.register({
    name: 'usage',
    label: tr('slash.usage', 'Usage'),
    description: tr('slash.usage.description', 'Your plan’s limits and Lumen’s use of them (Settings → Usage).'),
    takesInput: false,
    run() {
      if (!extras.openUsage) return { ok: false, message: tr('slash.usage.none', 'Usage is in Settings → Usage.') };
      extras.openUsage();
      return { ok: true };
    },
  });
  slash.register({
    name: 'model',
    label: tr('slash.model', 'Change the model'),
    description: tr('slash.model.description', 'Open the model menu. /model sonnet searches it.'),
    takesInput: false,
    run({ input }) {
      if (typeof modelPicker === 'undefined' || !modelPicker?.open) return { ok: false, message: tr('slash.model.none', 'The model menu is at the top of the chat.') };
      setTimeout(() => modelPicker.open(input || '')); // (after the composer has settled, so the menu keeps the focus)
      return { ok: true };
    },
  });
  slash.register({
    name: 'help',
    label: tr('slash.help', 'Commands'),
    description: tr('slash.help.description', 'List every command you can type after “/”.'),
    takesInput: false,
    run() {
      const box = Object.assign(document.createElement('div'), { className: 'notice slash-help' });
      box.append(Object.assign(document.createElement('strong'), { textContent: tr('slash.help.title', 'Commands') }));
      const list = document.createElement('ul');
      for (const cmd of slash.list().slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const li = document.createElement('li');
        li.append(Object.assign(document.createElement('code'), { textContent: `/${cmd.name}` }), ` ${cmd.description || cmd.label || ''}`);
        list.append(li);
      }
      box.append(list, Object.assign(document.createElement('span'), { textContent: tr('slash.help.cli', 'With Claude Code and full access on, its other commands and your own (like /goal) go to it as typed.') }));
      note(box);
      return { ok: true };
    },
  });
})();

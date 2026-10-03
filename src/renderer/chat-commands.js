// The chat's own "/" commands (skills add theirs in skills.js). Loaded after slash.js, in the sidebar and
// on the chat page alike. Names here are reserved for skills (features/skills.js RESERVED).
//   /clear     starts a fresh conversation, like the New chat button: the current one stays in the chat
//              history, so nothing is lost.
//   /compact   [context] summarizes the conversation so far to free up the context window (optional: what to
//              keep). Main answers it for every AI (agent.js commandTurn): Claude Code runs its own /compact.
//   /context   how full the chat's context window is (Claude Code: its own breakdown).
//   /cost      this chat's tokens and estimated cost; /usage opens Settings → Usage.
//   /model     opens the model picker (with a search: /model sonnet).
//   /help      lists every command.
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
    ['think', tr('slash.think', 'Think harder'), tr('slash.think.description', 'Ask Auto for its strongest model for this message. Type your question after it.')],
    ['deep', tr('slash.deep', 'Deep research'), tr('slash.deep.description', 'Ask Auto for its strongest model for a thorough answer to this message.')],
    ['fast', tr('slash.fast', 'Quick answer'), tr('slash.fast.description', 'Ask Auto for its quickest model for this message.')],
  ]) {
    slash.register({
      name, label, description,
      hint: tr('slash.auto.hint', 'Your message, then press Enter'),
      takesInput: false,
      run({ input, ask }) {
        if (document.getElementById('model')?.value !== 'auto') return { ok: false, message: tr('slash.auto.needAuto', 'Pick Auto at the top of the model menu first: /think, /deep and /fast ask Auto for a model.') };
        if (!input) return { ok: false, message: tr('slash.auto.needText', 'Type your message after the command, for example /{name} why is the sky blue', { name }) };
        ask(`/${name} ${input}`);
        return { ok: true };
      },
    });
  }

  // ---------- commands answered here ----------
  const extras = window.lumenExtras || {};
  slash.register({
    name: 'cost',
    label: tr('slash.cost', 'Cost of this chat'),
    description: tr('slash.cost.description', 'Tokens and estimated cost of this chat.'),
    takesInput: false,
    run() {
      const line = document.getElementById('chat-usage');
      const used = line && !line.hidden ? line.textContent.trim() : '';
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

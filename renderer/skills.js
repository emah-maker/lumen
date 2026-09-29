// Skills in the composer (features/skills.js is the backend): every saved skill becomes a "/" command
// (renderer/slash.js), a run goes through the normal chat path, and a skill's message shows as a small
// "Skill: Summarize" tag with the full prompt one click away, so nothing sent is hidden.
// Loaded after chat-core.js and slash.js, on the sidebar and on the full-page chat.
(() => {
  const api = window.skillsApi;
  const slash = window.slashCommands;
  if (!api || !slash) return; // a surface without the skills bridge (private windows have no chat at all)
  const messages = document.getElementById('messages');
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key ? (vars ? fallback.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : fallback) : text;
  };

  // The @ tab picker (another feature) sets window.skillsHooks.pickedTabs = () => [tab ids].
  const hooks = (window.skillsHooks = window.skillsHooks || { pickedTabs: () => [] });
  const picked = () => { try { return (hooks.pickedTabs?.() || []).filter(Number.isInteger); } catch { return []; } };

  // What the popup knows about the page: the selection, the page, the clipboard, picked tabs.
  slash.setContextLoader(() => api.context({ tabs: picked(), clipboard: skills.some((s) => s.inputs.includes('clipboard')) }).catch(() => ({ selection: 0, page: null, clipboard: false, tabs: 0 })));

  // A skill can't run without the context its prompt names: the popup says which, in words.
  const NEED_TEXT = {
    selection: () => tr('skills.need.selection', 'Select some text on the page first.'),
    content: () => tr('skills.need.content', 'Open a page or select some text first.'),
    page: () => tr('skills.need.page', 'Open a web page first.'),
    clipboard: () => tr('skills.need.clipboard', 'Copy some text first.'),
    tabs: () => tr('skills.need.tabs', 'Pick some tabs first (type @).'),
  };
  function checkFor(skill) {
    return (state) => {
      if (!state) return null;
      for (const need of skill.needs || []) {
        if (need === 'selection' && !(state.selection > 0)) return NEED_TEXT.selection();
        if (need === 'content' && !(state.selection > 0) && !state.page) return NEED_TEXT.content();
        if (need === 'page' && !state.page) return NEED_TEXT.page();
        if (need === 'clipboard' && !state.clipboard) return NEED_TEXT.clipboard();
        if (need === 'tabs' && !(picked().length > 0)) return NEED_TEXT.tabs();
      }
      return null;
    };
  }

  async function runSkill(skill, { input, extra, ask }) {
    const res = await api.prepare({ id: skill.id, input, selection: typeof extra?.selection === 'string' ? extra.selection : undefined, tabs: picked() });
    if (!res?.ok) return { ok: false, message: res?.message || res?.error || tr('skills.failed', 'That skill could not run.') };
    ask(res.text);
    return { ok: true };
  }

  let registered = [];
  let skills = [];
  function register(list) {
    for (const off of registered) off();
    skills = list;
    registered = list.map((skill) => slash.register({
      name: skill.name,
      label: skill.title,
      description: skill.description || skill.title,
      takesInput: skill.takesInput,
      hint: skill.inputRequired ? tr('skills.hint.required', 'Type what to use it on, then press Enter') : skill.takesInput ? tr('skills.hint.input', 'Add details, then press Enter') : tr('skills.hint.optional', 'Anything to add? (optional) Press Enter'),
      check: checkFor(skill),
      run: (ctx) => runSkill(skill, ctx),
    }));
    registered.push(slash.register({
      name: 'create-skill',
      label: tr('skills.create', 'Create a skill from this chat'),
      description: tr('skills.create.description', 'Turn the last exchange into a skill you can review and save.'),
      takesInput: false,
      async run({ notify }) {
        notify(tr('skills.create.working', 'Asking the model for a skill…'));
        const r = await api.draftFromChat();
        if (!r?.ok) return { ok: false, message: r?.error || tr('skills.failed', 'That skill could not run.') };
        notify(tr('skills.create.opened', 'The editor is open in Settings. Review it and save.'));
        return { ok: true };
      },
    }));
  }
  api.menu().then(register).catch(() => {});
  api.onChanged(() => api.menu().then(register).catch(() => {}));

  // "Run skill" on selected text (the page's right-click menu): the sidebar opens and the skill runs on that selection.
  api.onRun?.(async ({ id, selection } = {}) => {
    const skill = skills.find((s) => s.id === id);
    if (!skill || typeof selection !== 'string') return;
    window.showSidebar?.(true);
    if (skill.takesInput) { slash.activate(skill.name, { selection }); return; }
    const r = await runSkill(skill, { input: '', extra: { selection }, ask: (text) => window.ask(text) });
    if (!r.ok) slash.notify(r.message);
  });

  // ---------- the skill tag on a message ----------
  const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const REQUEST = /^<skill_request name="([^"]*)" title="([^"]*)" input="([^"]*)">\n([\s\S]*?)\n?<\/skill_request>\s*$/;
  function decorate(bubble) {
    if (!bubble || bubble.dataset.skill !== undefined) return;
    const text = bubble.textContent || '';
    const m = REQUEST.exec(text.trim());
    if (!m) return;
    bubble.dataset.skill = m[1];
    for (const node of [...bubble.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
    const tag = Object.assign(document.createElement('div'), { className: 'skill-tag' });
    tag.append(Object.assign(document.createElement('span'), { className: 'skill-badge', textContent: tr('skills.tag', 'Skill: {title}', { title: decode(m[2]) }) }));
    const typed = decode(m[3]);
    if (typed) tag.append(Object.assign(document.createElement('span'), { className: 'skill-input', textContent: typed }));
    const details = Object.assign(document.createElement('details'), { className: 'skill-full' });
    details.append(Object.assign(document.createElement('summary'), { textContent: tr('skills.showPrompt', 'Show the full prompt') }), Object.assign(document.createElement('pre'), { textContent: m[4].trim() }));
    bubble.append(tag, details);
  }
  const startBase = window.startTurn;
  if (typeof startBase === 'function') {
    window.startTurn = function startTurn(text, images) {
      const result = startBase.call(this, text, images);
      decorate([...messages.querySelectorAll(':scope > .msg.user')].pop());
      return result;
    };
  }
  const historyBase = window.showHistory;
  if (typeof historyBase === 'function') {
    window.showHistory = function showHistory(items) {
      const result = historyBase.call(this, items);
      for (const bubble of messages.querySelectorAll(':scope > .msg.user.restored')) decorate(bubble);
      return result;
    };
  }
})();

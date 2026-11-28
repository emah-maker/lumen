// What stands in for routines.js until it loads (tasks-loader.js loads it with tasks.js, in an idle moment after start or on first use),
// in its old place in index.src.html (after slash.js): the /routine command, which loads it and runs its own (routines.js then takes
// this one's place in the "/" menu), "Save as routine" on each finished reply (here for good: a chat can finish replies before
// routines.js is there), and a message that reads like a schedule ("every day at 8am ...") loads it so its offer bar can show.
(() => {
  const T = (key, vars) => window.t(key, vars);
  const load = () => window.lumenPanels?.loadTasks() || Promise.resolve(false);
  const routines = () => load().then((ok) => (ok && window.lumenRoutines) || null);

  // ---- /routine [every weekday at 8am:] what to do
  window.slashCommands?.register({
    name: 'routine',
    label: T('routines.slash.label'),
    description: T('routines.slash.description'),
    takesInput: true,
    hint: T('routines.slash.hint'),
    async run(args) {
      const r = await routines();
      if (!r) return { ok: false };
      const why = r.slash.check();
      return why ? { ok: false, message: why } : r.slash.run(args);
    },
  });

  // ---- "Save as routine" beside Copy on a finished reply: the request that led to it, as a routine.
  const CLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M3 2.5 1.5 4M13 2.5 14.5 4"/></svg>';
  const requestBefore = (bubble) => {
    for (let n = bubble.previousElementSibling; n; n = n.previousElementSibling) if (n.classList?.contains('msg') && n.classList.contains('user')) return n.textContent.trim();
    return '';
  };
  const finishBase = window.finishReply;
  if (typeof finishBase === 'function' && window.assistant?.tasks) {
    window.finishReply = function finishReply(bubble, ...rest) {
      const result = finishBase.call(this, bubble, ...rest);
      if (bubble?.querySelector(':scope > .reply-copy') && !bubble.querySelector(':scope > .reply-routine')) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'reply-routine', title: T('routines.fromReply'), innerHTML: CLOCK });
        b.setAttribute('aria-label', T('routines.fromReply'));
        b.onclick = () => { const text = requestBefore(bubble); if (text) routines().then((r) => r?.open({ prompt: text })); };
        bubble.append(b);
      }
      return result;
    };
  }

  // ---- "Every day at 8am check my email" typed before routines.js is in: load it (it then looks at the box once itself).
  const box = document.getElementById('prompt');
  const phrase = window.routinePhrase;
  if (box && phrase) box.addEventListener('input', () => { if (!window.lumenRoutines && phrase.looksScheduled(box.value.trim())) load(); });
})();

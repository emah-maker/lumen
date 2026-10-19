// Focus mode in the browser window (features/focus.js): the toolbar button (a menu to start, the time left while it is on), the "/focus"
// command, and "focus for 90 minutes" typed in the chat. Loaded after slash.js and chat-core.js. The bridge is window.assistant.focus (preload.js).
(() => {
  const api = window.assistant?.focus;
  const button = document.getElementById('focus-btn');
  const label = document.getElementById('focus-time');
  if (!api || !button) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text && text !== key ? text : (vars ? fallback.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : fallback);
  };

  let state = null;
  let ticker = 0;
  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };
  function draw() {
    const on = Boolean(state?.active);
    const left = on ? Math.max(0, state.until - Date.now()) : 0;
    button.classList.toggle('on', on);
    label.hidden = !on;
    label.textContent = on ? clock(left) : '';
    const name = on ? tr('focus.button.on', 'Focus mode: {time} left', { time: clock(left) }) : tr('focus.button', 'Focus mode');
    button.title = name;
    button.setAttribute('aria-label', name);
    if (on && left === 0) api.state().then(apply).catch(() => {});
  }
  function apply(next) {
    state = next;
    if (state?.active && !ticker) ticker = setInterval(draw, 1000);
    else if (!state?.active && ticker) { clearInterval(ticker); ticker = 0; }
    draw();
  }
  button.addEventListener('click', () => {
    const r = button.getBoundingClientRect();
    api.menu({ x: Math.round(r.left), y: Math.round(r.bottom + 4) });
  });
  api.onState(apply);
  api.state().then(apply).catch(() => {});

  const notice = (text) => {
    if (typeof window.append !== 'function') return;
    window.append(Object.assign(document.createElement('div'), { className: 'notice', textContent: text }));
  };
  const endsAt = (until) => new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  async function start(minutes) {
    try {
      const s = await api.start(minutes);
      apply(s);
      return { ok: true, state: s };
    } catch (err) {
      return { ok: false, message: String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    }
  }

  // "/focus 90 minutes" (Enter alone: 45 minutes)
  window.slashCommands?.register({
    name: 'focus',
    label: tr('focus.slash', 'Start focus mode'),
    description: tr('focus.slash.description', 'Block distracting sites for a while. Tab: say how long.'),
    hint: tr('focus.slash.hint', 'How long, like 90 minutes or 2 hours (Enter alone: 45 minutes)'),
    takesInput: false,
    async run({ input }) {
      const minutes = String(input || '').trim() ? window.focusPhrase?.parseLength(input) : 45;
      if (!minutes) return { ok: false, message: tr('focus.slash.bad', 'Say how long, like 90 minutes or 2 hours.') };
      const r = await start(minutes);
      if (r.ok) notice(tr('focus.started', 'Focus mode is on until {time}. Distracting sites are blocked.', { time: endsAt(r.state.until) }));
      return r;
    },
  });

  // A chat message that is only "focus for 90 minutes": handled here, not sent to the AI. True when it was.
  window.focusUi = {
    async tryStart(text) {
      const minutes = window.focusPhrase?.parseStart(text);
      if (!minutes) return false;
      const r = await start(minutes);
      notice(r.ok ? tr('focus.started', 'Focus mode is on until {time}. Distracting sites are blocked.', { time: endsAt(r.state.until) }) : r.message);
      return true;
    },
  };
})();

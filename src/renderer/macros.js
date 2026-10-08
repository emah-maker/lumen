// Macros in the main window (features/macros-runtime.js is the backend; Settings > Macros makes and edits them):
//   - the "/macro <name>" command in the sidebar composer,
//   - a progress toast in the tab strip while one runs (step N/M, Stop; "Continue" at a pause; "Edit macro" when a step fails),
//   - the recording toast (Stop / Cancel),
//   - the small form that asks for a macro's {{variables}} before it runs, and
//   - "Ask AI" / "Open sidebar" steps landing in the composer.
// Web pages cover everything below the tab strip, so the toast lives in the strip's own row (like the organize note).
(() => {
  const api = window.macrosApi;
  if (!api) return; // a surface without the macros bridge
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    const out = text && text !== key ? text : fallback;
    return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out;
  };
  const el = (tag, props = {}, ...kids) => { const node = Object.assign(document.createElement(tag), props); node.append(...kids.filter(Boolean)); return node; };
  const slash = window.slashCommands;

  // ---------- the list, for /macro ----------
  let list = [];
  const refresh = () => api.menu().then((m) => { list = m || []; }).catch(() => {});
  refresh();
  api.onChanged?.(() => refresh());
  const find = (query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { none: true };
    const exact = list.find((m) => m.name.toLowerCase() === q);
    if (exact) return { macro: exact };
    for (const test of [(m) => m.name.toLowerCase().startsWith(q), (m) => m.name.toLowerCase().includes(q)]) {
      const hits = list.filter(test);
      if (hits.length === 1) return { macro: hits[0] };
      if (hits.length > 1) return { many: hits };
    }
    return { none: true };
  };
  slash?.register({
    name: 'macro',
    label: tr('macros.slash', 'Run a macro'),
    description: tr('macros.slash.description', 'Run one of your saved macros: /macro <name>. Make them in Settings > Macros.'),
    hint: tr('macros.slash.hint', 'The macro’s name, then press Enter'),
    takesInput: true,
    async run({ input }) {
      let found = find(input);
      if (!found.macro && !found.many) { await refresh(); found = find(input); } // one made a moment ago, in another window
      if (found.macro) {
        api.run({ id: found.macro.id, source: 'slash' }).then((r) => { if (r && !r.ok && !r.asking && r.message) slash.notify?.(r.message); }).catch(() => {});
        return { ok: true };
      }
      if (found.many) return { ok: false, message: tr('macros.slash.which', 'Which one? {names}', { names: found.many.slice(0, 6).map((m) => m.name).join(', ') }) };
      const names = list.slice(0, 6).map((m) => m.name).join(', ');
      return { ok: false, message: list.length ? tr('macros.slash.none', 'No macro by that name. You have: {names}', { names }) : tr('macros.slash.empty', 'You have no macros yet. Make one in Settings > Macros.') };
    },
  });

  // ---------- the toast in the tab strip ----------
  let toast = null;
  let hideTimer = 0;
  const anchor = () => document.getElementById('organize-tabs');
  const clearToast = () => { clearTimeout(hideTimer); toast?.remove(); toast = null; };
  function put(className, text, buttons, { ttl = 0, title = '' } = {}) {
    clearTimeout(hideTimer);
    toast?.remove();
    const words = el('span', { className: 'macro-toast-text', textContent: text });
    toast = el('div', { className: `macro-toast ${className}`, role: 'status', title: title || text }, words, ...buttons.map(([label, fn, extra]) => el('button', { type: 'button', textContent: label, onclick: fn, ...(extra || {}) })));
    anchor()?.after(toast);
    if (ttl) hideTimer = setTimeout(clearToast, ttl);
  }
  const clip = (s, n = 48) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

  api.onProgress?.((e) => {
    if (!e) return;
    const stop = [tr('macros.toast.stop', 'Stop'), () => api.stop(e.runId), { className: 'macro-toast-stop' }];
    switch (e.phase) {
      case 'start': put('running', tr('macros.toast.starting', '{name}: starting', { name: e.macro }), [stop]); break;
      case 'step': put('running', tr('macros.toast.step', '{name} · step {n}/{total}: {label}', { name: e.macro, n: e.index, total: e.total, label: clip(e.label) }), [stop], { title: e.label }); break;
      case 'pause': put('paused', tr('macros.toast.pause', '{name} is waiting for you: {note}', { name: e.macro, note: clip(e.label, 60) }), [[tr('macros.toast.continue', 'Continue'), () => api.resume(e.runId), { className: 'macro-toast-go' }], stop]); break;
      case 'done': put('done', tr('macros.toast.done', '{name}: done', { name: e.macro }), [], { ttl: 2500 }); break;
      case 'stopped': put('done', tr('macros.toast.stopped', '{name}: stopped', { name: e.macro }), [], { ttl: 3000 }); break;
      case 'failed': {
        const text = e.index ? tr('macros.toast.failed', '{name} stopped at step {n}/{total}: {error}', { name: e.macro, n: e.index, total: e.total, error: clip(e.error, 90) }) : `${e.macro}: ${clip(e.error, 120)}`;
        put('failed', text, [
          ...(e.macroId ? [[tr('macros.toast.edit', 'Edit macro'), () => { api.edit(e.macroId); clearToast(); }]] : []),
          [tr('macros.toast.dismiss', 'Dismiss'), clearToast],
        ], { ttl: 30000, title: e.error });
        break;
      }
      default: break;
    }
  });
  api.onRecording?.((e) => {
    if (!e?.on) { if (toast?.classList.contains('recording')) clearToast(); return; }
    put('recording', e.steps ? tr('macros.toast.recordingN', 'Recording · {n} steps', { n: e.steps }) : tr('macros.toast.recording', 'Recording your actions…'), [
      [tr('macros.toast.finish', 'Stop and review'), () => api.stopRecording({}), { className: 'macro-toast-go' }],
      [tr('macros.toast.cancel', 'Cancel'), () => api.stopRecording({ cancel: true })],
    ]);
  });

  // ---------- {{variables}}: a small form above the composer ----------
  const composer = document.getElementById('composer');
  api.onVars?.(({ id, name, description, vars, source }) => {
    if (!composer) return;
    window.showSidebar?.(true);
    composer.querySelector('.macro-ask')?.remove();
    const inputs = vars.map((v) => el('input', { type: 'text', name: v, id: `macro-var-${v}`, autocomplete: 'off', spellcheck: false, placeholder: v }));
    const close = () => { card.remove(); document.getElementById('prompt')?.focus(); };
    const card = el('form', { className: 'macro-ask', role: 'group' },
      el('div', { className: 'macro-ask-head', textContent: tr('macros.ask.title', 'Run “{name}”', { name }) }),
      description ? el('div', { className: 'macro-ask-note', textContent: description }) : null,
      ...vars.map((v, i) => el('label', { className: 'macro-ask-field' }, el('span', { textContent: v }), inputs[i])),
      el('div', { className: 'macro-ask-row' },
        el('button', { type: 'submit', className: 'macro-ask-run', textContent: tr('macros.ask.run', 'Run') }),
        el('button', { type: 'button', textContent: tr('macros.ask.cancel', 'Cancel'), onclick: close })));
    card.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const values = Object.fromEntries(vars.map((v, i) => [v, inputs[i].value]));
      close();
      api.run({ id, values, source }).then((r) => { if (r && !r.ok && !r.asking && r.message) slash?.notify?.(r.message); }).catch(() => {});
    });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    composer.prepend(card);
    inputs[0]?.focus();
  });

  // ---------- "Ask AI" and "Open sidebar" steps ----------
  api.onSidebar?.(({ text, send, newChat }) => {
    window.showSidebar?.(true);
    if (newChat) document.getElementById('new-chat')?.click();
    if (typeof text !== 'string' || !text) return;
    if (send && typeof window.ask === 'function') { window.ask(text); return; }
    const prompt = document.getElementById('prompt');
    if (!prompt) return;
    prompt.value = text;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
  });
})();

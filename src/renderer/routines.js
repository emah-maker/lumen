// Routines in the sidebar (features/routines.js and features/background-runner.js are the backend): the
// Tasks panel's Routines tab (list, enable switch, Run now, starter templates), the editor card, a
// routine's run history in its task page, the /routine command, and "Save as routine" on a reply.
// A routine is a background task on a calendar schedule, so it is listed with the tasks too. Loaded after
// tasks.js (window.lumenTasks) and slash.js, on the main window's page only.
(() => {
  const core = window.lumenTasks;
  if (!core) return;
  const { api, h, btn, clock, statusText } = core;
  const T = (key, vars) => window.t(key, vars);
  const byId = (id) => document.getElementById(id);
  const sidebar = byId('sidebar');
  const composerInput = byId('prompt');
  const isMac = /Mac/.test(navigator.platform);
  const REPEATS = ['daily', 'weekdays', 'weekly', 'hours', 'once', 'cron'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const dayName = (d, style = 'short') => new Intl.DateTimeFormat([], { weekday: style }).format(new Date(2026, 0, 4 + d)); // 4 January 2026 is a Sunday
  const timeText = (hhmm) => { const [hh, mm] = String(hhmm || '08:00').split(':').map(Number); return new Date(2026, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const routinesOf = (state) => state.tasks.filter((t) => t.schedule?.type === 'routine');

  // "Weekdays at 8:00 AM", "Every 3 hours", "Mon, Thu at 9:15 AM"
  function scheduleText(s) {
    if (!s || s.type !== 'routine') return '';
    if (s.repeat === 'once') return T('routines.schedule.once', { time: clock(s.at) });
    if (s.repeat === 'hours') return s.hours === 1 ? T('routines.schedule.hour') : T('routines.schedule.hours', { n: s.hours });
    if (s.repeat === 'cron') return T('routines.schedule.cron', { cron: s.cron });
    const time = timeText(s.time);
    if (s.repeat === 'daily') return T('routines.schedule.daily', { time });
    if (s.repeat === 'weekdays') return T('routines.schedule.weekdays', { time });
    return T('routines.schedule.weekly', { days: DAY_ORDER.filter((d) => s.days.includes(d)).map((d) => dayName(d)).join(', '), time });
  }

  // ---- the Routines tab
  function list(state) {
    const items = routinesOf(state);
    const out = [h('p', { className: 'task-note', textContent: state.settings.enabled ? `${T('routines.note')}${isMac ? ` ${T('routines.note.mac')}` : ''}` : T('tasks.disabled') })];
    if (state.offline) out.push(h('p', { className: 'task-notice routine-offline', textContent: T('routines.offline') }));
    const add = btn(T('routines.new'), () => open({}), 'btn primary routine-new');
    add.disabled = !state.settings.enabled;
    out.push(h('div', { className: 'routine-bar' }, add));
    if (items.length) {
      out.push(h('ul', { className: 'chat-items task-items routine-items' }, items.map((task) => {
        const toggle = h('input', { type: 'checkbox', className: 'routine-toggle', checked: task.enabled !== false, onchange: (e) => api.enable(task.id, e.target.checked).then(core.refresh) });
        toggle.setAttribute('aria-label', T('routines.enabled.for', { name: task.title }));
        const meta = [scheduleText(task.schedule), task.enabled === false ? T('tasks.schedule.paused') : (task.nextRun ? T('tasks.next', { time: clock(task.nextRun) }) : ''),
          ['running', 'waiting-approval', 'queued'].includes(task.status) || task.lastRun ? statusText(task.status) : T('tasks.never')].filter(Boolean).join(' · ');
        const row = h('button', { type: 'button', className: `task-row${task.unseen ? ' unseen' : ''}`, onclick: () => core.openTask(task.id) },
          h('span', { className: `task-dot ${task.status}`, 'aria-hidden': 'true' }),
          h('span', { className: 'task-text' }, h('span', { className: 'task-title', textContent: task.title }), h('span', { className: 'task-meta', textContent: meta }),
            task.pending.length ? h('span', { className: 'task-needs', textContent: T('tasks.detail.approvals') }) : null));
        const busy = ['running', 'waiting-approval'].includes(task.status);
        const run = btn(T('tasks.act.run'), () => api.run(task.id).then(core.refresh), 'btn routine-run-now');
        run.disabled = busy || !state.settings.enabled;
        run.setAttribute('aria-label', T('routines.run.for', { name: task.title }));
        return h('li', { className: 'routine-item' }, toggle, row, run);
      })));
    } else out.push(h('p', { className: 'chat-list-empty', textContent: T('routines.empty') }));
    out.push(h('section', { className: 'routine-templates', 'aria-label': T('routines.templates') }, h('h3', { textContent: T('routines.templates') }),
      TEMPLATES.map((tp) => { const b = btn(T(`routines.template.${tp.key}.name`), () => open({ template: tp }), 'btn routine-template'); b.title = T(`routines.template.${tp.key}.description`); b.disabled = !state.settings.enabled; return b; })));
    return out;
  }

  // Starter routines. `page`: the start page is the tab in front (the user can change it).
  const TEMPLATES = [
    { key: 'news', schedule: { repeat: 'weekdays', time: '08:00' } },
    { key: 'changes', schedule: { repeat: 'daily', time: '09:00' }, page: true },
    { key: 'weekly', schedule: { repeat: 'weekly', days: [1], time: '09:00' }, page: true },
  ];

  // ---- a routine's history, in its task page
  function history(task) {
    const items = [...(task.routine?.history || [])].reverse();
    const out = [h('h3', { textContent: T('routines.history') })];
    if (!items.length) { out.push(h('p', { className: 'task-meta', textContent: T('routines.history.none') })); return out; }
    out.push(h('ul', { className: 'routine-history' }, items.map((r, i) => {
      const when = [clock(r.startedAt || r.endedAt), T(`routines.history.status.${r.status}`), T(`routines.trigger.${r.trigger}`),
        r.trigger === 'catch-up' && r.scheduledFor ? T('routines.history.dueAt', { time: clock(r.scheduledFor) }) : ''].filter(Boolean).join(' · ');
      const details = h('details', { className: 'routine-run', open: i === 0 && r.status !== 'done' }, // the newest problem is shown open; results are a click away (the latest is above)
        h('summary', {}, h('span', { className: `task-dot ${r.status === 'skipped' ? 'stopped' : r.status}`, 'aria-hidden': 'true' }), h('span', { textContent: when })));
      if (r.error) details.append(h('p', { className: r.status === 'skipped' ? 'task-meta' : 'task-error', textContent: r.error }));
      if (r.result) {
        const body = h('div', { className: 'msg assistant task-result routine-result' });
        body.innerHTML = window.renderMarkdown(r.result);
        body.addEventListener('click', (e) => { const a = e.target.closest?.('a[href]'); if (a) { e.preventDefault(); window.browser.newTab(a.href); } });
        details.append(body);
      } else if (!r.error) details.append(h('p', { className: 'task-meta', textContent: T('tasks.detail.noResult') }));
      return h('li', {}, details);
    })));
    return out;
  }

  // ---- the editor (new, from a template, from /routine or a reply, or editing one)
  let card = null;
  async function open({ task = null, prompt = '', schedule = null, template = null, fromComposer = false } = {}) {
    const state = core.state();
    if (!state.settings.enabled) { core.openPanel(null, { tab: 'routines' }); return; }
    card?.remove();
    core.showSidebar();
    const pv = await api.preview({ prompt: task?.prompt || prompt, model: task?.model });
    const overlay = h('div', { className: 'task-create routine-create', role: 'dialog' });
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', task ? T('routines.edit.title') : T('routines.create.title'));
    const box = h('div', { className: 'task-create-card' });
    overlay.append(box);
    const panel = byId('task-panel');
    const close = () => { overlay.remove(); card = null; (fromComposer || panel.hidden ? composerInput : panel.querySelector('button'))?.focus(); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    if (!pv.model) {
      box.append(h('h2', { textContent: T('routines.create.title') }), h('p', { textContent: T('tasks.create.cliOnly') }), h('div', { className: 'approval-actions' }, btn(T('tasks.close'), close, 'btn primary')));
      sidebar.append(overlay);
      card = overlay;
      overlay.querySelector('button').focus();
      return;
    }

    const field = (label, control, stack = true) => h('label', { className: `task-field${stack ? ' stack' : ''}` }, h('span', { textContent: label }), control);
    const name = h('input', { type: 'text', maxLength: 80, value: task?.title || '', placeholder: T('routines.field.name.placeholder') });
    const what = h('textarea', { rows: 3, value: task?.prompt || prompt });
    const start = h('input', { type: 'text', spellcheck: false, value: task?.routine?.startUrl || '', placeholder: 'https://' });
    const sites = h('input', { type: 'text', spellcheck: false, value: task ? task.allowedSites.filter((x, _i, all) => !(x.startsWith('www.') && all.includes(x.slice(4)))).join(', ') : pv.sites.join(', ') });
    let sitesTouched = Boolean(task);
    sites.addEventListener('input', () => { sitesTouched = true; });
    const model = h('select', {}, pv.models.map((m) => h('option', { value: m.id, textContent: window.usageBars ? window.usageBars.annotate(m.group ? `${m.group} · ${m.label}` : m.label, m.id) : (m.group ? `${m.group} · ${m.label}` : m.label), selected: m.id === (task?.model || pv.model), disabled: !m.available })));
    const signedIn = h('input', { type: 'checkbox', checked: Boolean(task?.signedIn) });
    const mcp = h('input', { type: 'checkbox', checked: Boolean(task?.allowMcp) });
    const enabled = h('input', { type: 'checkbox', checked: task ? task.enabled !== false : true });
    const syncMcp = () => { const cli = pv.models.find((m) => m.id === model.value)?.engine !== 'api'; mcp.disabled = cli; if (cli) mcp.checked = false; };
    model.addEventListener('change', syncMcp);

    // When: the repeat, and the fields it needs.
    const s0 = task?.schedule || schedule || { repeat: 'weekdays', time: '08:00' };
    const repeat = h('select', { className: 'routine-repeat' }, REPEATS.map((r) => h('option', { value: r, textContent: T(`routines.repeat.${r}`), selected: r === s0.repeat })));
    const time = h('input', { type: 'time', value: s0.time || '08:00', required: true });
    time.setAttribute('aria-label', T('routines.field.time'));
    const days = h('fieldset', { className: 'routine-days' }, h('legend', { textContent: T('routines.field.days') }),
      DAY_ORDER.map((d) => h('label', { className: 'routine-day', title: dayName(d, 'long') }, h('input', { type: 'checkbox', value: String(d), checked: (s0.days || [1]).includes(d) }), h('span', { textContent: dayName(d) }))));
    const hours = h('input', { type: 'number', min: 1, max: 24, value: s0.hours || 3, className: 'task-minutes' });
    hours.setAttribute('aria-label', T('routines.field.hours'));
    const pad = (x) => String(x).padStart(2, '0');
    const dt = new Date(s0.at || Date.now() + 3600000);
    const when = h('input', { type: 'datetime-local', value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}` });
    when.setAttribute('aria-label', T('routines.repeat.once'));
    const cron = h('input', { type: 'text', spellcheck: false, value: s0.cron || '30 8 * * 1-5', placeholder: '30 8 * * 1-5' });
    cron.setAttribute('aria-label', T('routines.field.cron'));
    const rows = {
      time: h('label', { className: 'task-field' }, h('span', { textContent: T('routines.field.time') }), time),
      days,
      hours: h('label', { className: 'task-field' }, h('span', { textContent: T('routines.field.every') }), hours, h('span', { textContent: T('routines.field.hoursUnit') })),
      once: h('label', { className: 'task-field' }, h('span', { textContent: T('routines.field.at') }), when),
      cron: h('div', {}, h('label', { className: 'task-field' }, h('span', { textContent: T('routines.field.cron') }), cron), h('p', { className: 'task-meta', textContent: T('routines.field.cron.hint') })),
    };
    const next = h('p', { className: 'task-meta routine-next', 'aria-live': 'polite' });
    const getSchedule = () => {
      const r = repeat.value;
      if (r === 'once') return { repeat: r, at: new Date(when.value).getTime() };
      if (r === 'hours') return { repeat: r, hours: Number(hours.value), ...(task?.schedule.repeat === 'hours' && Number(hours.value) === task.schedule.hours ? { anchor: task.schedule.anchor } : {}) };
      if (r === 'cron') return { repeat: r, cron: cron.value };
      return { repeat: r, time: time.value, days: [...days.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
    };
    let previewSeq = 0;
    const updateNext = async () => {
      const seq = ++previewSeq;
      const res = await api.routinePreview({ schedule: getSchedule() });
      if (seq !== previewSeq) return;
      next.classList.toggle('task-error', !res.ok);
      next.textContent = res.ok ? T('routines.next', { times: res.next.map((x) => clock(x)).join(' · ') || '-' }) : res.error;
    };
    const sync = () => {
      const r = repeat.value;
      rows.time.hidden = !['daily', 'weekdays', 'weekly'].includes(r);
      rows.days.hidden = r !== 'weekly';
      rows.hours.hidden = r !== 'hours';
      rows.once.hidden = r !== 'once';
      rows.cron.hidden = r !== 'cron';
      updateNext();
    };
    repeat.addEventListener('change', sync);
    for (const c of [time, hours, when, cron, days]) { c.addEventListener('input', updateNext); c.addEventListener('change', updateNext); }

    // The sites follow the request and the start page until the user edits them.
    let siteTimer = null;
    const followSites = () => {
      clearTimeout(siteTimer);
      siteTimer = setTimeout(async () => {
        if (sitesTouched) return;
        const page = start.value.trim();
        sites.value = (await api.preview({ prompt: `${what.value} ${page}`, pageUrl: '' })).sites.join(', ');
      }, 250);
    };
    what.addEventListener('input', followSites);
    start.addEventListener('input', followSites);

    const applyTemplate = (tp) => {
      name.value = T(`routines.template.${tp.key}.name`);
      what.value = T(`routines.template.${tp.key}.prompt`);
      if (tp.page) start.value = /^https?:/i.test(pv.pageUrl) ? pv.pageUrl : '';
      repeat.value = tp.schedule.repeat;
      time.value = tp.schedule.time || '08:00';
      for (const i of days.querySelectorAll('input')) i.checked = (tp.schedule.days || [1]).includes(Number(i.value));
      sitesTouched = false;
      sync();
      followSites();
      (tp.page && !start.value ? start : what).focus();
    };

    const error = h('p', { className: 'task-error', hidden: true, role: 'alert' });
    const save = btn(task ? T('tasks.edit.save') : T('routines.create.button'), async () => {
      save.disabled = true;
      const res = await api.saveRoutine({
        id: task?.id, title: name.value, prompt: what.value, startUrl: start.value, sites: sitesTouched ? sites.value.split(',').map((x) => x.trim()).filter(Boolean) : undefined, // untouched: worked out from the request and start page
        schedule: getSchedule(), model: model.value, signedIn: signedIn.checked, allowMcp: mcp.checked, enabled: enabled.checked, confirmed: true,
      });
      if (!res.ok) { error.textContent = res.error; error.hidden = false; save.disabled = false; return; }
      if (fromComposer) { composerInput.value = ''; composerInput.dispatchEvent(new Event('input')); }
      core.announce(task ? T('routines.saved') : T('routines.created'));
      fromComposer = false;
      close();
      await core.openPanel(res.id, { tab: 'routines' });
    }, 'btn primary');

    box.append(
      h('h2', { textContent: task ? T('routines.edit.title') : T('routines.create.title') }),
      task ? null : h('div', { className: 'routine-template-row', role: 'group', 'aria-label': T('routines.templates') }, h('span', { className: 'task-meta', textContent: T('routines.templates.start') }),
        TEMPLATES.map((tp) => btn(T(`routines.template.${tp.key}.name`), () => applyTemplate(tp), 'btn routine-template'))),
      field(T('routines.field.name'), name),
      field(T('tasks.create.prompt'), what),
      field(T('routines.field.start'), start),
      h('div', { className: 'task-schedule' }, field(T('routines.field.repeat'), repeat, false), rows.time, rows.days, rows.hours, rows.once, rows.cron, next),
      field(T('tasks.create.sites'), sites),
      h('label', { className: 'task-field' }, model, h('span', { textContent: T('tasks.create.model') })),
      h('label', { className: 'task-check' }, signedIn, T('tasks.create.signedIn')),
      pv.hasMcp ? h('label', { className: 'task-check' }, mcp, T('tasks.create.mcp')) : null,
      task ? h('label', { className: 'task-check' }, enabled, T('routines.field.enabled')) : null,
      h('p', { className: 'task-meta', textContent: `${T('tasks.create.asks')} ${T('routines.create.whileOpen')}` }),
      ...(pv.cli || []).filter((c) => c.state !== 'ready').map((c) => h('p', { className: 'task-meta', textContent: T(`tasks.create.cliNote.${c.state}`, { name: c.name }) })),
      error,
      h('div', { className: 'approval-actions' }, btn(T('tasks.create.cancel'), close), save));
    sidebar.append(overlay);
    card = overlay;
    syncMcp();
    sync();
    if (template) applyTemplate(template);
    else (task ? name : what).focus();
  }

  // ---- /routine [every weekday at 8am:] what to do
  window.slashCommands?.register({
    name: 'routine',
    label: T('routines.slash.label'),
    description: T('routines.slash.description'),
    takesInput: true,
    hint: T('routines.slash.hint'),
    check: () => (core.state().settings.enabled ? null : T('tasks.error.disabled')),
    async run({ input }) {
      const text = String(input || '').trim();
      const parsed = text ? (await api.routinePreview({ text })).parsed : null;
      open(parsed ? { prompt: parsed.prompt, schedule: parsed.schedule } : { prompt: text });
      return { ok: true };
    },
  });

  // ---- "Save as routine" beside Copy on a finished reply: the request that led to it, as a routine.
  const CLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M3 2.5 1.5 4M13 2.5 14.5 4"/></svg>';
  const requestBefore = (bubble) => {
    for (let n = bubble.previousElementSibling; n; n = n.previousElementSibling) if (n.classList?.contains('msg') && n.classList.contains('user')) return n.textContent.trim();
    return '';
  };
  const finishBase = window.finishReply;
  if (typeof finishBase === 'function') {
    window.finishReply = function finishReply(bubble, ...rest) {
      const result = finishBase.call(this, bubble, ...rest);
      if (bubble?.querySelector(':scope > .reply-copy') && !bubble.querySelector(':scope > .reply-routine')) {
        const b = h('button', { type: 'button', className: 'reply-routine', title: T('routines.fromReply') });
        b.setAttribute('aria-label', T('routines.fromReply'));
        b.innerHTML = CLOCK;
        b.onclick = () => { const text = requestBefore(bubble); if (text) open({ prompt: text }); };
        bubble.append(b);
      }
      return result;
    };
  }

  window.lumenRoutines = { list, history, scheduleText, open };
})();

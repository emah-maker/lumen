// The sidebar's Tasks panel: background tasks the AI does on its own (features/background-runner.js).
// A list with status dots, a detail view (steps, result, approval cards), the "Run in the background?"
// confirmation card, the composer's background button and the /background and /watch commands, and the
// toast banner for a finished task. Loaded after chat-core.js and app.js (same page). The panel's Routines
// view, and a routine's editor and history, are renderer/routines.js (window.lumenRoutines).

(() => {
  const api = window.assistant?.tasks;
  if (!api) return;
  const T = (key, vars) => window.t(key, vars);
  const byId = (id) => document.getElementById(id);
  const button = byId('tasks-btn');
  const badge = byId('tasks-badge');
  const panel = byId('task-panel');
  const sendBg = byId('send-bg');
  const composerInput = byId('prompt');
  const sidebar = byId('sidebar');
  const live = byId('task-live');

  let state = { tasks: [], badge: { running: 0, waiting: 0 }, unseen: 0, settings: { enabled: true, maxConcurrent: 2, notifications: true, notifyDone: true, timeoutMin: 30, approvalWaitMin: 60 } };
  let open = null; // task id whose detail is showing, or null for the list
  let view = 'tasks'; // the list's tab: 'tasks' or 'routines'
  let detail = null;
  let previousStatus = new Map();

  const h = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const btn = (text, onclick, cls = 'btn') => h('button', { type: 'button', className: cls, textContent: text, onclick });
  const iconBtn = (svg, label, onclick, cls = 'icon-btn') => { const b = h('button', { type: 'button', className: cls, title: label, onclick }); b.setAttribute('aria-label', label); b.innerHTML = svg; return b; };
  const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';

  const clock = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ago = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
    if (s < 60) return rtf.format(0, 'second');
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    return rtf.format(-Math.round(s / 86400), 'day');
  };
  const statusText = (s) => T(`tasks.status.${s}`);
  const scheduleText = (task) => {
    const s = task.schedule;
    if (task.enabled === false && (s.type === 'every' || s.type === 'watch' || s.type === 'routine')) return T('tasks.schedule.paused');
    if (s.type === 'routine') return window.lumenRoutines?.scheduleText(s) || '';
    if (s.type === 'every') return T('tasks.schedule.every', { n: s.minutes });
    if (s.type === 'watch') return T('tasks.schedule.watch', { n: s.minutes });
    if (s.type === 'at') return T('tasks.schedule.at', { time: clock(s.at) });
    return T('tasks.schedule.now');
  };
  const duration = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return T('tasks.duration.seconds', { n: Math.max(1, Math.round(ms / 1000)) });
    return m < 60 ? T('tasks.duration.minutes', { n: m }) : T('tasks.duration.hours', { n: Math.floor(m / 60), m: m % 60 });
  };
  // Where a queued task stands, as a sentence.
  const queueText = (task) => {
    const q = task.queue;
    if (!q) return '';
    if (q.reason === 'later') return T('tasks.queue.later', { time: clock(q.startsAt) });
    return q.reason === 'next' ? T('tasks.queue.next') : T('tasks.queue.slots', { position: q.position, busy: q.busy, slots: q.slots });
  };
  // The list row's second line: what a running task is doing right now, or why a queued one waits.
  const liveText = (task) => {
    if (task.status === 'running') {
      const time = duration(Date.now() - (task.runningSince || Date.now()));
      return task.currentStep ? T('tasks.list.step', { step: task.currentStep, n: task.stepCount, time }) : T('tasks.list.starting', { time });
    }
    return task.status === 'queued' ? queueText(task) : '';
  };
  const metaText = (task) => [
    statusText(task.status),
    task.status === 'queued' ? queueText(task) : '',
    scheduleText(task),
    task.lastRun ? T('tasks.last', { time: ago(task.lastRun) }) : T('tasks.never'),
    task.nextRun && task.status !== 'running' ? T('tasks.next', { time: clock(task.nextRun) }) : '',
    task.cost,
  ].filter(Boolean).join(' · ');

  // ---- toolbar badge and composer button
  function applyState() {
    const { running, waiting } = state.badge;
    const count = running + waiting;
    badge.textContent = count ? String(count) : '';
    badge.hidden = !count;
    badge.classList.toggle('waiting', waiting > 0);
    button.setAttribute('aria-label', count ? `${T('tasks.button')}: ${T('tasks.button.badge', { running, waiting })}` : T('tasks.button'));
    byId('toggle-sidebar').classList.toggle('has-task-attention', waiting > 0);
    button.classList.toggle('has-unseen', !count && state.unseen > 0); // finished while you were elsewhere
    if (!count && state.unseen > 0) button.setAttribute('aria-label', `${T('tasks.button')}: ${T('tasks.button.unseen', { count: state.unseen })}`);
    const enabled = state.settings.enabled;
    sendBg.hidden = !enabled;
    for (const task of state.tasks) {
      const before = previousStatus.get(task.id);
      if (before && before !== task.status && ['done', 'failed', 'waiting-approval', 'interrupted'].includes(task.status)) live.textContent = `${task.title}: ${statusText(task.status)}`;
      previousStatus.set(task.id, task.status);
    }
    updateSendBg();
  }
  // A background task is saved as words: it can't carry the images attached to the message, so the button waits
  // (and says why) rather than running the task without them.
  const attachedImages = () => window.chatAttachments?.count() || 0;
  function updateSendBg() {
    const images = attachedImages() > 0;
    sendBg.disabled = !composerInput.value.trim() || images;
    sendBg.title = images ? T('tasks.composer.noImages') : T('tasks.composer.run');
  }
  document.addEventListener('lumen:attachments', updateSendBg);

  async function refresh() {
    state = await api.state();
    applyState();
    if (!panel.hidden) await render();
  }

  // ---- the panel
  function showSidebar() {
    if (document.body.classList.contains('sidebar-hidden')) byId('toggle-sidebar').click();
  }
  async function openPanel(id = null, { tab } = {}) {
    showSidebar();
    open = id;
    if (tab) view = tab;
    await refresh();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    await render();
    (panel.querySelector('.task-row, .task-back, .task-close'))?.focus();
  }
  function closePanel(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    open = null;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    if (refocus) button.focus();
  }

  async function render() {
    if (open) {
      const fresh = await api.get(open);
      if (!fresh) { open = null; return render(); }
      // Updates arrive with every step: don't wipe a schedule being edited, and keep the scroll place.
      if (panel.querySelector('.task-edit') && detail?.id === fresh.id) return undefined;
      const scroll = panel.querySelector('.task-scroll')?.scrollTop || 0;
      detail = fresh;
      renderDetail();
      panel.querySelector('.task-scroll').scrollTop = scroll;
      return undefined;
    }
    detail = null;
    renderList();
    return undefined;
  }

  function head(title, left) {
    const close = iconBtn(CLOSE, T('tasks.close'), () => closePanel(true), 'icon-btn task-close');
    return h('div', { className: 'chat-list-head task-head' }, left || null, h('h2', { textContent: title }), close);
  }

  function renderList() {
    const rows = state.tasks.map((task) => {
      const live = liveText(task);
      const row = h('button', { type: 'button', className: `task-row${task.unseen ? ' unseen' : ''}`, onclick: () => { open = task.id; render(); } },
        h('span', { className: `task-dot ${task.status}`, 'aria-hidden': 'true' }),
        h('span', { className: 'task-text' },
          h('span', { className: 'task-title', textContent: task.title }),
          h('span', { className: 'task-meta', textContent: metaText(task) }),
          live && task.status === 'running' ? h('span', { className: 'task-live', textContent: live }) : null,
          task.pending.length ? h('span', { className: 'task-needs', textContent: T('tasks.detail.approvals') }) : null),
        task.unseen ? h('span', { className: 'task-new', textContent: T('tasks.list.new') }) : null);
      return h('li', {}, row);
    });
    const list = h('ul', { className: 'chat-items task-items' }, rows);
    if (view === 'routines' && window.lumenRoutines) { panel.replaceChildren(head(T('tasks.title')), tabs(), ...window.lumenRoutines.list(state)); return; }
    const body = [head(T('tasks.title')), tabs(), h('p', { className: 'task-note', textContent: state.settings.enabled ? T('tasks.note') : T('tasks.disabled') })];
    // What is waiting for the user comes first, with the same card as in the task's page, so it can be answered from here.
    const waiting = state.tasks.filter((t) => t.pending.length);
    if (waiting.length) {
      body.push(h('section', { className: 'task-needs-you', 'aria-label': T('tasks.list.needsYou') },
        h('h3', { textContent: T('tasks.list.needsYou') }),
        waiting.map((t) => h('div', { className: 'task-needs-item' }, h('button', { type: 'button', className: 'task-link', textContent: t.title, onclick: () => { open = t.id; render(); } }), t.pending.map((p) => approvalCard(t, p))))));
    }
    if (state.tasks.length) body.push(list);
    else body.push(h('p', { className: 'chat-list-empty', textContent: T('tasks.empty') }));
    body.push(settingsBlock());
    panel.replaceChildren(...body);
  }

  // Tasks | Routines: a tab list (arrow keys move between the two).
  function tabs() {
    if (!window.lumenRoutines) return null;
    const list = h('div', { className: 'task-tabs', role: 'tablist' });
    list.setAttribute('aria-label', T('tasks.title'));
    const tab = (key, label) => {
      const b = h('button', { type: 'button', className: 'task-tab', id: `task-tab-${key}`, textContent: label, tabIndex: view === key ? 0 : -1, onclick: () => { view = key; render().then(() => byId(`task-tab-${key}`)?.focus()); } });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(view === key));
      return b;
    };
    list.append(tab('tasks', T('tasks.tab.tasks')), tab('routines', T('routines.title')));
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      list.querySelector('[aria-selected="false"]')?.click();
    });
    return list;
  }

  function settingsBlock() {
    const s = state.settings;
    const set = (patch) => api.settings(patch).then(refresh);
    const check = (label, on, key) => h('label', { className: 'task-check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => set({ [key]: e.target.checked }) }), label);
    const max = h('select', { 'aria-label': T('tasks.settings.max'), onchange: (e) => set({ maxConcurrent: Number(e.target.value) }) }, [1, 2, 3].map((n) => h('option', { value: n, textContent: String(n), selected: n === s.maxConcurrent })));
    const timeout = h('select', { 'aria-label': T('tasks.settings.timeout'), onchange: (e) => set({ timeoutMin: Number(e.target.value) }) }, [10, 30, 60, 120].map((n) => h('option', { value: n, textContent: T('tasks.settings.timeout.n', { n }), selected: n === s.timeoutMin })));
    const wait = h('select', { 'aria-label': T('tasks.settings.approvalWait'), onchange: (e) => set({ approvalWaitMin: Number(e.target.value) }) }, [15, 60, 240].map((n) => h('option', { value: n, textContent: n >= 60 ? T('tasks.settings.approvalWait.h', { n: n / 60 }) : T('tasks.settings.approvalWait.n', { n }), selected: n === s.approvalWaitMin })));
    return h('details', { className: 'task-settings' },
      h('summary', { textContent: T('tasks.settings') }),
      check(T('tasks.settings.enabled'), s.enabled, 'enabled'),
      h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.settings.max') }), max),
      h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.settings.timeout') }), timeout),
      h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.settings.approvalWait') }), wait),
      check(T('tasks.settings.notify'), s.notifications, 'notifications'),
      check(T('tasks.settings.notifyDone'), s.notifyDone, 'notifyDone'));
  }

  // ---- one task
  function approvalCard(task, p) {
    const card = h('div', { className: 'approval task-approval', tabIndex: 0 });
    card.setAttribute('role', 'group');
    const title = p.title || T('tasks.detail.approvals');
    card.setAttribute('aria-label', title);
    const answer = (choice) => { for (const b of card.querySelectorAll('button')) b.disabled = true; api.approve(task.id, p.approvalId, choice).then(refresh); };
    const siteOk = ['interact', 'open', 'script'].includes(p.action) && p.host;
    card.append(h('p', { className: 'approval-title', textContent: title }));
    if (p.host && p.action !== 'tool') card.append(h('p', { className: 'approval-detail', textContent: p.host }));
    if (p.query !== undefined && p.query !== null) card.append(h('p', { className: 'approval-detail', textContent: `“${p.query}”` }));
    if (p.args) card.append(h('pre', { className: 'approval-args', textContent: p.args }));
    card.append(h('div', { className: 'approval-actions task-approval-actions' },
      btn(T('tasks.approval.stop'), () => api.stop(task.id).then(refresh)),
      btn(T('tasks.approval.deny'), () => answer('deny')),
      siteOk ? btn(T('tasks.approval.site'), () => answer('site')) : null,
      btn(T('tasks.approval.once'), () => answer('once'), 'btn primary')));
    return card;
  }

  function renderDetail() {
    const task = detail;
    const active = ['running', 'waiting-approval', 'queued'].includes(task.status);
    const back = iconBtn(BACK, T('tasks.back'), () => { open = null; render(); }, 'icon-btn task-back');
    const actions = h('div', { className: 'task-actions' });
    if (active) actions.append(btn(T('tasks.act.stop'), () => api.stop(task.id).then(refresh)));
    // Interrupted (or failed part-way): Resume goes on from what it did, Retry starts over.
    if (task.resumable && !active) {
      const resume = btn(T('tasks.act.resumeRun'), () => api.run(task.id, { resume: true }).then(refresh), 'btn primary');
      resume.title = T('tasks.act.resumeRun.hint');
      actions.append(resume);
    }
    if (!active || task.status === 'queued') actions.append(btn(task.status === 'done' ? T('tasks.act.run') : (['failed', 'interrupted', 'stopped'].includes(task.status) ? T('tasks.act.retry') : T('tasks.act.run')), () => api.run(task.id).then(refresh), task.resumable ? 'btn' : 'btn primary'));
    const routine = task.schedule.type === 'routine' && window.lumenRoutines;
    if (routine && !active) actions.append(btn(T('routines.act.edit'), () => window.lumenRoutines.open({ task })));
    if (!active && !routine) actions.append(btn(T('tasks.act.edit'), () => editTask(task)));
    if (task.schedule.type === 'every' || task.schedule.type === 'watch' || task.schedule.type === 'routine') actions.append(btn(task.enabled === false ? T('tasks.act.resume') : T('tasks.act.pause'), () => api.enable(task.id, task.enabled === false).then(refresh)));
    if (!routine) actions.append(btn(T('tasks.act.schedule'), () => editSchedule(task)));
    if (task.currentUrl) actions.append(btn(T('tasks.act.openPage'), () => api.openPage(task.id)));
    if (task.result) {
      actions.append(btn(T('tasks.act.continue'), () => continueInChat(task)));
      const copy = btn(T('tasks.act.copy'), async () => { try { await navigator.clipboard.writeText(detail.result); copy.textContent = T('tasks.act.copied'); setTimeout(() => { copy.textContent = T('tasks.act.copy'); }, 1500); } catch {} });
      actions.append(copy);
    }
    let armed = false;
    const del = btn(T('tasks.act.delete'), () => {
      if (!armed) { armed = true; del.textContent = T('tasks.act.deleteSure'); del.classList.add('armed'); setTimeout(() => { armed = false; del.textContent = T('tasks.act.delete'); del.classList.remove('armed'); }, 3000); return; }
      api.remove(task.id).then(() => { open = null; refresh(); });
    }, 'btn danger');
    actions.append(del);

    const body = h('div', { className: 'task-detail' },
      h('p', { className: 'task-status' }, h('span', { className: `task-dot ${task.status}`, 'aria-hidden': 'true' }), h('span', { textContent: metaText(task) })),
      task.status === 'running' && liveText(task) ? h('p', { className: 'task-live', textContent: liveText(task) }) : null,
      task.error ? h('p', { className: 'task-error', textContent: task.error }) : null,
      task.notice ? h('p', { className: 'task-notice', textContent: task.notice }) : null,
      task.watching ? h('p', { className: 'task-meta', textContent: [task.watching.checkedAt ? T('tasks.watch.checked', { time: ago(task.watching.checkedAt) }) : T('tasks.watch.none'), task.watching.holding ? T('tasks.watch.holding') : ''].filter(Boolean).join(' · ') }) : null,
      task.pending.map((p) => approvalCard(task, p)),
      actions,
      task.engine && task.engine !== 'api' ? h('p', { className: 'task-meta', textContent: T('tasks.detail.engine', { engine: task.engine === 'grokbuild' ? 'Grok Build' : 'Claude Code' }) }) : null,
      h('h3', { textContent: T('tasks.detail.prompt') }), h('p', { className: 'task-prompt', textContent: task.prompt }),
      task.routine?.startUrl ? h('p', { className: 'task-meta', textContent: T('routines.detail.start', { url: task.routine.startUrl }) }) : null,
      h('p', { className: 'task-meta', textContent: T('tasks.create.mayVisit', { sites: task.allowedSites.join(', ') || '-' }) }));

    body.append(h('h3', { textContent: T('tasks.detail.result') }));
    if (task.result && task.resultOld) body.append(h('p', { className: 'task-notice', textContent: T('tasks.detail.resultOld') }));
    if (task.result) {
      const result = h('div', { className: 'msg assistant task-result' });
      result.innerHTML = window.renderMarkdown(task.result);
      result.addEventListener('click', (e) => { const a = e.target.closest?.('a[href]'); if (a) { e.preventDefault(); window.browser.newTab(a.href); } });
      body.append(result);
    } else body.append(h('p', { className: 'task-meta', textContent: T('tasks.detail.noResult') }));

    // Where the task went, as links that open in tabs of the user's own.
    if (task.pages?.length) {
      body.append(h('h3', { textContent: T('tasks.detail.pages') }));
      body.append(h('ul', { className: 'task-pages' }, task.pages.map((u) => h('li', {}, h('a', { href: u, textContent: u.replace(/^https?:\/\//, ''), title: u, onclick: (e) => { e.preventDefault(); window.browser.newTab(u); } })))));
    }
    if (task.steps.length) {
      body.append(h('h3', { textContent: T('tasks.detail.steps') }));
      if (task.stepCount > task.steps.length) body.append(h('p', { className: 'task-meta', textContent: T('tasks.detail.steps.more', { count: task.stepCount - task.steps.length }) }));
      body.append(h('ol', { className: 'task-steps' }, task.steps.map((s) => h('li', { className: s.ok === false ? 'failed' : s.ok ? 'ok' : 'pending', textContent: s.error ? `${s.label}: ${s.error}` : s.label }))));
    }
    if (routine) body.append(...window.lumenRoutines.history(task));
    else if (task.runs.length) {
      body.append(h('h3', { textContent: T('tasks.detail.runs') }));
      body.append(h('ul', { className: 'task-runs' }, [...task.runs].reverse().map((r) => h('li', {}, h('span', { className: `task-dot ${r.status}`, 'aria-hidden': 'true' }), `${clock(r.endedAt || r.startedAt)} · ${statusText(r.status)}${r.summary ? ` · ${r.summary.slice(0, 90)}` : ''}`))));
    }
    panel.replaceChildren(head(task.title, back), h('div', { className: 'task-scroll' }, body));
  }

  // Edit and run again: change the request (or, for a watch, only the name and sites) and save, or save and run.
  function editTask(task) {
    const isWatch = task.schedule.type === 'watch';
    const title = h('input', { type: 'text', value: task.title, maxLength: 80 });
    title.setAttribute('aria-label', T('tasks.edit.title'));
    const prompt = h('textarea', { rows: 4, value: task.prompt });
    prompt.setAttribute('aria-label', T('tasks.edit.prompt'));
    const sites = h('input', { type: 'text', value: task.allowedSites.filter((x, _i, all) => !(x.startsWith('www.') && all.includes(x.slice(4)))).join(', '), spellcheck: false });
    sites.setAttribute('aria-label', T('tasks.edit.sites'));
    const error = h('p', { className: 'task-error', hidden: true });
    const save = async (andRun) => {
      const patch = { title: title.value, sites: sites.value.split(',').map((x) => x.trim()).filter(Boolean) };
      if (!isWatch) patch.prompt = prompt.value;
      const res = await api.edit(task.id, patch, { run: andRun });
      if (!res.ok) { error.textContent = res.error; error.hidden = false; return; }
      await refresh();
    };
    const card = h('div', { className: 'task-edit' },
      h('label', { className: 'task-field stack' }, h('span', { textContent: T('tasks.edit.title') }), title),
      isWatch ? null : h('label', { className: 'task-field stack' }, h('span', { textContent: T('tasks.edit.prompt') }), prompt),
      h('label', { className: 'task-field stack' }, h('span', { textContent: T('tasks.edit.sites') }), sites),
      error,
      h('div', { className: 'approval-actions' }, btn(T('tasks.create.cancel'), () => card.remove()), btn(T('tasks.edit.save'), () => save(false)), btn(T('tasks.edit.saveRun'), () => save(true), 'btn primary')));
    panel.querySelector('.task-detail').prepend(card);
    (isWatch ? title : prompt).focus();
  }

  // "Continue in chat": a fresh chat with the result in the message box, ready to send.
  function continueInChat(task) {
    byId('new-chat').click();
    composerInput.value = `${T('tasks.title')}: “${task.title}”\n\n${task.result}\n\n`;
    composerInput.dispatchEvent(new Event('input'));
    closePanel(false);
    composerInput.focus();
  }

  // ---- schedule fields (the confirmation card and Edit schedule)
  function scheduleFields(initial = { type: 'now' }, { allowWatch = true } = {}) {
    const type = h('select', { 'aria-label': T('tasks.create.when') },
      h('option', { value: 'now', textContent: T('tasks.create.now') }),
      h('option', { value: 'at', textContent: T('tasks.create.at') }),
      h('option', { value: 'every', textContent: T('tasks.create.every') }),
      allowWatch ? h('option', { value: 'watch', textContent: T('tasks.create.watch') }) : null);
    type.value = initial.type;
    const pad = (n) => String(n).padStart(2, '0');
    const dt = new Date(initial.at || Date.now() + 3600000);
    const at = h('input', { type: 'datetime-local', value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}` });
    at.setAttribute('aria-label', T('tasks.create.at'));
    const minutes = h('input', { type: 'number', min: 1, max: 10080, value: initial.minutes || 60, className: 'task-minutes' });
    minutes.setAttribute('aria-label', T('tasks.create.minutes'));
    const url = h('input', { type: 'text', value: initial.url || '', spellcheck: false });
    url.setAttribute('aria-label', T('tasks.create.url'));
    const condition = h('input', { type: 'text', value: initial.condition || '', placeholder: T('tasks.create.condition.placeholder') });
    condition.setAttribute('aria-label', T('tasks.create.condition'));
    const rows = {
      at: h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.at') }), at),
      every: h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.every') }), minutes, h('span', { textContent: T('tasks.create.minutes') })),
      watch: h('div', {},
        h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.url') }), url),
        h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.condition') }), condition),
        h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.every') }), h('input', { type: 'number', min: 1, max: 1440, value: initial.minutes || 15, className: 'task-minutes watch-minutes' }), h('span', { textContent: T('tasks.create.minutes') }))),
    };
    const node = h('div', { className: 'task-schedule' }, h('label', { className: 'task-field' }, h('span', { textContent: T('tasks.create.when') }), type), rows.at, rows.every, rows.watch);
    const sync = () => { for (const [k, row] of Object.entries(rows)) row.hidden = type.value !== k; };
    type.onchange = sync;
    sync();
    const get = () => {
      if (type.value === 'at') return { type: 'at', at: new Date(at.value).getTime() };
      if (type.value === 'every') return { type: 'every', minutes: Number(minutes.value) };
      if (type.value === 'watch') return { type: 'watch', url: url.value.trim(), condition: condition.value.trim(), minutes: Number(rows.watch.querySelector('.watch-minutes').value) };
      return { type: 'now' };
    };
    return { node, get, type, url };
  }

  function editSchedule(task) {
    const initial = { ...task.schedule };
    const fields = scheduleFields(initial);
    const error = h('p', { className: 'task-error', hidden: true });
    const card = h('div', { className: 'task-edit' }, fields.node, error,
      h('div', { className: 'approval-actions' }, btn(T('tasks.create.cancel'), () => card.remove()), btn(T('tasks.schedule.save'), async () => {
        const res = await api.schedule(task.id, fields.get());
        if (!res.ok) { error.textContent = res.error; error.hidden = false; return; }
        await refresh();
      }, 'btn primary')));
    panel.querySelector('.task-detail').prepend(card);
  }

  // ---- the "Run in the background?" card
  let creating = null;
  async function openCreate(spec = {}) {
    if (!state.settings.enabled) return;
    creating?.remove();
    showSidebar();
    const watch = spec.watchUrl !== undefined; // /watch with no address watches the page in front
    const pv = await api.preview({ prompt: spec.prompt || '', pageUrl: spec.watchUrl || '' });
    const overlay = h('div', { className: 'task-create', role: 'dialog' });
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', T('tasks.create.title'));
    const card = h('div', { className: 'task-create-card' });
    overlay.append(card);
    const error = h('p', { className: 'task-error', hidden: true });
    const close = () => { overlay.remove(); creating = null; composerInput.focus(); };
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    if (!pv.model) {
      card.append(h('h2', { textContent: T('tasks.create.title') }), h('p', { textContent: T('tasks.create.cliOnly') }), h('div', { className: 'approval-actions' }, btn(T('tasks.close'), close, 'btn primary')));
      sidebar.append(overlay);
      creating = overlay;
      overlay.querySelector('button').focus();
      return;
    }

    const prompt = h('textarea', { rows: 3, value: spec.prompt || '' });
    prompt.setAttribute('aria-label', T('tasks.create.prompt'));
    const fields = scheduleFields(watch ? { type: 'watch', url: spec.watchUrl || pv.pageUrl, condition: spec.condition || '', minutes: 15 } : (spec.schedule || { type: 'now' }));
    const sites = h('input', { type: 'text', value: pv.sites.join(', '), spellcheck: false });
    sites.setAttribute('aria-label', T('tasks.create.sites'));
    let sitesTouched = false;
    sites.addEventListener('input', () => { sitesTouched = true; summarize(); });
    const model = h('select', { 'aria-label': T('tasks.create.model') }, pv.models.map((m) => h('option', { value: m.id, textContent: window.usageBars ? window.usageBars.annotate(m.group ? `${m.group} · ${m.label}` : m.label, m.id) : (m.group ? `${m.group} · ${m.label}` : m.label), selected: m.id === pv.model, disabled: !m.available })));
    const signedIn = h('input', { type: 'checkbox' });
    const mcp = h('input', { type: 'checkbox' });
    // A Claude Code / Grok Build task has Lumen's browser tools only: the user's MCP tools are for API models.
    const mcpLabel = h('label', { className: 'task-check' }, mcp, T('tasks.create.mcp'));
    const syncMcp = () => { const cli = pv.models.find((m) => m.id === model.value)?.engine !== 'api'; mcp.disabled = cli; if (cli) mcp.checked = false; mcpLabel.title = cli ? T('tasks.create.mcp.cli') : ''; };
    const summary = h('p', { className: 'task-summary', 'aria-live': 'polite' });
    const siteList = () => sites.value.split(',').map((s) => s.trim()).filter(Boolean);
    const modelLabel = () => model.selectedOptions[0]?.textContent.replace(/^.*· /, '') || pv.label;
    const summarize = () => {
      const what = fields.type.value === 'watch' ? `${fields.url.value || pv.pageUrl}` : prompt.value.trim();
      const list = siteList();
      summary.textContent = [T('tasks.create.summary', { model: modelLabel(), prompt: what }), list.length ? T('tasks.create.mayVisit', { sites: list.join(', ') }) : T('tasks.create.noSites'), T('tasks.create.asks')].join('\n');
    };
    let timer = null;
    prompt.addEventListener('input', () => {
      summarize();
      clearTimeout(timer);
      timer = setTimeout(async () => { if (!sitesTouched) { sites.value = (await api.preview({ prompt: prompt.value, pageUrl: pv.pageUrl })).sites.join(', '); summarize(); } }, 250);
    });
    model.addEventListener('change', () => { syncMcp(); summarize(); });
    fields.node.addEventListener('input', summarize);
    fields.node.addEventListener('change', summarize);

    const create = btn(T('tasks.create.button'), async () => {
      create.disabled = true;
      const res = await api.create({ prompt: prompt.value, schedule: fields.get(), sites: siteList(), model: model.value, signedIn: signedIn.checked, allowMcp: mcp.checked, confirmed: true, pageUrl: pv.pageUrl });
      if (!res.ok) { error.textContent = res.error; error.hidden = false; create.disabled = false; return; }
      if (spec.fromComposer) { composerInput.value = ''; composerInput.dispatchEvent(new Event('input')); }
      live.textContent = T('tasks.created');
      close();
      await refresh();
      await openPanel(res.id);
    }, 'btn primary');
    card.append(
      h('h2', { textContent: T('tasks.create.title') }),
      summary,
      watch ? null : h('label', { className: 'task-field stack' }, h('span', { textContent: T('tasks.create.prompt') }), prompt),
      fields.node,
      h('label', { className: 'task-field stack' }, h('span', { textContent: T('tasks.create.sites') }), sites),
      h('label', { className: 'task-field' }, model, h('span', { textContent: T('tasks.create.model') })),
      h('label', { className: 'task-check' }, signedIn, T('tasks.create.signedIn')),
      pv.hasMcp ? mcpLabel : null,
      ...(pv.cli || []).filter((c) => c.state !== 'ready').map((c) => h('p', { className: 'task-meta', textContent: T(`tasks.create.cliNote.${c.state}`, { name: c.name }) })),
      error,
      window.lumenRoutines && !watch ? btn(T('routines.fromTask'), () => { const text = prompt.value; close(); window.lumenRoutines.open({ prompt: text, fromComposer: spec.fromComposer }); }, 'btn task-routine-link') : null,
      h('div', { className: 'approval-actions' }, btn(T('tasks.create.cancel'), close), create));
    sidebar.append(overlay);
    creating = overlay;
    syncMcp();
    summarize();
    (watch ? fields.url : prompt).focus();
  }

  // ---- toast banner (the page view covers most of the window, so this sits in the sidebar)
  let toastTimer = null;
  function toast({ id, kind, text }) {
    if (!state.settings.notifications || !panel.hidden) return; // the open panel shows the change itself (and the live region says it)
    byId('task-toast')?.remove();
    const node = h('div', { id: 'task-toast', className: `task-toast ${kind}`, role: 'status' }, h('span', { textContent: text }), btn(T('tasks.toast.open'), () => { node.remove(); openPanel(id); }), iconBtn(CLOSE, T('tasks.close'), () => node.remove()));
    sidebar.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 9000);
  }

  // ---- entry points
  sendBg.onclick = () => openCreate({ prompt: composerInput.value.trim(), fromComposer: true });
  composerInput.addEventListener('input', updateSendBg);
  // /background <request> and /watch <address> <what to watch for>: caught before the chat sends them.
  byId('composer').addEventListener('submit', (e) => {
    const text = composerInput.value.trim();
    const bgCmd = /^\/background\s+([\s\S]+)/i.exec(text);
    const watchCmd = /^\/watch(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i.exec(text);
    if (!bgCmd && !watchCmd) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!state.settings.enabled) return;
    if (bgCmd && attachedImages() > 0) { window.chatAttachments?.note([T('tasks.composer.noImages')]); return; } // (the request and the images stay in the box)
    composerInput.value = '';
    composerInput.dispatchEvent(new Event('input'));
    if (bgCmd) openCreate({ prompt: bgCmd[1].trim() });
    else openCreate({ watchUrl: /^[a-z][a-z0-9+.-]*:\/\//i.test(watchCmd[1] || '') ? watchCmd[1] : (watchCmd[1] ? `https://${watchCmd[1]}` : ''), condition: (watchCmd[2] || '').trim() });
  }, true);

  button.onclick = () => (panel.hidden ? openPanel() : closePanel(true));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !creating) { e.preventDefault(); if (open) { open = null; render(); } else closePanel(true); } });
  // Elapsed times tick while a task runs (the state itself only changes on a step).
  setInterval(() => { if (!panel.hidden && !panel.querySelector('.task-edit') && state.tasks.some((t) => t.status === 'running')) render(); }, 20000);
  api.onState((s) => { state = s; applyState(); if (!panel.hidden) render(); });
  api.onToast(toast);
  api.onOpen(({ id } = {}) => openPanel(id || null));
  api.onPropose((spec) => openCreate(spec || {}));
  // What renderer/routines.js builds the Routines view with (same page, loaded after this file).
  window.lumenTasks = {
    api, h, btn, iconBtn, clock, ago, statusText, showSidebar, refresh, closePanel,
    state: () => state,
    openPanel,
    openTask: (id) => { open = id; return render(); },
    announce: (text) => { live.textContent = text; },
  };
  refresh();
})();

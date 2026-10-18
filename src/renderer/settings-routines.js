// Settings → AI → Routines: every routine in one list (switch, schedule in words, next and last run, Edit, Run now, Stop, Delete, run
// history), the one-click templates, and quiet hours. features/background-runner.js is the backend (settings:routines and
// settings:routines-act, answered to the Settings tab only); the full editor lives in the sidebar, so Edit and New Routine open it there.
// Loaded before settings.js and built only when the page is first shown (settings.js's builder table). Everything shown is set with
// textContent; a routine's result is text, never markup. It uses that file's h(), row(), stackRow(), armedButton(), flash() and tr().
// The pure helpers (scheduleText, rowModel…) are in the first block so test/settings-routines-units.js can load them in plain Node.

(function (root) {
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const ACTIVE = ['queued', 'running', 'waiting-approval'];
  const dayName = (d) => new Intl.DateTimeFormat([], { weekday: 'short' }).format(new Date(2026, 0, 4 + d)); // 4 January 2026 is a Sunday
  const timeText = (hhmm) => { const [hh, mm] = String(hhmm || '08:00').split(':').map(Number); return new Date(2026, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const clock = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // "Weekdays at 8:00 AM", "Every 3 hours", "Mon, Thu at 9:15 AM" (the same wording as the sidebar's Routines tab)
  function scheduleText(s, T) {
    if (!s || s.type !== 'routine') return '';
    if (s.repeat === 'once') return T('routines.schedule.once', { time: clock(s.at) });
    if (s.repeat === 'hours') return s.hours === 1 ? T('routines.schedule.hour') : T('routines.schedule.hours', { n: s.hours });
    if (s.repeat === 'cron') return T('routines.schedule.cron', { cron: s.cron });
    const time = timeText(s.time);
    if (s.repeat === 'daily') return T('routines.schedule.daily', { time });
    if (s.repeat === 'weekdays') return T('routines.schedule.weekdays', { time });
    return T('routines.schedule.weekly', { days: DAY_ORDER.filter((d) => (s.days || []).includes(d)).map(dayName).join(', '), time });
  }

  // What a row shows, from one routine of the settings:routines answer. T is the page's translator: (key, vars) -> text.
  function rowModel(r, T) {
    const active = ACTIVE.includes(r.status);
    const last = r.last;
    const late = Boolean(last && last.trigger === 'catch-up');
    let lastText = T('tasks.never');
    if (active) lastText = T(`tasks.status.${r.status}`);
    else if (last) {
      const word = T(`routines.history.status.${last.status}`);
      lastText = T('settings.routines.last', { time: clock(last.at), status: word }) + (late ? ` (${T('routines.trigger.catch-up')})` : '');
    }
    return {
      title: r.title,
      schedule: scheduleText(r.schedule, T),
      next: !r.enabled ? T('settings.routines.off') : (r.nextRun ? T('settings.routines.next', { time: clock(r.nextRun) }) : ''),
      last: lastText,
      late,
      snippet: !active && last ? (last.error || last.snippet || '') : '',
      failed: !active && Boolean(last && (last.status === 'failed' || last.error)),
      needsOk: r.pending > 0,
      active,
      canStop: r.status === 'running' || r.status === 'waiting-approval' || r.status === 'queued',
      hasResult: (r.runs || 0) > 0,
    };
  }

  // One history entry: "Oct 18, 8:00 AM · Done · on schedule", with "was due …" for a late run.
  function historyLine(e, T) {
    return [clock(e.startedAt || e.at), T(`routines.history.status.${e.status}`), T(`routines.trigger.${e.trigger}`),
      e.trigger === 'catch-up' && e.scheduledFor ? T('routines.history.dueAt', { time: clock(e.scheduledFor) }) : ''].filter(Boolean).join(' · ');
  }

  // A template's state: its text and whether it can be added again.
  function templateModel(tp, view, T) {
    const have = (view.routines || []).some((r) => r.template === tp.key);
    const ready = tp.connector ? (view.connected || []).includes(tp.connector) : null;
    const app = tp.connector ? T(`routines.connector.${tp.connector}`) : '';
    return { have, ready, connectorText: ready === null ? '' : T(ready ? 'routines.template.ready' : 'routines.template.needs', { app }) };
  }

  const api = { scheduleText, rowModel, historyLine, templateModel, clock, timeText, dayName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.settingsRoutinesText = api;
})(typeof window !== 'undefined' ? window : globalThis);

async function buildRoutines(card) {
  const R = window.lumenSettings.routines;
  const X = window.settingsRoutinesText;
  const T = (key, vars) => tr(key, key, vars);
  const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const status = h('p', { class: 'note', id: 'routines-status', role: 'status', 'aria-live': 'polite' });
  const offline = h('p', { class: 'note error rt-offline', id: 'routines-offline', role: 'status', hidden: true });
  const disabledNote = h('p', { class: 'note error rt-disabled', id: 'routines-disabled', hidden: true });
  const list = h('div', { class: 'rt-list', id: 'routines-list' });
  const tplBox = h('div', { class: 'rt-templates', id: 'routines-templates' });
  const newBtn = h('button', { type: 'button', class: 'primary', id: 'routines-new', text: T('routines.new'), onclick: () => act({ act: 'new' }) });
  const quietOn = h('input', { type: 'checkbox', class: 'switch', id: 'routines-quiet-on', role: 'switch', 'aria-label': T('routines.quiet.on'), onchange: () => saveQuiet() });
  const quietFrom = h('input', { type: 'time', id: 'routines-quiet-from', 'aria-label': T('routines.quiet.from'), onchange: () => saveQuiet() });
  const quietTo = h('input', { type: 'time', id: 'routines-quiet-to', 'aria-label': T('routines.quiet.to'), onchange: () => saveQuiet() });
  const openHistory = new Set(); // routines whose History is open: kept across a redraw
  let view = null;
  let shown = ''; // what was drawn last (a read that changed nothing redraws nothing, so focus and open rows stay put)

  async function act(req, { say } = {}) {
    let next;
    try { next = await R.act(req); } catch (err) { flash(status, clean(err), 'error'); return; }
    paint(next);
    if (next.ok === false) flash(status, next.error || T('settings.routines.failed'), 'error');
    else if (say) flash(status, say, 'ok');
    else flash(status, '', '');
  }
  async function saveQuiet() {
    if (!quietFrom.value || !quietTo.value) return; // a cleared time field is not a time
    await act({ act: 'settings', patch: { quiet: { on: quietOn.checked, from: quietFrom.value, to: quietTo.value } } });
  }

  function rowFor(r) {
    const m = X.rowModel(r, T);
    const name = r.title;
    const toggle = h('input', { type: 'checkbox', class: 'switch routine-toggle', id: `routine-enable-${r.id}`, role: 'switch', checked: r.enabled, 'aria-label': T('routines.enabled.for', { name }), onchange: (e) => act({ act: 'enable', id: r.id, on: e.target.checked }) });
    const edit = h('button', { type: 'button', class: 'rt-edit', text: T('settings.routines.edit'), 'aria-label': T('settings.routines.edit.for', { name }), 'data-focus': `edit-${r.id}`, onclick: () => act({ act: 'edit', id: r.id }) });
    const open = m.hasResult ? h('button', { type: 'button', class: 'rt-open', text: T('settings.routines.open'), 'aria-label': T('settings.routines.open.for', { name }), 'data-focus': `open-${r.id}`, onclick: () => act({ act: 'open', id: r.id }) }) : null;
    const run = h('button', { type: 'button', class: 'rt-run', text: T('tasks.act.run'), 'aria-label': T('routines.run.for', { name }), 'data-focus': `run-${r.id}`, disabled: m.active || !view.enabled, onclick: () => act({ act: 'run', id: r.id }) });
    const stop = m.canStop ? h('button', { type: 'button', class: 'rt-stop', text: T('tasks.act.stop'), 'aria-label': T('settings.routines.stop.for', { name }), 'data-focus': `stop-${r.id}`, onclick: () => act({ act: 'stop', id: r.id }) }) : null;
    const del = armedButton(T('tasks.act.delete'), T('tasks.act.deleteSure'), () => act({ act: 'delete', id: r.id }), 'danger rt-delete');
    del.button.setAttribute('aria-label', T('settings.routines.delete.for', { name }));
    del.button.dataset.focus = `delete-${r.id}`;

    const meta = h('div', { class: 'rt-meta' },
      h('span', { class: 'rt-schedule', text: m.schedule }),
      m.next ? h('span', { class: `rt-next${r.enabled ? '' : ' rt-off'}`, text: m.next }) : null,
      h('span', { class: `rt-last${m.late ? ' late' : ''}`, text: m.last }),
      m.needsOk ? h('span', { class: 'rt-needs', text: T('tasks.detail.approvals') }) : null);
    const snippet = m.snippet ? h('p', { class: `rt-snippet${m.failed ? ' failed' : ''}`, text: m.snippet }) : null;

    const hist = r.history || [];
    const details = h('details', { class: 'rt-history', 'data-routine': r.id });
    details.open = openHistory.has(r.id);
    details.addEventListener('toggle', () => { if (details.open) openHistory.add(r.id); else openHistory.delete(r.id); });
    const summary = h('summary', { text: T('routines.history'), 'aria-label': T('settings.routines.history.for', { name }), 'data-focus': `history-${r.id}` });
    details.append(summary);
    if (!hist.length) details.append(h('p', { class: 'note', text: T('routines.history.none') }));
    else {
      details.append(h('ol', { class: 'rt-runs' }, hist.map((e) => h('li', { class: `rt-run-entry ${e.status}` },
        h('span', { class: 'rt-run-head', text: X.historyLine(e, T) }),
        h('pre', { class: 'rt-result', text: e.error || e.result || T('settings.routines.noResult') })))));
    }

    return h('div', { class: `rt-item${r.enabled ? '' : ' off'}${m.needsOk ? ' needs' : ''}`, 'data-routine-id': r.id, 'data-routine': name, role: 'group', 'aria-label': name },
      h('div', { class: 'rt-head' }, toggle,
        h('div', { class: 'rt-text' }, h('span', { class: 'rt-title', text: name }), meta, snippet),
        h('div', { class: 'rt-actions' }, edit, open, run, stop, del)),
      details);
  }

  function templateFor(tp) {
    const m = X.templateModel(tp, view, T);
    const name = T(`routines.template.${tp.key}.name`);
    const add = h('button', { type: 'button', class: 'rt-template-add', 'data-focus': `tpl-${tp.key}`, text: m.have ? T('routines.template.have') : T('routines.template.add'), 'aria-label': m.have ? `${name}: ${T('routines.template.have')}` : T('settings.routines.template.add.for', { name }), disabled: m.have || !view.enabled,
      onclick: () => act({ act: 'template', key: tp.key }, { say: T('routines.template.added', { name }) }) });
    return h('div', { class: `rt-template${m.have ? ' have' : ''}`, 'data-template': tp.key },
      h('div', { class: 'rt-text' }, h('span', { class: 'rt-title', text: name }), h('span', { class: 'note', text: T(`routines.template.${tp.key}.description`) }),
        m.connectorText ? h('span', { class: `note rt-connector ${m.ready ? 'ready' : 'needs'}`, text: m.connectorText }) : null),
      add);
  }

  function paint(next) {
    if (!next || !Array.isArray(next.routines)) return;
    const key = JSON.stringify({ ...next, now: 0 });
    if (key === shown) return;
    shown = key;
    view = next;
    const focused = document.activeElement?.closest?.('.rt-list, .rt-templates') ? document.activeElement.dataset.focus : '';
    offline.hidden = !view.offline;
    offline.textContent = view.offline ? T('routines.offline') : '';
    disabledNote.hidden = view.enabled;
    disabledNote.textContent = view.enabled ? '' : T('tasks.disabled');
    newBtn.disabled = !view.enabled;
    list.replaceChildren(...(view.routines.length ? view.routines.map(rowFor) : [h('p', { class: 'note rt-empty', text: T('routines.empty') })]));
    tplBox.replaceChildren(...(view.templates || []).map(templateFor));
    if (document.activeElement !== quietOn) quietOn.checked = Boolean(view.quiet?.on);
    if (document.activeElement !== quietFrom && view.quiet?.from) quietFrom.value = view.quiet.from;
    if (document.activeElement !== quietTo && view.quiet?.to) quietTo.value = view.quiet.to;
    if (focused) card.el.querySelector(`[data-focus="${focused}"]:not(:disabled)`)?.focus();
    const titles = view.routines.map((r) => r.title).join(' ');
    for (const el of [listRow, tplRow]) el.dataset.search = `${el.dataset.base} ${titles}`.toLowerCase();
  }

  async function refresh() {
    try { paint(await R.state()); } catch (err) { flash(status, clean(err), 'error'); }
  }

  const KEYWORDS = 'routine routines schedule scheduled repeat daily weekdays weekly cron every morning brief run now history template';
  const headRow = stackRow(T('routines.title'), '', h('p', { class: 'note', text: T('routines.note') }), h('div', { class: 'rt-bar' }, newBtn), offline, disabledNote, status);
  headRow.querySelector('.label').classList.add('sr-only'); // (the page's title says it)
  headRow.dataset.search = `${KEYWORDS} ${T('routines.note')}`.toLowerCase();
  card.append(headRow);
  card.group(T('settings.routines.list'));
  const listRow = stackRow(T('settings.routines.list'), '', list);
  listRow.dataset.base = KEYWORDS;
  card.append(listRow);
  card.group(T('routines.templates'));
  const tplRow = stackRow(T('routines.templates'), T('settings.routines.templates.desc'), tplBox);
  tplRow.dataset.base = `${KEYWORDS} email canvas news calendar gmail`;
  card.append(tplRow);
  card.group(T('routines.quiet.title'));
  const quietRow = row(T('routines.quiet.on'), T('routines.quiet.desc'), quietOn);
  quietRow.dataset.search += ' quiet hours night do not disturb sleep routine routines schedule';
  quietRow.querySelector('.label').addEventListener('click', () => quietOn.click());
  card.append(quietRow, row(T('routines.quiet.from'), '', quietFrom), row(T('routines.quiet.to'), '', quietTo));
  listRow.dataset.search = KEYWORDS;
  tplRow.dataset.search = `${KEYWORDS} email canvas news calendar gmail`;

  paint(await R.state());
  // Fresh when the tab is looked at again (a routine ran, or was changed in the sidebar): no timer, only a read when the page is shown.
  const again = () => { if (document.visibilityState === 'visible' && !card.pane.hidden) refresh(); };
  window.addEventListener('focus', again);
  document.addEventListener('visibilitychange', again);
  window.addEventListener('hashchange', () => setTimeout(again, 0));
}

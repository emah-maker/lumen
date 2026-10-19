// lumen://tasks: everything the AI is doing, on one page (features/mission-control.js sorts it, main.js answers). The page
// only reads; each button calls an action the sidebar, the Tasks panel or an agent's window already has. Updates come when
// a chat, task or card changes (mission:changed), and a light look every 2 s while the page is in view catches the rest
// (an outside agent's window opening or closing) and moves the elapsed times on.
const api = window.lumenMission;
const t = window.t || ((key) => key);
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
let data = null;

const duration = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return t('tasks.duration.seconds', { n: Math.max(1, Math.round(ms / 1000)) });
  return m < 60 ? t('tasks.duration.minutes', { n: m }) : t('tasks.duration.hours', { n: Math.floor(m / 60), m: m % 60 });
};
const when = (time) => {
  if (!time) return '';
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const kindText = (item) => t(item.kind === 'task' && item.routine ? 'mission.kind.routine' : `mission.kind.${item.kind}`);
// Where a task came from and what started a routine's run, when it was not the user here or the clock: Telegram, its web link, new email.
const originText = (item) => [item.via ? t(`mission.via.${item.via}`) : '', item.trigger ? t(`mission.trigger.${item.trigger}`) : ''].filter(Boolean).join(' · ');
const statusText = (s) => t(`tasks.status.${s}`);
const costText = (cost) => (typeof cost === 'string' ? cost : typeof cost === 'number' && cost > 0 ? `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ''); // (a task's own words, or a past run's dollars)

// A button with its own key, so focus stays on it when the list is drawn again.
function button(item, op, label, extra = {}, primary = false) {
  const b = el('button', { type: 'button', textContent: label, className: primary ? 'primary' : '' });
  b.dataset.key = [op, item.kind, item.id, item.approvalId ?? '', extra.choice || ''].join(':');
  b.setAttribute('aria-label', t('mission.action.label', { action: label, name: nameOf(item) }));
  b.onclick = async () => {
    b.disabled = true;
    let res;
    try { res = await api.act({ op, kind: item.kind, id: item.id, approvalId: item.approvalId, ...extra }); } catch { res = null; }
    if (!res?.ok) $('status').textContent = t('mission.failed');
    else if (op !== 'goto') $('status').textContent = '';
    await load();
  };
  return b;
}

// A temporary chat is named as one: the page never shows its words.
const nameOf = (item) => (item.temporary ? t('mission.temporaryChat') : item.who || item.title || ''); // (a card's `who` is its chat or task; its `title` is what it asks)

function needsCard(c) {
  const who = nameOf(c);
  const label = { allow: t('mission.answer.allow'), deny: t('mission.answer.deny'), once: t('mission.answer.once'), site: t('mission.answer.site') };
  const what = c.title || (c.host ? t('mission.wants', { host: c.host }) : t('mission.wantsOk'));
  const actions = c.choices.map((choice) => button(c, 'answer', label[choice] || choice, { choice }, choice === 'allow' || choice === 'once'));
  actions.push(button(c, 'goto', t('mission.goto')));
  const card = el('div', { className: 'card', role: 'group' },
    el('span', { className: 'who', textContent: [kindText(c), originText(c), who].filter(Boolean).join(' · ') }),
    el('p', { className: 'what', textContent: what }),
    // The page content warning, then the details whole (as the Tasks panel shows them): what Allow would approve.
    c.tainted ? el('p', { className: 'tainted', textContent: t('mission.tainted') }) : null,
    c.detail ? el('pre', { className: 'args', textContent: c.detail, tabIndex: 0 }) : null,
    c.choices.length ? null : el('span', { className: 'detail', textContent: t(c.cut ? 'mission.answerThereLong' : 'mission.answerThere') }),
    el('div', { className: 'actions' }, ...actions));
  card.setAttribute('aria-label', `${who}: ${what}`);
  return card;
}

function runningRow(r) {
  const bits = [statusText(r.status), originText(r), r.startedAt ? duration(Date.now() - r.startedAt) : '', costText(r.cost), r.step].filter(Boolean);
  const actions = [r.canStop ? button(r, 'stop', t('mission.stop')) : null, button(r, 'goto', t('mission.goto'))];
  return el('div', { className: 'row' },
    el('div', { className: 'main' },
      el('span', { className: 'kind', textContent: kindText(r) }),
      el('span', { className: 'title', textContent: nameOf(r) }),
      el('span', { className: `detail state-${r.status}`, textContent: bits.join(' · ') })),
    el('div', { className: 'actions always' }, ...actions));
}

function scheduledRow(s) {
  const detail = !s.enabled ? t('mission.off') : s.on ? t(`mission.on.${s.on}`) : s.nextRun ? t('mission.next', { time: when(s.nextRun) }) : '';
  return el('div', { className: 'row' },
    el('div', { className: 'main' },
      el('span', { className: 'kind', textContent: kindText(s) }),
      el('span', { className: 'title', textContent: s.title }),
      el('span', { className: 'detail', textContent: detail })),
    el('div', { className: 'actions always' },
      s.canToggle ? button(s, 'toggle', s.enabled ? t('mission.turnOff') : t('mission.turnOn'), { on: !s.enabled }) : null,
      button(s, 'goto', t('mission.goto'))));
}

function recentRow(r) {
  const bits = [statusText(r.status), originText(r), r.durationMs ? duration(r.durationMs) : '', costText(r.cost), when(r.endedAt)].filter(Boolean);
  return el('div', {},
    el('div', { className: 'row' },
      el('div', { className: 'main' },
        el('span', { className: 'kind', textContent: kindText(r) }),
        el('span', { className: 'title', textContent: r.title }),
        el('span', { className: `detail${r.status === 'failed' ? ' state-failed' : ''}`, textContent: bits.join(' · ') })),
      el('div', { className: 'actions' }, button(r, 'goto', r.kind === 'chat' ? t('mission.openChat') : t('mission.openTask')))),
    r.preview ? el('span', { className: 'preview', textContent: r.preview }) : null);
}

function fill(id, items, draw, emptyKey) {
  const box = $(id);
  box.replaceChildren(...(items.length ? items.map(draw) : [el('p', { className: 'empty', textContent: t(emptyKey) })]));
}

function render() {
  if (!data) return;
  const keep = document.activeElement?.dataset?.key || null;
  fill('needs-list', data.needsYou, needsCard, 'mission.needs.none');
  fill('running-list', data.running, runningRow, 'mission.running.none');
  fill('scheduled-list', data.scheduled, scheduledRow, 'mission.scheduled.none');
  fill('recent-list', data.recent, recentRow, 'mission.recent.none');
  document.title = data.needsYou.length ? `(${data.needsYou.length}) ${t('mission.title')}` : t('mission.title');
  if (keep) [...document.querySelectorAll('button[data-key]')].find((b) => b.dataset.key === keep)?.focus();
}

let loading = null;
async function load() {
  if (loading) return loading;
  loading = (async () => {
    try { data = (await api?.state()) || data; } catch { /* keep the last picture */ }
    render();
  })().finally(() => { loading = null; });
  return loading;
}

let pending = null;
api?.onChange(() => { if (!pending) pending = setTimeout(() => { pending = null; load(); }, 120); });
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
load();

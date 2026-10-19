// lumen://tasks: one page with everything the AI is doing (renderer/mission.html, docs/mission-control.md).
//
// This file is the pure part: main.js collects what is going on (sidebar chats in `chatRuns`, background tasks and routines
// from features/background-runner.js, outside agents' windows from features/agent-windows.js and their cards from
// features/ai-agents.js) and aggregate() sorts it into the page's four sections. The page only reads, and its buttons call the
// actions that already exist (agent.resolveApproval, bgTasks.approve, stopChat, bgTasks.stop, the agent session's own Stop,
// bgTasks.setEnabled): see act() in main.js. Nothing here can do more than the sidebar, the Tasks panel or an agent's window can.
//
//   needsYou   every approval card waiting: chats, background tasks and routines, outside agents; oldest first
//   running    chats working or waiting for their turn, tasks running, waiting or queued, agents with a window; newest first
//   scheduled  routines and tasks with a next run, soonest first; ones that are off last
//   recent     the last RECENT_MAX finished runs (tasks' and routines' run history without a watch's checks, chats finished since
//              Lumen started); newest first

const RECENT_MAX = 50;
const PREVIEW_MAX = 160;

// Approval cards the page can answer in place with Allow / Deny: the ones whose sidebar card is a plain yes or no. The others
// (a file to choose, an app to pick, a change to keep or undo) need their own card: the page offers Go to.
const PLAIN_ACTIONS = new Set(['interact', 'open', 'script', 'pdf', 'tool', 'terminal', 'signin']);
// A background task's card: once, for this task (a site), or deny (features/background-runner.js approve).
const SITE_ACTIONS = new Set(['interact', 'open', 'script']);

const str = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clip = (text, max = PREVIEW_MAX) => { const t = str(text, max + 1); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };

// What an approval card says. The details the user is asked to approve (an MCP tool's or a connector's arguments, a memory note)
// are shown whole, as the Tasks panel shows them: up to ARGS_MAX characters with their line breaks. Cut, or never plain:
// see choicesFor. `tainted`: the run has read page content, so the details may have come from a page.
const ARGS_MAX = 1500;
function cardText(card = {}) {
  const given = card.args || card.query || '';
  const raw = typeof given === 'string' ? given : JSON.stringify(given, null, 2) || '';
  const detail = raw.replace(/\r\n?/g, '\n').trim();
  return {
    host: str(card.host, 200), action: str(card.action || 'interact', 30), title: str(card.title, 300),
    detail: detail.slice(0, ARGS_MAX), cut: detail.length > ARGS_MAX || card.argsCut === true, tainted: card.tainted === true,
    guarded: Boolean(card.note) || card.noBypass === true, // a connector's write or a memory note: answered only on its own card
  };
}

// The answers the page offers for a card, or none (Go to only). A card is answered here only when it is a plain yes or no, its
// details are shown whole, it is not one that must be answered on its own card (a connector's write, a memory note), and its
// chat is not a temporary one (whose words the page does not show).
// `card`: cardText's view of it.
function choicesFor(kind, card = {}, { temporary = false } = {}) {
  if (temporary || card.cut || card.guarded || !PLAIN_ACTIONS.has(card.action || 'interact')) return [];
  const action = card.action || 'interact';
  if (kind === 'task') return SITE_ACTIONS.has(action) ? ['once', 'site', 'deny'] : ['once', 'deny'];
  return ['allow', 'deny'];
}

// What started a routine's run, when it was not the clock: its web link, new email, or a missed time run late. null otherwise.
const EVENTS = new Set(['webhook', 'email', 'catch-up']);
const eventTrigger = (trigger) => (EVENTS.has(trigger) ? trigger : null);

// A temporary chat on the page: what it is, never its words (its prompt, steps or a card's details).
const hideCard = (card) => ({ ...card, host: '', title: '', detail: '', tainted: false });

// inputs:
//   chats      [{ chatId, title, temporary, running, queued, startedAt, step, approvals: [{ approvalId, host, action, title, args, tainted, note, noBypass, since }] }]
//   tasks      background-runner summaries (bg.summarize) with `runs` (their history), a routine's `history` (what started each run)
//              and `trigger` (what started the run going now) added, and `via: 'telegram'` for a task sent from the phone
//   agents     [{ id, clientName, since, step }]
//   agentCards [{ approvalId, clientName, agentId, host, action, title, args, since }]
//   chatsDone  [{ chatId, title, startedAt, endedAt, status, preview }]
function aggregate({ chats = [], tasks = [], agents = [], agentCards = [], chatsDone = [], now = Date.now() } = {}) {
  const needsYou = [];
  const running = [];
  const scheduled = [];
  const recent = [];

  for (const c of chats) {
    if (!c || !c.chatId) continue;
    const temporary = c.temporary === true;
    const title = temporary ? '' : clip(c.title, 120);
    for (const a of c.approvals || []) {
      const card = temporary ? hideCard(cardText(a)) : cardText(a);
      needsYou.push({ kind: 'chat', id: c.chatId, approvalId: a.approvalId, who: title, temporary, since: num(a.since) || num(c.startedAt), ...card, choices: choicesFor('chat', card, { temporary }) });
    }
    if (c.running || c.queued) {
      const startedAt = num(c.startedAt);
      running.push({ kind: 'chat', id: c.chatId, title, temporary, status: c.queued ? 'queued' : (c.approvals || []).length ? 'waiting-approval' : 'running', step: temporary ? '' : clip(c.step, 140), startedAt, elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0, cost: null, canStop: true });
    }
  }

  for (const t of tasks) {
    if (!t || !t.id) continue;
    const title = clip(t.title, 120);
    for (const p of t.pending || []) {
      const card = cardText(p);
      needsYou.push({ kind: 'task', id: t.id, approvalId: p.approvalId, who: title, routine: Boolean(t.routine), via: t.via || null, since: num(t.waitingSince) || num(t.runningSince), ...card, choices: choicesFor('task', card) });
    }
    if (t.status === 'running' || t.status === 'waiting-approval' || t.status === 'queued') {
      const startedAt = t.status === 'queued' ? 0 : num(t.runningSince);
      running.push({ kind: 'task', id: t.id, title, routine: Boolean(t.routine), via: t.via || null, trigger: eventTrigger(t.trigger), status: t.status, step: clip(t.currentStep, 140), startedAt, elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0, cost: t.cost || null, canStop: true });
    }
    const repeats = t.schedule && ['routine', 'every', 'watch', 'at'].includes(t.schedule.type);
    if (t.routine || (repeats && (t.nextRun || t.enabled === false))) {
      scheduled.push({ kind: 'task', id: t.id, title, routine: Boolean(t.routine), on: eventTrigger(t.schedule?.repeat), schedule: t.schedule || null, nextRun: t.enabled === false ? null : num(t.nextRun) || null, enabled: t.enabled !== false, canToggle: t.schedule?.type !== 'at' });
    }
    for (const r of t.runs || []) {
      const endedAt = num(r?.endedAt);
      if (!endedAt || r.kind === 'watch' || r.kind === 'judge') continue; // (a watched page's checks are not runs)
      const startedAt = num(r.startedAt);
      const trigger = eventTrigger((t.history || []).find((h) => num(h?.startedAt) === startedAt)?.trigger);
      recent.push({ kind: 'task', id: t.id, title, routine: Boolean(t.routine), via: t.via || null, trigger, status: str(r.status, 30) || 'done', startedAt, endedAt, durationMs: startedAt ? Math.max(0, endedAt - startedAt) : 0, preview: clip(r.summary), cost: r.cost ?? null });
    }
  }

  for (const a of agents) {
    if (!a || a.id == null) continue;
    const startedAt = num(a.since);
    running.push({ kind: 'agent', id: a.id, title: clip(a.clientName, 80), client: clip(a.clientName, 80), status: agentCards.some((c) => c.agentId === a.id) ? 'waiting-approval' : 'running', step: clip(a.step, 140), startedAt, elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0, cost: null, canStop: Boolean(a.canStop) });
  }
  for (const c of agentCards) {
    if (!c || c.approvalId == null) continue;
    const card = cardText(c);
    needsYou.push({ kind: 'agent', id: c.agentId ?? null, approvalId: c.approvalId, who: clip(c.clientName, 80), since: num(c.since), ...card, choices: choicesFor('agent', card) });
  }

  for (const c of chatsDone) {
    if (!c || !c.chatId || !num(c.endedAt)) continue;
    const startedAt = num(c.startedAt);
    recent.push({ kind: 'chat', id: c.chatId, title: clip(c.title, 120), status: str(c.status, 30) || 'done', startedAt, endedAt: num(c.endedAt), durationMs: startedAt ? Math.max(0, num(c.endedAt) - startedAt) : 0, preview: clip(c.preview), cost: null });
  }

  needsYou.sort((a, b) => (a.since || Infinity) - (b.since || Infinity));
  const order = { 'waiting-approval': 0, running: 1, queued: 2 };
  running.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.startedAt - a.startedAt);
  scheduled.sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || (a.nextRun || Infinity) - (b.nextRun || Infinity) || a.title.localeCompare(b.title));
  recent.sort((a, b) => b.endedAt - a.endedAt);

  return { now, needsYou, running, scheduled, recent: recent.slice(0, RECENT_MAX), counts: { needsYou: needsYou.length, running: running.length, scheduled: scheduled.length } };
}

// A finished chat run as the page's Recent list keeps it (main.js, on the run's 'done'). Newest first, at most RECENT_MAX.
function noteFinished(list, entry) {
  const next = [{ chatId: String(entry.chatId), title: clip(entry.title, 120), startedAt: num(entry.startedAt), endedAt: num(entry.endedAt), status: str(entry.status, 30) || 'done', preview: clip(entry.preview) }, ...list];
  return next.slice(0, RECENT_MAX);
}

// The page's request, checked before main.js acts on it: the kind and op it names, the ids as the kinds use them, and an answer
// the card offers. null: not a request the page can make.
const KINDS = new Set(['chat', 'task', 'agent']);
const OPS = new Set(['answer', 'stop', 'goto', 'toggle']);
function cleanRequest(req) {
  if (!req || typeof req !== 'object') return null;
  const { op, kind } = req;
  if (!OPS.has(op) || !KINDS.has(kind)) return null;
  const id = typeof req.id === 'string' || Number.isInteger(req.id) ? String(req.id).slice(0, 100) : null;
  if (op === 'toggle') return kind === 'task' && id ? { op, kind, id, on: req.on === true } : null;
  if (op === 'answer') {
    const approvalId = Number(req.approvalId);
    if (!Number.isInteger(approvalId) || approvalId < 0) return null;
    const choice = String(req.choice || '');
    const allowed = kind === 'task' ? ['once', 'site', 'deny'] : ['allow', 'deny'];
    if (!allowed.includes(choice)) return null;
    if (kind !== 'agent' && !id) return null;
    return { op, kind, id, approvalId, choice };
  }
  return id ? { op, kind, id } : null;
}

module.exports = { aggregate, noteFinished, cleanRequest, choicesFor, cardText, RECENT_MAX, PLAIN_ACTIONS, ARGS_MAX };

// The sidebar AI working on its own: a reply keeps going while the user looks at another tab or window,
// closes the sidebar, or opens another chat (main.js keeps each running chat in `chatRuns`, agent.js
// runs it on its own messages array). This file is the pure part: how many chats may run at once, what
// a run's outcome is, when to tell the user, and what the system notification says.
//
// Notifications use the Background tasks setting (features/background-agents.js notifyPlan): with
// notifications off nothing is shown, and "finished" alone can be off while "needs your OK" and
// failures still come.
const bg = require('./background-agents');
const { plainScripts } = require('../renderer/markdown.js');

// The default cap on sidebar runs at once (Settings > AI: Chats working at once; one chat per tab, each
// driving its own tab). The next one waits its turn (features/tab-chats.js createRunSlots).
const MAX_RUNS = 3;

// May a new message start a run? A message in a chat that is already running replaces that run.
function canStart({ busy = 0, sameChatRunning = false, max = MAX_RUNS } = {}) {
  if (sameChatRunning) return true;
  return busy < max;
}

// The first line of a reply, without markdown marks, cut to `max` characters.
function firstLine(text, max = 90) {
  const line = plainScripts(String(text || '')).split('\n').map((l) => l.trim()).find((l) => l && !/^[-*_=`]{3,}$/.test(l)) || '';
  const plain = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

// How a run ended: 'failed' (an error), 'stopped' (the user pressed Stop: nothing to tell), or 'done'.
function outcome({ error = null, stopped = false } = {}) {
  if (error) return 'failed';
  if (stopped) return 'stopped';
  return 'done';
}

// Can the user see this chat's reply right now? Only with Lumen focused, and either on the chat's own tab (`chatHere`:
// the tab the chat lives in is in front, whichever tab the AI worked in) or with the sidebar (or the chat page) showing
// this chat and the tab the AI works in on screen. `chatOpen`: it is the chat the sidebar shows.
const inView = ({ focused = false, sidebarOpen = false, chatOpen = true, onRunTab = true, chatHere = false } = {}) => Boolean(focused && (chatHere || (sidebarOpen && chatOpen && onRunTab)));

// What to do about an event of a run (kind: done, failed, approval, stopped):
//   os      show a system notification
//   unread  mark the sidebar button (sidebar closed) or the chat in the list (another chat open)
function plan(kind, { settings, ...view } = {}) {
  if (kind === 'stopped') return { os: false, unread: false };
  const seen = inView(view);
  const bgPlan = bg.notifyPlan(kind === 'failed' ? 'failed' : kind === 'approval' ? 'approval' : 'done', { settings: bg.normalizeSettings(settings), focused: seen });
  const hidden = !(view.sidebarOpen && view.chatOpen !== false);
  return { os: bgPlan.os, unread: hidden };
}

// The system notification's text. t(key, vars) is the UI language (locales/en.json agent.notify.*).
function notification(kind, { reply = '', error = '', chat = '' } = {}, t = null) {
  const tr = (key, vars, english) => {
    const text = t ? t(key, vars) : '';
    return text && text !== key ? text : english;
  };
  const line = firstLine(reply);
  const body = chat ? String(chat).slice(0, 120) : '';
  if (kind === 'approval') return { title: tr('agent.notify.approval', {}, 'Lumen needs your OK'), body: body || tr('agent.notify.approvalBody', {}, 'Open the sidebar to answer.') };
  if (kind === 'failed') return { title: tr('agent.notify.failed', { error: firstLine(error, 80) }, `Lumen stopped: ${firstLine(error, 80)}`), body };
  return { title: line ? tr('agent.notify.done', { reply: line }, `Lumen finished: ${line}`) : tr('agent.notify.doneEmpty', {}, 'Lumen finished'), body };
}

// The mark on the sidebar's toolbar button: 'approval' (a run waits for an OK) outranks 'unread' (a
// reply finished while the sidebar was closed or another chat was open), or null.
function attention({ approvals = 0, unread = 0 } = {}) {
  if (approvals > 0) return 'approval';
  if (unread > 0) return 'unread';
  return null;
}

// A chat's row in the list: running, waiting for its turn, waiting for an OK, or finished and not seen yet.
function chatBadge({ running = false, queued = false, approvals = 0, unread = false } = {}) {
  if (approvals > 0) return 'approval';
  if (running) return 'running';
  if (queued) return 'queued';
  if (unread) return 'unread';
  return null;
}

module.exports = { MAX_RUNS, canStart, firstLine, outcome, inView, plan, notification, attention, chatBadge };

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
const { plainMath } = require('./plain-math'); // LaTeX as text: a notification can't render math

// The default cap on sidebar runs at once (Settings → AI and agents: Chats working at once; one chat per tab, each
// driving its own tab). The next one waits its turn (features/tab-chats.js createRunSlots).
const MAX_RUNS = 3;

// May a new message start a run? A message in a chat that is already running replaces that run.
function canStart({ busy = 0, sameChatRunning = false, max = MAX_RUNS } = {}) {
  if (sameChatRunning) return true;
  return busy < max;
}

// The first line of a reply, without markdown marks, cut to `max` characters.
function firstLine(text, max = 90) {
  // Math first, on the whole reply and before it is split into lines or cut: either can fall inside $…$.
  const line = plainScripts(plainMath(String(text || ''))).split('\n').map((l) => l.trim()).find((l) => l && !/^[-*_=`]{3,}$/.test(l)) || '';
  const plain = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  return clip(plain, max);
}
// Cut to `max` characters with an ellipsis. Always after the math is converted, never inside a math span.
function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
// Any text for a notification (a chat's title, a task's title, a task's message): LaTeX as text, then cut.
const notifyText = (text, max) => clip(plainMath(String(text ?? '')).trim(), max);

// How a run ended: 'failed' (an error), 'stopped' (the user pressed Stop: nothing to tell), or 'done'.
function outcome({ error = null, stopped = false } = {}) {
  if (error) return 'failed';
  if (stopped) return 'stopped';
  return 'done';
}

// Can the user see this chat's reply right now? Only with Lumen focused, and when any of these holds: `chatHere` (the tab in front is
// bound to this chat, whichever tab the AI worked in), `onAiTab` (the tab in front is the one the AI works in: the user watches it
// happen), or the sidebar (or the chat page) in front shows this chat (`sidebarOpen` and `chatOpen`), whatever tab the AI works in.
const inView = ({ focused = false, sidebarOpen = false, chatOpen = true, onAiTab = false, chatHere = false } = {}) => Boolean(focused && (chatHere || onAiTab || (sidebarOpen && chatOpen)));

// What to do about an event of a run (kind: done, failed, approval, stopped):
//   os      show a system notification
//   unread  mark the sidebar button (sidebar closed) or the chat in the list (another chat open)
// `views`: one view per window (the chat can be open in a tab of another window than the run's); seen in any of them counts.
function plan(kind, { settings, views = null, ...single } = {}) {
  if (kind === 'stopped') return { os: false, unread: false };
  const all = Array.isArray(views) && views.length ? views : [single];
  const seen = all.some(inView);
  const bgPlan = bg.notifyPlan(kind === 'failed' ? 'failed' : kind === 'approval' ? 'approval' : 'done', { settings: bg.normalizeSettings(settings), focused: seen });
  const hidden = !all.some((v) => v.sidebarOpen && v.chatOpen !== false);
  return { os: bgPlan.os, unread: hidden };
}

// [tab chips] A reply's [[tab:ID]] markers as words: a notification can't show a chip. The tab's title (tabs: { id: { t } }, the run's
// tabSnaps), or "a tab" when the title is unknown or the sentence already names it ("Opened X.pdf in X.pdf").
function tabWords(text, tabs) {
  const s = String(text || '');
  if (!s.includes('[[tab:')) return s;
  return require('../renderer/tab-marker').replace(s, (id) => { // (loaded only for a reply that names a tab: the start-up module budget)
    const title = String((tabs && (tabs[id] || tabs[String(id)]))?.t || '').replace(/[\r\n\t[\]]+/g, ' ').trim();
    return title && !s.includes(title) ? title : 'a tab';
  });
}

// The system notification's text. t(key, vars) is the UI language (locales/en.json agent.notify.*).
// summary: an error's short line (an engine's error event carries one), so the title is not a long sentence cut short.
function notification(kind, { reply = '', error = '', chat = '', summary = '', tabs = null } = {}, t = null) {
  const tr = (key, vars, english) => {
    const text = t ? t(key, vars) : '';
    return text && text !== key ? text : english;
  };
  const line = firstLine(tabWords(reply, tabs));
  const body = notifyText(chat, 120); // (a chat's title can hold math too)
  if (kind === 'approval') return { title: tr('agent.notify.approval', {}, 'Lumen needs your OK'), body: body || tr('agent.notify.approvalBody', {}, 'Open the sidebar to answer.') };
  if (kind === 'failed') {
    const what = summary ? firstLine(summary, 80) : firstLine(error, 80);
    return { title: tr('agent.notify.failed', { error: what }, `Lumen stopped: ${what}`), body: [body, summary ? tr('agent.notify.failedHint', {}, 'Open the chat and press Retry.') : ''].filter(Boolean).join('\n') };
  }
  return { title: line ? tr('agent.notify.done', { reply: line }, `Lumen finished: ${line}`) : tr('agent.notify.doneEmpty', {}, 'Lumen finished'), body };
}

// [sidebar shows the running chat] Which of the chats that touch the front tab the sidebar button opens on. `hits`: { id, reason, startedAt }
// for each chat of the tab (its own, or one whose run works in it) with a reason: 'approval' (waits for an OK), 'running', 'unread'.
// A question waiting for the user first, then a working chat, then the rest; among equals the run started last (most recent) wins.
function sidebarPick(hits = []) {
  const latest = (list) => list.reduce((best, h) => (!best || (h.startedAt || 0) >= (best.startedAt || 0) ? h : best), null);
  return latest(hits.filter((h) => h.reason === 'approval')) || latest(hits.filter((h) => h.reason === 'running')) || hits[0] || null;
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

module.exports = { sidebarPick, MAX_RUNS, canStart, firstLine, notifyText, outcome, inView, plan, notification, attention, chatBadge };

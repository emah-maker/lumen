// [ai tab tidy] Lumen cleans up the tabs the AI opened by itself, so the model never spends a step (or a token) closing them.
//
// features/ai-manners.js marks each tab the AI opens (`openedBy`: the run and chat) and main.js closes a run's tabs when it
// finishes (Settings → AI → AI tabs → "When the AI finishes": Close). That close only ever saw the tabs of the run that just
// ended, at the moment it ended, so tabs piled up: one the AI brought to the front, one a helper still held, one a background
// helper opened after the reply, one restored after a restart (a restored tab has no run id). This file is the rest of it:
//   linkedIds()      the tabs the final answer links to or names ([[tab:ID]], or the page's address): kept as results
//   sweepPlan()      every few minutes: tabs whose run is over. Not kept: they close. Kept (a result, keep:true): they sleep
//                    after SLEEP_AFTER_MS without use, then close after the grace period (Settings: aiTabsGrace)
//   capPlan()        about CAP_PER_CHAT tabs per chat: opening one more closes the oldest idle one
//   reusePick()      open_tab of an address the chat already has open in a tab of its own uses that tab
// Never closed or slept by any of them: a tab the user clicked, typed in, navigated, pinned or moved (ai-manners handOver /
// takenOver: it is not the AI's any more), the tab in front, a tab playing sound, the tab a chat lives in, a tab a run is
// working in. main.js checks at close time for typed form text and downloads in progress, which also keep a tab.
// Pure: main.js passes the tabs and the facts about them (main.js "[ai tab tidy]").

const CAP_PER_CHAT = 8;
const SLEEP_AFTER_MS = 15 * 60 * 1000;
const SETTLE_MS = 2 * 60 * 1000; // a finished run's leftover tab waits this long first (a helper's late step, a follow-up using it)
const SWEEP_EVERY_MS = 60 * 1000;
const GRACE = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '4h': 4 * 60 * 60 * 1000 };
const GRACE_CHOICES = Object.keys(GRACE);
const graceMs = (value) => GRACE[value] ?? GRACE['1h'];

// One address per page: no #fragment, no trailing slash, http(s) only ('' for anything else: those are never matched).
function urlKey(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.hash = '';
  return u.href.replace(/\/+$/, '');
}

// When the tab was last of use to the AI: opened, worked in by a run (`usedAt`), or reused.
const lastUse = (tab) => Math.max(Number(tab?.openedBy?.at) || 0, Number(tab?.openedBy?.usedAt) || 0);

// The AI tabs no automatic step may touch (see the top of the file). `facts`: { boundIds, busyIds, audibleIds, activeId }.
function untouchable(tab, { boundIds = [], busyIds = [], audibleIds = [], activeId = null } = {}) {
  if (!tab || !tab.openedBy || tab.closing || tab.pinned || tab.userMoved) return true;
  return tab.id === activeId || boundIds.includes(tab.id) || busyIds.includes(tab.id) || audibleIds.includes(tab.id);
}

// The ids of `tabs` the answer `text` points at: a [[tab:ID]] chip, or a link / bare address equal to the tab's page.
// `urlOf(tab)`: the tab's address (asleep: the one it will wake on).
function linkedIds(tabs, text, urlOf = (tab) => tab.url) {
  const s = String(text || '');
  if (!s) return [];
  const chips = new Set([...s.matchAll(/\[\[tab:(\d+)\]\]/g)].map((m) => Number(m[1])));
  const keys = new Set([...s.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)].map((m) => urlKey(m[0].replace(/[.,;:!?]+$/, ''))).filter(Boolean));
  return (tabs || []).filter((tab) => tab && (chips.has(tab.id) || (keys.size && keys.has(urlKey(urlOf(tab)))))).map((tab) => tab.id);
}

// What a sweep does now: { close: [tab], sleep: [tab] }.
//   liveRunIds   runs still going (their tabs wait for that run's own close when it ends)
//   asleep(tab)  is it asleep already
function sweepPlan(tabs, { now = Date.now(), liveRunIds = [], grace = GRACE['1h'], sleepAfter = SLEEP_AFTER_MS, settle = SETTLE_MS, asleep = () => false, ...facts } = {}) {
  const live = new Set(liveRunIds);
  const close = [];
  const sleep = [];
  for (const tab of tabs || []) {
    if (untouchable(tab, facts)) continue;
    if (tab.openedBy.runId != null && live.has(tab.openedBy.runId)) continue;
    if (tab.openedBy.runId == null && tab.openedBy.chatId == null) continue; // an automation client's tab (no chat, no run): its own session works in it
    const idle = now - lastUse(tab);
    if (!tab.openedBy.keep) { if (idle >= settle) close.push(tab); continue; }
    if (idle >= grace) close.push(tab);
    else if (idle >= sleepAfter && !asleep(tab)) sleep.push(tab);
  }
  return { close, sleep };
}

// Opening one more tab for `chatId`: the tabs to close first so the chat keeps about `cap` (oldest use first). A tab kept as a
// result goes only when nothing else can; none of the untouchable ones ever do.
function capPlan(tabs, { chatId, cap = CAP_PER_CHAT, ...facts } = {}) {
  if (chatId == null) return [];
  const mine = (tabs || []).filter((tab) => tab?.openedBy && !tab.closing && tab.openedBy.chatId === chatId);
  const over = mine.length - cap + 1;
  if (over <= 0) return [];
  const free = mine.filter((tab) => !untouchable(tab, facts)).sort((a, b) => Number(Boolean(a.openedBy.keep)) - Number(Boolean(b.openedBy.keep)) || lastUse(a) - lastUse(b));
  return free.slice(0, over);
}

// An AI tab of this chat (or run) already on `url`, to use instead of opening another: not one a run is working in (unless
// it is `ownTabId`, the calling run's own), not closing, and awake or asleep alike (`urlOf` gives the address either way).
function reusePick(tabs, url, { chatId = null, runId = null, busyIds = [], ownTabId = null, urlOf = (tab) => tab.url } = {}) {
  const key = urlKey(url);
  if (!key || (chatId == null && runId == null)) return null;
  return (tabs || []).find((tab) => tab?.openedBy && !tab.closing && !tab.pinned && !tab.userMoved
    && ((chatId != null && tab.openedBy.chatId === chatId) || (runId != null && tab.openedBy.runId === runId))
    && (tab.id === ownTabId || !busyIds.includes(tab.id))
    && urlKey(urlOf(tab)) === key) || null;
}

module.exports = { CAP_PER_CHAT, SLEEP_AFTER_MS, SETTLE_MS, SWEEP_EVERY_MS, GRACE, GRACE_CHOICES, graceMs, urlKey, lastUse, untouchable, linkedIds, sweepPlan, capPlan, reusePick };

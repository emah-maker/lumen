// A sidebar chat per tab, running at the same time (main.js wires this to the tabs and the agent).
//
// This file is the pure part:
//   createBindings()   which chat each tab shows in the sidebar (many tabs may show one chat; a chat
//                      shows in the tab it was last moved or started in)
//   createRunSlots()   how many chats may work at once, the waiting line behind them, and the rule
//                      that CLI engines (Claude Code, Grok Build) run one chat at a time
//   resolveToolTab()   which tab a chat's browser tools act on: its own, never "whichever is in front"
//   tabStatus()        the little mark a tab shows: working, waiting its turn, or done and not viewed
//   followPlan()       what the sidebar shows when a tab comes to the front
//
// The model, in short: a tab is bound to a chat id. A new tab starts with its own empty chat (the
// chat it would be bound to is created when it is first needed); the only exception is the one chat
// nobody else holds (the last chat after a restart, or one whose tab closed), which the tab you are
// on adopts so the sidebar never opens empty on a chat that still has a history.

const DEFAULT_MAX_RUNS = 3;
const MAX_RUNS_LIMIT = 8;

const clampRuns = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_RUNS_LIMIT, Math.max(1, v)) : DEFAULT_MAX_RUNS;
};

// ---- tab <-> chat
function createBindings() {
  const byTab = new Map(); // tab id -> chat id
  const api = {
    chatOf: (tabId) => byTab.get(tabId) ?? null,
    tabsOf: (chatId) => [...byTab].filter(([, c]) => c === chatId).map(([t]) => t),
    // The tab a chat belongs to: the one it was bound to last.
    tabOf: (chatId) => { let found = null; for (const [t, c] of byTab) if (c === chatId) found = t; return found; },
    claimed: (chatId) => chatId != null && [...byTab.values()].includes(chatId),
    // The tab shows `chatId` from now on. A tab holds one chat; its earlier one just loses this tab.
    bind(tabId, chatId) {
      if (tabId == null || !chatId) return;
      byTab.delete(tabId); // (re-inserted: the most recently bound tab is the chat's home)
      byTab.set(tabId, chatId);
    },
    // "Move chat to this tab": the chat leaves every other tab it showed in.
    move(chatId, tabId) {
      if (tabId == null || !chatId) return [];
      const left = api.tabsOf(chatId).filter((t) => t !== tabId);
      for (const t of left) byTab.delete(t);
      api.bind(tabId, chatId);
      return left;
    },
    unbindTab: (tabId) => byTab.delete(tabId),
    unbindChat(chatId) { for (const t of api.tabsOf(chatId)) byTab.delete(t); },
    size: () => byTab.size,
    entries: () => [...byTab],
    // For the saved session: each tab's chat, in the tab order given (null: none).
    snapshot: (tabIds) => (tabIds || []).map((id) => byTab.get(id) ?? null),
    // The other way: tab ids (new ones after a restart) in the same order as the saved chat ids.
    // `exists(chatId)` drops a chat that no longer exists (deleted, or unreadable on this machine).
    restore(tabIds, chatIds, exists = () => true) {
      (tabIds || []).forEach((id, i) => {
        const c = chatIds?.[i];
        if (typeof c === 'string' && c && exists(c) && !api.claimed(c)) byTab.set(id, c);
      });
    },
  };
  return api;
}

// ---- running chats: the cap and the waiting line
// slot kinds: 'api' (a model reached over its API) or 'cli' (Claude Code, Grok Build). The CLI engines
// call back into Lumen's tools through one connection that finds its run through a single pin, and keep
// one process warm, so only one of them works at a time; other chats wait (reason 'cli').
//   onError(chatId, err)  a start() that throws: the slot is given back and the chat is told (an error and a done), so it
//                         is never left showing "running" for ever
//   onStale(chatId)       sweep() found a slot whose run is gone without ever saying done (an engine process that exited
//                         without reaching "done"): the slot is released and the chat is told
function createRunSlots({ max = DEFAULT_MAX_RUNS, cliMax = 1, onError = null, onStale = null, misses = 2 } = {}) {
  let limit = clampRuns(max);
  const running = new Map(); // chat id -> { kind, alive, missed }
  const waiting = []; // { chatId, kind, start, alive }
  const cliBusy = () => [...running.values()].filter((r) => r.kind === 'cli').length;
  const fits = (kind) => running.size < limit && (kind !== 'cli' || cliBusy() < cliMax);
  const why = (kind) => (running.size >= limit ? 'limit' : kind === 'cli' && cliBusy() >= cliMax ? 'cli' : null);

  const begin = (chatId, kind, alive, start) => {
    running.set(chatId, { kind, alive, missed: 0 });
    try { start(); return true; } catch (err) {
      running.delete(chatId);
      try { onError?.(chatId, err); } catch { /* the report must not break the line */ }
      return false;
    }
  };

  function pump() {
    for (let i = 0; i < waiting.length;) {
      const w = waiting[i];
      if (!fits(w.kind)) { i++; continue; }
      waiting.splice(i, 1);
      begin(w.chatId, w.kind, w.alive, w.start);
      i = 0; // (the line is looked at again from the front: a slot may have been taken)
    }
  }

  return {
    get limit() { return limit; },
    setMax(n) { limit = clampRuns(n); pump(); },
    // A chat wants to start. 'started' (start() already ran), 'queued' (start() runs when a slot frees) or 'failed'
    // (start() threw: onError has told the chat). A chat that already holds a slot keeps it (a new message there
    // replaces its own run). `alive()`: whether its run still exists (for sweep).
    request(chatId, { kind = 'api', start, alive = null }) {
      if (running.has(chatId)) return begin(chatId, kind, alive, start) ? 'started' : 'failed';
      const queuedAt = waiting.findIndex((w) => w.chatId === chatId);
      if (queuedAt >= 0) waiting.splice(queuedAt, 1); // (the newer message wins its place in line)
      let failed = false;
      const guarded = () => { try { start(); } catch (err) { failed = true; throw err; } };
      waiting.push({ chatId, kind, start: guarded, alive });
      pump(); // (starts at once when there is room: a chat behind others that don't fit still goes ahead of them)
      if (failed) return 'failed';
      return running.has(chatId) ? 'started' : 'queued';
    },
    // The chat's run ended (or it was stopped): the next one in line may go.
    release(chatId) { running.delete(chatId); pump(); },
    // The watchdog: a slot whose run has been gone for `misses` sweeps in a row is released, and onStale says which.
    sweep() {
      const stale = [];
      for (const [id, r] of running) {
        if (!r.alive || r.alive()) { r.missed = 0; continue; }
        if (++r.missed >= misses) stale.push(id);
      }
      for (const id of stale) { running.delete(id); try { onStale?.(id); } catch { /* ignore */ } }
      if (stale.length) pump();
      return stale;
    },
    // A queued chat that is stopped or deleted leaves the line.
    cancel(chatId) {
      const i = waiting.findIndex((w) => w.chatId === chatId);
      if (i < 0) return false;
      waiting.splice(i, 1);
      return true;
    },
    state: (chatId) => (running.has(chatId) ? 'running' : waiting.some((w) => w.chatId === chatId) ? 'queued' : null),
    // Why a queued chat waits: 'limit' (the cap), 'cli' (a CLI engine is busy in another chat), or null.
    reason(chatId) {
      const w = waiting.find((x) => x.chatId === chatId);
      if (!w) return null;
      return why(w.kind);
    },
    runningIds: () => [...running.keys()],
    waitingIds: () => waiting.map((w) => w.chatId),
    size: () => running.size,
  };
}

// The engine kind of a model id, for the slots.
const slotKind = (model) => (/^(claudecode|grokbuild):/.test(String(model || '')) ? 'cli' : 'api');

// ---- tools
// The tab a chat's tools act on. `pinned`: the tab the chat's run is bound to (null: none yet).
// `activeId`: the tab in front. Only a run with no tab of its own yet falls back to the front tab; a
// pinned tab that is gone is an error, never a silent switch to whatever is in front.
// Returns { id } | { error: 'closed' | 'busy' }.
function resolveToolTab({ pinned = null, activeId = null, exists = () => true, busyElsewhere = () => false } = {}) {
  const id = pinned ?? activeId;
  if (id == null) return { id: null };
  if (pinned != null && !exists(pinned)) return { error: 'closed' };
  if (busyElsewhere(id)) return { error: 'busy' };
  return { id };
}

// May open_tab / switch_tab bring a tab to the front? Only when the user is looking at the run's own
// tab right now (they are watching this chat work). A run in a tab the user is not on never pulls the
// user away from the tab they are in.
const mayTakeFront = ({ runTabId = null, activeId = null } = {}) => runTabId != null && runTabId === activeId;

// ---- the tab's mark
// 'running' (working there now), 'waiting' (its turn is in line), 'approval' (waits for an OK),
// 'done' (finished, not looked at yet), or null.
function tabStatus({ run = null, approvals = 0, unread = false } = {}) {
  if (approvals > 0) return 'approval';
  if (run === 'running') return 'running';
  if (run === 'queued') return 'waiting';
  if (unread) return 'done';
  return null;
}

// A chat's row in the history list: what the chat is doing and where it lives.
// `here`: it is bound to the tab the list was opened from.
function chatPlace({ tabId = null, here = false } = {}) {
  if (tabId == null) return 'none';
  return here ? 'here' : 'other';
}

// ---- following the front tab
// What the sidebar should show when tab `tabId` comes to the front.
//   { chat: id }      the tab's own chat
//   { adopt: id }     no chat of its own, and the open chat belongs to no tab and is idle: the tab takes it
//   { fresh: true }   an empty chat of its own
// `openChatId`/`openIdle`: the chat the sidebar holds now and whether it is not working.
function followPlan({ tabId, chatOf, claimed, openChatId = null, openIdle = true, exists = () => true } = {}) {
  const own = chatOf(tabId);
  if (own && exists(own)) return { chat: own };
  if (openChatId && openIdle && !claimed(openChatId)) return { adopt: openChatId };
  return { fresh: true };
}

module.exports = { DEFAULT_MAX_RUNS, MAX_RUNS_LIMIT, clampRuns, createBindings, createRunSlots, slotKind, resolveToolTab, mayTakeFront, tabStatus, chatPlace, followPlan };

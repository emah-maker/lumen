// A sidebar chat per tab, running at the same time (main.js wires this to the tabs and the agent).
//
// This file is the pure part:
//   createBindings()   which chat each tab shows in the sidebar (many tabs may show one chat; its home
//                      tab is the one it was last moved or started in)
//   createRunSlots()   how many chats may work at once (no cap at all when the setting says so) and the waiting
//                      line behind them
//   resolveToolTab()   which tab a chat's browser tools act on: its own, never "whichever is in front"
//   tabStatus()        the little mark a tab shows: working, waiting its turn, or done and not viewed
//   followPlan()       what the sidebar shows when a tab comes to the front
//
// The model, in short: a tab is bound to a chat id. A new tab starts with its own empty chat (the
// chat it would be bound to is created when it is first needed); the only exception is the one chat
// nobody else holds (the last chat after a restart, or one whose tab closed), which the tab you are
// on adopts so the sidebar never opens empty on a chat that still has a history.

const DEFAULT_MAX_RUNS = 0; // 0: no limit (every chat that is sent a message works at once)
const MAX_RUNS_LIMIT = 8;

// maxChatRuns 0 (the default), 'unlimited', Infinity, or anything unreadable: no cap (every chat starts at once).
// Any other number is held to 1..MAX_RUNS_LIMIT.
const clampRuns = (n) => {
  if (n === 'unlimited' || n === Infinity) return Infinity;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return Infinity;
  return Math.min(MAX_RUNS_LIMIT, v);
};

// ---- tab <-> chat
// A chat may show in several tabs at once ("Also show in this tab"). One of them is its home: the tab it was last
// started or moved in. A run's browser tools act on the home tab, never on the tab you are looking at; showing the
// chat in a second tab does not change the home. When the home tab goes (closed, or it started a new chat) the
// most recently added of the others takes over.
function createBindings() {
  const byTab = new Map(); // tab id -> chat id
  const homes = new Map(); // chat id -> its home tab id
  const api = {
    chatOf: (tabId) => byTab.get(tabId) ?? null,
    // Every tab showing the chat, oldest binding first.
    tabsOf: (chatId) => [...byTab].filter(([, c]) => c === chatId).map(([t]) => t),
    // The chat's home tab (null: no tab shows it).
    homeOf: (chatId) => homes.get(chatId) ?? null,
    tabOf: (chatId) => homes.get(chatId) ?? null,
    // The tabs showing the chat in the order to try them: home first, then the others, newest binding first.
    tabsHomeFirst(chatId) {
      const home = homes.get(chatId);
      const rest = api.tabsOf(chatId).filter((t) => t !== home).reverse();
      return home != null ? [home, ...rest] : rest;
    },
    claimed: (chatId) => chatId != null && [...byTab.values()].includes(chatId),
    // The tab shows `chatId` from now on. A tab holds one chat; its earlier one just loses this tab.
    // Default: the tab becomes the chat's home (the chat was started or moved there). `share`: it only joins the tabs
    // already showing the chat and the home stays (a chat no other tab shows gets this tab as its home anyway).
    bind(tabId, chatId, { share = false } = {}) {
      if (tabId == null || !chatId) return;
      const before = byTab.get(tabId);
      if (before === chatId && share) return;
      byTab.delete(tabId); // (re-inserted: the newest binding is last)
      byTab.set(tabId, chatId);
      if (before != null && before !== chatId) api.fixHome(before);
      if (!share || !api.tabsOf(chatId).some((t) => t !== tabId && homes.get(chatId) === t)) homes.set(chatId, tabId);
    },
    // After a tab left a chat: a home that no longer shows it passes to the newest remaining tab (none left: no home).
    fixHome(chatId) {
      const left = api.tabsOf(chatId);
      if (!left.length) homes.delete(chatId);
      else if (!left.includes(homes.get(chatId))) homes.set(chatId, left[left.length - 1]);
    },
    // "Move chat to this tab": the chat leaves every other tab it showed in.
    move(chatId, tabId) {
      if (tabId == null || !chatId) return [];
      const left = api.tabsOf(chatId).filter((t) => t !== tabId);
      for (const t of left) byTab.delete(t);
      api.bind(tabId, chatId);
      return left;
    },
    unbindTab(tabId) {
      const chatId = byTab.get(tabId);
      const had = byTab.delete(tabId);
      if (chatId != null) api.fixHome(chatId);
      return had;
    },
    unbindChat(chatId) { for (const t of api.tabsOf(chatId)) byTab.delete(t); homes.delete(chatId); },
    size: () => byTab.size,
    entries: () => [...byTab],
    // For the saved session: each tab's chat, in the tab order given (null: none).
    snapshot: (tabIds) => (tabIds || []).map((id) => byTab.get(id) ?? null),
    // And which of those tabs is its chat's home, so a shared chat comes back with the same home.
    snapshotHomes: (tabIds) => (tabIds || []).map((id) => byTab.has(id) && homes.get(byTab.get(id)) === id),
    // The other way: tab ids (new ones after a restart) in the same order as the saved chat ids.
    // `exists(chatId)` drops a chat that no longer exists (deleted, or unreadable on this machine).
    // A chat saved in several tabs comes back in all of them. `homeFlags`: true where that tab was the chat's home;
    // a chat with no flagged tab (an older session) has the first tab restored as its home.
    restore(tabIds, chatIds, exists = () => true, homeFlags = []) {
      (tabIds || []).forEach((id, i) => {
        const c = chatIds?.[i];
        if (typeof c !== 'string' || !c || !exists(c)) return;
        const had = byTab.get(id);
        byTab.set(id, c);
        if (had != null && had !== c) api.fixHome(had);
        if (homeFlags?.[i] === true || !homes.has(c)) homes.set(c, id);
      });
    },
  };
  return api;
}

// ---- running chats: the cap and the waiting line
// slot kinds: 'api' (a model reached over its API) or 'cli' (Claude Code, Grok Build, Antigravity: each run reaches
// Lumen's tools over a connection of its own, found by its own tag, so they run side by side like any other chat;
// Antigravity's runs each use their chat's own home folder for the token file). Only the cap makes a chat wait.
//   onError(chatId, err)  a start() that throws: the slot is given back and the chat is told (an error and a done), so it
//                         is never left showing "running" for ever
//   onStale(chatId)       sweep() found a slot whose run is gone without ever saying done (an engine process that exited
//                         without reaching "done"): the slot is released and the chat is told
function createRunSlots({ max = DEFAULT_MAX_RUNS, onError = null, onStale = null, misses = 2 } = {}) {
  let limit = clampRuns(max);
  const running = new Map(); // chat id -> { kind, alive, missed }
  const waiting = []; // { chatId, kind, start, alive }
  const fits = () => running.size < limit;
  const why = () => (running.size >= limit ? 'limit' : null);

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
      if (!fits()) { i++; continue; }
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
      let failed = false, started = false;
      const guarded = () => { try { start(); started = true; } catch (err) { failed = true; throw err; } };
      waiting.push({ chatId, kind, start: guarded, alive });
      pump(); // (starts at once when there is room: a chat behind others that don't fit still goes ahead of them)
      if (failed) return 'failed';
      return started || running.has(chatId) ? 'started' : 'queued'; // (a start that ran and ended at once has already left `running`)
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
    // Why a queued chat waits: 'limit' (the cap), or null.
    reason(chatId) {
      return waiting.some((x) => x.chatId === chatId) ? why() : null;
    },
    runningIds: () => [...running.keys()],
    waitingIds: () => waiting.map((w) => w.chatId),
    size: () => running.size,
  };
}

// The engine kind of a model id, for the slots (see createRunSlots): a CLI engine or an API model.
const slotKind = (model) => (/^(claudecode|grokbuild|antigravity):/.test(String(model || '')) ? 'cli' : 'api');

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

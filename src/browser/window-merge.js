// Merging browser windows (Merge All Windows, Merge Window Into, Undo): the planning, with no Electron in it,
// so test/units.js can check it. main.js describes each window as plain data, asks for a plan, and carries it
// out with moveTabBetween (the page keeps running; nothing reloads).
//
// A window is described as
//   { id, private?, spare?, busy?, activeId, tabs: [{ id, pinned?, sleeping?, closing?, groupId? }],
//     groups: [{ id, name, color, userNamed?, colorLocked?, collapsed? }] }
//
// Which windows take part: normal browser windows only. A private window is never merged, neither with a
// normal window (its tabs would leave their throwaway session and land in the saved one, in history and in
// the AI's tool reach) nor with another private window (each has a session of its own, so merging two would
// mix logins that are kept apart on purpose). A private window is not even in main.js's list of windows, but
// the flag is honoured here too. A spare (the hidden window kept ready for a drag) and a window whose saved
// tabs are still coming back (`busy`) are left alone, as are detached chat or app windows (not described at all).
'use strict';

const eligible = (w) => Boolean(w) && !w.private && !w.spare && !w.busy;
const liveTabs = (w) => (w.tabs || []).filter((t) => !t.closing);

// How long the merge toast (and so its Undo button) stays up; main.js tells the tab strip to use the same time.
// A click that was sent just as the toast faded still arrives, hence the short grace.
const NOTE_MS = 9000;
const UNDO_GRACE_MS = 500;
const undoValid = (at, now = Date.now()) => Number.isFinite(at) && now - at >= 0 && now - at < NOTE_MS + UNDO_GRACE_MS;

// Whether a tab goes along, and in what state. `alive`: its page is running; `sleeping`: put to sleep (it wakes
// when shown); neither: restored but not loaded yet, which still has an address and moves like a sleeping tab.
// Null: it does not move (closing, or nothing left to move: no page and no address).
function describeTab({ closing = false, alive = false, sleeping = false, destroyed = false, url = '' } = {}) {
  if (closing) return null;
  if (alive || sleeping) return { unloaded: false };
  return url && !destroyed ? { unloaded: true } : null;
}

// What a tab keeps when it leaves its window: it always leaves its group; a hand-placed move marks it as placed
// ("userRemoved": automatic grouping leaves it alone), but a merge is not the user placing every tab, so it keeps
// the flag it had and automatic grouping still sees it.
function releaseFlags(tab, { keep = false } = {}) {
  return { groupId: null, userRemoved: keep ? Boolean(tab && tab.userRemoved) : true };
}

// Why "Merge All Windows" (or "Merge Window Into", with `sourceIds`) cannot do anything now, or null if it can:
// 'single' (no other window), 'restoring' (the windows that are there are still bringing their tabs back),
// 'empty' (the others have no tabs). `targetId` null: the first window that may take part.
function blocker(windows, targetId = null, sourceIds = null) {
  const all = (windows || []).filter((w) => w && !w.private && !w.spare);
  const target = targetId == null ? all.find(eligible) : all.find((w) => w.id === targetId);
  if (!target) return all.some((w) => w.busy) ? 'restoring' : 'single';
  if (target.busy) return 'restoring';
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const pool = all.filter((w) => w !== target && (!wanted || wanted.has(w.id)));
  if (!pool.length) return 'single';
  const ready = pool.filter(eligible);
  if (!ready.length) return 'restoring';
  return ready.some((w) => liveTabs(w).length) ? null : 'empty';
}

// For the menus: { enabled, reason, eligible }. Enabled only when two or more windows may take part.
function availability(windows, currentId = null) {
  const reason = blocker(windows, currentId);
  return { enabled: reason === null, reason, eligible: eligibleWindows(windows).length };
}

// The windows that may be merged, in window order.
function eligibleWindows(windows) {
  return (windows || []).filter(eligible);
}

// The window everything lands in for "Merge All Windows": the one the command was given in, else the focused
// one, else the first. Null when it would merge nothing (fewer than two eligible windows).
function pickTarget(windows, { currentId = null, focusedId = null } = {}) {
  const list = eligibleWindows(windows);
  if (list.length < 2) return null;
  return (list.find((w) => w.id === currentId) || list.find((w) => w.id === focusedId) || list[0]).id;
}

// "Merge Window Into": every other eligible window, in window order, labelled by the caller.
function mergeIntoChoices(windows, sourceId) {
  const list = eligibleWindows(windows);
  if (!list.some((w) => w.id === sourceId)) return [];
  return list.filter((w) => w.id !== sourceId);
}

// One source window's tabs and groups, as they were (what Undo needs) and how to move them.
// The moves keep the strip's order. Pinned tabs go to the end of the target's pinned run, the others are
// appended; the source's active tab goes last, because releasing the active tab of a window that still has
// tabs makes it switch to a neighbour, which would wake a sleeping one. Its index puts it back in its place.
function planSource(src, dst) {
  const tabs = liveTabs(src);
  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);
  const active = tabs.find((t) => t.id === src.activeId) || null;
  const pinnedBefore = dst.pinned; // the target's pinned tabs when this window's turn comes
  const looseStart = dst.length + pinned.length; // where this window's unpinned tabs begin
  const moves = [];
  let placed = 0; // this window's pinned tabs already at the end of the target's pinned run
  for (const t of pinned) if (t !== active) moves.push({ id: t.id, index: pinnedBefore + placed++ });
  for (const t of loose) if (t !== active) moves.push({ id: t.id, index: null });
  if (active) {
    const i = active.pinned ? pinned.indexOf(active) : loose.indexOf(active);
    moves.push({ id: active.id, index: (active.pinned ? pinnedBefore : looseStart) + i });
  }
  const groups = [];
  const byGroup = new Map();
  for (const t of loose) {
    if (!t.groupId) continue;
    if (!byGroup.has(t.groupId)) {
      const g = (src.groups || []).find((x) => x.id === t.groupId);
      if (!g) continue;
      const entry = { ids: [], group: { name: g.name, color: g.color, userNamed: Boolean(g.userNamed), colorLocked: Boolean(g.colorLocked), collapsed: Boolean(g.collapsed) } };
      byGroup.set(t.groupId, entry);
      groups.push(entry);
    }
    byGroup.get(t.groupId).ids.push(t.id);
  }
  dst.length += tabs.length;
  dst.pinned += pinned.length;
  return {
    id: src.id,
    activeId: active ? active.id : null,
    tabIds: tabs.map((t) => t.id),
    tabs: tabs.map((t) => ({ id: t.id, pinned: Boolean(t.pinned), sleeping: Boolean(t.sleeping), unloaded: Boolean(t.unloaded) })),
    moves,
    groups,
  };
}

// The plan for moving `sourceIds` (default: every other eligible window) into `targetId`: sources in window
// order, each with its moves and groups, and the totals for the toast. Null when there is nothing to do.
function planMerge(windows, targetId, { sourceIds = null } = {}) {
  const list = eligibleWindows(windows);
  const target = list.find((w) => w.id === targetId);
  if (!target) return null;
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const sources = list.filter((w) => w.id !== targetId && (!wanted || wanted.has(w.id)) && liveTabs(w).length);
  if (!sources.length) return null;
  const tabsNow = liveTabs(target);
  const dst = { length: tabsNow.length, pinned: tabsNow.filter((t) => t.pinned).length };
  const planned = sources.map((s) => planSource(s, dst));
  return {
    targetId,
    targetActiveId: target.activeId ?? null, // stays the active tab after the merge
    sources: planned,
    windowCount: planned.length,
    tabCount: planned.reduce((n, s) => n + s.tabIds.length, 0),
  };
}

// What Undo does: one new window per merged one, with the tabs that are still open there, the groups they
// were in, and the tab to show (the one that was active, else the first one that isn't asleep, so showing it
// wakes nothing). `entries` are a plan's sources, each with `bounds` added by the caller. `liveIds`: the ids of
// the target's tabs now; windows with nothing left are skipped. The target always keeps at least one tab,
// so if closing others since then left too few, the last tabs of the last windows stay where they are.
function undoPlan(entries, liveIds) {
  const live = new Set(liveIds);
  const out = [];
  for (const e of entries || []) {
    const tabs = (e.tabs || []).filter((t) => live.has(t.id));
    if (!tabs.length) continue;
    const ids = tabs.map((t) => t.id);
    const lead = ids.includes(e.activeId) ? e.activeId : (tabs.find((t) => !t.sleeping && !t.unloaded) || tabs[0]).id;
    const groups = (e.groups || []).map((g) => ({ ids: g.ids.filter((id) => live.has(id)), group: g.group })).filter((g) => g.ids.length);
    out.push({ id: e.id, bounds: e.bounds || null, ids, lead, groups, pinnedIds: tabs.filter((t) => t.pinned).map((t) => t.id) });
  }
  let spare = live.size - out.reduce((n, w) => n + w.ids.length, 0); // tabs the target keeps of its own
  for (let i = out.length - 1; i >= 0 && spare < 1; i--) {
    const w = out[i];
    while (w.ids.length && spare < 1) {
      const drop = w.ids.pop();
      spare++;
      w.groups = w.groups.map((g) => ({ ...g, ids: g.ids.filter((id) => id !== drop) })).filter((g) => g.ids.length);
      w.pinnedIds = w.pinnedIds.filter((id) => id !== drop);
      if (w.lead === drop) w.lead = w.ids[0];
    }
  }
  return out.filter((w) => w.ids.length);
}

module.exports = { NOTE_MS, UNDO_GRACE_MS, undoValid, describeTab, releaseFlags, blocker, availability, eligibleWindows, pickTarget, mergeIntoChoices, planMerge, undoPlan };

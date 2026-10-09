// ---------- what Reopen Closed Tab brings back besides the address ----------
//
// main.js's closedTabs list holds each closed tab's URL. Next to it, a parallel list holds what
// snapshot() kept of the tab: whether it was pinned, its group, its place in the strip and its
// back/forward list. placement() turns that into where the reopened tab goes now, given the strip as
// it is: a group that has since gone is left behind, the position is clamped, and pinned tabs stay
// first (a pinned tab never lands among the loose ones, nor a loose one among the pinned).

const MAX_ENTRIES = 50; // back/forward entries kept per closed tab (the ones nearest the page it was on)

// The back/forward list worth keeping: { entries: [{ url, title }], index } around the current entry, or null.
function trimHistory(history, max = MAX_ENTRIES) {
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const index = Number.isInteger(history?.index) ? history.index : -1;
  if (!entries.length || index < 0 || index >= entries.length) return null;
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), entries.length - max));
  const kept = entries.slice(start, start + max).map((e) => ({ url: String(e?.url || ''), title: String(e?.title || '') }));
  return kept.length > 1 ? { entries: kept, index: index - start } : null; // a single entry is just the address
}

// { pinned, groupId, index, history } of a tab being closed (`index`: its place among its window's tabs).
function snapshot({ pinned = false, groupId = null, index = 0, history = null } = {}) {
  return { pinned: Boolean(pinned) && !groupId, groupId: groupId || null, index: Math.max(0, index | 0), history: trimHistory(history) };
}

// -> { pinned, groupId, at } for the tab reopening. `strip`: { count, pinned, hasGroup(id) } of the tabs now there
// (before the reopened tab is added). `at` is its index in the strip.
function placement(info, strip) {
  const count = Math.max(0, strip?.count | 0);
  const pinnedCount = Math.min(count, Math.max(0, strip?.pinned | 0));
  if (!info) return { pinned: false, groupId: null, at: count };
  const groupId = info.groupId && strip?.hasGroup?.(info.groupId) ? info.groupId : null;
  const pinned = Boolean(info.pinned) && !groupId;
  const want = Math.min(Math.max(0, info.index | 0), count);
  const at = pinned ? Math.min(want, pinnedCount) : Math.max(want, pinnedCount);
  return { pinned, groupId, at };
}

module.exports = { MAX_ENTRIES, trimHistory, snapshot, placement };

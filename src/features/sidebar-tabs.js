// Whether the AI sidebar is open, per tab (main.js "[sidebar per tab]", renderer/app.js showSidebar).
//
// Opening the sidebar in one tab leaves every other tab as it was. Tabs that share a session (they are bound to the
// same chat: features/tab-chats.js) share the open state: opening it in one opens it in the others, closing closes all.
// The sidebar's width is not part of this: it stays one setting for the window.
//
//   set(tab, open, sharers)    the user (or the app, for that tab) opened or closed the sidebar there; the tabs that
//                              share its chat get the same answer. Returns the tab ids written.
//   isOpen(tab, sharers)       the state the tab shows. A tab that shares a chat shows the newest answer given to it
//                              or to any tab it shares with, so a tab that joins a chat later takes the chat's state
//                              and a tab that leaves one keeps what it last showed.
//   forget(tab)                the tab closed.
//   snapshot(tabs, sharersOf) / restore(tabs, values)   the saved session: one boolean per tab, in tab order.
// A tab nobody has opened the sidebar in starts closed, or open when `defaultOpen` says so.

function create({ defaultOpen = false } = {}) {
  const records = new Map(); // tab id -> { open, rev }
  let rev = 0;
  const write = (id, open) => { records.set(id, { open: Boolean(open), rev: ++rev }); };
  const api = {
    isOpen(tabId, sharers = []) {
      let best = null;
      for (const id of [tabId, ...sharers]) {
        const r = records.get(id);
        if (r && (!best || r.rev > best.rev)) best = r;
      }
      return best ? best.open : Boolean(defaultOpen);
    },
    set(tabId, open, sharers = []) {
      if (tabId == null) return [];
      const ids = [...new Set([tabId, ...sharers])];
      for (const id of ids) write(id, open);
      return ids;
    },
    has: (tabId) => records.has(tabId),
    forget: (tabId) => records.delete(tabId),
    size: () => records.size,
    snapshot: (tabIds, sharersOf = () => []) => (tabIds || []).map((id) => api.isOpen(id, sharersOf(id))),
    // Only open tabs are written back: a closed one is just the default again.
    restore(tabIds, values) {
      (tabIds || []).forEach((id, i) => { if (values?.[i] === true) write(id, true); });
    },
  };
  return api;
}

module.exports = { create };

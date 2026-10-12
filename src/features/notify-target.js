// A chat's system notification: which tab its click brings forward, and keeping the notification alive until then.
// Pure logic (main.js tellUser does the windows): test/notify-units.js.

// The tab a click goes to, the first of these that still exists:
//  - an approval notification: the tab the approval is about (where the run was working when it asked);
//  - the tab the run last acted in (its pinned tab: the AI's own tab when it navigated, else the page it worked on);
//  - the AI's own navigation tab of the chat (agents out of sight: it loads pages in a tab of its own);
//  - the tab the chat was started from, then the tabs bound to the chat.
// `exists(id)` says whether a tab is still open (the AI's tab may have been closed after the run).
function pickTab({ kind, approvalTab = null, runTab = null, aiNavTab = null, homeTab = null, bound = [] } = {}, exists = () => true) {
  const order = [...(kind === 'approval' ? [approvalTab] : []), runTab, aiNavTab, homeTab, ...bound];
  const seen = new Set();
  for (const id of order) {
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    if (exists(id)) return id;
  }
  return null;
}

// Electron's Notification loses its click handler when the object is garbage collected, so every notification is held here until
// it is clicked or too old. A toast that went to the Action Center can still be clicked then: Windows starts (or wakes) the app instead
// of calling the handler, so the newest unclicked one is also what an activation without a link ('second-instance', the pipe's
// 'focus') opens, once, while it is fresh.
function createKeeper({ now = Date.now, keepMs = 30 * 60 * 1000, activationMs = 2 * 60 * 1000, max = 20 } = {}) {
  const held = []; // oldest first: { n, entry, at, clicked }
  const sweep = () => { const t = now(); for (let i = held.length - 1; i >= 0; i--) if (held[i].clicked || t - held[i].at > keepMs) held.splice(i, 1); while (held.length > max) held.shift(); };
  return {
    keep(n, entry) { sweep(); const item = { n, entry, at: now(), clicked: false }; held.push(item); return item; },
    // The notification was clicked (by its own handler or an activation): not offered to an activation again, and let go.
    clicked(item) { item.clicked = true; sweep(); },
    // The entry an activation without a link stands for, or null.
    takeActivation() {
      sweep();
      const t = now();
      for (let i = held.length - 1; i >= 0; i--) if (!held[i].clicked && t - held[i].at <= activationMs) { const item = held[i]; this.clicked(item); return item.entry; }
      return null;
    },
    size() { sweep(); return held.length; },
    has(n) { sweep(); return held.some((x) => x.n === n); },
  };
}

module.exports = { pickTab, createKeeper };

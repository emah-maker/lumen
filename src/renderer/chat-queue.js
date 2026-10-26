// The pure logic behind the chat's waiting line and its message marks (renderer/chat-core.js draws it; test/units/chat-queue-units.js).
//   - the line of messages typed while a reply runs: order kept, owned by the chat they were typed in, Send now moves one to the front
//   - merge: several waiting messages sent as ONE turn ("Send all now")
//   - a message's mark, like a messaging app: queued (clock) -> sent (one check) -> read (two checks, the AI started its reply); it only moves forward
//   - where the "running" pill goes while the live card is out of the scrolled chat: top, bottom, or nowhere (the card is in view)
// Plain script in the UI; Node loads it with require().
(function (root) {
  const ORDER = { queued: 0, sent: 1, read: 2 };
  const isStatus = (s) => Object.prototype.hasOwnProperty.call(ORDER, s);
  // The mark after `event`; never goes back (a late 'sent' must not undo 'read'). An unknown value is ignored.
  function advance(current, next) {
    if (!isStatus(next)) return isStatus(current) ? current : null;
    if (!isStatus(current)) return next;
    return ORDER[next] > ORDER[current] ? next : current;
  }
  // The first event of a reply that shows the AI took the message up (the engine said a word, thought, took a step or asked for an OK).
  const READ_EVENTS = new Set(['text', 'thinking', 'tool', 'desktop_card', 'helper_card', 'plan', 'approval']);
  const countsAsRead = (type) => READ_EVENTS.has(type);

  // Whose a message typed now is: the chat shown; while a run of the view has not named its chat yet (nothing is shown then), the chat that run continues
  // (`runOwner`; null for a new chat, whose first event names it and claims what waited). null: nobody's yet.
  const ownerNow = ({ shown = null, running = false, runOwner = null } = {}) => shown || (running ? runOwner : null) || null;
  // Is a line entry for another chat than the one this view is in? An entry with an owner is, unless the owner is the chat shown or run here; also while no
  // chat is shown (a new empty chat must never take what was queued in another chat). An entry with no owner is never another chat's.
  const otherChat = (id, state) => Boolean(id && id !== ownerNow(state) && id !== (state?.shown ?? null));

  // 1st, 2nd, 3rd, 4th (English; the label around it comes from the locale)
  function ordinal(n) {
    const v = Math.abs(Math.trunc(n)) % 100;
    const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
    return `${n}${suffix}`;
  }

  // A line of entries { text, images, tabs, screen, opts, chatId, fresh }. `onChange(list)` runs after every change (chat-core.js keeps a copy in
  // localStorage with it: a waiting message must outlive a reload of the UI).
  let nextUid = 0;
  function create(onChange = null) {
    const list = [];
    const changed = () => { if (onChange) { try { onChange(list); } catch { /* the copy is a convenience: the line still works */ } } };
    return {
      list,
      get length() { return list.length; },
      add(entry) { if (!entry.uid) entry.uid = `${Date.now().toString(36)}-${(nextUid++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`; list.push(entry); changed(); return entry; },
      has(entry) { return list.includes(entry); },
      remove(entry) { const i = list.indexOf(entry); if (i === -1) return false; list.splice(i, 1); changed(); return true; },
      // Entries for the chat shown now (`other(id)`: true when an id is another chat's), in the order they were typed.
      mine(other) { return list.filter((q) => !other(q.chatId)); },
      // The next one to send: the first of this chat's (a message queued in another chat belongs to that chat's run).
      take(other) { const i = list.findIndex((q) => !other(q.chatId)); if (i === -1) return null; const [entry] = list.splice(i, 1); changed(); return entry; },
      // Send now: the entry goes first in the line.
      promote(entry) { const i = list.indexOf(entry); if (i === -1) return false; if (i > 0) { list.splice(i, 1); list.unshift(entry); changed(); } return true; },
      // 1-based place among this chat's waiting messages (0 when it is not waiting).
      place(entry, other) { const i = this.mine(other).indexOf(entry); return i + 1; },
      drain(pred = () => true) { const out = list.filter(pred); for (const q of out) list.splice(list.indexOf(q), 1); if (out.length) changed(); return out; },
      // A message typed before its chat was named (a new chat's first event names it) belongs to that chat once it is: with no owner it was
      // taken for whichever chat was shown next, and dropped by the redraw that names the chat.
      claim(id) { if (!id) return 0; let n = 0; for (const q of list) if (q.chatId == null) { q.chatId = id; n++; } if (n) changed(); return n; },
    };
  }

  // ---- the copy of the line kept on this machine, so a waiting message survives a reload of the UI, a crash or a restart
  // { uid: { session, beat, chatId, text, images, tabs, screen, opts, fresh, at, imagesLost } } in one localStorage entry. A live view rewrites its own
  // entries (and their `beat`) while it has any; the entries of a view that is gone (its `beat` is old, or it left on purpose: beat 0) are
  // "carried": the next view that shows their chat takes them back (claim), as bubbles when that chat is still running, else into the box.
  const STORE_KEY = 'lumen.chatQueue';
  const STALE_MS = 12000; // a live view beats every BEAT_MS; this long without one and its entries are carried
  const BEAT_MS = 4000;
  const MAX_STORED = 60; // entries, all views together
  const MAX_BYTES = 1500000; // one saved entry with its pictures; past this the pictures are left out (and the entry says so: imagesLost)
  const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const plain = (q) => ({ chatId: q.chatId ?? null, text: String(q.text || ''), images: Array.isArray(q.images) ? q.images.map(({ url, bubble, ...rest }) => rest) : [], tabs: q.tabs || null, screen: q.screen || undefined, opts: q.opts || null, fresh: Boolean(q.fresh) });
  const hasContent = (e) => Boolean(e && (String(e.text || '').trim() || (e.images || []).length));
  function createStore(storage, { key = STORE_KEY, session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, now = Date.now } = {}) {
    const load = () => {
      try {
        const parsed = JSON.parse(storage.getItem(key) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch { return {}; }
    };
    const write = (all) => {
      const uids = Object.keys(all);
      if (uids.length > MAX_STORED) for (const u of uids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, uids.length - MAX_STORED)) delete all[u];
      try { if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all)); else storage.removeItem(key); return true; } catch { return false; }
    };
    return {
      session,
      // The live entries of this view replace the ones it saved before; other views' entries are left alone. `beat`: the time stamped on them (0: leaving).
      save(list, beat = now()) {
        const all = load();
        const was = new Map(Object.keys(all).filter((u) => all[u].session === session).map((u) => [u, all[u].at]));
        for (const u of was.keys()) delete all[u];
        for (const q of list) {
          if (!hasContent(q) || !q.uid) continue;
          const e = { ...plain(q), session, beat, at: was.get(q.uid) || now() };
          if (JSON.stringify(e).length > MAX_BYTES) { e.images = []; e.imagesLost = (q.images || []).length || undefined; }
          all[q.uid] = e;
        }
        if (write(all)) return true;
        // (storage full) once more with no pictures: the words matter most
        for (const u of Object.keys(all)) if (all[u].session === session && all[u].images?.length) { all[u].imagesLost = all[u].images.length; all[u].images = []; }
        return write(all);
      },
      // The entries a gone view left, of one chat (`chatId`), oldest first: nothing of a view that still beats. `take`: also removes them from the copy
      // (returns only what this call really took: two views starting together never both get one).
      carried(chatId, { take = false } = {}) {
        const all = load();
        const t = now();
        const got = Object.keys(all)
          .filter((u) => all[u].session !== session && all[u].chatId === chatId && hasContent(all[u]) && t - (all[u].beat || 0) > STALE_MS && t - (all[u].at || 0) < MAX_AGE_MS)
          .map((u) => ({ uid: u, ...all[u] }))
          .sort((a, b) => (a.at || 0) - (b.at || 0));
        if (take && got.length) { for (const e of got) delete all[e.uid]; write(all); }
        return got;
      },
    };
  }

  // A message that can join others in one turn: nothing special about it (a plan to run, a new chat to open).
  const mergeable = (q) => Boolean(q) && !q.fresh && !q.opts && (q.text || q.images?.length);
  // Several waiting messages as one: the texts in order (a blank line between), every picture and file, the "@" tabs and the first screen.
  // Returns null when fewer than two can be merged.
  function merge(entries, maxAttach = 8) {
    const parts = entries.filter(mergeable);
    if (parts.length < 2) return null;
    const ids = [...new Set(parts.flatMap((q) => q.tabs?.ids || []))];
    const names = [...new Set(parts.flatMap((q) => q.tabs?.names || []))];
    const gone = [...new Set(parts.flatMap((q) => q.tabs?.gone || []))];
    return {
      text: parts.map((q) => q.text).filter(Boolean).join('\n\n'),
      images: parts.flatMap((q) => q.images || []).slice(0, maxAttach),
      tabs: ids.length || gone.length ? { ids, names, gone } : null,
      screen: parts.map((q) => q.screen).find(Boolean),
      chatId: parts[0].chatId,
      merged: parts,
    };
  }

  // Where the pill for the running card goes: the card's box against the chat's visible box.
  // 'top': the card scrolled up out of view; 'bottom': it is below; null: any part of it shows (or nothing is known).
  function pillSide(card, view, margin = 0) {
    if (!card || !view) return null;
    if (card.bottom < view.top + margin) return 'top';
    if (card.top > view.bottom - margin) return 'bottom';
    return null;
  }

  const api = { advance, countsAsRead, ownerNow, otherChat, ordinal, create, createStore, merge, mergeable, pillSide, plain, BEAT_MS, STALE_MS, STORE_KEY, STATUSES: Object.keys(ORDER) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.chatQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);

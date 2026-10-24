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

  // 1st, 2nd, 3rd, 4th (English; the label around it comes from the locale)
  function ordinal(n) {
    const v = Math.abs(Math.trunc(n)) % 100;
    const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
    return `${n}${suffix}`;
  }

  // A line of entries { text, images, tabs, screen, opts, chatId, fresh }.
  function create() {
    const list = [];
    return {
      list,
      get length() { return list.length; },
      add(entry) { list.push(entry); return entry; },
      has(entry) { return list.includes(entry); },
      remove(entry) { const i = list.indexOf(entry); if (i === -1) return false; list.splice(i, 1); return true; },
      // Entries for the chat shown now (`other(id)`: true when an id is another chat's), in the order they were typed.
      mine(other) { return list.filter((q) => !other(q.chatId)); },
      // The next one to send: the first of this chat's (a message queued in another chat belongs to that chat's run).
      take(other) { const i = list.findIndex((q) => !other(q.chatId)); return i === -1 ? null : list.splice(i, 1)[0]; },
      // Send now: the entry goes first in the line.
      promote(entry) { const i = list.indexOf(entry); if (i === -1) return false; if (i > 0) { list.splice(i, 1); list.unshift(entry); } return true; },
      // 1-based place among this chat's waiting messages (0 when it is not waiting).
      place(entry, other) { const i = this.mine(other).indexOf(entry); return i + 1; },
      drain(pred = () => true) { const out = list.filter(pred); for (const q of out) list.splice(list.indexOf(q), 1); return out; },
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

  const api = { advance, countsAsRead, ordinal, create, merge, mergeable, pillSide, STATUSES: Object.keys(ORDER) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.chatQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);

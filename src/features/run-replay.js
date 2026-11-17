// [run replay] What a running reply has already shown, kept so a chat opened again mid-run draws it all again.
// Before (2026-11-17): a chat left while its reply ran (another tab, another chat) came back with only the user's message, the
// working line and the words after the last step: the reply's activity card with its steps, the review-loop card, the agents card,
// pictures and files were gone until the reply ended, so it looked as if the chat had forgotten what it was doing.
// main.js logs each event it sends the chat (after the text coalescer, so streamed words are a few joined events) and chatView
// hands the log over as `live.events`; chat-core.js resumeLive replays it through the chat's own event handler.
// Pure, so test/units/run-replay-units.js covers it in plain Node.

const MAX_EVENTS = 3000; // a very long run keeps its newest events (its first steps drop off rather than the chat growing without end)
const MAX_CHARS = 4_000_000; // the same for its size (a long reply's text, step inputs)

// Not drawn again from the log: approval cards come from the run's pending set (live.approvals); a send countdown and the run's status
// line are only true at the moment; done / reply_complete never come while a run is still running; only the newest picture of the tab
// is kept (each frame is a whole image).
const SKIP = new Set(['approval', 'approval_done', 'send_pending', 'send_pending_done', 'status', 'done', 'reply_complete', 'ai_tabs_closed', 'skill_offer', 'followup_start']);

function createRunLog({ maxEvents = MAX_EVENTS, maxChars = MAX_CHARS } = {}) {
  let list = []; // [{ ev, size }]
  let chars = 0;
  let thumb = null; // the newest 'thumb' event
  const sizeOf = (ev) => { try { return JSON.stringify(ev).length; } catch { return maxChars + 1; } };
  return {
    push(ev) {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      if (ev.type === 'thumb') { thumb = ev; return; }
      if (SKIP.has(ev.type)) return;
      const size = sizeOf(ev);
      if (size > maxChars) return;
      list.push({ ev, size });
      chars += size;
      while (list.length > maxEvents || chars > maxChars) chars -= list.shift().size;
    },
    // In order, the newest picture last (the card is drawn by then).
    events: () => [...list.map((x) => x.ev), ...(thumb ? [thumb] : [])],
    // A new turn of the same run (followup_start): the turn before is saved with the chat, so only what follows is live.
    reset() { list = []; chars = 0; thumb = null; },
    size: () => list.length,
  };
}

module.exports = { createRunLog, SKIP, MAX_EVENTS, MAX_CHARS };

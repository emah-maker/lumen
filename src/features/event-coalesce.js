// A streamed reply arrives as one event per token or two, and each one used to cost two IPC messages (the
// sidebar and the mirrored view) plus a renderer wake-up, far more often than a screen can show. This joins
// consecutive text (or thinking) chunks of one run into a single event, sent at most once per interval, and
// sends anything else at once after the pending chunk, so the order of events never changes and nothing waits
// on the timer but streamed words. Pure: `deliver` sends, the timer functions can be replaced in tests.

const JOINABLE = new Set(['text', 'thinking']);
const joinable = (msg) => Boolean(msg) && JOINABLE.has(msg.type) && typeof msg.text === 'string' && Object.keys(msg).every((k) => k === 'type' || k === 'text');

function createCoalescer(deliver, { ms = 16, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;
  let timer = null;
  const flush = () => {
    if (timer) { clearTimer(timer); timer = null; }
    if (!pending) return;
    const msg = pending;
    pending = null;
    deliver(msg);
  };
  const push = (msg) => {
    if (!joinable(msg)) { flush(); deliver(msg); return; }
    if (pending && pending.type !== msg.type) flush();
    pending = pending ? { type: pending.type, text: pending.text + msg.text } : { type: msg.type, text: msg.text };
    if (!timer) timer = setTimer(flush, ms);
  };
  return { push, flush };
}

module.exports = { createCoalescer, joinable };

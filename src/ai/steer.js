// [mid-run messages] A message the user types while a reply runs reaches the model at the run's next step, as in Claude Code, instead of
// waiting for the whole reply to end. The view hands it over (main.js agent:steer); the run takes it at its next point that can take input:
//   - API models (agent.js loop): after a round of tool calls, the messages waiting go in with the tool results, before the next model call
//   - Claude Code (claude-code.js): a stream-json line on stdin while one of its tool calls runs; the CLI reads it at its next step
// Codex, Grok Build and Antigravity take no input mid-run: their messages wait for the reply to end, as before (the view says so).
// Each message goes once, in the order it was typed; one taken back (Edit, ×) before it went is never sent. What is still waiting when the run
// ends was never sent: the view sends it as the next message, as it always did (test/units/steer-units.js).

// The model reads the message in this frame; the chat shows only the user's words (unwrap: agent.js transcriptFor).
const NOTE = 'The user sent this message while you were working. Take it into account from your next step on: it may add to or change the task.';
const OPEN = '<sent_while_working>';
const CLOSE = '</sent_while_working>';
const MAX_CHARS = 20000;

const wrap = (text) => `${NOTE}\n${OPEN}\n${String(text).slice(0, MAX_CHARS)}\n${CLOSE}`;
// The user's words of a wrapped message; null for any other text.
function unwrap(text) {
  const m = /<sent_while_working>\n?([\s\S]*?)\n?<\/sent_while_working>/.exec(String(text || ''));
  return m ? m[1] : null;
}

// The messages one run has been handed. add(): 'waiting' (it goes at the next step), 'sent' (it already went: the same message handed
// over again, as after a reload of the view) or null (nothing to send). take(): what waits, oldest first, each once.
function createBox() {
  const waiting = [];
  const sent = new Set();
  return {
    add({ uid, text } = {}) {
      const id = String(uid || '');
      const words = String(text || '').trim();
      if (!id || !words) return null;
      if (sent.has(id)) return 'sent';
      if (!waiting.some((e) => e.uid === id)) waiting.push({ uid: id, text: words });
      return 'waiting';
    },
    // Taken back before it went: true. false: it already went (or was never here).
    remove(uid) {
      const i = waiting.findIndex((e) => e.uid === String(uid || ''));
      if (i === -1) return false;
      waiting.splice(i, 1);
      return true;
    },
    take() {
      const out = waiting.splice(0, waiting.length);
      for (const e of out) sent.add(e.uid);
      return out;
    },
    // A message that was taken but never reached the model (the run stopped first): it waits again, ahead of the rest.
    giveBack(entries) {
      for (const e of [...entries].reverse()) { sent.delete(e.uid); if (!waiting.some((w) => w.uid === e.uid)) waiting.unshift(e); }
    },
    get size() { return waiting.length; },
    wasSent: (uid) => sent.has(String(uid || '')),
  };
}

// The text blocks a round's tool results carry for the messages that went with them (one block each, in order).
const blocksFor = (entries) => entries.map((e) => ({ type: 'text', text: wrap(e.text) }));

module.exports = { NOTE, wrap, unwrap, createBox, blocksFor };

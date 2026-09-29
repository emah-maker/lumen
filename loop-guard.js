// Pure helpers for the agent's tool loop (no Electron, unit-tested in test/units.js):
// - RepeatDetector: notices a model repeating the same failing (or pointless) action and returns a
//   note that tells it to change strategy. The note is appended to the tool result, nothing is blocked.
// - withNote: appends a text note to a tool result (string or content blocks).
// - trimToolResults: shortens old tool results for providers without server-side context editing.
// - cacheLastTool: puts the prompt-cache breakpoint on the last tool definition.

// Repeating these is normal (paging, waiting, re-reading), so only failures count for them.
const BENIGN = new Set(['scroll', 'press_key', 'wait', 'wait_for', 'screenshot', 'read_page', 'find', 'list_tabs', 'hover']);

class RepeatDetector {
  constructor(limit = 8) {
    this.limit = limit;
    this.calls = [];
  }

  reset() { this.calls = []; }

  // Records a finished call; returns a note for the model, or null.
  record(name, input, ok) {
    let sig;
    try { sig = `${name}:${JSON.stringify(input ?? {})}`; } catch { sig = name; }
    this.calls.push({ name, sig, ok });
    if (this.calls.length > this.limit) this.calls.shift();
    let same = 0;
    for (let i = this.calls.length - 1; i >= 0 && this.calls[i].sig === sig && this.calls[i].ok === ok; i--) same++;
    let failStreak = 0;
    for (let i = this.calls.length - 1; i >= 0 && !this.calls[i].ok; i--) failStreak++;
    const fix = 'Do something different: call read_page mode:"compact" for fresh refs, try click with the visible text, go straight to a URL with navigate, or use find/run_script.';
    if (!ok && same >= 3) return `REPEAT: this exact call has failed ${same} times in a row. Retrying it will not help. ${fix} If nothing works, stop and tell the user what is blocking you.`;
    if (!ok && same === 2) return `NOTE: this exact call just failed twice. Re-read the page before trying again; ids and the page may have changed.`;
    if (!ok && failStreak >= 4) return `REPEAT: ${failStreak} tool calls in a row have failed. Stop varying the same approach. ${fix} If it is still failing, stop and tell the user.`;
    if (ok && !BENIGN.has(name) && same >= 3) return `REPEAT: you have made this same call ${same} times with the same input. It is not making progress. ${fix} If the task is already done, stop and answer.`;
    return null;
  }
}

function withNote(content, note) {
  if (!note) return content;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note }];
  if (typeof content !== 'string') return content;
  return `${content}\n\n${note}`;
}

// Returns messages where tool results older than the newest `keep` tool-result messages are cut to
// `maxChars` (images dropped). Never mutates the input. Only for providers that lack server-side
// context editing: for Anthropic the clear_tool_uses edit does this, and editing old turns by hand
// would break the prompt cache.
function trimToolResults(messages, { keep = 4, maxChars = 1500 } = {}) {
  const hasResult = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
  const indexes = messages.map((m, i) => (hasResult(m) ? i : -1)).filter((i) => i >= 0);
  const old = new Set(indexes.slice(0, Math.max(0, indexes.length - keep)));
  if (!old.size) return messages;
  const cut = (text) => (text.length > maxChars ? `${text.slice(0, maxChars)}\n[older result trimmed: ${text.length} chars]` : text);
  return messages.map((m, i) => {
    if (!old.has(i)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        if (typeof b.content === 'string') return { ...b, content: cut(b.content) };
        if (!Array.isArray(b.content)) return b;
        const parts = b.content.map((p) => (p.type === 'image' ? { type: 'text', text: '[earlier screenshot omitted]' } : p.type === 'text' ? { ...p, text: cut(p.text) } : p));
        return { ...b, content: parts };
      }),
    };
  });
}

// One breakpoint on the last tool: the (large, stable) tool list is cached on its own, whatever the
// system prompt or the moving message tail do. Returns a new array; clears any earlier marker.
function cacheLastTool(tools) {
  if (!tools.length) return tools;
  return tools.map((t, i) => {
    const { cache_control, ...rest } = t;
    return i === tools.length - 1 ? { ...rest, cache_control: { type: 'ephemeral' } } : rest;
  });
}

module.exports = { RepeatDetector, withNote, trimToolResults, cacheLastTool, BENIGN };

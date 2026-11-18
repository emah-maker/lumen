// [agent cursors] Which helper or sub-agent made a browser tool call, so the page can show that agent's own colored cursor
// (page-scripts.js agentCursor, drawn by agent.js after each acting call).
//
// - Lumen's acting helpers (ai/acting-helpers.js) know their number: agent.js runs each helper's calls inside run({ key, n }).
// - Claude Code and Codex sub-agents call Lumen's tools through the MCP server, where a call carries no agent. Their engines see the
//   call first in their own stream: Claude Code's assistant message has the tool_use with the sub-agent's parent_tool_use_id, and
//   Codex's item/started has the mcpToolCall in the sub-agent's thread. The engine notes it (note), and the MCP side takes the
//   match by tool name and arguments (take) when the call arrives a moment later. A call with no match is the lead agent's: no cursor.
//
// Plain Node, no Electron: test/units/agent-tags-units.js covers it.
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();
const NOTE_MS = 20000; // a noted call that never arrived is dropped after this long
const MAX_NOTES = 200;
const MAX_AGENTS = 60; // agent keys remembered for their numbers; past it the numbering starts over

// Six colors that read on light and dark pages and apart from each other (the lead agent's click ring is #0a84ff blue).
const COLORS = ['#ff375f', '#30d158', '#ff9f0a', '#bf5af2', '#00c7be', '#ffd60a'];
const colorOf = (n) => COLORS[(Math.max(1, Number(n) || 1) - 1) % COLORS.length];

// JSON with sorted keys, so the stream's input and the MCP call's arguments compare equal whatever their key order.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const bare = (name) => String(name || '').replace(/^mcp__lumen__/, '');

function createTags({ now = Date.now } = {}) {
  const notes = []; // { name, args, agent, at }
  const numbers = new Map(); // agent key -> n
  const numberOf = (agent) => {
    if (!numbers.has(agent)) {
      if (numbers.size >= MAX_AGENTS) numbers.clear();
      numbers.set(agent, numbers.size + 1);
    }
    return numbers.get(agent);
  };
  const prune = () => {
    const t = now();
    while (notes.length && (notes.length > MAX_NOTES || t - notes[0].at > NOTE_MS)) notes.shift();
  };
  return {
    // An engine saw a sub-agent's call to a Lumen tool (agent: the sub-agent's key, e.g. its parent tool_use id or thread id).
    note(name, args, agent) {
      if (!agent) return;
      prune();
      notes.push({ name: bare(name), args: stable(args ?? {}), agent: String(agent), at: now() });
    },
    // The MCP call arrived: the tag of the sub-agent that made it ({ key, n, label, color }), or null (the lead agent's, or unknown).
    take(name, args) {
      prune();
      const key = stable(args ?? {});
      const n = bare(name);
      const i = notes.findIndex((x) => x.name === n && x.args === key);
      if (i < 0) return null;
      const [hit] = notes.splice(i, 1);
      return tagOf(hit.agent, numberOf(hit.agent));
    },
    size: () => notes.length,
  };
}
const tagOf = (key, n) => ({ key: String(key), n, label: `Helper ${n}`, color: colorOf(n) });

const shared = createTags();
module.exports = {
  COLORS, colorOf, stable, createTags, tagOf,
  note: (name, args, agent) => shared.note(name, args, agent),
  take: (name, args) => shared.take(name, args),
  run: (tag, fn) => (tag ? store.run(tag, fn) : fn()), // fn's calls are this agent's
  current: () => store.getStore() || null,
};

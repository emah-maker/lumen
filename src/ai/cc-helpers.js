// [background helpers] What Claude Code says about the helpers it starts in the background (a subagent started with the Agent
// tool and run_in_background, or a background shell task), read from its stream-json lines.
//
// From the CLI's own documentation (Agent SDK message types, code.claude.com/docs/en/agent-sdk/typescript):
//   - `{ type: 'system', subtype: 'task_started', task_id, tool_use_id, description, task_type: 'local_agent' | 'local_bash' | ..., is_backgrounded, ambient }`
//   - `task_progress` ({ task_id, description, last_tool_name }), `task_updated` ({ task_id, patch: { status, description, is_backgrounded } }),
//     `task_notification` ({ task_id, status: 'completed' | 'failed' | 'stopped', summary }) when a task ends, and
//     `background_tasks_changed` ({ tasks: [...] }, the whole live set, ambient ones included).
//   - Everything a subagent says carries `parent_tool_use_id` (the Agent call that started it), and `agent_id` (its task_id) on newer CLIs.
//   - The Agent tool's own result for a background start is `tool_use_result.status === 'async_launched'` with an `agentId`.
//   - A turn the CLI starts on its own when a task ends is a user message with `origin: { kind: 'task-notification' }`.
// A CLI that sends none of the `task_*` lines is still seen through the `async_launched` result, but then nothing says when the helper
// ends: the caller's own limits apply (claude-code.js HELPER_MAX_MS).
//
// This file is pure: feed() takes one parsed line and says what changed.
//
// [agents card] Every subagent (an Agent call, in the background or one the reply waits on) is also reported as it starts, makes progress and
// ends: feed()'s `agents` list, each a snapshot (snapshot() below) the chat's Agents card draws. A background shell task is not an agent.

const TYPES = new Set(['local_agent', 'local_bash']);

class HelperTracker {
  constructor() {
    this.tasks = new Map(); // task id -> { id, tool, desc, type, backgrounded, announced, latest, startedAt, tools, tokens, step }
    this.byTool = new Map(); // the Agent / Bash call's tool_use id -> task id
  }

  // The helpers that are working in the background now.
  working() { return [...this.tasks.values()].filter((h) => h.announced); }
  count() { return this.working().length; }

  // [agents card] What the card shows of one agent: state 'working' | 'done' | 'failed' | 'stopped'. `tools`: its tool calls so far (the CLI's
  // count, or the calls seen when it sends none), `last`: what it is doing (its latest step, or the CLI's own words for its progress).
  static snapshot(h, state = 'working', end = {}) {
    return {
      id: h.id, desc: h.desc || '', background: Boolean(h.backgrounded), state, startedAt: h.startedAt,
      tools: Math.max(h.tools || 0, h.seen || 0), tokens: h.tokens || 0, last: h.step || h.latest || '',
      ...(end.summary ? { summary: String(end.summary).slice(0, 600) } : {}), ...(state !== 'working' ? { endedAt: end.at || Date.now() } : {}),
    };
  }

  // The subagent (any, background or not) a line of its own belongs to, or null.
  agentOf(msg) {
    const id = msg?.parent_tool_use_id ? this.byTool.get(msg.parent_tool_use_id) : msg?.agent_id;
    const h = id ? this.tasks.get(id) : null;
    return h && h.type === 'local_agent' ? h : null;
  }

  // A tool call a subagent made (`label` is how its step reads): counted, and it is what the agent is doing now. Returns its snapshot.
  stepOf(h, label) {
    h.seen = (h.seen || 0) + 1;
    if (label) h.step = String(label).slice(0, 160);
    return HelperTracker.snapshot(h);
  }

  // A helper's own line (a subagent's assistant / user message): its helper, or null.
  helperOf(msg) {
    const id = msg?.parent_tool_use_id ? this.byTool.get(msg.parent_tool_use_id) : msg?.agent_id;
    const h = id ? this.tasks.get(id) : null;
    return h && h.announced && h.type === 'local_agent' ? h : null;
  }

  // One parsed line. Returns { started: [helper], progress: [helper], ended: [{ helper, status }] }; each list may be empty.
  feed(msg, now = Date.now()) {
    const out = { started: [], progress: [], ended: [], agents: [] };
    const agent = (h, state, end) => { if (h?.type === 'local_agent') out.agents.push(HelperTracker.snapshot(h, state, end)); };
    if (!msg || typeof msg !== 'object') return out;
    const start = (h, backgrounded) => {
      let cur = this.tasks.get(h.id);
      if (!cur) { cur = { latest: '', startedAt: now, announced: false, ...h, backgrounded }; this.tasks.set(cur.id, cur); agent(cur, 'working'); }
      else { if (h.desc) cur.desc = h.desc; if (h.tool) cur.tool = h.tool; cur.backgrounded = cur.backgrounded || backgrounded; if (!h.fallback) cur.fallback = false; }
      if (cur.tool) this.byTool.set(cur.tool, cur.id);
      if (cur.backgrounded && !cur.announced) { cur.announced = true; out.started.push(cur); if (!out.agents.some((x) => x.id === cur.id)) agent(cur, 'working'); } // (moved to the background: now said as one)
    };
    const end = (id, status, summary = '') => {
      const h = this.tasks.get(id);
      if (!h) return;
      agent(h, status === 'completed' ? 'done' : status, { summary, at: now });
      this.tasks.delete(id);
      if (h.tool) this.byTool.delete(h.tool);
      if (h.announced) out.ended.push({ helper: h, status });
    };
    if (msg.type === 'system') {
      if (msg.subtype === 'task_started') {
        if (msg.ambient === true || !TYPES.has(msg.task_type) || !msg.task_id) return out;
        start({ id: String(msg.task_id), tool: msg.tool_use_id ? String(msg.tool_use_id) : '', desc: String(msg.description || ''), type: msg.task_type }, msg.is_backgrounded !== false);
      } else if (msg.subtype === 'task_updated' && msg.task_id) {
        const h = this.tasks.get(String(msg.task_id));
        const p = msg.patch || {};
        if (!h) return out;
        if (typeof p.description === 'string' && p.description) h.desc = p.description;
        if (p.is_backgrounded === true) start({ id: h.id }, true);
        if (p.status === 'completed' || p.status === 'failed' || p.status === 'killed') end(h.id, p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : 'stopped');
      } else if (msg.subtype === 'task_progress' && msg.task_id) {
        const h = this.tasks.get(String(msg.task_id));
        if (!h) return out;
        const u = msg.usage || {};
        let changed = false;
        if (Number.isFinite(u.tool_uses) && u.tool_uses !== h.tools) { h.tools = u.tool_uses; changed = true; }
        if (Number.isFinite(u.total_tokens)) h.tokens = u.total_tokens;
        if (typeof msg.summary === 'string' && msg.summary && msg.summary !== h.latest) { h.latest = msg.summary; h.step = ''; changed = true; } // (the CLI's own words for what it does, newer than the last step seen)
        if (h.announced && typeof msg.description === 'string' && msg.description && msg.description !== h.latest && !msg.summary) { h.latest = msg.description; out.progress.push(h); changed = true; }
        if (changed) agent(h, 'working');
      } else if (msg.subtype === 'task_notification' && msg.task_id) {
        end(String(msg.task_id), msg.status === 'failed' ? 'failed' : msg.status === 'stopped' ? 'stopped' : 'completed', typeof msg.summary === 'string' ? msg.summary : '');
      } else if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
        // The whole live set: what is in it and not known yet has started; a background helper that is not in it any more has ended.
        const live = new Set();
        for (const t of msg.tasks) {
          if (!t || t.ambient === true || !TYPES.has(t.task_type) || !t.task_id) continue;
          live.add(String(t.task_id));
          start({ id: String(t.task_id), tool: '', desc: String(t.description || ''), type: t.task_type }, true);
        }
        for (const h of [...this.tasks.values()]) if (h.announced && !live.has(h.id)) end(h.id, 'completed');
      }
      return out;
    }
    // The Agent tool's result for a background start (the lines above may not exist on an older CLI).
    if (msg.type === 'user' && !msg.parent_tool_use_id && msg.tool_use_result && typeof msg.tool_use_result === 'object') {
      const r = msg.tool_use_result;
      const block = (Array.isArray(msg.message?.content) ? msg.message.content : []).find((b) => b?.type === 'tool_result' && b.tool_use_id);
      if (block && r.status === 'async_launched' && !this.byTool.has(block.tool_use_id)) {
        const id = String(r.agentId || r.agent_id || block.tool_use_id);
        if (!this.tasks.has(id)) start({ id, tool: String(block.tool_use_id), desc: String(r.description || ''), type: 'local_agent', fallback: true }, true);
        else this.byTool.set(String(block.tool_use_id), id);
      }
    }
    return out;
  }

  // Everything still working is over (the process ended): the helpers that were showing as working.
  endAll(status = 'stopped') {
    const out = this.working().map((helper) => ({ helper, status, agent: helper.type === 'local_agent' ? HelperTracker.snapshot(helper, status === 'completed' ? 'done' : status) : null }));
    this.tasks.clear();
    this.byTool.clear();
    return out;
  }

  // The helpers known only from the Agent tool's async_launched result (a CLI that sends no task_* lines says nothing when they end): the CLI
  // going on by itself, on a helper's result, is what ends them.
  endFallback(status = 'completed') {
    const out = [];
    for (const h of [...this.tasks.values()]) if (h.fallback && h.announced) { this.tasks.delete(h.id); if (h.tool) this.byTool.delete(h.tool); out.push({ helper: h, status, agent: HelperTracker.snapshot(h, status === 'completed' ? 'done' : status) }); }
    return out;
  }

  // Foreground tasks are gone once their turn is (they only block it): kept ones are the background helpers. Returns the snapshots of the
  // subagents among them, ended (one the CLI never said was done: done with its turn).
  dropForeground() {
    const out = [];
    for (const h of [...this.tasks.values()]) if (!h.announced) { this.tasks.delete(h.id); if (h.tool) this.byTool.delete(h.tool); if (h.type === 'local_agent') out.push(HelperTracker.snapshot(h, 'done')); }
    return out;
  }
}

module.exports = { HelperTracker };

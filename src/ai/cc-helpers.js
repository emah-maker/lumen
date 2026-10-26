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

const TYPES = new Set(['local_agent', 'local_bash']);

class HelperTracker {
  constructor() {
    this.tasks = new Map(); // task id -> { id, tool, desc, type, backgrounded, announced, latest, startedAt }
    this.byTool = new Map(); // the Agent / Bash call's tool_use id -> task id
  }

  // The helpers that are working in the background now.
  working() { return [...this.tasks.values()].filter((h) => h.announced); }
  count() { return this.working().length; }

  // A helper's own line (a subagent's assistant / user message): its helper, or null.
  helperOf(msg) {
    const id = msg?.parent_tool_use_id ? this.byTool.get(msg.parent_tool_use_id) : msg?.agent_id;
    const h = id ? this.tasks.get(id) : null;
    return h && h.announced && h.type === 'local_agent' ? h : null;
  }

  // One parsed line. Returns { started: [helper], progress: [helper], ended: [{ helper, status }] }; each list may be empty.
  feed(msg, now = Date.now()) {
    const out = { started: [], progress: [], ended: [] };
    if (!msg || typeof msg !== 'object') return out;
    const start = (h, backgrounded) => {
      let cur = this.tasks.get(h.id);
      if (!cur) { cur = { latest: '', startedAt: now, announced: false, ...h, backgrounded }; this.tasks.set(cur.id, cur); }
      else { if (h.desc) cur.desc = h.desc; if (h.tool) cur.tool = h.tool; cur.backgrounded = cur.backgrounded || backgrounded; if (!h.fallback) cur.fallback = false; }
      if (cur.tool) this.byTool.set(cur.tool, cur.id);
      if (cur.backgrounded && !cur.announced) { cur.announced = true; out.started.push(cur); }
    };
    const end = (id, status) => {
      const h = this.tasks.get(id);
      if (!h) return;
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
        if (h?.announced && typeof msg.description === 'string' && msg.description && msg.description !== h.latest) { h.latest = msg.description; out.progress.push(h); }
      } else if (msg.subtype === 'task_notification' && msg.task_id) {
        end(String(msg.task_id), msg.status === 'failed' ? 'failed' : msg.status === 'stopped' ? 'stopped' : 'completed');
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
    const out = this.working().map((helper) => ({ helper, status }));
    this.tasks.clear();
    this.byTool.clear();
    return out;
  }

  // The helpers known only from the Agent tool's async_launched result (a CLI that sends no task_* lines says nothing when they end): the CLI
  // going on by itself, on a helper's result, is what ends them.
  endFallback(status = 'completed') {
    const out = [];
    for (const h of [...this.tasks.values()]) if (h.fallback && h.announced) { this.tasks.delete(h.id); if (h.tool) this.byTool.delete(h.tool); out.push({ helper: h, status }); }
    return out;
  }

  // Foreground tasks are gone once their turn is (they only block it): kept ones are the background helpers.
  dropForeground() {
    for (const h of [...this.tasks.values()]) if (!h.announced) { this.tasks.delete(h.id); if (h.tool) this.byTool.delete(h.tool); }
  }
}

module.exports = { HelperTracker };

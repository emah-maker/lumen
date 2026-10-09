// Keeps every agent that is not the chat the user is typing into out of the user's window (pure; ai-agents.js, agent.js and
// background-runner.js wire it in, test/agents-quiet-units.js covers it).
//   routeMcpEvent(event, { hasWindow })   where an outside agent's (MCP) event goes: 'agent' (its own window), 'pending' (the agent's
//                                         window plus the passive badge count), 'user' (the user's window; only with no window of
//                                         its own, i.e. tests), or 'none'
//   createPendingApprovals()              the approval cards waiting in agent windows, counted for the one toolbar badge
//   helperUiEvent(event)                  what the chat that started `delegate` helpers sees of their work: nothing live
//   taskToastPlan(plan)                   a background task never shows an in-window toast (OS notification and the badge stay)
//   navTarget(...)                        where the sidebar chat's navigate goes: its own non-active tab, unless the request is about the current page

const STEP_EVENTS = new Set(['tool', 'tool_update', 'tool_done']);
const APPROVAL_EVENTS = new Set(['approval', 'approval_done']);

function routeMcpEvent(event, { hasWindow = true } = {}) {
  if (!event || event.engine) return 'none'; // the sidebar's own engine sessions are the user's chat, not an outside agent
  if (!hasWindow) return 'user';
  if (STEP_EVENTS.has(event.type)) return 'agent';
  if (APPROVAL_EVENTS.has(event.type)) return 'pending';
  if (event.type === 'session') return 'agent'; // "connected" / "disconnected": never in the user's chat
  return 'agent';
}

// Approval cards of outside agents, by approval id. `count` is what the badge shows.
function createPendingApprovals() {
  const waiting = new Map(); // approvalId -> { clientName, key }
  return {
    add(id, info = {}) { waiting.set(id, info); return waiting.size; },
    remove(id) { waiting.delete(id); return waiting.size; },
    // The agent's window went away: its cards are void.
    dropKey(key) { for (const [id, v] of [...waiting]) if (v.key === key) waiting.delete(id); return waiting.size; },
    count: () => waiting.size,
    ids: () => [...waiting.keys()],
    keyOf: () => [...waiting.values()][0]?.key ?? null, // the window the badge takes the user to
  };
}

// A helper's start / step / done events would add and update rows in the chat that called delegate: dropped. The chat gets the
// delegate call's own row and its final result.
const helperUiEvent = () => null;

// bg.notifyPlan's answer without the in-window toast.
const taskToastPlan = (plan) => ({ ...plan, toast: false });

// Where the sidebar chat's `navigate` loads. current: the tab the run is on.
//   aboutPage   the request is about the current page ("this page", "here", a selection, an attached tab)
//   onAiTab     the run's tab is one the AI opened itself
//   ownTabAlive the chat has a tab of its own from earlier steps
//   outside     the call is not the user's chat (outside agent, task, helper): never decided here, those have windows of their own
// -> 'current' (navigate where the run is), 'own' (the chat's own tab), 'new' (open a fresh background tab first)
function navTarget({ aboutPage = false, onAiTab = false, ownTabAlive = false, outside = false } = {}) {
  if (outside || aboutPage || onAiTab) return 'current';
  return ownTabAlive ? 'own' : 'new';
}

module.exports = { routeMcpEvent, createPendingApprovals, helperUiEvent, taskToastPlan, navTarget };

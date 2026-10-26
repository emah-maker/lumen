// Rules that keep an outside agent (MCP client) off the user's window, tabs, focus and clipboard.
// Pure helpers (main.js and ai/agent.js wire them to real windows and tabs; test/units/agent-hands-off-units.js covers them).
//   resolveRun(...)       which window a tool call runs in; an outside agent's call whose window is gone does NOT fall back to the user's
//   foreignTabIds(...)    tab ids a call named that are not in the agent's own window (the user's tabs, or another window's)
//   foreignTabText(...)   the refusal that names them
//   privateClipboard()    a per-session text buffer standing in for the system clipboard
//   mayFocus(rec)         may Lumen move the keyboard focus inside this window? Never inside an agent window the user is not in
//   userInputCounts(rec)  is input in this window's pages the user's? In an agent window, only while it holds the OS focus
//   stillHeld(at, ...)    is a tab the user took over still theirs (in the window, or within HOLD_MS of their last input)?
const AGENT_WINDOW_GONE = 'The window this agent was working in was closed, so the call was not run (it would have acted on one of the user\'s own windows). Make the call again to get a new window.';
const FOREIGN_TAB = 'is one of the user\'s own tabs (or in another window), which agents do not touch. An agent works only in the tabs of its own Lumen window: use list_tabs for them, or open_tab for a new page.';

// scope: the call's task scope ({ mcp, rec } for an outside agent); chatRec: the open chat's run window;
// alive(rec): the window still exists. Returns { rec, gone }.
function resolveRun({ scope, chatRec = null, alive }) {
  if (scope?.mcp) {
    const rec = scope.rec || null;
    return rec && alive(rec) ? { rec, gone: false } : { rec: null, gone: true };
  }
  const rec = scope?.rec || chatRec || null;
  return { rec: rec && alive(rec) ? rec : null, gone: false };
}

function foreignTabIds(ids, ownIds, existsElsewhere = () => false) {
  const own = new Set(ownIds);
  return [...new Set(ids)].filter((id) => !own.has(id) && existsElsewhere(id));
}

const foreignTabText = (ids) => `Tab${ids.length === 1 ? '' : 's'} ${ids.join(', ')} ${ids.length === 1 ? FOREIGN_TAB : FOREIGN_TAB.replace('is one', 'are ones')}`;

function privateClipboard() {
  let text = '';
  return { readText: () => text, writeText: (t) => { text = String(t ?? ''); } };
}

// rec.agent is set on an agent's window until the user keeps it. Inside one that does not hold the OS focus, no webContents.focus() / win.focus().
const mayFocus = (rec) => !(rec && rec.agent && !(rec.win && !rec.win.isDestroyed() && rec.win.isFocused()));

// Does a click or key in an agent window's page count as the user's? Only while that window holds the OS focus: the user is in it.
// The agent's own click sent to a window that is behind others or minimized can reach the page after the agent's input flag is down
// (a view that is not painting queues it), and must not lock the agent out of its own tab.
const userInputCounts = (rec) => !(rec && rec.agent) || Boolean(rec.win && !rec.win.isDestroyed() && rec.win.isFocused());

// Is a tab the user took over (heldAt: their last click or key in it) still theirs? While they are in the window, yes; once they have
// left it (back in their chat, telling the agent to go on), for holdMs after that last input. There was no way to hand a held tab
// back short of Pause and Resume, and the agent was locked out of it for good.
const HOLD_MS = 30000;
const stillHeld = (heldAt, { focused = false, now = Date.now(), holdMs = HOLD_MS } = {}) => Boolean(heldAt) && (focused || now - heldAt < holdMs);

module.exports = { AGENT_WINDOW_GONE, FOREIGN_TAB, HOLD_MS, resolveRun, foreignTabIds, foreignTabText, privateClipboard, mayFocus, userInputCounts, stillHeld };

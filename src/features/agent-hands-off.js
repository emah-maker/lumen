// Rules that keep an outside agent (MCP client) off the user's window, tabs, focus and clipboard.
// Pure helpers (main.js and ai/agent.js wire them to real windows and tabs; test/agent-hands-off-units.js covers them).
//   resolveRun(...)       which window a tool call runs in; an outside agent's call whose window is gone does NOT fall back to the user's
//   foreignTabIds(...)    tab ids a call named that are not in the agent's own window (the user's tabs, or another window's)
//   foreignTabText(...)   the refusal that names them
//   privateClipboard()    a per-session text buffer standing in for the system clipboard
//   mayFocus(rec)         may Lumen move the keyboard focus inside this window? Never inside an agent window the user is not in
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

module.exports = { AGENT_WINDOW_GONE, FOREIGN_TAB, resolveRun, foreignTabIds, foreignTabText, privateClipboard, mayFocus };

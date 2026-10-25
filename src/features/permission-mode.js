// How much the AI asks before it acts: one choice with three levels, stored as two settings so older
// settings files keep their meaning (askBeforeActing: false was "Auto-allow actions" before this existed).
//   ask    (default) every approval card asks
//   auto   "Auto-allow actions": the sidebar's AI skips the per-site cards (agent.js autoAllows)
//   bypass "Bypass permissions": every card is answered allow, with a step saying so (agent.js askApproval)
// Pure: the sidebar's bolt menu (main.js agent:permission-mode), Settings → AI and agents and the agent all read it here.
const MODES = ['ask', 'auto', 'bypass'];

const modeOf = (s) => (s?.bypassPermissions === true ? 'bypass' : s?.askBeforeActing === false ? 'auto' : 'ask');

// The settings a mode is stored as, or null for something that is not a mode. Leaving Bypass also switches off "Bypass in background
// tasks and routines too" (bypassBackground): it is chosen again each time Bypass is, so it can't wait unseen and then reach unattended
// runs the next time Bypass is picked for the sidebar.
function patchOf(mode) {
  if (!MODES.includes(mode)) return null;
  return { askBeforeActing: mode === 'ask', bypassPermissions: mode === 'bypass', ...(mode === 'bypass' ? {} : { bypassBackground: false }) };
}

module.exports = { MODES, modeOf, patchOf };

// How much the AI asks before it acts: one choice with three levels, stored as two settings so older
// settings files keep their meaning (askBeforeActing: false was "Auto-allow actions" before this existed).
//   ask    (default) every approval card asks
//   auto   "Auto-allow actions": the sidebar's AI skips the per-site cards (agent.js autoAllows)
//   bypass "Bypass permissions": every card is answered allow, with a step saying so (agent.js askApproval)
// Pure: the sidebar's bolt menu (main.js agent:permission-mode), Settings → AI and the agent all read it here.
const MODES = ['ask', 'auto', 'bypass'];

const modeOf = (s) => (s?.bypassPermissions === true ? 'bypass' : s?.askBeforeActing === false ? 'auto' : 'ask');

// The settings a mode is stored as, or null for something that is not a mode. Leaving Bypass also switches off "Bypass in background
// tasks and routines too" (bypassBackground): it is chosen again each time Bypass is, so it can't wait unseen and then reach unattended
// runs the next time Bypass is picked for the sidebar.
function patchOf(mode) {
  if (!MODES.includes(mode)) return null;
  return { askBeforeActing: mode === 'ask', bypassPermissions: mode === 'bypass', ...(mode === 'bypass' ? {} : { bypassBackground: false }) };
}

// ---- [project permissions] A project may choose its own level ("Use default" = none: the global one). Kept on the project record on
// this computer only (features/chat-store.js setProjectPermissions): never synced and never in a portable project's project.json, so
// a folder or another computer can't switch Bypass on. allowedHosts: sites "Always allowed" in the project, for its chats only.
const MAX_HOSTS = 200;
const HOST_RE = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const projectModeOf = (project) => (MODES.includes(project?.permissionMode) ? project.permissionMode : null);

// The level a chat runs at: its project's own, else the global one. 'bypass' only when it is really chosen (an unknown value is ignored).
const effectiveMode = (settings, project) => projectModeOf(project) || modeOf(settings);

// Background tasks and routines of a project: they bypass only with both global switches on (Bypass permissions and "Bypass in background
// tasks and routines too", which only the Settings page writes: features/background-runner.js) AND, when the project chose its own
// level, that level being Bypass. A project on Ask or Auto-allow keeps its tasks asking; a project can never switch background Bypass on.
const projectLetsBypass = (project) => { const own = projectModeOf(project); return !own || own === 'bypass'; };

// A site as a project's allow list keeps it: a bare host (lower case, no www twin kept apart: both are stored), or null.
function cleanHost(value) {
  let h = String(value ?? '').trim().toLowerCase();
  if (!h) return null;
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = new URL(h).host; } catch { return null; }
  h = h.replace(/\.$/, '');
  return HOST_RE.test(h) && /[a-z]/.test(h) ? h : null;
}
const cleanHosts = (list) => [...new Set((Array.isArray(list) ? list : []).map(cleanHost).filter(Boolean))].slice(0, MAX_HOSTS);
const hostAllowed = (project, host) => { const h = cleanHost(host); return Boolean(h) && (project?.allowedHosts || []).includes(h); };

// The project fields a patch from the UI sets: { permissionMode: mode | null ("Use default"), allowedHosts }, cleaned. Anything else
// is ignored.
function projectPatchOf(patch = {}) {
  const out = {};
  if ('permissionMode' in patch) out.permissionMode = MODES.includes(patch.permissionMode) ? patch.permissionMode : null;
  if ('allowedHosts' in patch) out.allowedHosts = cleanHosts(patch.allowedHosts);
  return out;
}

module.exports = { MODES, modeOf, patchOf, projectModeOf, effectiveMode, projectLetsBypass, cleanHost, cleanHosts, hostAllowed, projectPatchOf, MAX_HOSTS };

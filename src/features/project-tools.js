// [project tools] Which of the user's tools a project's chats get: its connected apps (Settings → Apps and connections), its MCP servers
// (Settings → AI → MCP servers) and its skills (Settings → Skills). Pure (no Electron), unit-tested in test/units/project-tools-units.js.
//
// A project keeps its choice in `defaults` (features/chat-store.js), next to the model and plan-first:
//   apps:    [connector id]   the connected apps its chats may use. Unset: every app the user connects (as before projects had a choice).
//   servers: [server name]    the user's own MCP servers its chats may use. Unset: every one. (A server a connector card added, like
//                             Linear, is an app: it follows `apps`.)
//   skills:  [skill name]     the skills listed to the AI in its chats. Unset: every skill the AI may use on its own.
//   connectors: false / mcp: false   the older all-or-nothing switches; still read (false wins over any list).
// An empty list means none. main.js asks `allows` for each tool a chat is offered and each call it makes; the project page and the
// New project dialog draw `catalog` and save what `toggle` gives back. Loaded only when a project's tools are asked about.
'use strict';

const APP_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const SERVER_NAME = /^[a-z0-9_-]{1,40}$/i;
const SKILL_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const MAX = 60;
const KINDS = { apps: APP_ID, servers: SERVER_NAME, skills: SKILL_NAME };

// A list as the store keeps it: known shape only, no repeats, at most MAX. Not an array: undefined (unset, "every one").
function cleanList(v, kind) {
  if (!Array.isArray(v)) return undefined;
  const re = KINDS[kind];
  const out = [];
  for (const x of v) {
    const s = String(x ?? '').trim();
    if (re.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX) break;
  }
  return out;
}
// The tool fields of a project's defaults, cleaned: { apps?, servers?, skills? } (a key only when it is set).
function cleanTools(d) {
  const out = {};
  for (const kind of Object.keys(KINDS)) { const l = cleanList(d?.[kind], kind); if (l) out[kind] = l; }
  return out;
}

// Whether a project's chats may use one tool. `what`: 'app:<id>', 'server:<name>' (the user's own MCP server), 'preset:<connector id>'
// (an MCP server a connector card added), 'skill:<name>', or the older 'connectors' / 'mcp' (any of them at all). No defaults: yes.
function allows(defaults, what) {
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const [kind, ...rest] = String(what ?? '').split(':');
  const id = rest.join(':');
  const inList = (list) => !Array.isArray(list) || list.includes(id);
  switch (kind) {
    case 'connectors': return d.connectors !== false && !(Array.isArray(d.apps) && !d.apps.length);
    case 'mcp': return d.mcp !== false;
    case 'app': return d.connectors !== false && inList(d.apps);
    case 'preset': return d.mcp !== false && d.connectors !== false && inList(d.apps);
    case 'server': return d.mcp !== false && inList(d.servers);
    case 'skill': return inList(d.skills);
    default: return true;
  }
}
// The connector ids the `connector` tool may list in a project's chats: null for every connected one.
const onlyApps = (defaults) => (defaults?.connectors === false ? [] : Array.isArray(defaults?.apps) ? defaults.apps.slice() : null);

// What the project page shows: every app, server and skill the user has, each with whether this project's chats get it.
// connectors: connectors:list's cards ({ id, name, kind, status, icon, category, summary }); servers: mcp-client list() ({ name, enabled,
// state, preset, tools }); skills: [{ name, title, description, source }]. Unset lists show everything connected as on (`all: true`).
function catalog({ connectors = [], servers = [], skills = [] } = {}, defaults = {}) {
  const d = defaults || {};
  const custom = servers.filter((s) => !s.preset);
  const all = { apps: !Array.isArray(d.apps) && d.connectors !== false, servers: !Array.isArray(d.servers) && d.mcp !== false, skills: !Array.isArray(d.skills) };
  // (with "every one", what is on is what the user has connected or switched on; with a list, what the list says, connected or not yet)
  return {
    apps: connectors.map((c) => { const connected = c.status === 'connected'; return { id: c.id, name: c.name, kind: c.kind, category: c.category || '', icon: c.icon || null, summary: c.summary || '', status: c.status || 'off', connected, connect: connectMode(c), on: all.apps ? connected : allows(d, `${c.kind === 'mcp' ? 'preset' : 'app'}:${c.id}`) }; }),
    servers: custom.map((s) => { const enabled = s.enabled !== false; return { id: s.name, name: s.name, enabled, state: s.state || 'stopped', tools: Array.isArray(s.tools) ? s.tools.length : 0, needsAuth: Boolean(s.needsAuth), on: all.servers ? enabled : allows(d, `server:${s.name}`) }; }),
    skills: skills.map((s) => ({ id: s.name, name: s.name, title: s.title || s.name, description: String(s.description || '').slice(0, 160), source: s.source || '', on: allows(d, `skill:${s.name}`) })),
    all,
  };
}

// The defaults after one switch on the project page: `kind` 'apps' | 'servers' | 'skills', `id`, `on`. An unset list becomes the list of
// what is on now (`present`: the ids the page showed as on), so turning one off keeps the others. 'all' for `id` goes back to unset
// (every one, including ones connected later); 'none' empties it. The older all-or-nothing switch is dropped once a list says it.
function toggle(defaults, kind, id, on, present = []) {
  if (!KINDS[kind]) return { ...(defaults || {}) };
  const d = { ...(defaults || {}) };
  const legacy = kind === 'servers' ? 'mcp' : kind === 'apps' ? 'connectors' : '';
  if (id === 'all') { delete d[kind]; if (legacy) delete d[legacy]; return d; }
  if (id === 'none') { d[kind] = []; if (legacy) delete d[legacy]; return d; }
  const start = Array.isArray(d[kind]) && !(legacy && d[legacy] === false) ? d[kind] : legacy && d[legacy] === false ? [] : cleanList(present, kind) || [];
  const set = new Set(start);
  if (on) set.add(String(id)); else set.delete(String(id));
  d[kind] = cleanList([...set], kind);
  if (legacy) delete d[legacy];
  return d;
}

// The apps a project has turned on that are not connected yet: what its page offers to Connect.
const missing = (cat) => cat.apps.filter((a) => a.on && !a.connected && !cat.all.apps);

// What a template's project starts with ({ apps, skills, plan }): its preset apps and skills as lists, so a new chat in it gets those and no
// others. A preset app that the user hasn't connected stays in the list (the page offers Connect); nothing is connected on its own.
function templateDefaults(t) {
  const out = {};
  if (Array.isArray(t?.tools?.apps)) out.apps = cleanList(t.tools.apps, 'apps');
  if (Array.isArray(t?.tools?.skills)) out.skills = cleanList(t.tools.skills, 'skills');
  if (t?.tools?.plan === true) out.plan = true;
  return out;
}
// The New project dialog's choice on top of a template's: { apps, servers, skills } lists the user ticked (a key left out keeps the template's).
function mergeChosen(base, chosen) {
  const out = { ...(base || {}) };
  for (const kind of Object.keys(KINDS)) {
    if (chosen?.[kind] === null) { delete out[kind]; continue; } // ("every one")
    const l = cleanList(chosen?.[kind], kind);
    if (l) out[kind] = l;
  }
  return out;
}

// How a connector card connects from the project page: 'click' (one sign-in in the user's browser, nothing to type: Google, Microsoft, Gmail,
// a connector card's MCP server, Canvas when Lumen finds the school's address) or 'settings' (an API token or an address to type: those open
// Settings → Apps and connections at that card).
const connectMode = (c) => (['google', 'microsoft', 'oauth', 'mcp'].includes(c?.kind) || c?.id === 'canvas' ? 'click' : 'settings');

module.exports = { cleanList, cleanTools, allows, onlyApps, catalog, toggle, missing, templateDefaults, mergeChosen, connectMode, MAX };

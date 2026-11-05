// [project permissions] A project's own permission level and its "Always allowed" sites, plain Node: the pure rules
// (features/permission-mode.js), the project record (features/chat-store.js setProjectPermissions: kept on this computer only, never
// set by sync or a portable folder), the agent (each chat runs at its project's level; a site allowed in a project skips the card in
// that project's chats only, and the card's Always adds it there) and background tasks (a project on Ask or Auto-allow keeps its
// tasks asking; only Settings' own switch lets tasks bypass at all).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const PM = require('../../src/features/permission-mode');
const { createChatStore } = require('../../src/features/chat-store');
const portable = require('../../src/features/project-portable');
const { Agent } = require('../../src/ai/agent');
const { TaskAgent } = require('../../src/features/background-runner');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = (v) => JSON.stringify(v);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message || String(e); } };
const root = path.join(__dirname, '..', '..');

// ---- the pure rules
{
  check('rules: a project with no level of its own follows the global one', PM.effectiveMode({ bypassPermissions: true }, {}) === 'bypass' && PM.effectiveMode({ askBeforeActing: false }, null) === 'auto' && PM.effectiveMode({}, { permissionMode: 'nonsense' }) === 'ask');
  check('rules: a project\'s own level wins, in both directions', PM.effectiveMode({}, { permissionMode: 'bypass' }) === 'bypass' && PM.effectiveMode({ bypassPermissions: true }, { permissionMode: 'ask' }) === 'ask');
  check('rules: background tasks of a project bypass only when it uses the default or Bypass', PM.projectLetsBypass(null) && PM.projectLetsBypass({}) && PM.projectLetsBypass({ permissionMode: 'bypass' }) && !PM.projectLetsBypass({ permissionMode: 'ask' }) && !PM.projectLetsBypass({ permissionMode: 'auto' }));
  check('rules: a site is kept as a bare lower-case host; junk is dropped', PM.cleanHost('https://Shop.Example.com/cart?x=1') === 'shop.example.com' && PM.cleanHost('localhost:3000') === 'localhost:3000' && PM.cleanHost('a b') === null && PM.cleanHost('') === null && PM.cleanHost('1234') === null);
  check('rules: a patch keeps only the level and the sites (nothing can set a background switch through it)', J(PM.projectPatchOf({ permissionMode: 'bypass', bypassBackground: true, allowedHosts: ['A.test', 'a.test', 'bad host'], other: 1 })) === J({ permissionMode: 'bypass', allowedHosts: ['a.test'] }) && PM.projectPatchOf({ permissionMode: 'everything' }).permissionMode === null);
}

// ---- the project record
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-perm-'));
  let clock = 1000;
  const store = createChatStore({ dir, encrypt: (t) => Buffer.from(t).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString(), now: () => ++clock });
  const p = store.saveProject({ name: 'Thesis' });
  const set = store.setProjectPermissions(p.id, { permissionMode: 'bypass', allowedHosts: ['scholar.test'], bypassBackground: true });
  check('store: a level and its sites are saved on the project', set?.permissionMode === 'bypass' && J(set.allowedHosts) === J(['scholar.test']) && !('bypassBackground' in set), J(set));
  const again = createChatStore({ dir, encrypt: (t) => Buffer.from(t).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString(), now: () => ++clock });
  const read = again.projects().find((x) => x.id === p.id);
  check('store: they survive a restart', read?.permissionMode === 'bypass' && read.allowedHosts?.[0] === 'scholar.test', J(read));
  again.saveProject({ id: p.id, name: 'Thesis 2', defaults: { plan: true } });
  check('store: editing the project elsewhere keeps them', again.projects().find((x) => x.id === p.id)?.permissionMode === 'bypass');
  again.adoptProject({ id: p.id, name: 'Thesis', instructions: '', permissionMode: 'ask', allowedHosts: ['evil.test'] });
  const synced = again.projects().find((x) => x.id === p.id);
  check('store: a project from sync keeps this computer\'s level and sites, and sets neither', synced.permissionMode === 'bypass' && J(synced.allowedHosts) === J(['scholar.test']), J(synced));
  const other = again.saveProject({ name: 'Fresh' });
  again.adoptProject({ id: other.id, name: 'Fresh', permissionMode: 'bypass', allowedHosts: ['evil.test'] });
  const fresh = again.projects().find((x) => x.id === other.id);
  check('store: sync can\'t switch a project to Bypass', !fresh.permissionMode && !fresh.allowedHosts, J(fresh));
  const cleared = again.setProjectPermissions(p.id, { permissionMode: null, allowedHosts: [] });
  check('store: "Use default" and an empty list clear them', !cleared.permissionMode && !cleared.allowedHosts, J(cleared));
  check('store: an unknown project is refused', again.setProjectPermissions('nope', { permissionMode: 'bypass' }) === null);
  const parsed = portable.parseSettings(JSON.stringify({ format: portable.FORMAT, description: '', defaults: { model: 'x', permissionMode: 'bypass' }, permissionMode: 'bypass', allowedHosts: ['evil.test'] }));
  check('portable: a project folder\'s project.json can\'t carry a level or sites', !J(parsed).includes('bypass') && !J(parsed).includes('evil.test'), J(parsed));
  const syncSrc = fs.readFileSync(path.join(root, 'src', 'features', 'sync-providers.js'), 'utf8');
  check('sync: the project fields it sends name neither the level nor the sites', !/permissionMode|allowedHosts/.test(syncSrc));
}

// ---- the agent: each chat at its project's level, and the project's sites
const projects = new Map(); // messages -> project
const settings = { bypassPermissions: false, askBeforeActing: true };
const modeFor = (messages) => PM.effectiveMode(settings, projects.get(messages) || null);
const state = { url: 'https://shop.test/page' };
const wc = { id: 7, getURL: () => state.url, isDestroyed: () => false };
const tab = { id: 1, webContents: wc };
const browser = {
  activeTab: () => tab, tabById: (id) => (id === 1 ? tab : null), listTabs: () => [{ id: 1, title: 't', url: state.url, active: true }],
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, handsOff: () => false, isAiTab: () => false, tabOff: () => false, typingText: () => '',
  autoApprove: (messages) => modeFor(messages) !== 'ask', bypassPermissions: (messages) => modeFor(messages) === 'bypass',
  projects: {
    name: (messages) => projects.get(messages)?.name || '',
    hostAllowed: (messages, host) => PM.hostAllowed(projects.get(messages), host),
    allowHost: (messages, host) => { const p = projects.get(messages); if (!p) return false; p.allowedHosts = PM.cleanHosts([...(p.allowedHosts || []), host]); return true; },
  },
};
const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
agent.closeSignedInTabs = () => {};
agent.newActionLog = () => ({});
agent.undoSummary = () => null;
const signal = new AbortController().signal;
const events = [];
let answer = false;
const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, answer)); };
const cards = () => events.filter((e) => e.type === 'approval');
const steps = () => events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed');
const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
const click = (messages, hosts = new Set()) => agent.inTask(1, signal, () => agent.ensureAllowed('click', emit, signal, { emit, signal, hosts, who: 'Claude', external: false, noAsk: false, run: { tainted: false }, input: { element_id: 1 } }), messages);
const reset = () => { events.length = 0; answer = false; settings.bypassPermissions = false; settings.askBeforeActing = true; state.url = 'https://shop.test/page'; };

(async () => {
  const thesis = chat();
  const plain = chat();
  projects.set(thesis, { id: 'p1', name: 'Thesis', permissionMode: 'bypass' });

  reset();
  const inProject = await refused(() => click(thesis));
  check('agent: a chat of a project set to Bypass gets no site card', inProject === null && cards().length === 0, J(events));
  reset();
  const asked = await agent.inTask(1, signal, () => agent.askApproval('memory', emit, signal, { action: 'tool', who: 'Claude', title: 'Claude wants to remember: x', args: 'x' }), thesis);
  check('agent: …and any other card in it is answered by Bypass, with a step naming it', asked === true && cards().length === 0 && steps().length === 1, J(events));
  reset();
  const outside = await refused(() => click(plain));
  check('agent: a chat outside the project still asks (the global level is Ask)', cards().length === 1 && outside !== null, J({ outside, cards: cards().length }));

  reset();
  settings.bypassPermissions = true; settings.askBeforeActing = false; // global Bypass
  projects.set(thesis, { id: 'p1', name: 'Thesis', permissionMode: 'ask' });
  const strict = await refused(() => click(thesis));
  check('agent: a project set to Ask still asks while the global level is Bypass', cards().length === 1 && steps().length === 0 && strict !== null, J(events));
  reset();
  settings.bypassPermissions = true; settings.askBeforeActing = false;
  await refused(() => click(plain));
  check('agent: …and the chat outside it follows the global Bypass', cards().length === 0, J(events));
  reset();
  settings.bypassPermissions = true; settings.askBeforeActing = false;
  const plainAsked = await agent.inTask(1, signal, () => agent.askApproval('memory', emit, signal, { action: 'tool', who: 'Claude', title: 'Claude wants to remember: x', args: 'x' }), plain);
  const strictAsked = await agent.inTask(1, signal, () => agent.askApproval('memory', emit, signal, { action: 'tool', who: 'Claude', title: 'Claude wants to remember: x', args: 'x' }), thesis);
  check('agent: under global Bypass, a card in the plain chat is answered, the same card in the Ask project shows', plainAsked === true && strictAsked === false && cards().length === 1 && steps().length === 1, J(events));

  reset();
  projects.set(thesis, { id: 'p1', name: 'Thesis', permissionMode: 'auto' });
  await refused(() => click(thesis));
  check('agent: a project set to Auto-allow skips the site card quietly (no step), like the global Auto-allow', cards().length === 0 && steps().length === 0, J(events));

  // The project's sites
  reset();
  projects.set(thesis, { id: 'p1', name: 'Thesis', allowedHosts: ['shop.test'] });
  const listed = await refused(() => click(thesis));
  check('sites: a site always allowed in the project needs no card in its chats', listed === null && cards().length === 0, J(events));
  reset();
  await refused(() => click(plain));
  check('sites: …another chat still asks about it', cards().length === 1);

  reset();
  projects.set(thesis, { id: 'p1', name: 'Thesis' });
  state.url = 'https://library.test/';
  answer = 'always';
  const saidAlways = await refused(() => click(thesis));
  const card = cards()[0];
  check('sites: in a project\'s chat the site card names the project (its Always is for the project)', card?.project === 'Thesis' && card.host === 'library.test', J(card));
  check('sites: Always on it allows the site and adds it to the project\'s list', saidAlways === null && J(projects.get(thesis).allowedHosts) === J(['library.test']), J(projects.get(thesis)));
  reset();
  state.url = 'https://library.test/';
  await refused(() => click(thesis));
  check('sites: the next chat of the project goes straight through', cards().length === 0, J(events));
  reset();
  state.url = 'https://library.test/';
  await refused(() => click(plain));
  check('sites: a chat outside the project is not covered, and its card names no project', cards().length === 1 && !cards()[0].project, J(cards()));

  // Background tasks of a project: both Settings switches, and the project's level must allow it
  {
    const allow = { project: true };
    const bg = (s) => new TaskAgent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '', bypassPermissions: () => s.bypassPermissions === true && s.bypassBackground === true, projectLetsBypass: () => allow.project }, () => null, () => ({}), () => null, { riskOf: async () => null });
    check('background: both Settings switches on and a project that allows it: the task bypasses', bg({ bypassPermissions: true, bypassBackground: true }).bypassOn() === true);
    allow.project = false;
    check('background: a project on Ask or Auto-allow keeps its tasks asking, whatever Settings says', bg({ bypassPermissions: true, bypassBackground: true }).bypassOn() === false);
    allow.project = true;
    check('background: without Settings\' own background switch nothing a project chooses lets a task bypass', bg({ bypassPermissions: true, bypassBackground: false }).bypassOn() === false);
    const runner = fs.readFileSync(path.join(root, 'src', 'features', 'background-runner.js'), 'utf8');
    check('background: the runner asks the task\'s project (task.projectId) through projectLetsBypass', /projectLetsBypass: \(\) => permissionModes\.projectLetsBypass\(task\.projectId \? deps\.projectOf\?\.\(task\.projectId\) : null\)/.test(runner));
  }

  // The wiring: main resolves the chat's project, the IPC is allowed for the UI and the chat page, the bolt menu knows the project
  {
    const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    check('main: autoApprove and bypassPermissions take the chat and use its project\'s level', /autoApprove: \(messages\) => TEST \|\| permissionModeFor\(messages\) !== 'ask'/.test(main) && /bypassPermissions: \(messages\) => permissionModeFor\(messages\) === 'bypass'/.test(main));
    check('main: the project IPC is on the UI and chat page lists', /'chats:project-permissions'/.test(main.slice(0, 40000)) && /'chats:project-permissions'/.test(fs.readFileSync(path.join(root, 'src', 'features', 'chat-page.js'), 'utf8')));
    check('main: the chat view\'s project chip carries its level for the bolt menu', /permissionModes\.projectModeOf\(p\) \? \{ permissionMode: p\.permissionMode \}/.test(main));
    const en = require('../../src/locales/en.json');
    check('strings: the bolt menu says where the level comes from and asks where a new one applies', /\{mode\}.*\{project\}/.test(en['sidebar.perm.fromProject']) && /\{project\}/.test(en['sidebar.perm.scope.project']) && en['sidebar.perm.scope.all'] === 'Everywhere' && /\{host\}.*\{project\}/.test(en['approval.project.always']));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();

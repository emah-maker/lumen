// [bypass permissions] Security checks for "Bypass in background tasks and routines too" (bypassBackground), plain Node. With both
// switches on a background task answers its own cards, but must keep what bypass never covered: sites with AI off, tabs kept off,
// hands-off mode, the "Choose file…" card, and upload_file (a task has no attached files and no file paths). It is read live, only
// the Settings page and Lumen's own mode switch write it, and leaving Bypass switches it off so it cannot wait unseen.
const fs = require('fs');
const path = require('path');
const { TaskAgent } = require('../../src/features/background-runner');
const PM = require('../../src/features/permission-mode');
const { DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

const settings = { bypassPermissions: true, bypassBackground: true };
const rule = () => settings.bypassPermissions === true && settings.bypassBackground === true; // as in background-runner.js browserFor (checked below)
const state = { url: 'https://shop.test/cart', aiOff: new Set(), off: new Set(), handsOff: false };
const wc = { id: 3, getURL: () => state.url, isDestroyed: () => false };
const tab = { id: 1, webContents: wc };
const browser = {
  background: true, activeTab: () => tab, tabById: (id) => (id === 1 ? tab : null), listTabs: () => [{ id: 1, title: 'Cart', url: state.url, active: true }],
  noTabReason: () => '', effectiveModel: (m) => m, maxSteps: () => 0, autoApprove: () => false, bypassPermissions: rule,
  aiOff: (url) => state.aiOff.has(new URL(url).host), tabOff: (id) => state.off.has(id), handsOff: () => state.handsOff, isAiTab: () => false, typingText: () => '',
};
const agent = new TaskAgent(browser, () => null, () => ({ model: 'claude-opus-5' }), () => null, { riskOf: async () => null });
const signal = new AbortController().signal;
const events = [];
const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, false)); };
const cards = () => events.filter((e) => e.type === 'approval');
const autos = () => events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed');
const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
const call = (name, input, run = { tainted: true }) => agent.inTask(1, signal, () => agent.ensureAllowed(name, emit, signal, { hosts: new Set(['shop.test']), who: 'The task', input, run }), chat());
const reset = () => { events.length = 0; state.url = 'https://shop.test/cart'; state.aiOff.clear(); state.off.clear(); state.handsOff = false; settings.bypassPermissions = true; settings.bypassBackground = true; };

(async () => {
  // The user's own blocks come before any card, and bypass never reaches them
  reset();
  state.aiOff.add('private.test');
  let err = await refused(() => call('navigate', { url: 'https://private.test/' }));
  check('both on: a site with AI off is refused, with no card and no "Allowed automatically" step', /turned off AI on private\.test/.test(err || '') && cards().length === 0 && autos().length === 0, err);
  err = await refused(() => call('read_urls', { urls: ['https://private.test/x'] }));
  check('both on: read_urls of a site with AI off is refused too', /turned off AI/.test(err || '') && autos().length === 0, err);
  reset();
  state.aiOff.add('shop.test');
  err = await refused(() => call('click', { element_id: 1 }));
  check('both on: acting on a tab that sits on an AI-off site is refused', /turned off AI/.test(err || '') && autos().length === 0, err);
  reset();
  state.off.add(1);
  err = await refused(() => call('click', { element_id: 1 }));
  check('both on: a tab the user keeps the AI off is refused', err !== null && cards().length === 0 && autos().length === 0, err);
  reset();
  state.handsOff = true;
  err = await refused(() => call('click', { element_id: 1 }));
  check('both on: hands-off mode refuses acting on a tab the AI did not open', err !== null && cards().length === 0 && autos().length === 0, err);

  // What bypass does answer: a new site after reading, no card, a step says so (and it is read live)
  reset();
  err = await refused(() => call('navigate', { url: 'https://other.test/' }));
  check('both on: a new site after reading is answered Allow and listed as a step', err === null && cards().length === 0 && autos().length === 1, err);
  reset();
  settings.bypassBackground = false; // switched off while a task runs: the very next card asks
  err = await refused(() => call('navigate', { url: 'https://other.test/' }));
  check('read live: switched off mid-run, the next card asks (refused here)', err !== null && cards().length === 1 && autos().length === 0, err);

  // Files: the picker still asks, and a task cannot upload anything of its own
  reset();
  const pick = agent.askApproval('shop.test', emit, signal, { action: 'upload-pick', who: 'The task', title: 'The task needs a file for shop.test', upload: {} });
  const answered = await pick;
  check('both on: the "Choose file…" card still asks', cards().length === 1 && cards()[0].action === 'upload-pick' && autos().length === 0 && answered === false, JSON.stringify(events));
  check('a task agent has no upload store (upload_file is unavailable in the background)', agent.uploads === null);
  err = await refused(() => agent.inTask(1, signal, () => agent.uploadFile({ element_id: 1, paths: ['C:\\Users\\me\\secret.txt'] }), chat()));
  check('upload_file with a path in a task is refused', /not available here|approval step/.test(err || ''), err);
  const main = read('src/main.js');
  check('only the main agent gets the upload store (defined on `agent`, not on tasks)', /Object\.defineProperty\(agent, 'uploads'/.test(main));

  // Who can switch it on
  const withBg = Object.keys(DEFAULTS).filter((k) => k === 'bypassBackground');
  check('off by default', withBg.length === 1 && DEFAULTS.bypassBackground === false && DEFAULTS.bypassPermissions === false);
  const holders = [];
  const walk = (dir) => { for (const f of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const rel = `${dir}/${f.name}`; if (f.isDirectory()) walk(rel); else if (/\.js$/.test(f.name) && !/bundle/.test(f.name) && /bypassBackground/.test(read(rel))) holders.push(rel); } };
  walk('src');
  const expected = ['src/features/background-runner.js', 'src/features/permission-mode.js', 'src/renderer/settings.js', 'src/settings/settings-backend.js'];
  check('only the runner, the mode logic, Settings and the settings store mention it (no IPC, MCP or chat tool writes it)', JSON.stringify(holders.sort()) === JSON.stringify(expected), holders.join(', '));
  const backend = read('src/settings/settings-backend.js');
  check('Settings writes (prefs:set) answer only the settings page', /handle\('prefs:set', set\)/.test(backend) && /isSettingsSender\(event\)\) throw new Error\('Not allowed'\)/.test(backend));
  check('the background runner reads it live from the settings, not once at task start', /bypassPermissions: \(\) => \{ const s = deps\.readSettings\(\); return s\.bypassPermissions === true && s\.bypassBackground === true; \}/.test(read('src/features/background-runner.js')));

  // Leaving Bypass switches it off
  check('choosing Bypass leaves the background option as it was', !('bypassBackground' in PM.patchOf('bypass')));
  check('choosing Ask or Auto-allow switches the background option off', PM.patchOf('ask').bypassBackground === false && PM.patchOf('auto').bypassBackground === false);
  const after = { bypassPermissions: true, bypassBackground: true, askBeforeActing: true };
  Object.assign(after, PM.patchOf('ask'));
  check('Bypass on + background on, then back to Ask: both are off, so choosing Bypass again does not reach tasks', PM.modeOf(after) === 'ask' && after.bypassBackground === false);
  const en = require('../../src/locales/en.json');
  check('the setting says tasks are no longer held to their allowed sites and that it switches itself off', /allowed sites/.test(en['settings.ai.bypassBackgroundDesc']) && /switches itself off/.test(en['settings.ai.bypassBackgroundDesc']));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

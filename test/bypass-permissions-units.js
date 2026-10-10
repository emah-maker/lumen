// Bypass permissions (Settings → AI, the bolt menu in the sidebar head; agent.js askApproval / bypassOn, features/permission-mode.js),
// plain Node: no Electron. With it on, every approval card is answered "allow" by itself and shown as a step ("Allowed automatically:
// …"); with it off each card still asks. Covers one check per card type, the user's own blocks (AI off on a site, a tab kept off,
// hands-off mode) that still refuse first, the "Choose file…" card that still needs the user, outside agents, and the pure mode logic.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Agent } = require('../src/ai/agent');
const PM = require('../src/features/permission-mode');
const { DEFAULTS } = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// ---- the pure mode logic
{
  check('modes: ask is the default, and every mode round-trips through its settings', PM.modeOf({}) === 'ask' && PM.modeOf(undefined) === 'ask' && PM.MODES.every((m) => PM.modeOf(PM.patchOf(m)) === m), J(PM.MODES.map((m) => PM.patchOf(m))));
  check('modes: an old settings file with askBeforeActing:false is still Auto-allow actions', PM.modeOf({ askBeforeActing: false }) === 'auto');
  check('modes: bypass wins over auto, and only a real true counts', PM.modeOf({ bypassPermissions: true, askBeforeActing: false }) === 'bypass' && PM.modeOf({ bypassPermissions: 'yes' }) === 'ask');
  check('modes: something that is not a mode is refused', PM.patchOf('everything') === null && PM.patchOf(undefined) === null);
  check('modes: Bypass is off by default in the settings', DEFAULTS.bypassPermissions === false && DEFAULTS.askBeforeActing === true);
  const en = require('../src/locales/en.json');
  const keys = ['title', 'btn.ask', 'btn.auto', 'btn.bypass', 'ask', 'ask.desc', 'auto', 'auto.desc', 'bypass', 'bypass.desc', 'confirm', 'note'].map((k) => `sidebar.perm.${k}`)
    .concat(['composer.bypass', 'composer.bypass.title', 'settings.ai.permissionMode', 'settings.ai.permissionModeDesc', 'settings.ai.permissionMode.ask', 'settings.ai.permissionMode.auto', 'settings.ai.permissionMode.bypass']);
  check('strings: every key the bolt menu, badge and Settings use exists', keys.every((k) => typeof en[k] === 'string'), keys.filter((k) => typeof en[k] !== 'string').join(', '));
  check('strings: the warning says what the user gives up', /won’t ask before acting, reading PDFs, using your signed-in accounts, or sending what it read anywhere/.test(en['sidebar.perm.bypass.desc']));
  check('strings: Settings says the file picker still needs the user, and that AI-off, kept-off tabs and hands-off still apply', /Choose file/.test(en['settings.ai.permissionModeDesc']) && /Hands-off/.test(en['settings.ai.permissionModeDesc']) && /turned AI off/.test(en['settings.ai.permissionModeDesc']) && /Hands-off/.test(en['sidebar.perm.note']) && /file for an upload still needs you/.test(en['sidebar.perm.note']));
}

// ---- the agent with real approval cards: asked, or answered by itself
const state = { url: 'https://site.test/page', aiOff: new Set(), off: new Set(), handsOff: false, auto: false, bypass: false };
const wc = { id: 7, getURL: () => state.url, isDestroyed: () => false };
const tab = { id: 1, webContents: wc };
const ext = { isExternal: (n) => n === 'mcp__srv__lookup', lookupTool: () => ({ server: 'srv', tool: 'lookup' }), isAlwaysAllowed: () => false, setAlwaysAllowed: () => {} };
const browser = {
  activeTab: () => tab, tabById: (id) => (id === 1 ? tab : null), listTabs: () => [{ id: 1, title: 't', url: state.url, active: true }],
  effectiveModel: (m) => m, aiOff: (url) => state.aiOff.has(new URL(url).host), noTabReason: () => 'No tab open.', maxSteps: () => 0,
  autoApprove: () => state.auto, bypassPermissions: () => state.bypass, handsOff: () => state.handsOff, isAiTab: () => false, tabOff: (id) => state.off.has(id), typingText: () => '',
  externalTools: ext,
};
const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
agent.closeSignedInTabs = () => {};
agent.newActionLog = () => ({});
agent.undoSummary = () => null;
agent.pdfTarget = async () => ({ url: 'https://site.test/report.pdf', wc });
const signal = new AbortController().signal;
const events = [];
let answer = false; // what the user says to a card that is shown
const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, answer)); };
const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
const cards = () => events.filter((e) => e.type === 'approval');
const autoSteps = () => events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed');
const reset = () => { events.length = 0; answer = false; state.bypass = false; state.auto = false; state.handsOff = false; state.aiOff.clear(); state.off.clear(); state.url = 'https://site.test/page'; };
const gateOf = (extra = {}) => ({ emit, signal, hosts: new Set(), who: 'Claude', external: false, noAsk: false, run: { tainted: false }, ...extra });
const call = (name, input, extra = {}) => agent.inTask(1, signal, () => agent.ensureAllowed(name, emit, signal, { ...gateOf(extra), input }), chat());

// Each card type: how to raise it, the action it carries, and what the step says when it is allowed by itself.
const CASES = [
  { name: 'interact (a new site)', action: undefined, run: () => call('click', { element_id: 1 }), step: /Allowed automatically: Claude interacting with site\.test/ },
  { name: 'script (run_script after reading)', action: 'script', run: () => call('run_script', { code: '1' }, { run: { tainted: true } }), step: /Allowed automatically: running a script on site\.test/ },
  { name: 'open (a new site after reading)', action: 'open', run: () => call('navigate', { url: 'https://other.test/' }, { run: { tainted: true } }), step: /Allowed automatically: open other\.test/ },
  { name: 'search (DuckDuckGo after reading)', action: 'open', run: () => call('web_search', { query: 'cats' }, { run: { tainted: true } }), step: /Allowed automatically: search DuckDuckGo for/ },
  { name: 'image prompt (after reading)', action: 'open', run: () => call('generate_image', { prompt: 'a cat' }, { run: { tainted: true } }), step: /Allowed automatically: sending a picture request to an image AI/ },
  { name: 'PDF (read_pdf)', action: 'pdf', run: () => call('read_pdf', { url: 'https://site.test/report.pdf' }), step: /Allowed automatically: reading report\.pdf/ },
  { name: 'MCP-client tool (external tool)', action: 'tool', run: () => call('mcp__srv__lookup', { q: 1 }), step: /Allowed automatically: use lookup from srv/ },
  { name: 'signed-in account (read_urls as_user)', action: 'signin', run: async () => { const grant = await agent.askSignedIn({ host: 'bank.test', offerAlways: true, sensitive: false }, gateOf()); if (!grant) throw new Error('not granted'); return grant; }, step: /Allowed automatically: using your signed-in bank\.test account/ },
  { name: 'terminal command (Grok Build run_terminal_command)', action: 'terminal', run: async () => { if (!(await agent.askApproval('run_terminal_command', emit, signal, { action: 'terminal', title: 'Grok wants to run a terminal command', args: 'ls -la' }))) throw new Error('denied'); }, step: /Allowed automatically: run a terminal command: ls -la/ },
  { name: 'upload (attached file to a site)', action: 'upload', run: async () => { if (!(await agent.askApproval('site.test', emit, signal, { action: 'upload', who: 'Claude', title: 'Claude wants to upload cv.pdf to site.test', upload: { files: [{ name: 'cv.pdf', size: 4 }] } }))) throw new Error('denied'); }, step: /Allowed automatically: upload cv\.pdf to site\.test/ },
];

(async () => {
  for (const c of CASES) {
    // off: the card is shown, and a "no" refuses
    reset();
    const no = await refused(c.run);
    check(`${c.name}: with bypass off it asks (a card is shown), and No refuses`, cards().length === 1 && cards()[0].action === c.action && no !== null && autoSteps().length === 0, J({ cards: cards().map((x) => x.action), no }));
    // off, answered yes: the card is the only way in
    reset();
    answer = true;
    const yes = await refused(c.run);
    check(`${c.name}: with bypass off a Yes on the card lets it through`, yes === null && cards().length === 1 && autoSteps().length === 0, yes);
    // on: no card, allowed, and a step says so
    reset();
    state.bypass = true;
    const on = await refused(c.run);
    const step = autoSteps()[0];
    const done = events.find((e) => e.type === 'tool_done' && e.id === step?.id);
    check(`${c.name}: with bypass on there is no card, it is allowed, and a step says "Allowed automatically"`, on === null && cards().length === 0 && autoSteps().length === 1 && c.step.test(step?.label || '') && done?.ok === true, J({ on, label: step?.label, cards: cards().length }));
  }

  // Auto-allow actions (today's bolt) is a different level: it still asks about everything but the per-site cards
  {
    reset();
    state.auto = true;
    const site = await refused(() => call('click', { element_id: 1 }));
    check('auto-allow actions (not bypass): the per-site card is skipped quietly (no step)', site === null && cards().length === 0 && autoSteps().length === 0, site);
    reset();
    state.auto = true;
    const pdf = await refused(() => call('read_pdf', { url: 'https://site.test/report.pdf' }));
    check('auto-allow actions (not bypass): a PDF still asks', cards().length === 1 && cards()[0].action === 'pdf' && pdf !== null, J(cards()));
    reset();
    state.auto = true;
    const tool = await refused(() => call('mcp__srv__lookup', {}));
    check('auto-allow actions (not bypass): an MCP-client tool still asks', cards().length === 1 && cards()[0].action === 'tool' && tool !== null);
  }

  // The same card, once per chat: a PDF allowed by itself is remembered like an answered one
  {
    reset();
    state.bypass = true;
    const run = { tainted: false };
    await call('read_pdf', { url: 'https://site.test/report.pdf' }, { run });
    await call('read_pdf', { url: 'https://site.test/report.pdf' }, { run });
    check('a PDF allowed by itself is allowed for the rest of the chat (one step, like one card)', autoSteps().length === 1, J(autoSteps()));
  }

  // The user's own blocks still refuse first, with no card and no "Allowed automatically" step
  {
    reset();
    state.bypass = true;
    state.aiOff.add('site.test');
    let msg = await refused(() => call('click', { element_id: 1 }));
    check('bypass on: a site with AI off still refuses (before any card)', /turned off AI on site\.test/.test(msg || '') && events.length === 0, msg);
    msg = await refused(() => call('navigate', { url: 'https://site.test/x' }));
    check('bypass on: opening a site with AI off is still refused', /turned off AI on site\.test/.test(msg || '') && events.length === 0, msg);
    reset();
    state.bypass = true;
    state.off.add(1);
    msg = await refused(() => call('click', { element_id: 1 }));
    check('bypass on: a tab kept off (the shield) still refuses', /keeps the AI from acting on this tab/.test(msg || '') && events.length === 0, msg);
    reset();
    state.bypass = true;
    state.handsOff = true;
    msg = await refused(() => call('click', { element_id: 1 }));
    check('bypass on: hands-off mode still refuses', /Hands-off mode is on/.test(msg || '') && events.length === 0, msg);
    msg = await refused(() => call('upload_file', { element_id: 1 }));
    check('bypass on: hands-off mode still refuses an upload', /Hands-off mode is on/.test(msg || '') && events.length === 0, msg);
    reset();
    state.bypass = true;
    state.off.add(1);
    msg = await refused(() => call('run_script', { code: '1' }, { run: { tainted: true } }));
    check('bypass on: a script on a kept-off tab is still refused', /keeps the AI from acting on this tab/.test(msg || '') && events.length === 0, msg);
  }

  // The file picker needs the user's hands: bypass cannot choose a file for them
  {
    reset();
    state.bypass = true;
    const pick = agent.askApproval('site.test', emit, signal, { action: 'upload-pick', who: 'Claude', title: 'Claude needs a file for site.test', upload: { label: 'Resume' } });
    check('bypass on: the "Choose file…" card still waits for the user', cards().length === 1 && cards()[0].action === 'upload-pick' && autoSteps().length === 0);
    agent.resolveApproval(cards()[0].approvalId, false);
    check('bypass on: and a Cancel on it is a no', (await pick) === false);
  }

  // Outside agents (MCP) are covered too, in or out of their own window
  {
    reset();
    state.bypass = true;
    const own = await refused(() => call('click', { element_id: 1 }, { who: 'Codex', external: true, noAsk: false }));
    check('bypass on: an outside agent (no "don\'t ask" setting) gets no site card either, and a step shows it', own === null && cards().length === 0 && autoSteps().length === 1 && /Codex interacting with site\.test/.test(autoSteps()[0].label), own);
    reset();
    const asks = await refused(() => call('click', { element_id: 1 }, { who: 'Codex', external: true, noAsk: false }));
    check('bypass off: the same outside agent still asks', cards().length === 1 && asks !== null);
    reset();
    state.bypass = true;
    const pdf = await refused(() => call('read_pdf', { url: 'https://site.test/report.pdf' }, { who: 'Codex', external: true }));
    check('bypass on: an outside agent reading a PDF is allowed by itself', pdf === null && cards().length === 0 && /reading report\.pdf/.test(autoSteps()[0]?.label || ''), pdf);
    reset();
    state.bypass = true;
    const open = await refused(() => call('navigate', { url: 'https://other.test/' }, { who: 'Codex', external: true, run: { tainted: true } }));
    check('bypass on: an outside agent that read a page may open a new site', open === null && cards().length === 0 && autoSteps().length === 1, open);
    reset();
    state.bypass = true;
    const toolMsg = await refused(() => call('mcp__srv__lookup', {}, { who: 'Codex', external: true }));
    check('bypass on: an outside agent still never gets the sidebar\'s MCP-client tools', /Unknown tool/.test(toolMsg || '') && cards().length === 0, toolMsg);
  }

  // A page that redirects to another site after reading: bypass lets the load go on (it is the same card, answered)
  {
    const guard = async (bypass) => {
      reset();
      state.bypass = bypass;
      const w = Object.assign(new EventEmitter(), { isDestroyed: () => false });
      let prevented = false;
      await agent.inTask(1, signal, async () => {
        await agent.ensureAllowed('navigate', emit, signal, { ...gateOf({ run: { tainted: true }, hosts: new Set(['site.test']) }), input: { url: 'https://site.test/' } });
        const g = agent.guardRedirects(w);
        w.emit('will-redirect', { preventDefault: () => { prevented = true; }, url: 'https://evil.test/' }, 'https://evil.test/', false, true);
        g?.release();
      }, chat());
      return prevented;
    };
    check('redirect guard: with bypass off a redirect to an unapproved site is stopped', (await guard(false)) === true);
    check('redirect guard: with bypass on it is not stopped', (await guard(true)) === false);
  }

  // A background task bypasses only with both switches on (Bypass permissions and bypassBackground; test/bypass-background-units.js)
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'background-runner.js'), 'utf8');
    check('background tasks: their agent bypasses only when bypassPermissions and bypassBackground are both true', /bypassPermissions: \(\) => \{ const s = deps\.readSettings\(\); return s\.bypassPermissions === true && s\.bypassBackground === true; \}/.test(src));
    const bare = new Agent({ activeTab: () => null, listTabs: () => [], noTabReason: () => '' }, () => null, () => ({}));
    check('an agent whose browser has no bypass switch never bypasses', bare.bypassOn() === false);
  }

  // The main process wires it: one switch (the IPC), read through the agent's browser
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    check('main: the agent reads bypassPermissions from the saved setting (never from the test flag)', /bypassPermissions: \(\) => readSettings\(\)\.bypassPermissions === true/.test(main));
    check('main: the bolt menu and Settings have one IPC, allowed for the UI and the chat page', /ipcMain\.handle\('agent:permission-mode'/.test(main) && /'agent:permission-mode'/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'chat-page.js'), 'utf8')));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

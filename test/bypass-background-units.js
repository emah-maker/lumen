// [bypass permissions] Settings → AI → "Bypass in background tasks and routines too" (bypassBackground), plain Node: a
// background task's agent (TaskAgent, features/background-runner.js) answers its cards itself only when Bypass permissions
// AND this switch are on, the buy / send / submit step included, and lists each as a step; with either off the card waits
// for the user. Plus the default, the strings, and the docs.
const fs = require('fs');
const path = require('path');
const { TaskAgent } = require('../src/features/background-runner');
const { DEFAULTS } = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// The runner's own rule, as written in background-runner.js (checked against the source below).
const settings = { bypassPermissions: false, bypassBackground: false };
const rule = () => settings.bypassPermissions === true && settings.bypassBackground === true;

(async () => {
  const wc = { id: 3, getURL: () => 'https://shop.test/cart', isDestroyed: () => false };
  const tab = { id: 1, webContents: wc };
  const browser = {
    activeTab: () => tab, tabById: () => tab, listTabs: () => [{ id: 1, title: 'Cart', url: wc.getURL(), active: true }], noTabReason: () => '',
    effectiveModel: (m) => m, aiOff: () => false, maxSteps: () => 0, autoApprove: () => false, bypassPermissions: rule, handsOff: () => false,
    isAiTab: () => false, tabOff: () => false, typingText: () => '',
  };
  const risk = { host: 'shop.test', what: 'place an order on shop.test', detail: 'Total: $40' };
  const agent = new TaskAgent(browser, () => null, () => ({ model: 'claude-opus-5' }), () => null, { riskOf: async () => risk });
  const signal = new AbortController().signal;
  const run = async (answer) => {
    const events = [];
    const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, answer)); };
    // super.ensureAllowed's own site gate is not what is tested here: only the risk card TaskAgent adds.
    const proto = Object.getPrototypeOf(TaskAgent.prototype);
    const saved = proto.ensureAllowed;
    proto.ensureAllowed = async () => {};
    let error = null;
    try { await agent.ensureAllowed('click', emit, signal, { input: {}, who: 'The task' }); } catch (err) { error = err.message; } finally { proto.ensureAllowed = saved; }
    return { cards: events.filter((e) => e.type === 'approval'), steps: events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed'), error };
  };

  let r = await run(false);
  check('both off: the buy step shows a card and waits for the user (refused here)', r.cards.length === 1 && r.steps.length === 0 && /did not allow/.test(r.error || ''), JSON.stringify(r));
  settings.bypassPermissions = true;
  r = await run(false);
  check('Bypass permissions alone: a background task still asks', r.cards.length === 1 && r.steps.length === 0, JSON.stringify(r));
  settings.bypassPermissions = false; settings.bypassBackground = true;
  r = await run(false);
  check('the background switch alone does nothing', r.cards.length === 1 && r.steps.length === 0, JSON.stringify(r));
  settings.bypassPermissions = true;
  r = await run(false);
  check('both on: no card, the step is allowed and listed', r.cards.length === 0 && r.steps.length === 1 && r.error === null, JSON.stringify(r));

  const src = read('src/features/background-runner.js');
  check('the runner uses exactly this rule', /bypassPermissions: \(\) => \{ const s = deps\.readSettings\(\); return s\.bypassPermissions === true && s\.bypassBackground === true; \}/.test(src));
  check('off by default', DEFAULTS.bypassBackground === false);
  const en = JSON.parse(read('src/locales/en.json'));
  check('Settings has its strings, and they say what it gives up', en['settings.ai.bypassBackground'] && /buy, send, post or submit/.test(en['settings.ai.bypassBackgroundDesc'] || '') && /does nothing/.test(en['settings.ai.bypassBackgroundDesc'] || ''));
  check('the Bypass text no longer says background tasks never bypass', !/Background tasks never bypass/.test(en['settings.ai.permissionModeDesc']) && !/Background tasks never bypass/.test(read('README.md')) && !/Background tasks never bypass/.test(read('docs/settings.md')));
  check('docs/settings.md has its row', read('docs/settings.md').includes('`bypassBackground`'));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

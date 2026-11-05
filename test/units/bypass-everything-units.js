// Bypass permissions skips every card, plain Node: the cards that used to opt out of it (noBypass: a memory save after reading a page,
// a connector's write, a Gmail send) and the ones that ask even with Auto-allow on (the content-loss card, a file on this computer).
// For each one: Ask and Auto-allow actions show the card, and a "no" refuses; Bypass answers allow with no card and an
// "Allowed automatically" step naming what it allowed. The "Choose file…" picker still waits for the user (bypass-permissions-units.js).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../../src/ai/agent');
const registry = require('../../src/features/connectors/registry');
const sendLib = require('../../src/features/gmail-send');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const J = (v) => JSON.stringify(v);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message || String(e); } };

const state = { auto: false, bypass: false };
const connectors = {
  hasAny: () => true,
  isWrite: () => true,
  isSend: (i) => i.app === 'gmail' && i.action === 'send',
  describeWrite: async (i) => (i.action === 'send'
    ? { title: 'Send an email to jane@x.org: “Late”', detail: 'To: jane@x.org\nSubject: Late', fixed: 'From: ada@example.com', fields: [], names: {} }
    : { title: 'Comment on ada/notes#7', detail: 'From the AI', fixed: 'Comment on ada/notes#7', fields: [] }),
  alwaysList: () => [],
};
const browser = { connectors, autoApprove: () => state.auto, bypassPermissions: () => state.bypass, memory: { on: () => true } };
const agent = new Agent(browser, () => null, () => ({}));
const signal = new AbortController().signal;
const events = [];
const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, false)); }; // a card shown: the user says no
const cards = () => events.filter((e) => e.type === 'approval');
const steps = () => events.filter((e) => e.type === 'tool' && e.name === 'auto_allowed');
const tainted = () => { const run = { chat: Object.assign([], { settings: {}, typed: [] }) }; agent.markTainted(run, {}); return run; };
const gate = (extra = {}) => ({ emit, signal, who: 'Claude', external: false, noAsk: false, run: {}, ...extra });
registry.setConnected(['github', 'gmail']);

// Each former noBypass card (and the cards Auto-allow never answers): how to raise it, and what its step says under Bypass.
const CASES = [
  { name: 'a memory save after reading a page', run: () => agent.allowMemory({ action: 'add', text: 'Likes jazz' }, gate({ run: tainted() })), step: /Allowed automatically: remember: “Likes jazz”/ },
  { name: 'a connector write (a GitHub comment)', run: () => agent.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'From the AI' } }, gate()), step: /Allowed automatically: Comment on ada\/notes#7/ },
  { name: 'a Gmail send', run: () => agent.allowConnector({ app: 'gmail', action: 'send', args: { to: 'jane@x.org', subject: 'Late', body: 'Running late' } }, gate({ run: { chat: Object.assign([], { typed: [] }) } })), step: /Allowed automatically: Send an email to jane@x\.org/ },
  { name: 'the content-loss card (deletes or replaces a lot)', run: async () => { if (!(await agent.askApproval('docs.google.com', emit, signal, { action: 'content-loss', who: 'Claude', title: 'The AI is about to delete 3 paragraphs', args: '3 paragraphs', upload: { phase: 'before', undone: false } }))) throw new Error('did not allow'); }, step: /Allowed automatically: to delete 3 paragraphs/ },
  { name: 'a file on this computer (Share … with the AI?)', run: async () => { const plan = await agent.screenAskFile({ capture: true, ask: true, local: { url: 'file:///C:/Docs/notes.txt', name: 'notes.txt' } }, { emit, signal }); if (plan.why === 'declined') throw new Error('did not allow'); }, step: /Allowed automatically: shared notes\.txt/ },
];

(async () => {
  for (const c of CASES) {
    for (const mode of ['ask', 'auto']) {
      events.length = 0;
      state.auto = mode === 'auto'; state.bypass = false;
      const no = await refused(c.run);
      check(`${c.name}: ${mode === 'ask' ? 'Ask' : 'Auto-allow actions'} shows the card, and No refuses`, cards().length === 1 && steps().length === 0 && no !== null, J({ cards: cards().length, steps: steps().length, no }));
    }
    events.length = 0;
    state.auto = false; state.bypass = true;
    const on = await refused(c.run);
    check(`${c.name}: Bypass permissions answers allow with no card, and a step names it`, on === null && cards().length === 0 && steps().length === 1 && c.step.test(steps()[0].label), J({ on, events }));
  }

  // The cards that were marked noBypass are still marked for lumen://tasks (answered only on their own card), under the new name
  {
    let seen = null;
    const real = agent.askApproval;
    agent.askApproval = async (host, _e, _s, opts) => { seen = opts; return true; };
    await agent.allowMemory({ action: 'add', text: 'Likes tea' }, gate({ run: tainted() }));
    const memory = seen;
    await agent.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'x' } }, gate());
    agent.askApproval = real;
    check('the memory and connector cards carry guarded (for lumen://tasks), and nothing carries noBypass', memory?.guarded === true && seen?.guarded === true && !('noBypass' in memory) && !('noBypass' in seen), J({ memory, seen }));
  }

  // A Gmail send under Bypass is logged as such, not as "you pressed Send"
  {
    events.length = 0;
    state.bypass = true;
    const input = { app: 'gmail', action: 'send', args: { to: 'jane@x.org', subject: 'Late', body: 'Running late' } };
    await agent.allowConnector(input, gate({ run: { chat: Object.assign([], { typed: [] }) } }));
    check('a send allowed by Bypass goes to the service as via "bypass"', agent.sendVias?.get(input) === 'bypass', J(agent.sendVias?.get(input)));
    state.bypass = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bypass-everything-'));
    const log = sendLib.createLog({ file: path.join(dir, 'log.json'), now: () => 1000 });
    log.record({ to: 'jane@x.org', subject: 'Late', via: 'bypass' });
    log.record({ to: 'jane@x.org', subject: 'Late', via: 'card' });
    check('the send log keeps "bypass" apart from a click on Send', log.list().map((e) => e.via).join() === 'card,bypass', J(log.list()));
  }

  // Background tasks and routines keep their own opt-in: a connector write there is still refused, card or no card
  {
    events.length = 0;
    const bg = new Agent({ ...browser, background: true, bypassPermissions: () => true }, () => null, () => ({}));
    const msg = await refused(() => bg.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'x' } }, gate()));
    check('a background task\'s connector write is still refused, even with Bypass in the background on', /can only read/.test(msg || '') && cards().length === 0 && steps().length === 0, msg);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();

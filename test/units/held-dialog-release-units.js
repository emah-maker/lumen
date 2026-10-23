// A confirm/prompt held for the AI (page-debug.js pageDialog) is let go when the run that holds it ends or is stopped, so the
// page's sync IPC never stays blocked. Plain Node: no Electron; the tab and the page are fakes.
// Covers: Stop -> the user gets the dialog (tab open) or it is answered "cancel" (tab closed); a run that finishes while holding;
// another chat's held dialog untouched; and a sync-IPC handler that throws still answers the renderer.
require('../helpers/_tmp-cleanup');
const { EventEmitter } = require('events');
const { Agent, pageDebugShared } = require('../../src/ai/agent');
const { replyOnThrow } = require('../../src/ai/page-debug');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

let nextId = 9000;
const fakeWc = () => {
  const wc = new EventEmitter();
  wc.id = nextId++;
  wc.getURL = () => 'https://shop.test/';
  wc.isDestroyed = () => Boolean(wc.destroyed);
  wc.debugger = { isAttached: () => false };
  return wc;
};
function makeAgent(wc) {
  const browser = { activeTab: () => ({ id: 1, webContents: wc }), tabById: () => ({ id: 1, webContents: wc }), effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, bypassPermissions: () => false, handsOff: () => false, tabOff: () => false, isAiTab: () => false };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  agent.closeSignedInTabs = () => {};
  agent.debugWc = () => wc;
  return agent;
}
// The page calls confirm() while a tool of the run is clicking in the tab.
function pageConfirm(wc, log, tag) {
  return pageDebugShared.pageDialog(wc, { kind: 'confirm', message: 'Delete?' }, (a) => log.push(`${tag}:answer:${a}`), () => log.push(`${tag}:user`));
}
const holdingTool = (wc, log, tag) => async () => { pageConfirm(wc, log, tag); return 'clicked'; };

(async () => {
  // ---- Stop while held, tab still open: the user gets the dialog
  {
    const wc = fakeWc(); const agent = makeAgent(wc); const log = [];
    agent.executeGuarded = holdingTool(wc, log, 'a');
    const ctl = new AbortController();
    let finish; const gate = new Promise((r) => { finish = r; });
    const run = agent.inTask(1, ctl.signal, async () => { await agent.executeDebugged('click', {}); await gate; }, {});
    await new Promise((r) => setTimeout(r, 20));
    check('held: the dialog is held for the AI, nothing answered yet', pageDebugShared.captureOf(wc).dialog && log.length === 0, log.join());
    ctl.abort();
    check('Stop: the held dialog goes to the user at once (run still unwinding)', log.join() === 'a:user', log.join());
    finish(); await run;
    check('Stop: and is not shown or answered a second time', log.join() === 'a:user' && !pageDebugShared.captureOf(wc).dialog, log.join());
  }

  // ---- Stop while held, tab closed: answered cancel
  {
    const wc = fakeWc(); const agent = makeAgent(wc); const log = [];
    agent.executeGuarded = holdingTool(wc, log, 'b');
    const ctl = new AbortController();
    let finish; const gate = new Promise((r) => { finish = r; });
    const run = agent.inTask(1, ctl.signal, async () => { await agent.executeDebugged('click', {}); await gate; }, {});
    await new Promise((r) => setTimeout(r, 20));
    wc.destroyed = true; // (a closed tab answers "no" itself from its destroyed event)
    ctl.abort();
    finish(); await run;
    check('tab closed while held: answered cancel, never shown', log.join() === 'b:answer:false', log.join());
  }

  // ---- the run finishes normally while holding (the model never called handle_dialog)
  {
    const wc = fakeWc(); const agent = makeAgent(wc); const log = [];
    agent.executeGuarded = holdingTool(wc, log, 'c');
    await agent.inTask(1, new AbortController().signal, () => agent.executeDebugged('click', {}), {});
    check('run ends while held: the dialog goes to the user', log.join() === 'c:user' && !pageDebugShared.captureOf(wc).dialog, log.join());
    wc.destroyed = true;
  }

  // ---- another chat's held dialog is untouched by this chat's Stop and end
  {
    const wcA = fakeWc(); const wcB = fakeWc(); const agent = makeAgent(wcA); const log = [];
    agent.executeGuarded = async () => { pageConfirm(wcA, log, 'A'); return 'x'; };
    agent.debugWc = (name, input) => input.tab === 'B' ? wcB : wcA;
    const execB = holdingTool(wcB, log, 'B');
    const ctlA = new AbortController(); const ctlB = new AbortController();
    let finishB; const gateB = new Promise((r) => { finishB = r; });
    const runB = agent.inTask(1, ctlB.signal, async () => { agent.executeGuarded = async () => execB(); await agent.executeDebugged('click', { tab: 'B' }); await gateB; }, {});
    await new Promise((r) => setTimeout(r, 20));
    agent.executeGuarded = async () => { pageConfirm(wcA, log, 'A'); return 'x'; };
    await agent.inTask(2, ctlA.signal, () => agent.executeDebugged('click', { tab: 'A' }), {}); // A's run ends
    ctlA.abort();
    check('two chats: A ending releases A only', log.join() === 'A:user', log.join());
    check('two chats: B is still held, undisturbed', Boolean(pageDebugShared.captureOf(wcB).dialog), log.join());
    ctlB.abort(); finishB(); await runB;
    check('two chats: B\'s own Stop releases B', log.join() === 'A:user,B:user', log.join());
    wcA.destroyed = true; wcB.destroyed = true;
  }

  // ---- a sync-IPC handler that throws still answers the renderer
  {
    const ev = {};
    const errs = [];
    replyOnThrow(() => { throw new Error('view destroyed'); }, (req) => (req.kind === 'confirm' ? false : null), (e) => errs.push(e.message))(ev, { kind: 'confirm' });
    check('handler throw: the renderer is answered with the cancel value', ev.returnValue === false && errs.join() === 'view destroyed', `${ev.returnValue} ${errs}`);
    const ev2 = {};
    replyOnThrow(() => { throw new Error('x'); }, (req) => (req.kind === 'prompt' ? null : undefined))(ev2, { kind: 'prompt' });
    check('handler throw: a prompt answers null', ev2.returnValue === null);
    const ev3 = {};
    replyOnThrow((e) => { e.returnValue = 'ok'; }, () => 'bad')(ev3, {});
    check('no throw: the handler\'s own answer stands', ev3.returnValue === 'ok');
    const dead = { set returnValue(_v) { throw new Error('gone'); } };
    let threw = false;
    try { replyOnThrow(() => { throw new Error('x'); }, () => 1)(dead, {}); } catch { threw = true; }
    check('handler throw on a dead renderer does not throw out of the listener', !threw);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

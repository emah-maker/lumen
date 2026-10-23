// Stop ends a tool that is already running (agent.stopCheck). Plain Node: no Electron, no network; the page is mocked.
// Covers: fill_form (remaining fields, submit), batch (remaining steps), type_text and drag after Stop, the outside-agent / CLI
// path (the call's signal rides on the task scope), and one chat's Stop never touching another chat's tools.
require('../helpers/_tmp-cleanup');
const { Agent } = require('../../src/ai/agent');
const snapshot = require('../../src/ai/snapshot');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

function makeAgent() {
  const typed = [];
  const wc = { id: 1, getURL: () => 'https://shop.test/', isDestroyed: () => false, isLoading: () => false, isLoadingMainFrame: () => false, executeJavaScript: async () => null, executeJavaScriptInIsolatedWorld: async () => null, insertText: async () => { typed.push('direct'); }, debugger: { isAttached: () => true } };
  const browser = { activeTab: () => ({ id: 1, webContents: wc }), tabById: () => ({ id: 1, webContents: wc }), effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, bypassPermissions: () => false, handsOff: () => false, tabOff: () => false, isAiTab: () => false };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  agent.closeSignedInTabs = () => {};
  agent.requireTab = () => wc;
  agent.refreshRegistry = async () => {};
  agent.resolveTarget = async (_wc, label) => label;
  agent.allowStep = async () => {};
  agent.elementRun = async () => null; // not a toggle (and no form found for submit: the Enter key below is what a submit does here)
  agent.pressKey = () => { typed.push('submit'); };
  return { agent, wc, typed };
}
const fields = (n, p = 'f') => Array.from({ length: n }, (_, i) => ({ label: `${p}${i + 1}`, value: 'x' }));

(async () => {
  // ---- fill_form: Stop at field 3 of 8 with submit
  {
    const { agent, typed } = makeAgent();
    const ctl = new AbortController();
    agent.execute = async (name, input) => { typed.push(input.element_id); if (input.element_id === 'f3') ctl.abort(); return 'ok'; };
    const err = await rejects(() => agent.inTask(1, ctl.signal, () => agent.executeGuardedCore('fill_form', { fields: fields(8), submit: true })));
    check('fill_form: Stop at field 3 fills no more fields and never submits', typed.join() === 'f1,f2,f3' && /Stopped by the user/.test(err || ''), `${typed} ${err}`);
  }
  {
    const { agent, typed } = makeAgent();
    const ctl = new AbortController();
    agent.execute = async (name, input) => { typed.push(input.element_id); if (input.element_id === 'f2') ctl.abort(); return 'ok'; };
    const err = await rejects(() => agent.inTask(1, ctl.signal, () => agent.executeGuardedCore('fill_form', { fields: fields(2), submit: true })));
    check('fill_form: Stop during the last field still does not submit', !typed.includes('submit') && /Stopped by the user/.test(err || ''), `${typed} ${err}`);
  }

  // ---- batch: Stop after step 2 of 5
  {
    const { agent, typed } = makeAgent();
    const ctl = new AbortController();
    agent.execute = async (name, input) => { typed.push(input.element_id); if (input.element_id === 's2') ctl.abort(); return 'ok'; };
    const steps = [1, 2, 3, 4, 5].map((n) => ({ do: 'type', ref: `s${n}`, text: 'x' }));
    const err = await rejects(() => agent.inTask(1, ctl.signal, () => snapshot.execute(agent, 'batch', { steps }, { runScript: async () => null, scripts: {}, dedupe: () => false })));
    check('batch: Stop after step 2 runs no later step', typed.join() === 's1,s2' && /Stopped by the user/.test(err || ''), `${typed} ${err}`);
  }

  // ---- type_text and drag after Stop do nothing
  {
    const { agent, typed } = makeAgent();
    const ctl = new AbortController();
    ctl.abort();
    const err = await rejects(() => agent.inTask(1, ctl.signal, () => agent.executeRaw('type_text', { element_id: 'f1', text: 'hello' })));
    check('type_text after Stop types nothing', /Stopped by the user/.test(err || '') && typed.length === 0, `${typed} ${err}`);
    const drag = await rejects(() => agent.inTask(1, ctl.signal, () => agent.executeRaw('drag', { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })));
    check('drag after Stop does nothing', /Stopped by the user/.test(drag || ''), drag);
    // Stop lands while type_text is still focusing the field: the text is not sent
    const live = new AbortController();
    agent.keepUserFocus = async (_wc, fn) => fn();
    agent.elementRun = async () => { live.abort(); return 'ok'; }; // (the field took focus; Stop came meanwhile)
    const mid = await rejects(() => agent.inTask(1, live.signal, () => agent.executeGuardedCore('type_text', { element_id: 'f1', text: 'hello' })));
    check('type_text: Stop while focusing the field sends no text', /Stopped by the user/.test(mid || '') && !typed.includes('direct'), `${typed} ${mid}`);
  }

  // ---- the outside-agent / CLI path: the call's signal is the task scope's signal (features/ai-agents.js inTask / inScope)
  {
    const { agent, typed } = makeAgent();
    const ctl = new AbortController();
    agent.execute = async (name, input) => { typed.push(input.element_id); if (input.element_id === 'f2') ctl.abort(); return 'ok'; };
    const viaTask = await rejects(() => agent.inTask(1, ctl.signal, () => agent.executeGuardedCore('fill_form', { fields: fields(5), submit: true }), null, null, { mcp: true }));
    check('MCP call (inTask with the call signal): Stop mid fill_form stops it and skips submit', typed.join() === 'f1,f2' && /Stopped/.test(viaTask || ''), `${typed} ${viaTask}`);
    const engine = new AbortController();
    const scope = { tabId: 1, signal: engine.signal, chat: null, log: null };
    typed.length = 0;
    agent.execute = async (name, input) => { typed.push(input.element_id); if (input.element_id === 'f1') engine.abort(); return 'ok'; };
    const viaScope = await rejects(() => agent.inScope(scope, () => agent.executeGuardedCore('fill_form', { fields: fields(5), submit: true })));
    check('CLI engine call (inScope with the run\'s scope): Stop mid fill_form stops it', typed.join() === 'f1' && /Stopped/.test(viaScope || ''), `${typed} ${viaScope}`);
    check('a call with no task scope is not affected', (() => { try { agent.stopCheck(); return true; } catch { return false; } })());
  }

  // ---- two chats at once: Stop in one leaves the other's tools alone
  {
    const { agent, typed } = makeAgent();
    const a = new AbortController();
    const b = new AbortController();
    const ran = { a: [], b: [] };
    agent.execute = async (name, input) => { (input.element_id.startsWith('a') ? ran.a : ran.b).push(input.element_id); if (input.element_id === 'a2') a.abort(); await new Promise((r) => setTimeout(r, 5)); return 'ok'; };
    const [ra, rb] = await Promise.all([
      rejects(() => agent.inTask(1, a.signal, () => agent.executeGuardedCore('fill_form', { fields: fields(4, 'a'), submit: true }), [], null, { chatId: 'A' })),
      rejects(() => agent.inTask(1, b.signal, () => agent.executeGuardedCore('fill_form', { fields: fields(4, 'b'), submit: true }), [], null, { chatId: 'B' })),
    ]);
    check('parallel chats: chat A stops after its Stop', ran.a.join() === 'a1,a2' && /Stopped/.test(ra || ''), `${ran.a} ${ra}`);
    check('parallel chats: chat B fills every field and submits', ran.b.join() === 'b1,b2,b3,b4' && rb === null && typed.includes('submit'), `${ran.b} ${rb} ${typed}`);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

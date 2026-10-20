// Antigravity subagents as helper rows ("Helper · ..."), plain Node: no Electron, no real agy, no network.
// What agy 1.2.14 documents (read from its own embedded docs and changelog, no model call): the hook payload's common field
// conversationId (a subagent is a conversation of its own, with a parent_conversation_id), and the stream's subagent_info
// ({ conversation_id, log_uri }) on the parent's invoke_subagent step. The payloads below have those shapes.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { helperRows, helperLabel } = require('../src/ai/agy-tools');
const ag = require('../src/ai/antigravity');
const { startHttp } = require('../src/automation/mcp-http');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agyrows-'));
const hook = (conv, name, args = {}) => ({ toolCall: { name, args }, stepIdx: 3, conversationId: conv, workspacePaths: ['C:/w'], modelName: 'auto' });

(async () => {
  // ---------- the row logic ----------
  const ev = [];
  const rows = helperRows((e) => ev.push(e));
  check('rows: the run\'s own calls are not helper rows', rows.parent('conv-main') === undefined && rows.call(hook('conv-main', 'run_command', { CommandLine: 'ls' })) === false && ev.length === 0, JSON.stringify(ev));
  check('rows: a call with another conversation id starts a Helper row with a plain label', rows.call(hook('sub-1', 'run_command', { CommandLine: 'npm test' })) === true && ev[0].type === 'tool' && ev[0].label === 'Helper · Running npm test' && ev[0].name === 'run_command' && ev[0].input.CommandLine === 'npm test', JSON.stringify(ev[0]));
  rows.call(hook('sub-1', 'view_file', { AbsolutePath: 'C:\\w\\src\\a.js' }));
  check('rows: the same helper\'s next call ends its previous row', ev[1].type === 'tool_done' && ev[1].id === ev[0].id && ev[1].ok === true && ev[2].label === 'Helper · Reading a.js', JSON.stringify(ev.slice(1)));
  rows.call(hook('sub-2', 'grep_search', { Query: 'TODO' }));
  check('rows: a second helper has rows of its own and does not end the first one\'s', ev[3].label === 'Helper · Searching for TODO' && !ev.slice(3).some((e) => e.type === 'tool_done' && e.id === ev[2].id), JSON.stringify(ev.slice(3)));
  rows.finish('sub-1');
  check('rows: finish(conversation) ends only that helper\'s open row', ev.at(-1).type === 'tool_done' && ev.at(-1).id === ev[2].id && !ev.some((e) => e.type === 'tool_done' && e.id === ev[3].id), JSON.stringify(ev.at(-1)));
  rows.finish();
  check('rows: finish() ends the rest', ev.at(-1).type === 'tool_done' && ev.at(-1).id === ev[3].id, JSON.stringify(ev.at(-1)));
  const before = ev.length;
  rows.call(hook('sub-1', 'mcp_lumen_click', {}));
  rows.call(hook('sub-1', 'mcp__lumen__read_page', {}));
  rows.call({ conversationId: 'sub-1' });
  rows.call(hook('bad id with spaces', 'run_command', { CommandLine: 'x' }));
  rows.call({ toolCall: { name: 'run_command', args: {} } });
  check('rows: Lumen\'s own tools (rows come from the MCP side), a payload without a tool, an unsafe or missing id show nothing', ev.length === before, JSON.stringify(ev.slice(before)));
  const noParent = [];
  const r2 = helperRows((e) => noParent.push(e));
  r2.call(hook('sub-1', 'run_command', { CommandLine: 'ls' }));
  r2.parent('not valid!');
  r2.call(hook('sub-1', 'run_command', { CommandLine: 'ls' }));
  check('rows: with the run\'s own conversation unknown nothing is shown (the behaviour before this)', noParent.length === 0, JSON.stringify(noParent));
  const big = [];
  const r3 = helperRows((e) => big.push(e));
  r3.parent('p');
  r3.call(hook('s', 'write_to_file', { TargetFile: 'C:/w/x.txt', CodeContent: 'y'.repeat(50000), Nested: { a: 1 } }));
  check('rows: a step carries clipped scalar arguments, not a file\'s whole text or nested objects', big[0].label === 'Helper · Editing x.txt' && big[0].input.CodeContent.length <= 200 && !('Nested' in big[0].input), JSON.stringify(big[0]).slice(0, 300));
  check('label: unknown tools are named in plain words, not raw', helperLabel('some_new_tool', {}) === 'Helper · Using some new tool' && helperLabel('invoke_subagent', {}) === 'Helper · Starting another helper', helperLabel('some_new_tool', {}));
  const r4 = helperRows(() => { throw new Error('window gone'); });
  r4.parent('p');
  let threw = false;
  try { r4.call(hook('s', 'run_command', { CommandLine: 'ls' })); } catch { threw = true; }
  check('rows: a failing sink is the caller\'s to handle (the hook wraps it), and finish() never throws', threw && (() => { try { r4.finish(); return true; } catch { return false; } })(), '');

  // ---------- Lumen's gate: the hook payload reaches the rows, and the verdict is unchanged ----------
  const gate = await startHttp({ tools: [{ name: 'click', description: 'c', input_schema: { type: 'object' } }], callTool: async () => ({ content: [], isError: false }) });
  const post = (url, body) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    req.end(JSON.stringify(body));
  });
  const seen = [];
  const full = gate.open('hr-full', 'c-1', { agy: true, fullAccess: true, onCall: (m) => seen.push(m) });
  const off = gate.open('hr-off', 'c-2', { agy: true, fullAccess: false, onCall: (m) => seen.push(m) });
  const bad = gate.open('hr-bad', 'c-3', { agy: true, fullAccess: true, onCall: () => { throw new Error('boom'); } });
  const vFull = await post(full.hookUrl, hook('sub-1', 'run_command', { CommandLine: 'ls' }));
  await post(full.hookUrl, { conversationId: 'conv-main' }); // PreInvocation: no toolCall
  const vOff = await post(off.hookUrl, hook('sub-1', 'run_command', { CommandLine: 'ls' }));
  const vBad = await post(bad.hookUrl, hook('sub-1', 'run_command', { CommandLine: 'ls' }));
  check('gate: full access hands the payload (with conversationId) to onCall and still allows; without full access onCall is not used and the tool is denied', seen.length === 1 && seen[0].conversationId === 'sub-1' && vFull.decision === 'allow' && vOff.decision === 'deny', JSON.stringify({ seen, vFull, vOff }));
  check('gate: a throwing onCall does not change the verdict', vBad.decision === 'allow', JSON.stringify(vBad));
  gate.stop();

  // ---------- the engine, against a fake agy whose stream and hook calls have the documented shapes ----------
  const fakeSpawn = (script) => {
    const spawn = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 8123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      (async () => {
        for (const step of script) { if (typeof step === 'function') await step(); else child.stdout.write(`${JSON.stringify(step)}\n`); await new Promise((r) => setImmediate(r)); }
        child.exitCode = 0;
        child.stdout.end();
        setImmediate(() => child.emit('close', 0));
      })();
      return child;
    };
    return { spawn, kill: (c) => { c.stdout.end(); setImmediate(() => c.emit('close', null)); } };
  };
  const init = { event: 'init', conversation_id: 'conv-main', init: { model: 'gemini-3.8-flash-high' } };
  const say = { event: 'step_update', step_update: { conversation_id: 'conv-main', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Done.' } };
  const delegating = (state) => ({ event: 'step_update', step_update: { conversation_id: 'conv-main', step_index: 2, state, step_type: 'tool', tool_name: 'invoke_subagent', ...(state === 'DONE' ? { tool_info: { name: 'invoke_subagent' }, subagent_info: { conversation_id: 'sub-1', display_name: 'researcher', log_uri: 'file:///x/log' } } : {}) } });
  const result = { event: 'result', result: { conversation_id: 'conv-main', status: 'SUCCESS', response: 'Done.', usage: {} } };
  async function runAgy({ fullAccess, sessionId = null, script }) {
    const data = fs.mkdtempSync(path.join(tmp, 'ag-'));
    const hookCall = {};
    const gateStub = { open(tag, session, opts) { hookCall.fn = opts.onCall; hookCall.opts = opts; return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'm'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close() {} };
    const f = fakeSpawn(script(hookCall));
    const engine = new ag.AntigravityEngine({ userData: data, gate: async () => gateStub, spawn: f.spawn, kill: f.kill });
    engine.bin = process.execPath;
    const events = [];
    const out = await engine.run({ prompt: 'hello', sessionId, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), fullAccess });
    return { out, events, hookCall };
  }
  const call = (h, conv, name, args) => () => h.fn(hook(conv, name, args));
  const a = await runAgy({ fullAccess: true, script: (h) => [init, call(h, 'conv-main', 'run_command', { CommandLine: 'echo own' }), delegating('ACTIVE'), call(h, 'sub-1', 'run_command', { CommandLine: 'dir' }), call(h, 'sub-1', 'view_file', { AbsolutePath: 'C:/w/b.md' }), delegating('DONE'), say, result] });
  const tools = a.events.filter((e) => e.type === 'tool');
  const dones = a.events.filter((e) => e.type === 'tool_done');
  check('engine, full access: the subagent\'s hook calls show as Helper rows; the run\'s own built-in call does not', a.out.text === 'Done.' && tools.length === 2 && tools[0].label === 'Helper · Running dir' && tools[1].label === 'Helper · Reading b.md', JSON.stringify(a.events.map((e) => e.label || e.type)));
  check('engine, full access: every row is ended (the invoke_subagent step is DONE with subagent_info)', dones.length === 2 && tools.every((t) => dones.some((d) => d.id === t.id)), JSON.stringify(dones));
  const b = await runAgy({ fullAccess: true, sessionId: 'conv-main', script: (h) => [call(h, 'sub-9', 'run_command', { CommandLine: 'dir' }), result] });
  const bt = b.events.filter((e) => e.type === 'tool');
  check('engine, resumed conversation: the saved session id is the run\'s own before init arrives; rows are ended when the run ends', bt.length === 1 && b.events.filter((e) => e.type === 'tool_done').length === 1, JSON.stringify(b.events.map((e) => e.type)));
  const c = await runAgy({ fullAccess: false, script: () => [init, say, result] });
  check('engine, no full access: no row logic and no onCall handed to the gate', c.hookCall.opts.onCall === null && !c.events.some((e) => e.type === 'tool'), JSON.stringify(Object.keys(c.hookCall.opts)));
  const d = await runAgy({ fullAccess: true, script: (h) => [init, call(h, 'conv-main', 'run_command', { CommandLine: 'echo own' }), say, result] });
  check('engine, full access, no subagent: nothing is added (the hook\'s calls all carry the run\'s own id)', !d.events.some((e) => e.type === 'tool' || e.type === 'tool_done') && d.out.text === 'Done.', JSON.stringify(d.events.map((e) => e.type)));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

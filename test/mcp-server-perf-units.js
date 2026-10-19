// Plain Node: Lumen's local MCP HTTP server keeps idle keep-alive sockets, arms hooks by event (not a poll), and wait_for's
// text probe ignores whitespace differences.
const http = require('http');
const vm = require('vm');
const { startHttp } = require('../src/automation/mcp-http');
const { createSession } = require('../src/automation/mcp');
const scripts = require('../src/ai/page-scripts');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tools = ['ping', 'click'].map((name) => ({ name, description: 'p', input_schema: { type: 'object' } }));
const okTool = async () => ({ content: [{ type: 'text', text: 'hi' }], isError: false });

function post(agent, port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Two requests on ONE reused socket, idleMs apart.
async function keepAlive(idleMs, opts) {
  const gate = await startHttp({ tools, callTool: okTool, ...opts });
  const { mcpToken } = gate.open('t1');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const call = (id) => post(agent, gate.port, '/mcp', { jsonrpc: '2.0', id, method: 'ping' }, { authorization: `Bearer ${mcpToken}` });
  let ok = false;
  let detail = '';
  try {
    ok = (await call(1)).status === 200;
    await sleep(idleMs);
    ok = ok && (await call(2)).status === 200;
  } catch (err) { ok = false; detail = err.code || err.message; }
  agent.destroy();
  gate.stop();
  return { ok, detail };
}

(async () => {
  // keep-alive: a socket idle past Node's old 5 s default still works (default config), and the timeout is injectable
  const idle = await keepAlive(6000, {});
  check('a keep-alive socket idle for 6 s is still usable (default timeout)', idle.ok, idle.detail);
  const long = await keepAlive(800, { keepAliveMs: 3000 });
  check('an injected longer timeout keeps the socket', long.ok, long.detail);

  // armed(): answered as soon as tools/list arrives, not on a poll; the hold still ends at holdMs; close() wakes it
  {
    const gate = await startHttp({ tools, callTool: okTool, holdMs: 3000 });
    const r = gate.open('hold');
    const hook = (run, event) => post(undefined, gate.port, new URL(run.hookUrl).pathname, { hook_event_name: event });
    const mcp = (msg) => post(undefined, gate.port, '/mcp', msg, { authorization: `Bearer ${r.mcpToken}` });
    const t0 = Date.now();
    const held = hook(r, 'UserPromptSubmit');
    await sleep(150);
    await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const tList = Date.now();
    await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await held;
    const lag = Date.now() - tList;
    check('UserPromptSubmit is held until tools/list, then answered at once', res.status === 200 && Date.now() - t0 >= 150 && lag < 40, `lag ${lag} ms`);
    check('the run is armed and listed', gate.armed('hold') && gate.listed('hold'), '');
    const again = Date.now();
    await hook(r, 'UserPromptSubmit');
    check('an already-listed run is answered without waiting', Date.now() - again < 40, `${Date.now() - again} ms`);

    const r2 = gate.open('closing');
    const t1 = Date.now();
    const waiting = hook(r2, 'UserPromptSubmit');
    await sleep(100);
    gate.close('closing');
    await waiting;
    check('closing a run releases a held hook at once', Date.now() - t1 < 500, `${Date.now() - t1} ms`);
    gate.stop();

    const gate2 = await startHttp({ tools, callTool: okTool, holdMs: 300 });
    const h2 = gate2.open('never');
    const t2 = Date.now();
    await post(undefined, gate2.port, new URL(h2.hookUrl).pathname, { hook_event_name: 'UserPromptSubmit' });
    const waited = Date.now() - t2;
    check('a run that never lists tools is released after holdMs', waited >= 280 && waited < 800, `${waited} ms`);
    gate2.stop();
  }

  // replies
  {
    const gate = await startHttp({ tools, callTool: okTool });
    const r = gate.open('call');
    const auth = { authorization: `Bearer ${r.mcpToken}` };
    const res = await post(undefined, gate.port, '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ping', arguments: {} } }, auth);
    check('tools/call returns the tool result', res.body?.id === 7 && res.body.result.content[0].text === 'hi', JSON.stringify(res.body));
    const unknown = await post(undefined, gate.port, '/mcp', { jsonrpc: '2.0', id: 8, method: 'nope' }, auth);
    check('an unknown method still gets an error answer', unknown.body?.error?.code === -32601, JSON.stringify(unknown.body));
    const note = await post(undefined, gate.port, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    check('a notification gets 202', note.status === 202, String(note.status));
    gate.stop();
  }

  // onListed fires once, on the first tools/list
  {
    let n = 0;
    const out = [];
    const s = createSession({ tools, callTool: async () => ({}), enabled: () => true, onEvent: () => {}, send: (m) => out.push(m), onListed: () => { n++; } });
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('onListed runs once per session', n === 1 && out.length === 2, `${n}`);
  }

  // wait_for's probe: whitespace and case insensitive
  {
    const probe = (text, bodyText) => vm.runInNewContext(scripts.textProbe(text), { document: { body: { innerText: bodyText } } });
    check('probe finds a multi-word text', probe('Example Domain', 'Welcome\nto the Example Domain page') === true, '');
    check('probe ignores case', probe('example DOMAIN', 'Example Domain') === true, '');
    check('probe matches across a line break or non-breaking space', probe('Example Domain', 'Example\n  Domain') === true && probe('Example Domain', 'Example Domain') === true, '');
    check('probe does not match absent text', probe('Example Domain', 'This domain is for examples') === false, '');
    check('probe tolerates a missing body', vm.runInNewContext(scripts.textProbe('x'), { document: {} }) === false, '');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

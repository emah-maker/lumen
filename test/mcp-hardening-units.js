// Local MCP endpoints against bad input, plain Node (no Electron; test/mcp.js is the Electron one):
//  - the pipe/socket server (mcp.js startServer): a huge line, JSON null, non-object JSON, a connection that never authenticates,
//    and that a valid challenge-response still works afterwards,
//  - the HTTP endpoint (mcp-http.js startHttp): a handler that throws answers 500 instead of hanging, and does not reach
//    the process's unhandledRejection.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const mcp = require('../src/automation/mcp');
const { startHttp } = require('../src/automation/mcp-http');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

// A client over the channel: collects parsed lines, and resolves waiters.
function connect(where) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(where);
    const lines = [];
    let buf = '';
    const c = { socket, lines, closed: false, write: (obj) => socket.write(typeof obj === 'string' ? obj : `${JSON.stringify(obj)}\n`) };
    socket.setEncoding('utf8');
    socket.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch {} buf = buf.slice(i + 1); } });
    socket.on('close', () => { c.closed = true; });
    socket.on('error', () => { c.closed = true; });
    socket.once('connect', () => resolve(c));
    socket.once('error', reject);
  });
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return false; };
const challenge = async (c) => { await until(() => c.lines.some((l) => l.lumenChallenge)); return c.lines.find((l) => l.lumenChallenge)?.lumenChallenge; };

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcphard-'));
  const events = [];
  const tools = [{ name: 'ping', description: 'p', input_schema: { type: 'object' } }];
  const srv = mcp.startServer({ userData, tools, callTool: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }), enabled: () => true, onEvent: (e) => events.push(e), authTimeoutMs: 400, maxLine: 64 * 1024 });
  await new Promise((r) => (srv.server.listening ? r() : srv.server.once('listening', r)));
  const where = mcp.channelPath(userData);
  const token = fs.readFileSync(mcp.tokenPath(userData), 'utf8');
  const auth = async (c, engine) => { const nonce = await challenge(c); c.write({ lumenProof: mcp.proofFor(token, nonce), lumenEngine: engine }); return until(() => c.lines.some((l) => l.lumenAuth)); };

  check('server: the default line cap is 8 MB', mcp.MAX_LINE === 8 * 1024 * 1024, String(mcp.MAX_LINE));

  // valid auth still works, and tools answer
  const good = await connect(where);
  await auth(good, 'tag-1');
  check('server: a valid challenge-response is accepted', good.lines.some((l) => l.lumenAuth === 'ok'), JSON.stringify(good.lines));
  good.write({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } });
  check('server: an authenticated tool call is answered', await until(() => good.lines.some((l) => l.id === 1 && l.result?.content?.[0]?.text === 'pong')), JSON.stringify(good.lines));

  // after auth: null / non-object JSON do not throw or drop the session
  good.write('null\n');
  good.write('42\n');
  good.write('"text"\n');
  good.write('[1]\n');
  check('server: null, number, string and array JSON after auth get an Invalid Request, not a crash', await until(() => good.lines.filter((l) => l.error?.code === -32600).length === 4), JSON.stringify(good.lines.slice(-5)));
  good.write({ jsonrpc: '2.0', id: 2, method: 'ping' });
  check('server: the session still works after bad messages', await until(() => good.lines.some((l) => l.id === 2 && l.result)), '');

  // before auth: JSON null, a number, a wrong proof
  for (const [label, text] of [['null', 'null\n'], ['a number', '7\n'], ['an array', '[]\n']]) {
    const c = await connect(where);
    await challenge(c);
    c.write(text);
    check(`server: ${label} instead of a proof is denied and the connection closed`, await until(() => c.closed) && c.lines.some((l) => l.lumenAuth === 'denied'), JSON.stringify(c.lines));
  }
  const wrong = await connect(where);
  await challenge(wrong);
  wrong.write({ lumenProof: 'nope' });
  check('server: a wrong proof is still denied', await until(() => wrong.closed) && wrong.lines.some((l) => l.lumenAuth === 'denied'), '');

  // huge line (no newline) is cut off
  const huge = await connect(where);
  await challenge(huge);
  huge.socket.write('x'.repeat(200 * 1024));
  check('server: a line past the cap closes the connection', await until(() => huge.closed), '');
  const hugeAuthed = await connect(where);
  await auth(hugeAuthed);
  hugeAuthed.socket.write(`{"jsonrpc":"2.0","id":9,"method":"ping","pad":"${'y'.repeat(200 * 1024)}"}\n`);
  check('server: an oversize line after auth closes the connection too', await until(() => hugeAuthed.closed), '');
  check('server: the closed session was reported ended', events.some((e) => e.type === 'session' && e.active === false), JSON.stringify(events));

  // a connection that never authenticates is dropped by the timeout
  const idle = await connect(where);
  await challenge(idle);
  check('server: an unauthenticated connection is open before the timeout', !idle.closed, '');
  check('server: ...and dropped after it', await until(() => idle.closed, 2000), '');
  check('server: an authenticated connection is not dropped by the pre-auth timeout', !good.closed, '');
  await sleep(500);
  check('server: ...still open past it', !good.closed, '');

  // the server is healthy after all of it
  const again = await connect(where);
  check('server: a fresh valid connection still authenticates', await auth(again) && again.lines.some((l) => l.lumenAuth === 'ok'), '');
  for (const c of [good, again, huge, hugeAuthed, wrong, idle]) c.socket.destroy();
  srv.disconnectAll();
  srv.close();

  // onLines itself
  const { PassThrough } = require('stream');
  const pt = new PassThrough();
  const got = [];
  mcp.onLines(pt, (l) => got.push(l), 100);
  pt.write('{"a":1}\n\n{"b":2}\n');
  await sleep(20);
  check('onLines: lines under the cap are delivered, blank ones skipped', got.join('|') === '{"a":1}|{"b":2}', got.join('|'));
  pt.write('z'.repeat(500));
  await sleep(20);
  check('onLines: a stream past the cap is destroyed', pt.destroyed, '');

  // ---------- HTTP endpoint: a throwing handler answers 500 ----------
  const throwing = { map() { throw new Error('boom'); }, some() { throw new Error('boom'); } };
  const gate = await startHttp({ tools: throwing, callTool: async () => ({ content: [], isError: false }) });
  const post = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.setTimeout(3000, () => { req.destroy(new Error('hung')); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  const origError = console.error;
  console.error = () => {};
  const run = gate.open('h-1', 'c-1');
  let r;
  try { r = await post(run.hookUrl, { hook_event_name: 'PreToolUse', tool_name: 'search_tool' }); } catch (e) { r = { status: 0, body: String(e) }; }
  console.error = origError;
  await sleep(50);
  check('http: a handler that throws answers 500 with a JSON-RPC error instead of hanging', r.status === 500 && JSON.parse(r.body).error?.code === -32603, JSON.stringify(r));
  check('http: ...and nothing reached unhandledRejection', unhandled.length === 0, String(unhandled[0]));
  gate.stop();

  // and a normal gate still answers
  const ok = await startHttp({ tools, callTool: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }) });
  const run2 = ok.open('h-2', 'c-2');
  const init = await post(run2.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }, { authorization: `Bearer ${run2.mcpToken}` });
  check('http: a valid MCP call still answers 200', init.status === 200 && JSON.parse(init.body).result?.content?.[0]?.text === 'pong', JSON.stringify(init));
  const nul = await post(run2.mcpUrl, null, { authorization: `Bearer ${run2.mcpToken}` });
  check('http: a JSON null body is a 400, not a hang', nul.status === 400, JSON.stringify(nul));
  ok.stop();

  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} FAILED` : '\nAll mcp-hardening checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

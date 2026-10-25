// The stdio bridge (mcp.js relay) when Lumen is not up yet: a cold start outlasts the client's 30 s connect timeout, so the bridge answers
// initialize itself, serves tools/list from the cache Lumen keeps, queues tool calls until Lumen is up, and reconnects after Lumen restarts.
// Plain Node, in-process: a fake slow Lumen (a real startServer that only starts listening after a delay, as spawnLumen), scaled-down timings.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const mcp = require('../../src/automation/mcp');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(15); } return false; };
const TOOLS = [{ name: 'ping', description: 'p', input_schema: { type: 'object' } }];

// One scenario: a profile folder, a fake Lumen that `launch()` brings up after `delay` ms, and a bridge wired to in-memory streams.
function scenario({ delay = 1200, never = false, timing = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcpcold-'));
  const events = [];
  const s = { userData, events, servers: [], spawned: 0, lines: [], exited: null, startedAt: Date.now() };
  const startFake = () => {
    const srv = mcp.startServer({ userData, tools: TOOLS, callTool: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }), enabled: () => true, onEvent: (e) => events.push(e) });
    s.servers.push(srv);
  };
  s.input = new PassThrough();
  s.output = new PassThrough();
  let buf = '';
  s.output.setEncoding('utf8');
  s.output.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { s.lines.push({ at: Date.now() - s.startedAt, msg: JSON.parse(buf.slice(0, i)) }); buf = buf.slice(i + 1); } });
  s.send = (obj) => s.input.write(`${JSON.stringify(obj)}\n`);
  s.reply = (id) => s.lines.find((l) => l.msg.id === id);
  s.has = (pred) => s.lines.some((l) => pred(l.msg));
  s.start = () => { s.startedAt = Date.now(); mcp.relay({ userData, launch: { command: 'fake', args: [] }, input: s.input, output: s.output, exit: (code) => { s.exited = code; }, log: () => {}, spawnLumen: () => { s.spawned++; if (!never) setTimeout(startFake, delay); }, timing: { launchMs: 6000, listWaitMs: 300, handshakeMs: 300, pollMs: 40, tokenMs: 500, ...timing } }); };
  s.stop = () => { for (const srv of s.servers) { srv.disconnectAll(); srv.close(); } s.input.end(); };
  return s;
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-test' } } };

(async () => {
  // 1. initialize is answered at once, with Lumen's own answer shape, while Lumen has not even started listening; Lumen then gets the client's initialize and the client is not answered twice.
  {
    const s = scenario({ delay: 1200 });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('cold start: initialize is answered in under a second with Lumen not running', await until(() => s.reply(1), 1000) && s.reply(1).at < 1000 && s.servers.length === 0, JSON.stringify(s.lines));
    const r = s.reply(1)?.msg.result || {};
    const want = mcp.initializeResult('2025-06-18');
    check('cold start: ...with the same result Lumen gives (negotiated version, listChanged, serverInfo, instructions)', JSON.stringify(r) === JSON.stringify(want) && r.capabilities.tools.listChanged === true && r.protocolVersion === '2025-06-18', JSON.stringify(r));
    check('cold start: the bridge started Lumen once, at once', await until(() => s.spawned === 1, 500) && s.spawned === 1);
    check('cold start: Lumen then received the client\'s own initialize (clientInfo)', await until(() => s.events.some((e) => e.type === 'session' && e.active && e.clientName === 'relay-test'), 5000), JSON.stringify(s.events));
    await sleep(200);
    check('cold start: the client got exactly one reply to initialize', s.lines.filter((l) => l.msg.id === 1).length === 1, JSON.stringify(s.lines));
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    check('cold start: ping is answered', await until(() => s.reply(2)?.msg.result), JSON.stringify(s.lines));
    s.stop();
  }

  // 1b. Lumen already running: its own answer comes (nothing is answered twice), and a refused agent is told so, as before.
  {
    const s = scenario({ delay: 0 });
    s.servers.push(mcp.startServer({ userData: s.userData, tools: TOOLS, callTool: async () => ({ content: [{ type: 'text', text: 'pong' }], isError: false }), enabled: () => true, onEvent: (e) => s.events.push(e) }));
    await sleep(100);
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    check('warm: Lumen answers initialize and the call', await until(() => s.reply(1)?.msg.result && s.reply(2)?.msg.result?.content?.[0]?.text === 'pong') && s.events.some((e) => e.type === 'session' && e.active && e.clientName === 'relay-test'), JSON.stringify(s.lines));
    await sleep(200);
    check('warm: one reply to initialize, Lumen is not started', s.lines.filter((l) => l.msg.id === 1).length === 1 && s.spawned === 0);
    s.stop();
  }
  {
    const s = scenario({ delay: 0 });
    s.servers.push(mcp.startServer({ userData: s.userData, tools: TOOLS, callTool: async () => ({ content: [], isError: false }), enabled: () => true, onEvent: () => {} }));
    fs.writeFileSync(mcp.tokenPath(s.userData), 'not-the-token');
    await sleep(100);
    s.start();
    s.send(INIT);
    check('refused: the agent gets an error for initialize (not a made-up success) and the bridge leaves with 1', await until(() => s.reply(1)?.msg.error && s.exited === 1), JSON.stringify({ lines: s.lines, exited: s.exited }));
    s.stop();
  }

  // 2. A tool call sent before Lumen is up waits for it, then is answered.
  {
    const s = scenario({ delay: 1200 });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    check('queued call: answered once Lumen is up', await until(() => s.reply(3)?.msg.result?.content?.[0]?.text === 'pong'), JSON.stringify(s.lines));
    check('queued call: not before Lumen started', s.reply(3).at >= 1000, String(s.reply(3)?.at));
    s.stop();
  }

  // 3. tools/list from the cache Lumen wrote; an unchanged real list is silent, a changed one sends list_changed.
  {
    const s = scenario({ delay: 1200 });
    fs.writeFileSync(mcp.toolsCachePath(s.userData), JSON.stringify([{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }]));
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('tools/list: answered from the cache in under a second, Lumen not up', await until(() => s.reply(2), 1000) && s.reply(2).at < 1000 && s.reply(2).msg.result.tools[0].name === 'ping' && s.servers.length === 0, JSON.stringify(s.lines));
    await until(() => s.servers.length === 1 && s.events.length, 5000);
    await sleep(500);
    check('tools/list: Lumen\'s own list matches the cache, so no list_changed is sent', !s.has((m) => m.method === 'notifications/tools/list_changed'), JSON.stringify(s.lines));
    check('tools/list: Lumen writes the cache when it serves a list (atomic, no temp file left)', (() => { s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }); return true; })() && await until(() => s.reply(3)) && JSON.parse(fs.readFileSync(mcp.toolsCachePath(s.userData), 'utf8'))[0].name === 'ping' && !fs.readdirSync(s.userData).some((f) => f.endsWith('.tmp')));
    s.stop();
  }
  {
    const s = scenario({ delay: 1200 });
    fs.writeFileSync(mcp.toolsCachePath(s.userData), JSON.stringify([{ name: 'stale', description: 's', inputSchema: { type: 'object' } }]));
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('tools/list: a stale cache is served first...', await until(() => s.reply(2)?.msg.result.tools[0].name === 'stale', 1000));
    check('tools/list: ...and list_changed follows once Lumen is up with a different list', await until(() => s.has((m) => m.method === 'notifications/tools/list_changed'), 6000));
    s.stop();
  }
  // no cache: short wait then an empty list and list_changed; a long wait gets the real list at once
  {
    const s = scenario({ delay: 1200 });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('tools/list without a cache: an empty list after the wait bound', await until(() => s.reply(2)?.msg.result?.tools?.length === 0, 1000), JSON.stringify(s.lines));
    check('tools/list without a cache: list_changed once Lumen is up', await until(() => s.has((m) => m.method === 'notifications/tools/list_changed'), 6000));
    s.stop();
  }
  {
    const s = scenario({ delay: 800, timing: { listWaitMs: 5000 } });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('tools/list without a cache: waits for Lumen and returns every tool at once', await until(() => s.reply(2)?.msg.result?.tools?.[0]?.name === 'ping'), JSON.stringify(s.lines));
    check('tools/list without a cache: ...with no list_changed', !s.has((m) => m.method === 'notifications/tools/list_changed'));
    s.stop();
  }

  // 4. Lumen never starts: a clear tool error, and a later call tries again.
  {
    const s = scenario({ never: true, timing: { launchMs: 700 } });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    const ok = await until(() => s.reply(3));
    const res = s.reply(3)?.msg.result;
    check('never starts: the call gets a tool error that says Lumen did not start', ok && res.isError === true && /Lumen didn't start/.test(res.content[0].text), JSON.stringify(s.lines));
    check('never starts: initialize was still answered', !!s.reply(1)?.msg.result);
    s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    await until(() => s.reply(4));
    check('never starts: a later call tries to start Lumen again', s.spawned === 2, String(s.spawned));
    s.stop();
  }

  // 5. Lumen restarts mid-session (an update, a quit): the next call reconnects, starting it if needed, after the client's initialize is sent again.
  {
    const s = scenario({ delay: 300 });
    s.start();
    s.send(INIT);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    check('restart: first call answered', await until(() => s.reply(2)?.msg.result?.content?.[0]?.text === 'pong'), JSON.stringify(s.lines));
    s.servers[0].disconnectAll(); s.servers[0].close();
    await sleep(300);
    s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    check('restart: a call after Lumen went is answered by the new Lumen', await until(() => s.reply(3)?.msg.result?.content?.[0]?.text === 'pong'), JSON.stringify(s.lines));
    check('restart: Lumen was started again and the new session got the client\'s initialize', s.spawned === 2 && s.events.filter((e) => e.type === 'session' && e.active && e.clientName === 'relay-test').length === 2, JSON.stringify({ spawned: s.spawned, events: s.events }));
    s.stop();
    check('restart: the bridge leaves when the client closes stdin', await until(() => s.exited === 0, 3000), String(s.exited));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll mcp-cold-start checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

// Read-only tools of the official MCP presets (GitHub, Notion, Todoist) run without a card, as the old built-in connectors' reads did; everything
// else still asks. In plain Node against a stand-in MCP server over http: the server's own `readOnlyHint: true` is the only thing that lets a
// call through, only for a server a Connectors card added (tagged `preset`), and never for a custom server, a tool with no annotations, a hint
// that is not literally true, or a page trying to tag its own server as a preset. Also the fixed headers a preset sends (GitHub's toolset choice).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const mcpClient = require('../../src/features/mcp-client');
const agentLib = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };

function server() {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, toolsets: req.headers['x-mcp-toolsets'] || '', auth: req.headers.authorization || '' });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } });
      if (msg.method === 'tools/list') {
        const schema = { type: 'object', properties: {} };
        return reply({ tools: [
          { name: 'read_thing', description: 'reads', inputSchema: schema, annotations: { readOnlyHint: true } },
          { name: 'write_thing', description: 'writes', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true } },
          { name: 'plain', description: 'no hints', inputSchema: schema },
          { name: 'odd', description: 'a string hint', inputSchema: schema, annotations: { readOnlyHint: 'true' } },
        ] });
      }
      reply({ content: [{ type: 'text', text: 'ok' }] });
    });
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}/mcp` })));
}

async function main() {
  const srv = await server();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-readonly-'));
  const client = mcpClient.create({ userData, version: '1', secrets: fakeSecrets });
  // What connectors/service.js does for a card (it alone may tag a server as a preset and give it fixed headers).
  client.save({ name: 'github', type: 'http', url: srv.url, header: { name: 'Authorization', value: 'Bearer tok' }, preset: 'github', fixedHeaders: { 'X-MCP-Toolsets': 'context,issues,pull_requests' } });
  client.save({ name: 'mine', type: 'http', url: srv.url });
  await Promise.all(client.list().map((x) => client.refresh(x.id)));
  const rows = Object.fromEntries(client.list().map((x) => [x.name, x]));

  check('a preset sends its fixed header (GitHub: only the toolsets the old connector covered) along with the token', srv.seen.some((m) => m.method === 'tools/list' && m.toolsets === 'context,issues,pull_requests' && m.auth === 'Bearer tok'), JSON.stringify(srv.seen.slice(0, 3)));
  check('…and a custom server sends none', srv.seen.filter((m) => !m.toolsets).length > 0 && srv.seen.filter((m) => !m.auth).length > 0, '');
  check('on a preset only the tool the server marks readOnlyHint: true is read only; no hint, readOnlyHint false and a non-boolean hint are not', rows.github.tools.filter((t) => t.readOnly).map((t) => t.name).join() === 'read_thing' && rows.github.tools.length === 4, JSON.stringify(rows.github.tools));
  check('on a custom server no tool is read only, whatever it claims', rows.mine.tools.every((t) => !t.readOnly) && rows.mine.tools.length === 4, JSON.stringify(rows.mine.tools));
  check('only a preset’s annotated read passes the check the agent uses', client.isReadOnlyPreset('github__read_thing') && !client.isReadOnlyPreset('github__write_thing') && !client.isReadOnlyPreset('github__plain') && !client.isReadOnlyPreset('github__odd') && !client.isReadOnlyPreset('mine__read_thing') && !client.isReadOnlyPreset('nope__x') && !client.isReadOnlyPreset('github__missing'), '');

  // The settings page can't tag its own server as a preset or set fixed headers (that would let a custom server's reads skip the card).
  const handlers = {};
  mcpClient.registerIpc({ handle: (n, fn) => { handlers[n] = fn; } }, client);
  await handlers['mcp:server-save']({}, { name: 'sneaky', type: 'http', url: srv.url, preset: 'github', fixedHeaders: { 'X-Evil': '1' } });
  await client.refresh(client.list().find((x) => x.name === 'sneaky').id);
  const sneaky = client.list().find((x) => x.name === 'sneaky');
  check('a server saved from the page can’t be tagged as a preset or get fixed headers, so its reads still ask', sneaky.preset === '' && sneaky.tools.every((t) => !t.readOnly) && !client.isReadOnlyPreset('sneaky__read_thing'), JSON.stringify(sneaky));
  let bad = '';
  try { client.save({ name: 'badhdr', type: 'http', url: srv.url, fixedHeaders: { 'X Bad': 'x' } }); } catch (e) { bad = e.message; }
  check('a fixed header with a bad name is refused', /valid header/.test(bad), bad);

  // The agent's gate.
  const events = [];
  const agent = new agentLib.Agent({ externalTools: client }, () => null, () => ({}));
  const gate = { emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, run: {} };
  const asks = async (name) => {
    events.length = 0;
    const p = agent.allowExternal(name, {}, gate);
    await new Promise((r) => setTimeout(r, 30));
    const card = events.find((e) => e.type === 'approval');
    if (card) agent.resolveApproval(card.approvalId, false);
    await p.catch(() => {});
    return Boolean(card);
  };
  check('the agent runs a preset’s read-only tool without a card', (await asks('github__read_thing')) === false, JSON.stringify(events));
  check('…and still asks for a preset’s write, a tool with no hints, and a string hint', (await asks('github__write_thing')) && (await asks('github__plain')) && (await asks('github__odd')), '');
  check('…and for every tool of a custom server, even one that says it is read only', (await asks('mine__read_thing')) && (await asks('mine__write_thing')), '');
  check('an outside agent is still refused for all of them', await Promise.all(['github__read_thing', 'mine__read_thing'].map((n) => agent.allowExternal(n, {}, { ...gate, external: true }).then(() => '', (e) => e.message))).then((r) => r.every((m) => /Unknown tool/.test(m))), '');

  client.stopAll();
  srv.s.closeAllConnections?.();
  srv.s.close();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 300);
}).catch((err) => { console.log(`FAIL  no exceptions  -> ${err.stack}`); process.exit(1); });

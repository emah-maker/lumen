// A fake `claude` / `grok` CLI for the tests (test/bgtasks.js): no login, no model, no tokens.
//
// Two halves in one file:
//  - spawn(bin, argv, opts): what Lumen's engines call in place of child_process.spawn when the app runs in
//    test mode with LUMEN_TEST_CLI_SPAWN pointing here (features/ai-agents.js cliSpawn). It starts THIS file
//    as a real Node-mode process (Electron's own exe with ELECTRON_RUN_AS_NODE), so Stop can kill a real
//    process tree, and the argv, env and cwd are exactly what the engine built.
//  - run as a script: acts like the CLI. It finds its script by a marker (TASK-x / SIDE-x) in the prompt,
//    talks to Lumen the way the real CLI does (Claude: a real `mcp.js` bridge child over stdio, named by the
//    MCP config's LUMEN_ENGINE tag; Grok: Lumen's HTTP MCP server with the bearer token, and the gate hooks),
//    prints the CLI's stream-json events, and logs what happened to <dir>/log.jsonl.
//
// <dir> is LUMEN_TEST_CLI_DIR. scripts.json in it maps a marker to steps:
//   { say: 'text' }            the model says something
//   { tool: 'read_page', input: {} }   the model calls one of Lumen's tools
//   { hold: 'name' }           wait until <dir>/release-<name> exists
//   { rawTool: 'edit_file' }   (grok) a tool call that is not Lumen's
//   { terminal: 'echo hi' }    (grok) run_terminal_command, judged by the gate hook
//   { foreign: true }          connect with a run tag / token Lumen never issued, and log the answer
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

function spawn(bin, argv, opts) {
  const role = argv.includes('--prompt-file') ? 'grok' : 'claude';
  return cp.spawn(process.execPath, [__filename], {
    ...opts,
    env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLI_ROLE: role, FAKE_CLI_ARGV: JSON.stringify(argv), FAKE_CLI_DIR: process.env.LUMEN_TEST_CLI_DIR },
  });
}

async function main() {
  const dir = process.env.FAKE_CLI_DIR;
  const role = process.env.FAKE_CLI_ROLE;
  const argv = JSON.parse(process.env.FAKE_CLI_ARGV);
  const flag = (f) => argv[argv.indexOf(f) + 1];
  const log = (entry) => fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ role, pid: process.pid, ...entry })}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const session = flag('--session-id') || flag('--resume');

  // The prompt: Claude gets it on stdin (one stream-json line), Grok in the --prompt-file.
  let prompt = '';
  if (role === 'claude') {
    prompt = await new Promise((resolve) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => resolve(b)); });
    try { prompt = JSON.parse(prompt.trim().split('\n')[0]).message.content[0].text; } catch {}
  } else {
    try { prompt = JSON.parse(fs.readFileSync(flag('--prompt-file'), 'utf8'))[0].text; } catch {}
  }
  const marker = /(?:TASK|SIDE)-[A-Z0-9]+/.exec(prompt)?.[0] || 'NONE';
  let steps = [{ say: 'No script.' }];
  try { steps = JSON.parse(fs.readFileSync(path.join(dir, 'scripts.json'), 'utf8'))[marker] || steps; } catch {}
  const cleanArgv = argv.map((a, i) => (argv[i - 1] === '--system-prompt-override' || argv[i - 1] === '--append-system-prompt' ? '(system prompt)' : a));
  log({ event: 'start', marker, session, argv: cleanArgv, cwd: process.cwd(), env: Object.keys(process.env), home: process.env.GROK_HOME || null, system: argv[argv.indexOf('--append-system-prompt') + 1] || argv[argv.indexOf('--system-prompt-override') + 1] || '' });

  // ---- talking to Lumen
  let bridge = null;
  let nextId = 1;
  const openBridge = (env) => {
    const cfg = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.lumen;
    const child = cp.spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const waiting = new Map();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {} } });
    let closed = false;
    child.on('close', () => { closed = true; for (const r of waiting.values()) r({ error: { message: 'bridge closed' } }); });
    return {
      child,
      call: (method, params) => new Promise((resolve) => {
        if (closed) return resolve({ error: { message: 'bridge closed' } });
        const id = nextId++;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); resolve({ error: { message: 'timeout' } }); } }, 60000);
      }),
    };
  };
  const post = (url, body, headers = {}) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', (err) => resolve({ status: 0, json: { error: err.message } }));
    req.end(data);
  });
  const bearer = () => ({ authorization: `Bearer ${process.env.LUMEN_MCP_TOKEN}` });
  const mcp = async (method, params) => {
    if (role === 'claude') return bridge.call(method, params);
    const id = nextId++;
    const res = await post(process.env.LUMEN_MCP_URL, { jsonrpc: '2.0', id, method, params }, bearer());
    return res.json || { error: { message: `HTTP ${res.status}` } };
  };

  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake', mcp_servers: [{ name: 'lumen', status: role === 'claude' ? 'connected' : 'pending' }] });
  if (role === 'claude') {
    bridge = openBridge({});
    log({ event: 'bridge', bridgePid: bridge.child.pid, tag: JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.lumen.env.LUMEN_ENGINE });
  }
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `fake-${role}` } });
  log({ event: 'initialize', ok: Boolean(init.result), error: init.error?.message || init.result?.content?.[0]?.text || null });
  if (role === 'claude') bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await mcp('tools/list', {});
  const toolNames = (listed.result?.tools || []).map((t) => t.name);
  log({ event: 'tools', count: toolNames.length, hasScreenshot: toolNames.includes('screenshot') });
  if (role === 'grok') {
    process.stderr.write('wait_for_mcp_handshakes_until: done session_id=x outcome=Complete elapsed_ms=2 final_initializing_names=[] final_client_names=["lumen"]\n');
    const armed = await post(process.env.LUMEN_HOOK_URL, { hook_event_name: 'UserPromptSubmit' });
    log({ event: 'armed', status: armed.status });
  }

  // ---- the script
  let text = '';
  let blocks = 0;
  const say = (t) => {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: blocks, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: blocks, delta: { type: 'text_delta', text: t } } });
    blocks++;
    text += (text ? '\n\n' : '') + t;
  };
  let turns = 1;
  for (const step of steps) {
    if (step.say) say(step.say);
    else if (step.hold) { while (!fs.existsSync(path.join(dir, `release-${step.hold}`))) await sleep(50); log({ event: 'released', hold: step.hold }); }
    else if (step.foreign) {
      // Something that was never issued a run tag / token.
      if (role === 'claude') {
        const stray = openBridge({ LUMEN_ENGINE: 'f'.repeat(36) });
        const a = await stray.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stray' } });
        const b = await stray.call('tools/call', { name: 'read_page', arguments: {} });
        log({ event: 'foreign', initialize: a.error?.message || a.result?.content?.[0]?.text || (a.result ? 'accepted' : 'none'), call: b.error?.message || b.result?.content?.[0]?.text || (b.result ? 'accepted' : 'none') });
        stray.child.kill();
      } else {
        const res = await post(process.env.LUMEN_MCP_URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${'0'.repeat(48)}` });
        const hook = await post(process.env.LUMEN_HOOK_URL.replace(/[a-f0-9]{48}$/, '0'.repeat(48)), { hook_event_name: 'PreToolUse', tool_name: 'lumen__read_page' });
        log({ event: 'foreign', mcpStatus: res.status, hookDenied: hook.json?.decision === 'deny' });
      }
    } else if (step.rawTool) {
      out({ type: 'stream_event', event: { type: 'content_block_start', index: blocks++, content_block: { type: 'tool_use', id: 'c-raw', name: step.rawTool, input: {} } } });
      log({ event: 'rawTool', name: step.rawTool });
      await sleep(15000); // Lumen's tool watch kills this process long before
    } else if (step.terminal !== undefined) {
      const hook = await post(process.env.LUMEN_HOOK_URL, { hook_event_name: 'PreToolUse', tool_name: 'run_terminal_command', tool_input: { command: step.terminal } });
      log({ event: 'terminal', denied: hook.json?.decision === 'deny' });
    } else if (step.tool) {
      turns++;
      if (role === 'grok') {
        out({ type: 'stream_event', event: { type: 'content_block_start', index: blocks++, content_block: { type: 'tool_use', id: `c${turns}`, name: `lumen__${step.tool}`, input: {} } } });
        const hook = await post(process.env.LUMEN_HOOK_URL, { hook_event_name: 'PreToolUse', tool_name: `lumen__${step.tool}` });
        if (hook.json?.decision === 'deny') { log({ event: 'tool', name: step.tool, gateDenied: true }); continue; }
      }
      const res = await mcp('tools/call', { name: step.tool, arguments: step.input || {} });
      log({ event: 'tool', name: step.tool, isError: Boolean(res.result?.isError), text: String(res.result?.content?.[0]?.text || res.error?.message || '').slice(0, 1500) });
    }
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, num_turns: turns, total_cost_usd: 0.0123, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, modelUsage: { fake: { contextWindow: 200000 } } });
  log({ event: 'done' });
  bridge?.child.kill();
  process.exit(0);
}

if (require.main === module) main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });

module.exports = { spawn };

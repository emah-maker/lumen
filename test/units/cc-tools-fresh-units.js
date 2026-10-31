// A kept Claude Code process gets Lumen's tools once, when it lists them (the HTTP connection has no way to say the list changed).
//  - mcp.js createSession remembers the names it served (session.served)
//  - a chat that now needs a tool the kept process was not given (the word tool once the chat is about a Word file) gets a new
//    process for its message, resuming the same session; a chat that needs nothing new keeps its warm process
//  - features/ai-agents.js wires toolsMissing into the Claude Code engines and counts only the chat's own extras
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const cc = require('../../src/ai/claude-code');
const mcp = require('../../src/automation/mcp');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// A fake `claude` that answers every message at once.
function fakeClaude() {
  const spawned = [];
  const spawn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 6000 + spawned.length;
    const rec = { argv, child, killed: false, session: flag(argv, '--session-id') || flag(argv, '--resume'), resumed: argv.includes('--resume') };
    const out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (msg.type === 'control_request') continue;
          setImmediate(() => {
            out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
            out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: rec.session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
          });
        }
        cb();
      },
    });
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; if (child.exitCode === null) { child.exitCode = null; setImmediate(() => child.emit('close', null)); } } };
  return { spawn, kill, spawned };
}

async function main() {
  // 1. The session remembers what it served.
  {
    const sent = [];
    const s = mcp.createSession({ tools: [{ name: 'read_page', description: 'r', inputSchema: { type: 'object' } }], extraTools: () => [{ name: 'word', description: 'w', inputSchema: { type: 'object' } }], callTool: async () => ({}), enabled: () => true, onEvent: () => {}, send: (m) => sent.push(m), engine: 'cc-1' });
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('a session remembers the names it served (its extras included)', s.session.served instanceof Set && s.session.served.has('read_page') && s.session.served.has('word'), JSON.stringify([...(s.session.served || [])]));
  }

  // 2. The engine: a new process only when the chat needs a tool the kept one lacks.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cctools-'));
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: 'tok', hookUrl: 'x' }), close: () => {} };
  const cli = fakeClaude();
  let missing = false;
  const asked = [];
  const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 10, toolsMissing: (tag, chat) => { asked.push({ tag, chat }); return missing; } });
  eng.bin = process.execPath;
  const chat = { settings: {} };
  const turn = (prompt, sessionId, resume) => eng.run({ prompt, sessionId, resume, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {}, scope: { chat } });

  const r1 = await turn('hello', 'sess-w', false);
  const r2 = await turn('and again', 'sess-w', true);
  check('nothing new needed: the warm process takes the next message', !r1.failed && !r2.failed && cli.spawned.length === 1, JSON.stringify(cli.spawned.map((r) => r.argv.slice(-4))));
  check('the check is asked with the kept process\'s tag and the message\'s chat', asked.length >= 1 && asked.at(-1).chat === chat && typeof asked.at(-1).tag === 'string' && asked.at(-1).tag.length > 0, JSON.stringify(asked.map((a) => a.tag)));

  missing = true; // the chat turned to a Word file: it needs the word tool, which the kept process never listed
  const r3 = await turn('edit my report.docx', 'sess-w', true);
  check('a tool the chat now needs: the message gets a new process', !r3.failed && cli.spawned.length === 2 && cli.spawned[0].killed, JSON.stringify({ n: cli.spawned.length, killed: cli.spawned[0].killed }));
  check('...which resumes the same session (the conversation goes on)', cli.spawned[1].resumed && cli.spawned[1].session === 'sess-w', JSON.stringify(cli.spawned[1].argv));

  missing = false; // the new process listed it
  const r4 = await turn('now shorten it', 'sess-w', true);
  check('once it has the tool, the next message reuses it (no new process each time)', !r4.failed && cli.spawned.length === 2, String(cli.spawned.length));
  eng.dispose();

  // A check that throws never stops the message: the warm process is kept.
  const cli2 = fakeClaude();
  const eng2 = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli2.spawn, kill: cli2.kill, retryDelayMs: 10, toolsMissing: () => { throw new Error('boom'); } });
  eng2.bin = process.execPath;
  const t2 = (prompt, resume) => eng2.run({ prompt, sessionId: 'sess-x', resume, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {}, scope: { chat } });
  const q1 = await t2('one', false);
  const q2 = await t2('two', true);
  check('a check that throws never fails the message, and the warm process is kept', !q1.failed && !q2.failed && cli2.spawned.length === 1, JSON.stringify({ q1, q2, n: cli2.spawned.length }));
  eng2.dispose();

  // 3. Wiring.
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const agents = src('src/features/ai-agents.js');
  check('ai-agents gives the Claude Code engines toolsMissing', /onFresh: freshReads, toolsMissing,/.test(agents));
  check('toolsMissing counts the chat\'s own extras (connectors, project, word, skills, MCP servers), not the shared helpers', /function toolsMissing\(tag, chat\)/.test(agents) && /deps\.wordTools\?\.\(chat\)/.test(agents.slice(agents.indexOf('function toolsMissing'), agents.indexOf('const runTools'))) && !/helperTools/.test(agents.slice(agents.indexOf('function toolsMissing'), agents.indexOf('const runTools'))));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

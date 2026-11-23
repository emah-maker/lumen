// [keep connected] Antigravity's kept process (features/agy-warm.js), plain Node with a fake `agy` (no real CLI, no account):
//  - prepare() starts the chat's process; its messages go to that one process on stdin as {"event":"user"} lines;
//  - one MCP tag for the process's life (gate.open once, mcp_config.json once), owner(tag) with the turn's scope only during a turn;
//  - another model, a dropped chat, Stop and a tool that isn't Lumen's end the process;
//  - the fallback: an agy that ends with no output on stdin turns (or the feature off) sends the message through `agy -p`.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const tick = () => new Promise((r) => setImmediate(r));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agy-warm-'));
const ag = require('../../src/ai/antigravity');
const { createAgyWarm, modeOf } = require('../../src/features/agy-warm');

// A fake agy. stdin turns (`--input-format`): `onTurn(msg, n, say)` answers each line (default: words + SUCCESS). `-p`: one answer.
// noStream: an agy without --input-format (exits with a usage error on stderr, nothing on stdout).
function fakeAgy({ noStream = false, onTurn = null } = {}) {
  const spawns = [];
  const kills = [];
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 7000 + spawns.length, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const rec = { argv, opts, child, lines: [], mcp: null };
    try { rec.mcp = JSON.parse(fs.readFileSync(path.join(opts.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8')); } catch { /* none */ }
    spawns.push(rec);
    const conv = flag(argv, '--conversation') || `conv-${spawns.length}`;
    const say = (o) => { if (!child.killed) child.stdout.write(`${JSON.stringify(o)}\n`); };
    const end = (code) => { if (child.killed) return; child.killed = true; child.stdout.end(); setImmediate(() => child.emit('close', code)); };
    if (argv.includes('--input-format')) {
      if (noStream) { setImmediate(() => { child.stderr.write('flag provided but not defined: -input-format\n'); end(2); }); return child; }
      let buf = '';
      let n = 0;
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const msg = JSON.parse(line);
          rec.lines.push(msg);
          n++;
          (async () => {
            await tick();
            if (n === 1) say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-high' } });
            if (onTurn) { await onTurn(msg, n, say, conv); return; }
            say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: `answer ${n}` } });
            say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: `answer ${n}` } });
          })();
        }
      });
      child.stdin.on('finish', () => end(0));
    } else {
      setImmediate(() => {
        say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-high' } });
        say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'cold answer' } });
        say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'cold answer' } });
        end(0);
      });
    }
    return child;
  };
  const kill = (child) => { kills.push(child.pid); if (child.killed) return; child.killed = true; child.stdout.end(); setImmediate(() => child.emit('close', null)); };
  return { spawn, kill, spawns, kills };
}

function setup(opts = {}, warmOpts = {}) {
  const data = fs.mkdtempSync(path.join(tmp, 'ud-'));
  const f = fakeAgy(opts);
  const gate = { opened: [], closed: [], open(tag, session, o) { this.opened.push({ tag, session, o }); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: `tok-${this.opened.length}`, hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close(tag) { this.closed.push(tag); }, rearm() {}, bindChat() {} };
  const engine = new ag.AntigravityEngine({ userData: data, gate: async () => gate, spawn: f.spawn, kill: f.kill, startWait: async () => {} });
  engine.bin = process.execPath;
  engine.keepWarm = createAgyWarm({ engine, quitGraceMs: 10, exitWaitMs: 500, ...warmOpts });
  const send = async (o = {}) => {
    const events = [];
    const scope = { chatId: 'chatId' in o ? o.chatId : 'chat-1' };
    const ctl = o.controller || new AbortController();
    const out = await engine.run({ prompt: o.prompt || 'hello', sessionId: o.sessionId ?? null, systemPrompt: 'SYS', model: o.model || 'default', signal: ctl.signal, emit: (e) => { events.push(e); o.onEvent?.(e); }, scope, fullAccess: false, runAgent: null });
    return { out, events };
  };
  return { data, f, gate, engine, send };
}

(async () => {
  // ---------- argv and the stdin line ----------
  const sa = ag.buildStreamArgs({ conversation: 'c-9', model: 'gemini-3.1-pro-high' });
  check('stream argv: --input-format stream-json with --output-format stream-json, no -p, same sandbox and conversation flags', flag(sa, '--input-format') === 'stream-json' && flag(sa, '--output-format') === 'stream-json' && !sa.includes('-p') && sa.includes('--sandbox') && flag(sa, '--conversation') === 'c-9' && flag(sa, '--model') === 'gemini-3.1-pro-high' && !sa.includes('--dangerously-skip-permissions'), sa.join(' '));
  const line = ag.streamLine('hi "there"\nsecond');
  const parsed = JSON.parse(line);
  check('stream line: one NDJSON line {"event":"user","message":{"content":<text>}} (the shape agy 1.5.15 accepts)', line.endsWith('\n') && line.indexOf('\n') === line.length - 1 && parsed.event === 'user' && parsed.message.content === 'hi "there"\nsecond', line);
  check('modeOf: model, effort, access and work folder each make a different process', new Set([modeOf({}), modeOf({ model: 'x1' }), modeOf({ effort: 'high' }), modeOf({ fullAccess: true }), modeOf({ workDir: tmp })]).size === 5, '');

  // ---------- reuse: prepare() starts it, every message of the chat goes to that one process ----------
  {
    const t = setup();
    t.engine.prepare({ scope: { chatId: 'chat-1' }, sessionId: null }).catch(() => {});
    await tick();
    const one = await t.send();
    let tagDuring = null;
    let ownerDuring = null;
    const two = await t.send({ sessionId: one.out.sessionId, prompt: 'next', onEvent: (e) => { if (e.type === 'text' && !ownerDuring) { tagDuring = t.gate.opened[0]?.tag; ownerDuring = t.engine.keepWarm.owner(tagDuring)?.active?.scope?.chatId; } } });
    const three = await t.send({ sessionId: two.out.sessionId, prompt: 'third' });
    const rec = t.f.spawns[0];
    check('warm: one agy process for three messages (prepare started it, every message reused it)', t.f.spawns.length === 1 && t.engine.keepWarm.stats.spawned === 1 && t.engine.keepWarm.stats.reused === 3, JSON.stringify({ spawns: t.f.spawns.length, stats: t.engine.keepWarm.stats }));
    check('warm: answers stream and the conversation id carries over', one.out.text === 'answer 1' && two.out.text === 'answer 2' && three.out.text === 'answer 3' && one.out.sessionId === 'conv-1' && three.out.sessionId === 'conv-1' && !one.out.failed, JSON.stringify([one.out, two.out, three.out]));
    check('warm: the messages are stdin lines; the first carries Lumen\'s instructions, later ones only the reminder', rec.lines.length === 3 && rec.lines.every((m) => m.event === 'user') && /<lumen_instructions>\nSYS/.test(rec.lines[0].message.content) && /<lumen_reminder>/.test(rec.lines[1].message.content) && /next$/.test(rec.lines[1].message.content) && !/<lumen_instructions>/.test(rec.lines[2].message.content), JSON.stringify(rec.lines));
    check('warm: one MCP tag for the process\'s life (gate opened once, mcp_config.json written with its token before the spawn)', t.gate.opened.length === 1 && rec.mcp?.mcpServers?.lumen?.headers?.Authorization === 'Bearer tok-1' && t.gate.closed.length === 0, JSON.stringify({ opened: t.gate.opened.length, mcp: rec.mcp }));
    check('warm: the process owns its tag, with the message\'s scope during a turn and none between turns', ownerDuring === 'chat-1' && t.engine.keepWarm.owner(tagDuring) && t.engine.keepWarm.owner(tagDuring).active === null && t.engine.keepWarm.owner('nope') === null, JSON.stringify({ ownerDuring }));
    check('warm: "Starting Antigravity…" only on the process\'s first message', one.events.some((e) => e.type === 'status') && !two.events.some((e) => e.type === 'status'), JSON.stringify(two.events));
    // another model: the idle process goes, a new one starts with the new --model
    const other = await t.send({ sessionId: three.out.sessionId, model: 'gemini-3.1-pro-high' });
    await tick();
    check('warm: another model ends the idle process and starts one with that model, resuming the conversation', t.f.spawns.length === 2 && t.f.spawns[0].child.killed && flag(t.f.spawns[1].argv, '--model') === 'gemini-3.1-pro-high' && flag(t.f.spawns[1].argv, '--conversation') === 'conv-1' && other.out.text === 'answer 1', JSON.stringify({ n: t.f.spawns.length, argv: t.f.spawns[1]?.argv, out: other.out }));
    // the chat is gone: its process ends, its token file goes, the gate closes the tag
    const mcpFile = path.join(ag.chatHomeFor(t.data, 'chat-1'), '.gemini', 'config', 'mcp_config.json');
    await t.engine.keepWarm.dropChat('chat-1');
    await tick(); await tick();
    check('warm: dropChat ends the chat\'s process, closes its MCP tag and removes its token file', t.f.spawns[1].child.killed && t.engine.keepWarm.count() === 0 && t.gate.closed.includes(t.gate.opened[1].tag) && !fs.existsSync(mcpFile), JSON.stringify({ count: t.engine.keepWarm.count(), closed: t.gate.closed.length, file: fs.existsSync(mcpFile) }));
  }

  // ---------- two chats: two processes, each in its own home ----------
  {
    const t = setup();
    await t.send({ chatId: 'a' });
    await t.send({ chatId: 'b' });
    check('warm: two chats get two processes, each in its own chat home', t.f.spawns.length === 2 && t.f.spawns[0].opts.env.HOME !== t.f.spawns[1].opts.env.HOME && t.f.spawns[0].opts.env.HOME === ag.chatHomeFor(t.data, 'a'), JSON.stringify(t.f.spawns.map((s) => s.opts.env.HOME)));
    t.engine.keepWarm.disposeAll({ now: true });
  }

  // ---------- fallback: an agy without stream input, and the feature off ----------
  {
    const t = setup({ noStream: true });
    const r = await t.send();
    check('fallback: an agy that ends with no output on stdin turns -> the same message through a cold `agy -p` run', t.f.spawns.length === 2 && t.f.spawns[0].argv.includes('--input-format') && flag(t.f.spawns[1].argv, '-p')?.includes('hello') && r.out.text === 'cold answer' && !r.out.failed && !r.events.some((e) => e.type === 'error'), JSON.stringify({ argv: t.f.spawns.map((s) => s.argv), out: r.out, events: r.events }));
    await t.send({ sessionId: r.out.sessionId });
    await t.send({ sessionId: r.out.sessionId });
    const streams = t.f.spawns.filter((s) => s.argv.includes('--input-format')).length;
    check('fallback: after two failed starts this agy gets cold runs only (no third stream start)', streams === 2 && t.f.spawns.length === 5 && t.engine.keepWarm.stats.fallbacks >= 3, JSON.stringify({ streams, spawns: t.f.spawns.length, stats: t.engine.keepWarm.stats }));
  }
  {
    const t = setup({}, { enabled: () => false });
    const r = await t.send();
    check('fallback: with the feature off every message is a cold `agy -p` run', t.f.spawns.length === 1 && t.f.spawns[0].argv.includes('-p') && !t.f.spawns[0].argv.includes('--input-format') && r.out.text === 'cold answer', JSON.stringify(t.f.spawns.map((s) => s.argv)));
  }
  {
    const t = setup();
    const r = await t.send({ chatId: null });
    check('fallback: a message that belongs to no chat runs cold (no kept process)', t.f.spawns.length === 1 && t.f.spawns[0].argv.includes('-p') && r.out.text === 'cold answer', JSON.stringify(t.f.spawns.map((s) => s.argv)));
  }

  // ---------- Stop ends the process (agy's stream input has no interrupt); the next message resumes in a new one ----------
  {
    let turns = 0; // (over both processes: the first message never ends, the next one does)
    const t = setup({ onTurn: async (msg, n, say, conv) => { turns++; say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'partial' } }); if (turns === 1) return; say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'ok' } }); } });
    const controller = new AbortController();
    const r = await t.send({ controller, onEvent: (e) => { if (e.type === 'text') controller.abort(); } });
    check('stop: aborting a turn kills the kept process and returns stopped with the text so far', r.out.stopped === true && r.out.text === 'partial' && t.f.kills.includes(t.f.spawns[0].child.pid) && t.engine.keepWarm.count() === 0, JSON.stringify({ out: r.out, kills: t.f.kills, count: t.engine.keepWarm.count() }));
    const next = await t.send({ sessionId: r.out.sessionId });
    check('stop: the next message starts a new process that resumes the conversation', t.f.spawns.length === 2 && flag(t.f.spawns[1].argv, '--conversation') === 'conv-1' && next.out.sessionId === 'conv-1' && !next.out.failed, JSON.stringify({ argv: t.f.spawns[1]?.argv, out: next.out }));
    t.engine.keepWarm.disposeAll({ now: true });
  }

  // ---------- the stream check still applies ----------
  {
    const t = setup({ onTurn: async (msg, n, say, conv) => { say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } }); } });
    const r = await t.send();
    check('stream check: a shell tool on a kept process stops it and fails the message (Lumen\'s tools only)', r.out.failed === true && r.out.sessionId === null && r.events.some((e) => e.type === 'error' && /run_command/.test(e.text)) && t.f.spawns[0].child.killed && t.engine.keepWarm.count() === 0, JSON.stringify({ out: r.out, events: r.events }));
  }

  // ---------- an ERROR result keeps the process (agy: "multi-turn stream-json sessions still warn and continue") ----------
  {
    const t = setup({ onTurn: async (msg, n, say, conv) => { if (n === 1) say({ event: 'result', result: { conversation_id: conv, status: 'ERROR', error: 'the model request failed with an unspecified error' } }); else say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'fine now' } }); } });
    const bad = await t.send();
    const good = await t.send({ sessionId: 'conv-1' });
    check('error result: the message fails with agy\'s error, the process stays for the next one', bad.out.failed === true && bad.events.some((e) => e.type === 'error' && /unspecified error/.test(e.text)) && good.out.text === 'fine now' && t.f.spawns.length === 1, JSON.stringify({ bad: bad.out, good: good.out, spawns: t.f.spawns.length }));
    t.engine.keepWarm.disposeAll({ now: true });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });

// Reaching Claude Code while the machine is busy (plain Node, a mocked spawn, no real CLI).
//  - concurrent chats (one engine each) get separate processes, tags and MCP tokens
//  - a slow start is shown ("still starting"), never failed: the first line may come after the normal watchdog
//  - a CLI that stays silent is reported as such and flagged noFallback (agent.js never hands that to another model)
//  - a transient failure (overloaded API, a spawn error, a CLI that died silently) is retried once on a fresh process
//  - a failure that keeps happening is reported once, with the CLI's own words; a plan limit / sign-in problem is not retried
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const cc = require('../src/ai/claude-code');
const fallback = require('../src/ai/fallback');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// A fake `claude`: one child per spawn; `respond(rec, msg, n)` answers each stream-json message. `failSpawn(n)` may return an Error to throw.
function fakeClaude(respond, failSpawn = () => null) {
  const spawned = [];
  let attempts = 0;
  const spawn = (bin, argv) => {
    const err = failSpawn(++attempts);
    if (err) throw err;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 5000 + spawned.length;
    const rec = { argv, child, lines: [], killed: false, mcp: JSON.parse(fs.readFileSync(flag(argv, '--mcp-config'), 'utf8')) };
    rec.out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.err = (text) => child.stderr.write(text);
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    rec.session = flag(argv, '--session-id') || flag(argv, '--resume');
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (msg.type === 'control_request') continue;
          rec.lines.push(msg);
          setImmediate(() => respond(rec, msg, rec.lines.length));
        }
        cb();
      },
    });
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
  return { spawn, kill, spawned };
}
const say = (rec, text) => {
  rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
  rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  rec.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
};
const failWith = (rec, text) => rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text, session_id: rec.session });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reach-'));
  let tokens = 0;
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: `tok${++tokens}`, hookUrl: 'x' }), close: () => {} };
  const rig = (respond, extra = {}, failSpawn) => {
    const cli = fakeClaude(respond, failSpawn);
    const make = (more = {}) => {
      const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 10, ...extra, ...more });
      eng.bin = process.execPath;
      return eng;
    };
    return { cli, make };
  };
  const opts = (events, o = {}) => ({ prompt: 'hello', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...o });

  // 1) concurrent chats: each its own engine, process, tag and token; neither waits for the other.
  {
    const { cli, make } = rig(async (rec, msg) => { await sleep(30); say(rec, `re: ${msg.message.content[0].text}`); });
    const a = make();
    const b = make();
    const ea = [];
    const eb = [];
    const [ra, rb] = await Promise.all([a.run(opts(ea, { prompt: 'A', sessionId: 'chat-a' })), b.run(opts(eb, { prompt: 'B', sessionId: 'chat-b' }))]);
    const tokensUsed = cli.spawned.map((r) => r.mcp.mcpServers.lumen.headers.Authorization);
    check('concurrent chats: two processes, each its own session', cli.spawned.length === 2 && cli.spawned[0] !== cli.spawned[1] && new Set(cli.spawned.map((r) => r.session)).size === 2, JSON.stringify(cli.spawned.map((r) => r.session)));
    check('concurrent chats: separate MCP tokens, both answered', new Set(tokensUsed).size === 2 && ra.text === 're: A' && rb.text === 're: B' && !ra.failed && !rb.failed, JSON.stringify({ tokensUsed, ra, rb }));
    a.dispose();
    b.dispose();
  }

  // 2) a slow start (first line well after the normal watchdog) is not a failure, and says it is still starting.
  {
    const { cli, make } = rig(async (rec) => { await sleep(250); say(rec, 'finally'); });
    const eng = make({ watchdogMs: 60, startupWatchdogMs: 2000, slowStartMs: 40 });
    const ev = [];
    const r = await eng.run(opts(ev));
    check('slow start: answered after a wait longer than the watchdog', r.text === 'finally' && !r.failed && cli.spawned.length === 1 && !cli.spawned[0].killed, JSON.stringify({ r, ev }));
    check('slow start: "Starting Claude Code" then a still-starting note, no error', ev.some((e) => e.type === 'status' && /^Starting Claude Code/.test(e.text)) && ev.some((e) => e.type === 'status' && /still starting/.test(e.text)) && !ev.some((e) => e.type === 'error'), JSON.stringify(ev));
    eng.dispose();
    const kept = make({ watchdogMs: 60, startupWatchdogMs: 2000, slowStartMs: 0 });
    await kept.run(opts([]));
    check('startup allowance is for the first line only: the default allowance is longer than the silence watchdog', cc.STARTUP_WATCHDOG_MS > 90 * 1000, String(cc.STARTUP_WATCHDOG_MS));
    kept.dispose();
  }

  // 3) a CLI that never speaks: ended with the plain error, flagged so no other model takes the message.
  {
    const { cli, make } = rig(() => {});
    const eng = make({ watchdogMs: 50, startupWatchdogMs: 50, slowStartMs: 0 });
    const ev = [];
    const r = await eng.run(opts(ev));
    const err = ev.find((e) => e.type === 'error');
    check('silent CLI: ended, the error says it stopped responding and is flagged noFallback', r.failed && cli.spawned.length === 1 && cli.spawned[0].killed && /stopped responding/.test(err?.text || '') && err.noFallback === true, JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 4) a transient API failure is retried once on a fresh process and then succeeds, without an error on screen.
  {
    const { cli, make } = rig((rec, msg, n) => (cli.spawned.length === 1 ? failWith(rec, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}') : say(rec, 'ok now')));
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('transient 529: retried once, the second process answers, no error shown', r.text === 'ok now' && !r.failed && cli.spawned.length === 2 && !ev.some((e) => e.type === 'error') && ev.some((e) => e.type === 'status' && /trying again/.test(e.text)), JSON.stringify({ r, ev, n: cli.spawned.length }));
    eng.dispose();
  }

  // 4b) a spawn that fails once (EBUSY on a busy Windows machine) is retried.
  {
    const busy = Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' });
    const { cli, make } = rig((rec) => say(rec, 'started'), {}, (n) => (n === 1 ? busy : null));
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('spawn EBUSY: retried once and answered', r.text === 'started' && !r.failed && cli.spawned.length === 1 && !ev.some((e) => e.type === 'error'), JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 4c) a CLI that exits at once with nothing to say (exit 1, no output) is retried too.
  {
    const { cli, make } = rig((rec) => (cli.spawned.length === 1 ? rec.exit(1) : say(rec, 'second try')));
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('early silent exit: retried once and answered', r.text === 'second try' && !r.failed && cli.spawned.length === 2, JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 5) a failure that persists: one retry, then ONE error carrying the CLI's own words, which the fallback can explain.
  {
    const { cli, make } = rig((rec) => failWith(rec, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'));
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    const errs = ev.filter((e) => e.type === 'error');
    check('persistent 529: exactly one retry, then one error', r.failed && cli.spawned.length === 2 && errs.length === 1 && !errs[0].noFallback, JSON.stringify({ r, ev }));
    const info = fallback.classify(errs[0]?.text || '');
    check('persistent 529: the fallback notice gives the real reason', info.kind === 'unreachable' && fallback.noticeFor({ kind: info.kind, from: 'claudecode:sonnet', to: 'gemini:flash', reason: fallback.reasonFor(info, 'claudecode:sonnet') }, [{ id: 'gemini:flash', label: 'Gemini Flash', provider: 'Gemini' }]).startsWith('Couldn’t reach Claude Code (it is overloaded), switched to '), JSON.stringify(info));
    eng.dispose();
  }

  // 5b) a hard exit with stderr: the notice says what claude printed.
  {
    const { cli, make } = rig((rec) => { rec.err('EPERM: operation not permitted, open settings.json\nmore\n'); rec.exit(2); });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    const text = ev.find((e) => e.type === 'error')?.text || '';
    const info = fallback.classify(text);
    check('stderr exit: retried once (EPERM is transient), then the first stderr line is the reason', r.failed && cli.spawned.length === 2 && /EPERM/.test(text) && fallback.reasonFor({ ...info, detail: text }, 'claudecode:sonnet').startsWith('claude exited with code 2: EPERM'), JSON.stringify({ text, reason: fallback.reasonFor({ ...info, detail: text }, 'claudecode:sonnet') }));
    eng.dispose();
  }

  // 6) a plan's usage limit and a sign-in problem say the same thing again: no retry.
  {
    const { cli, make } = rig((rec) => failWith(rec, "Your Claude plan's usage limit is reached. resets 5pm"));
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('usage limit: not retried', r.failed && cli.spawned.length === 1 && ev.filter((e) => e.type === 'error').length === 1, JSON.stringify(ev));
    eng.dispose();
    check('transientFailure: what is retried and what is not', cc.transientFailure('API Error: 529 overloaded', 1) && cc.transientFailure('spawn EBUSY', -1) && cc.transientFailure('', 1) && !cc.transientFailure('Not logged in · Please run /login', 1) && !cc.transientFailure('Claude AI usage limit reached|1790640600', 1) && !cc.transientFailure('', 0));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall Claude Code reach checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });

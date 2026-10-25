// A CLI that is being updated cannot be started for a few seconds (claude.exe rewritten by an npm / native self-update: spawn UNKNOWN, EBUSY,
// EACCES, EPERM, ENOENT). Lumen waits and starts it again (1 s, 2 s, 3 s, looking it up afresh), then moves the turn to another AI, and blames
// security software only on a real block (cli-utils startChild / describeStart; plain Node, a fake spawn, no real CLI, no account).
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const cu = require('../../src/ai/cli-utils');
const cc = require('../../src/ai/claude-code');
const cx = require('../../src/ai/codex');
const gb = require('../../src/ai/grok-build');
const ag = require('../../src/ai/antigravity');
const fallback = require('../../src/ai/fallback');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const coded = (message, code) => Object.assign(new Error(message), { code });

// A fake `claude`. `fail(file, n)` returns an Error to throw for this spawn (n counts from 1), or null to start.
function fakeClaude(fail) {
  const spawned = [];
  const files = [];
  const spawn = (file, argv) => {
    files.push(file);
    const err = fail(file, files.length);
    if (err) throw err;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 7000 + spawned.length;
    const rec = { argv, child };
    rec.session = flag(argv, '--session-id') || flag(argv, '--resume');
    rec.out = (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`);
    child.stdin = new Writable({
      write(_c, _e, cb) {
        setImmediate(() => {
          rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
          rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi there' } } });
          rec.out({ type: 'result', subtype: 'success', is_error: false, result: 'hi there', session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
        });
        cb();
      },
    });
    spawned.push(rec);
    return child;
  };
  return { spawn, spawned, files, kill: (c) => { c.exitCode = 0; setImmediate(() => c.emit('close', 0)); } };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-start-'));
  const oldExe = path.join(tmp, 'old-claude.exe');
  const newExe = path.join(tmp, 'new-claude.exe');
  fs.writeFileSync(oldExe, 'x');
  fs.writeFileSync(newExe, 'x');
  const aged = new Date(Date.now() - 3600e3);
  fs.utimesSync(oldExe, aged, aged); // not "just rewritten"
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: 'tok', hookUrl: 'x' }), close: () => {} };
  const waits = [];
  const rig = (fail) => {
    const cli = fakeClaude(fail);
    const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 10, startWait: async (ms) => { waits.push(ms); } });
    eng.bin = oldExe;
    return { cli, eng };
  };
  const run = (eng, events) => eng.run({ prompt: 'open mech of mats review packet 1', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e) });
  const savedBin = process.env.LUMEN_CLAUDE_BIN;
  process.env.LUMEN_CLAUDE_BIN = oldExe;

  // 1) spawn UNKNOWN twice (the exe is mid-update), then it starts: one reply, no error, the waits are 1 s and 2 s.
  {
    waits.length = 0;
    const { cli, eng } = rig((_f, n) => (n <= 2 ? coded('spawn UNKNOWN', 'UNKNOWN') : null));
    const ev = [];
    const r = await run(eng, ev);
    check('UNKNOWN twice then success: one reply, no error shown', r.text === 'hi there' && !r.failed && !ev.some((e) => e.type === 'error') && cli.files.length === 3 && cli.spawned.length === 1, JSON.stringify({ r, ev, files: cli.files.length }));
    check('UNKNOWN twice: waited 1 s then 2 s, and said it was updating', waits.join() === '1000,2000' && ev.some((e) => e.type === 'status' && /updating/.test(e.text)), JSON.stringify({ waits, ev }));
    eng.dispose();
  }

  // 2) UNKNOWN every time: three waits (1, 2, 3 s), then the engine's own failure, said as "didn't start", never as security software.
  {
    waits.length = 0;
    const { cli, eng } = rig(() => coded('spawn UNKNOWN', 'UNKNOWN'));
    const ev = [];
    const r = await run(eng, ev);
    const err = ev.find((e) => e.type === 'error');
    check('UNKNOWN persisting: four tries over 1 s + 2 s + 3 s, then a failed turn', r.failed === true && cli.files.length === 4 && waits.join() === '1000,2000,3000', JSON.stringify({ r, files: cli.files.length, waits }));
    check('UNKNOWN persisting: "didn\'t start (it may have just updated)", not security software', err && /didn.t start \(it may have just updated\)\. Lumen tried again/.test(err.text) && !/security software/i.test(err.text), JSON.stringify(err));
    // The failover reads the error text: an engine failure with a brief cooldown, and the notice names the switch.
    const info = fallback.classify(err.text);
    check('UNKNOWN persisting: classified as the engine\'s own failure (unreachable) so the turn moves to the next AI', info.kind === 'unreachable', JSON.stringify(info));
    const options = [{ id: 'claudecode:default', label: 'Claude Code' }, { id: 'codex:gpt-6-luna', label: 'Codex · GPT-6 Luna' }];
    const notice = fallback.noticeFor({ kind: 'unreachable', from: 'claudecode:default', to: 'codex:gpt-6-luna', reason: fallback.reasonFor(info, 'claudecode:default') }, options);
    check('UNKNOWN persisting: the notice says it tried again and switched', /^Claude Code didn.t start \(it may have just updated\)\. Lumen tried again and switched to .*Codex/.test(notice), notice);
    eng.dispose();
  }

  // 3) a genuine block: Windows' virus / Smart App Control text says security; so does EPERM that stays with the file untouched.
  {
    waits.length = 0;
    const virus = rig(() => coded('spawn C:\\x\\claude.exe EACCES: Operation did not complete successfully because the file contains a virus or potentially unwanted software.', 'EACCES'));
    const ev = [];
    await run(virus.eng, ev);
    check('a virus verdict: the security-software message', /security software/.test(ev.find((e) => e.type === 'error')?.text || ''), JSON.stringify(ev));
    virus.eng.dispose();

    const sac = cu.describeStart('spawn UNKNOWN: Smart App Control blocked this app', { name: 'Claude Code', exe: 'claude.exe' });
    check('Smart App Control text: the security-software message', /security software/.test(sac.text), JSON.stringify(sac));

    const perm = rig(() => coded('spawn EPERM', 'EPERM'));
    const ev2 = [];
    await run(perm.eng, ev2);
    check('EPERM persisting with the file unchanged: the security-software message', /security software/.test(ev2.find((e) => e.type === 'error')?.text || ''), JSON.stringify(ev2));
    perm.eng.dispose();

    // The same EPERM while the file is rewritten between tries is an update, not a block.
    const touched = rig(() => coded('spawn EPERM', 'EPERM'));
    touched.eng.startWait = async () => { fs.appendFileSync(oldExe, 'y'); };
    const ev3 = [];
    await run(touched.eng, ev3);
    const text3 = ev3.find((e) => e.type === 'error')?.text || '';
    check('EPERM while the file changes: "didn\'t start", not security software', /didn.t start/.test(text3) && !/security software/.test(text3), text3);
    touched.eng.dispose();
    fs.writeFileSync(oldExe, 'x');
    fs.utimesSync(oldExe, aged, aged);
  }

  // 4) the exe moved during the update (npm -> native): the next try looks it up again and uses the new path.
  {
    waits.length = 0;
    process.env.LUMEN_CLAUDE_BIN = newExe;
    const { cli, eng } = rig((f) => (f === oldExe ? coded('spawn UNKNOWN', 'UNKNOWN') : null));
    const ev = [];
    const r = await run(eng, ev);
    check('a moved exe: the retry re-resolves the path and starts the new one', r.text === 'hi there' && !r.failed && cli.files[0] === oldExe && cli.files[1] === newExe && cli.files.length === 2, JSON.stringify({ r, files: cli.files }));
    eng.dispose();
    process.env.LUMEN_CLAUDE_BIN = oldExe;
  }

  // 5) startChild itself: an error emitted on the child (EACCES / ENOENT come this way, one tick after spawn) is retried; ENOENT on a path
  // that never existed is not; a final failure reaches the engine's own 'error' handler.
  {
    const seen = [];
    const spawn = (file) => {
      seen.push(file);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      if (seen.length < 3) process.nextTick(() => child.emit('error', coded('spawn EACCES', 'EACCES')));
      else child.pid = 1;
      return child;
    };
    const slept = [];
    const r = await cu.startChild({ spawn, file: oldExe, args: [], options: {}, wait: async (ms) => { slept.push(ms); } });
    check('startChild: an error emitted on the child is retried until it starts', r.tries === 2 && seen.length === 3 && slept.join() === '1000,2000' && r.child.pid === 1, JSON.stringify({ seen: seen.length, slept, tries: r.tries }));

    let calls = 0;
    const never = () => { calls++; const c = new EventEmitter(); process.nextTick(() => c.emit('error', coded('spawn nope ENOENT', 'ENOENT'))); return c; };
    const gone = await cu.startChild({ spawn: never, file: path.join(tmp, 'never-existed.exe'), args: [], options: {}, wait: async () => {} });
    const got = await new Promise((resolve) => { gone.child.once('error', resolve); });
    check('startChild: ENOENT on a path that never existed is not retried, and still reaches the engine', calls === 1 && got.code === 'ENOENT', JSON.stringify({ calls }));

    let n = 0;
    const always = () => { n++; const c = new EventEmitter(); process.nextTick(() => c.emit('error', coded('spawn EBUSY', 'EBUSY'))); return c; };
    const last = await cu.startChild({ spawn: always, file: oldExe, args: [], options: {}, wait: async () => {} });
    const lastErr = await new Promise((resolve) => { last.child.once('error', resolve); });
    check('startChild: a start that keeps failing is tried 4 times, then the error is emitted on the child, marked', n === 4 && /\[lumen-start:unchanged\]/.test(lastErr.message), JSON.stringify({ n, m: lastErr.message }));

    // An exe rewritten within the last two minutes is "updating" however the failure looks: EPERM on it is never blamed on security software.
    const fresh = path.join(tmp, 'fresh.exe');
    fs.writeFileSync(fresh, 'x');
    const freshSpawn = () => { const c = new EventEmitter(); process.nextTick(() => c.emit('error', coded('spawn EPERM', 'EPERM'))); return c; };
    const f = await cu.startChild({ spawn: freshSpawn, file: fresh, args: [], options: {}, wait: async () => {} });
    const freshErr = await new Promise((resolve) => { f.child.once('error', resolve); });
    check('startChild: EPERM on an exe rewritten a moment ago is marked changed (an update, not a block)', /\[lumen-start:changed\]/.test(freshErr.message) && cu.startFailure(freshErr.message).blocked === false, freshErr.message);
  }

  // 6) every engine words a failed start the same way (and the other CLIs' own texts are untouched).
  {
    for (const [name, mod] of [['Claude Code', cc], ['Codex', cx], ['Grok Build', gb], ['Antigravity', ag]]) {
      const soft = mod.describeFailure('spawn UNKNOWN [lumen-start:changed]', -1);
      const hard = mod.describeFailure('spawn EPERM [lumen-start:unchanged]', -1);
      check(`${name}: a failed start is "didn't start", a persistent EPERM on an untouched file is security`, new RegExp(`^${name} didn.t start`).test(soft.text) && /security software/.test(hard.text), JSON.stringify({ soft, hard }));
      check(`${name}: its own failure text is unchanged`, new RegExp(`^${name} stopped \\(exit 3\\): boom`).test(mod.describeFailure('boom', 3).text), mod.describeFailure('boom', 3).text);
    }
  }

  if (savedBin === undefined) delete process.env.LUMEN_CLAUDE_BIN; else process.env.LUMEN_CLAUDE_BIN = savedBin;
  if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall CLI start-retry checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });

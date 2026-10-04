// [cc settings] Settings > AI > "Use my Claude Code settings in Lumen chats" (ccUserSettings, off by default).
// Plain Node, no Electron and no real CLI: a fake `claude` (a Node child speaking stream-json) records its argv.
//  - argv: --setting-sources project when the setting is off; none when on; none in full access (it loads them anyway)
//  - one-shot runs (cli-json.js) follow the same rule
//  - a kept (warm) process is keyed by the setting, so changing it starts another one
//  - a failed start that looks like a sign-in / credential / proxy problem is retried once with the user's settings, with a notice
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cc = require('../src/ai/claude-code');
const cliJson = require('../src/ai/cli-json');
const { DEFAULTS } = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const has = (argv) => argv.includes('--setting-sources') && argv[argv.indexOf('--setting-sources') + 1] === 'project';
const base = { mcpConfig: 'm.json', sessionId: 's', resume: false, systemPrompt: 'P' };

// FAKE_MODE=authfail: fails with a sign-in error whenever the user's settings are NOT loaded (as a CLI whose credentials live in ~/.claude/settings.json).
// FAKE_MODE=alwaysfail: the same error whatever the flags (really signed out).
const FAKE = `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + '\\n');
const lean = argv.includes('--setting-sources');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    const mode = process.env.FAKE_MODE;
    if (mode === 'alwaysfail' || (mode === 'authfail' && lean)) {
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: 'sess-1', usage: {} });
    } else {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello.', session_id: 'sess-1', total_cost_usd: 0, usage: {} });
    }
  }
});
`;

(async () => {
  check('setting: off by default', DEFAULTS.ccUserSettings === false, DEFAULTS.ccUserSettings);

  check('args: off adds --setting-sources project', has(cc.buildArgs({ ...base })) && has(cc.buildArgs({ ...base, userSettings: false })), cc.buildArgs(base).join(' '));
  check('args: on loads the user settings (no flag)', !cc.buildArgs({ ...base, userSettings: true }).includes('--setting-sources'), '');
  check('args: the lockdown flags are unchanged with the setting off', (() => { const a = cc.buildArgs(base); return a[a.indexOf('--tools') + 1] === '' && a.includes('--strict-mcp-config') && a[a.indexOf('--permission-mode') + 1] === 'dontAsk'; })(), '');
  check('args: full access never gets the flag, with the setting on or off', !cc.buildArgs({ ...base, fullAccess: true }).includes('--setting-sources') && !cc.buildArgs({ ...base, fullAccess: true, userSettings: true }).includes('--setting-sources'), '');

  check('one-shot args: off adds it, on does not', has(cliJson.claudeArgs({ system: 's', schema: {} })) && !cliJson.claudeArgs({ system: 's', schema: {}, userSettings: true }).includes('--setting-sources'), cliJson.claudeArgs({ system: 's', schema: {} }).join(' '));
  cliJson.configure({ userSettings: () => true });
  check('one-shot args: follow the setting once main.js wires it', !cliJson.claudeArgs({ system: 's', schema: {} }).includes('--setting-sources'), '');
  cliJson.configure({ userSettings: () => false });

  const k = (o) => cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'P', ...o });
  check('process key: the setting is part of it; model stays at index 2', k({}) === k({ userSettings: false }) && k({}) !== k({ userSettings: true }) && JSON.parse(k({ model: 'haiku' }))[2] === 'haiku', k({}));

  check('failure text: sign-in, credential and proxy errors are retryable; a plain failure is not', cc.settingsRetryable('Invalid API key · Please run /login') && cc.settingsRetryable('self-signed certificate in certificate chain') && cc.settingsRetryable('proxy connection refused') && !cc.settingsRetryable('Prompt is too long') && !cc.settingsRetryable(''), '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ccset-'));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, FAKE);
  process.env.LUMEN_CLAUDE_BIN = fake;
  let n = 0;
  const make = (mode, keepAlive) => {
    const log = path.join(dir, `log-${++n}.jsonl`);
    const fakeSpawn = (bin, argv, opts) => spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', FAKE_LOG: log, FAKE_MODE: mode } });
    const engine = new cc.ClaudeCodeEngine({ userData: dir, mcpCommand: () => ({ command: process.execPath, args: ['-e', ''], env: {} }), ensureServer: () => {}, keepAlive, watchdogMs: 20000, spawn: fakeSpawn });
    const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { engine, starts };
  };
  const send = async (engine, extra = {}) => {
    const events = [];
    const out = await engine.run({ prompt: 'hi', sessionId: '00000000-0000-4000-8000-000000000001', resume: false, systemPrompt: 'LUMEN', signal: new AbortController().signal, emit: (e) => events.push(e), ...extra });
    return { out, events };
  };

  // Off: the real process gets the flag; on: it does not.
  {
    const off = make('ok', false);
    const r = await send(off.engine);
    check('run: off starts the CLI with --setting-sources project', r.out.text === 'Hello.' && off.starts().length === 1 && has(off.starts()[0]), JSON.stringify(off.starts()));
    const on = make('ok', false);
    await send(on.engine, { userSettings: true });
    check('run: on starts the CLI without it', on.starts().length === 1 && !on.starts()[0].includes('--setting-sources'), JSON.stringify(on.starts()));
    const full = make('ok', false);
    await send(full.engine, { fullAccess: true });
    check('run: full access starts it without it', full.starts().length === 1 && !full.starts()[0].includes('--setting-sources'), JSON.stringify(full.starts()));
  }

  // Fallback: a CLI that needs ~/.claude/settings.json to sign in.
  {
    const f = make('authfail', true);
    const r = await send(f.engine);
    const notices = r.events.filter((e) => e.type === 'notice');
    check('fallback: retried once with the user settings and the message succeeds', r.out.text === 'Hello.' && !r.out.failed && f.starts().length === 2 && has(f.starts()[0]) && !f.starts()[1].includes('--setting-sources'), JSON.stringify(f.starts()));
    check('fallback: no error shown, one notice naming the setting', !r.events.some((e) => e.type === 'error') && notices.length === 1 && /Use my Claude Code settings/.test(notices[0].text), JSON.stringify(r.events.filter((e) => e.type === 'error' || e.type === 'notice')));
    const r2 = await send(f.engine, { sessionId: 'sess-1', resume: true }); // (the CLI named the session: the kept process is keyed by that)
    check('fallback: the next message keeps the user settings, with no second notice', r2.out.text === 'Hello.' && f.starts().length === 2 && !r2.events.some((e) => e.type === 'notice'), JSON.stringify(f.starts()));
    f.engine.dispose();

    const g = make('authfail', true);
    const r3 = await send(g.engine);
    check('fallback: a second engine retries again but the notice is only once per run', r3.out.text === 'Hello.' && g.starts().length === 2 && !r3.events.some((e) => e.type === 'notice'), JSON.stringify(r3.events));
    g.engine.dispose();

    const bad = make('alwaysfail', true);
    const r4 = await send(bad.engine);
    check('fallback: a really signed-out CLI is retried once, then reports the sign-in error', r4.out.failed === true && bad.starts().length === 2 && r4.events.some((e) => e.type === 'error' && /not signed in/.test(e.text)) && !r4.events.some((e) => e.type === 'notice'), JSON.stringify(r4.events));
    bad.engine.dispose();

    const fa = make('alwaysfail', true);
    const r5 = await send(fa.engine, { fullAccess: true });
    check('fallback: full access is not retried (it already loads the settings)', r5.out.failed === true && fa.starts().length === 1, JSON.stringify(fa.starts()));
    fa.engine.dispose();

    const on = make('alwaysfail', true);
    const r6 = await send(on.engine, { userSettings: true });
    check('fallback: with the setting on there is no retry', r6.out.failed === true && on.starts().length === 1, JSON.stringify(on.starts()));
    on.engine.dispose();
  }

  // Warm processes: changing the setting replaces the kept process.
  {
    const w = make('ok', true);
    const opts = { sessionId: '00000000-0000-4000-8000-000000000002', resume: false, systemPrompt: 'LUMEN', model: 'default', maxTurns: 0, fullAccess: false };
    const p1 = await w.engine.take({ ...opts, userSettings: false });
    const same = await w.engine.take({ ...opts, userSettings: false });
    check('warm: the same setting keeps the process', same === p1 && !p1.exited, '');
    const p2 = await w.engine.take({ ...opts, userSettings: true });
    check('warm: changing the setting starts another process and ends the old one', p2 !== p1 && p1.disposed === true && p2.key !== p1.key, `${p2 === p1} ${p1.disposed}`);
    const p3 = await w.engine.take({ ...opts, userSettings: false });
    check('warm: changing it back replaces it again', p3 !== p2 && p2.disposed === true, '');
    w.engine.dispose();
  }

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

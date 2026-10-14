// Every external program Lumen starts goes through the hidden-spawn helper in src/ai/cli-utils.js, so none can open a console window
// (with Windows Terminal as the default terminal, a console made for a GUI process's child shows up as a Terminal window:
// "error 0x800700e8 when launching agy.exe --version"). Plain Node, no Electron, no real CLI:
//  - a lint over src/: nothing but the helper (and a short allowlist) touches child_process, and nothing uses shell: true;
//  - the helper sets windowsHide, never a shell, never inherited stdio;
//  - a probe that fails with ERROR_NO_DATA / EBUSY is asked once more, and is "try later", never "not installed".
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const SRC = path.join(__dirname, '..', 'src');
const J = (v) => JSON.stringify(v);

// ---- 1. the lint ----
// Files allowed to use child_process directly, each with the reason. Anything else must use the helper in ai/cli-utils.js.
const ALLOW = {
  'ai/cli-utils.js': 'the helper itself (hidden spawn lives in cli-utils so it adds no start-up module)',
  'features/swap-helper.js': 'starts Lumen (a GUI exe) again after an update; SW_HIDE would hide the new Lumen window',
  'automation/launcher.js': 'relaunches Lumen itself with inherited stdio (a GUI exe, no console is made)',
  'automation/mcp.js': 'starts Lumen visibly on purpose (windowsHide: false) and runs the --mcp bridge on inherited stdio (a GUI exe)',
};
{
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(vendor|node_modules|assets|locales)$/.test(e.name)) walk(p); } else if (/\.(js|mjs|cjs)$/.test(e.name) && !/\.bundle\.js$/.test(e.name)) files.push(p); } };
  walk(SRC);
  const code = (text) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const direct = []; const shellTrue = []; const allowedSeen = new Set();
  for (const file of files) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const text = code(fs.readFileSync(file, 'utf8'));
    if (/['"](?:node:)?child_process['"]/.test(text)) { if (rel in ALLOW) allowedSeen.add(rel); else direct.push(rel); }
    if (/\bshell\s*:\s*true\b/.test(text)) shellTrue.push(rel);
  }
  check('no file in src/ requires child_process except the helper and the allowlist', direct.length === 0, J(direct));
  check('nothing in src/ passes shell: true', shellTrue.length === 0, J(shellTrue));
  check('every allowlist entry is still needed (it requires child_process) and has a reason', Object.entries(ALLOW).every(([f, why]) => allowedSeen.has(f) && why.length > 10), J([...allowedSeen]));
  const helper = fs.readFileSync(path.join(SRC, 'ai', 'cli-utils.js'), 'utf8');
  check('the helper loads child_process lazily (startup budget)', !/^(const|let|var)\s+[^=]*=\s*require\(['"]child_process['"]\)/m.test(helper) && /require\('child_process'\)/.test(helper));
}

(async () => {
  // ---- 2. the helper's options ----
  const cp = require('child_process');
  const real = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFile: cp.execFile, execFileSync: cp.execFileSync };
  const calls = [];
  let execScript = []; // each entry: { err, stdout } for the next execFile
  cp.spawn = (file, args, o) => { calls.push({ fn: 'spawn', file, args, o }); return {}; };
  cp.spawnSync = (file, args, o) => { calls.push({ fn: 'spawnSync', file, args, o }); return { status: 0 }; };
  cp.execFileSync = (file, args, o) => { calls.push({ fn: 'execFileSync', file, args, o }); return ''; };
  cp.execFile = (file, args, o, cb) => { calls.push({ fn: 'execFile', file, args, o }); const step = execScript.shift() || { stdout: '' }; setImmediate(() => cb(step.err || null, step.stdout || '', step.stderr || '')); return {}; };
  const hs = require('../src/ai/cli-utils');
  try {
    const hidden = (c) => c.o.windowsHide === true && c.o.shell === false && c.o.stdio !== 'inherit' && !(Array.isArray(c.o.stdio) && c.o.stdio.includes('inherit'));
    hs.spawn('agy.exe', ['--version']);
    hs.spawn('claude', ['-p'], { shell: true, windowsHide: false, stdio: 'inherit', cwd: 'C:\\x' });
    hs.spawn('claude', [], { stdio: ['inherit', 'pipe', 'inherit'], detached: true });
    hs.spawnSync('where', ['ant'], { windowsHide: false });
    hs.execFileSync('powershell.exe', ['-NoProfile'], { shell: true });
    await new Promise((r) => hs.execFile('reg', ['query', 'x'], { shell: true, windowsHide: false, timeout: 5 }, r));
    check('spawn with no options: windowsHide true, no shell, stdio pipe', hidden(calls[0]) && calls[0].o.stdio === 'pipe', J(calls[0]));
    check('windowsHide: false, shell: true and stdio inherit from the caller are overridden', hidden(calls[1]) && calls[1].o.cwd === 'C:\\x', J(calls[1]));
    check('an inherited entry in a stdio array becomes ignore; pipes and detached are kept', J(calls[2].o.stdio) === J(['ignore', 'pipe', 'ignore']) && calls[2].o.detached === true && hidden(calls[2]), J(calls[2]));
    check('spawnSync and execFileSync are hidden too', hidden(calls[3]) && calls[4].o.windowsHide === true && calls[4].o.shell === false, J([calls[3], calls[4]]));
    check('execFile is hidden, never a shell, and keeps the caller\'s timeout', calls[5].o.windowsHide === true && calls[5].o.shell === false && calls[5].o.timeout === 5, J(calls[5]));
    check('file and args are passed through untouched (never joined into a command line)', calls[0].file === 'agy.exe' && J(calls[0].args) === J(['--version']));

    // ---- 3. probes: retry once on ERROR_NO_DATA / EBUSY ----
    const noData = Object.assign(new Error("[error 2147942632 (0x800700e8) when launching 'agy.exe --version']"), { code: 'UNKNOWN', errno: -4094 });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const busy = Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' });
    const gone = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    const exit1 = Object.assign(new Error('Command failed'), { code: 1 });
    check('isTransient: ERROR_NO_DATA text, EPIPE, EBUSY, errno 232 are transient; ENOENT and a plain exit code are not', hs.isTransient(noData) && hs.isTransient(epipe) && hs.isTransient(busy) && hs.isTransient({ errno: 232 }) && !hs.isTransient(gone) && !hs.isTransient(exit1) && !hs.isTransient(null));

    const waits = [];
    const wait = (ms) => { waits.push(ms); return Promise.resolve(); };
    for (const [name, err] of [['ERROR_NO_DATA', noData], ['EBUSY', busy], ['EPIPE', epipe]]) {
      calls.length = 0; waits.length = 0; execScript = [{ err }, { stdout: 'agy 1.3.5\n' }];
      const r = await hs.probe('agy.exe', ['--version'], { timeout: 8000 }, { wait });
      check(`probe: ${name} on the first try, then success -> ok after one retry`, r.ok === true && r.stdout.includes('1.3.5') && r.transient === false && calls.filter((c) => c.fn === 'execFile').length === 2 && waits.length === 1 && waits[0] > 0 && waits[0] <= 2000, J({ ok: r.ok, transient: r.transient, n: calls.length, waits }));
    }
    calls.length = 0; waits.length = 0; execScript = [{ err: noData }, { err: noData }, { err: noData }];
    const twice = await hs.probe('agy.exe', ['--version'], {}, { wait });
    check('probe: ERROR_NO_DATA twice -> one retry only, reported as transient ("try later", not "not installed")', twice.ok === false && twice.transient === true && calls.length === 2, J({ ok: twice.ok, transient: twice.transient, n: calls.length }));
    calls.length = 0; execScript = [{ err: exit1 }];
    const bad = await hs.probe('ant', ['--version'], {}, { wait });
    check('probe: a plain non-zero exit is not retried and not transient', bad.ok === false && bad.transient === false && calls.length === 1, J({ transient: bad.transient, n: calls.length }));
    calls.length = 0; execScript = [{ err: gone }, { err: gone }];
    const missing = await hs.probe('agy', ['--version'], {}, { wait });
    check('probe: ENOENT is asked once more (a replaced exe) and then reported as not found, not transient', missing.ok === false && missing.transient === false && calls.length === 2, J({ transient: missing.transient, n: calls.length }));
    calls.length = 0; execScript = [{ stdout: 'ok' }];
    const fine = await hs.probe('claude', ['--version'], {}, { wait });
    check('probe: success on the first try runs once, with no wait', fine.ok && calls.length === 1, J(calls.length));
    const thrown = await hs.retryProbe(async () => { throw busy; }, { wait });
    check('retryProbe: a thrown error is data, not an exception', thrown.ok === false && thrown.transient === true);

    // ---- 4. a hidden test Electron never runs the user's real CLIs ----
    const os = require('os');
    const saved = { electron: process.versions.electron, defaultApp: process.defaultApp, test: process.env.CLAUDE_BROWSER_TEST, real: process.env.LUMEN_TEST_REAL_CLIS };
    const setMode = (on) => {
      Object.defineProperty(process.versions, 'electron', { value: on ? '44.1.0' : saved.electron, configurable: true, writable: true });
      process.defaultApp = on ? true : saved.defaultApp;
      if (on) process.env.CLAUDE_BROWSER_TEST = '1'; else if (saved.test === undefined) delete process.env.CLAUDE_BROWSER_TEST; else process.env.CLAUDE_BROWSER_TEST = saved.test;
    };
    const realAgy = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const realClaude = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    try {
      const stub =path.join(os.tmpdir(), 'lumen-stub', 'agy.exe');
      check('outside a test Electron nothing is blocked', hs.testBlocksRealCli(realAgy) === false);
      setMode(true);
      delete process.env.LUMEN_TEST_REAL_CLIS;
      check('test Electron: the real agy / claude / codex / grok / ant paths are blocked', [realAgy, realClaude, 'codex', 'grok.cmd', 'ant.exe'].every((f) => hs.testBlocksRealCli(f)));
      check('test Electron: a stub inside the test\'s temp folder runs; non-CLI programs (where, reg, powershell) are not touched', hs.testBlocksRealCli(stub) === false && !hs.testBlocksRealCli('where') && !hs.testBlocksRealCli('reg.exe') && !hs.testBlocksRealCli('powershell.exe'));
      calls.length = 0;
      const blocked = await hs.probe(realAgy, ['--version'], {}, { wait: () => Promise.resolve() });
      check('test Electron: a version probe of the real agy never starts a process (no window, no self-update)', calls.length === 0 && blocked.ok === false, J({ n: calls.length }));
      process.env.LUMEN_TEST_REAL_CLIS = '1';
      check('LUMEN_TEST_REAL_CLIS=1 lets a manual suite use the real CLI', hs.testBlocksRealCli(realClaude) === false);
    } finally {
      setMode(false);
      if (saved.real === undefined) delete process.env.LUMEN_TEST_REAL_CLIS; else process.env.LUMEN_TEST_REAL_CLIS = saved.real;
    }
  } finally {
    Object.assign(cp, real);
  }
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

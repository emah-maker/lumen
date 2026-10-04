// Claude Code's per-process temp folder (os.tmpdir()/lumen-cc-*, holding mcp.json with a bearer token) is removed when its
// process ends (exit, kill, idle timeout, warm-pool eviction, quit) and never while the process runs; the start-up sweep
// removes only old folders with exactly that name pattern. Plain Node: fake CLI processes, TEMP pointed at a scratch folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-cleanup-test-'));
const scratch = path.join(base, 'tmp');
fs.mkdirSync(scratch);
for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = scratch; // os.tmpdir() reads these on every call
const ccDirs = () => fs.readdirSync(scratch).filter((n) => n.startsWith('lumen-cc-'));

const cc = require('../src/ai/claude-code');
const { createWarmChats } = require('../src/features/warm-chats');
const { sweepStale } = require('../src/ai/temp-dirs');

function fakeCli() {
  const spawned = [];
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.exitCode = null;
    child.pid = 9000 + spawned.length;
    const cfg = argv[argv.indexOf('--mcp-config') + 1];
    spawned.push({ child, cfg, cwd: opts.cwd, exit: (code = 0) => { if (!child.done) { child.done = true; child.exitCode = code ?? -1; setImmediate(() => child.emit('close', code)); } } });
    return child;
  };
  const kill = (child) => { spawned.find((r) => r.child === child)?.exit(null); };
  return { spawn, kill, spawned };
}
const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'secret-token', hookUrl: 'x' }), close() {} };
function engine(cli, extra = {}) {
  const e = new cc.ClaudeCodeEngine({ userData: base, mcpCommand: () => ({}), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, ...extra });
  e.bin = process.execPath;
  return e;
}
const optsFor = (id) => ({ sessionId: id, resume: false, systemPrompt: 'SYS', model: 'default', maxTurns: 0 });

(async () => {
  // ---- the folder exists, private, while its process runs; the config is 0600 on POSIX
  {
    const cli = fakeCli();
    const e = engine(cli);
    const p = await e.take(optsFor('s1'));
    const dir = path.dirname(cli.spawned[0].cfg);
    check('running process: its folder (with mcp.json) exists', fs.existsSync(cli.spawned[0].cfg) && ccDirs().length === 1, ccDirs().join());
    if (process.platform !== 'win32') check('mcp.json is 0600', (fs.statSync(cli.spawned[0].cfg).mode & 0o777) === 0o600);
    // reuse: a second take for the same session keeps the process and its folder
    const again = await e.take(optsFor('s1'));
    await sleep(50);
    check('reused kept process: same process, folder still there', again === p && fs.existsSync(dir), '');

    // exit on its own
    cli.spawned[0].exit(0);
    await sleep(150);
    check('process exits: folder removed', !fs.existsSync(dir) && ccDirs().length === 0, ccDirs().join());
    check('workDirs forgets the folder', e.workDirs.size === 0, String(e.workDirs.size));
  }

  // ---- kill (dispose)
  {
    const cli = fakeCli();
    const e = engine(cli);
    await e.take(optsFor('s2'));
    const dir = path.dirname(cli.spawned[0].cfg);
    e.dispose();
    await sleep(150);
    check('dispose/kill: folder removed', !fs.existsSync(dir), dir);
  }

  // ---- idle timeout
  {
    const cli = fakeCli();
    const e = engine(cli, { idleMs: 40 });
    e.warm(optsFor('s3'));
    await sleep(20);
    const dir = path.dirname(cli.spawned[0].cfg);
    check('warm process within idle window: folder kept', fs.existsSync(dir), '');
    await sleep(250);
    check('idle timeout: process killed, folder removed', cli.spawned[0].child.done && !fs.existsSync(dir), `exit=${cli.spawned[0].child.exitCode}`);
  }

  // ---- spawn failure
  {
    const e = engine(fakeCli(), { spawn: () => { const err = new Error('nope'); err.code = 'ENOENT'; throw err; } });
    await e.take(optsFor('s4'));
    await sleep(150);
    check('spawn failure: folder removed', ccDirs().length === 0, ccDirs().join());
  }

  // ---- warm-pool eviction: maxIdle 1, the least recently used idle chat's folder goes, the other's stays
  {
    const cli = fakeCli();
    let t = 0;
    const pool = createWarmChats({ make: () => engine(cli), maxIdle: () => 1, idleMs: () => 600000, now: () => ++t });
    const a = pool.peek('chat-a'); a.warm(optsFor('a')); await sleep(30); pool.warmed();
    const b = pool.peek('chat-b'); b.warm(optsFor('b')); await sleep(30); pool.warmed();
    await sleep(200);
    const [ra, rb] = cli.spawned;
    check('eviction: the evicted chat\'s process is killed and its folder removed', ra.child.exitCode !== null && !fs.existsSync(path.dirname(ra.cfg)), `exit=${ra.child.exitCode}`);
    check('eviction: the other chat\'s warm process keeps its folder', rb.child.exitCode === null && fs.existsSync(rb.cfg), '');
    pool.disposeAll();
    await sleep(150);
    check('disposeAll: every folder removed', ccDirs().length === 0, ccDirs().join());
  }

  // ---- quit: purgeDirs removes synchronously, even before the async path ran
  {
    const cli = fakeCli();
    const e = engine(cli);
    await e.take(optsFor('s5'));
    e.dispose();
    e.purgeDirs();
    check('quit: purgeDirs removes the folder at once', ccDirs().length === 0 && e.workDirs.size === 0, ccDirs().join());
  }

  // ---- start-up sweep
  {
    const old = Date.now() - 3 * 86400000;
    const mk = (name, { age = old, file = false } = {}) => {
      const p = path.join(scratch, name);
      if (file) fs.writeFileSync(p, 'x'); else { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'mcp.json'), '{}'); }
      fs.utimesSync(p, new Date(age), new Date(age));
      return p;
    };
    const oldCc = mk('lumen-cc-AbC123');
    const oldCc1 = mk('lumen-cc1-Zz9Yy8');
    const fresh = mk('lumen-cc-Fresh1', { age: Date.now() - 60000 });
    const live = mk('lumen-cc-Live01');
    const other = mk('lumen-other-AbC123');
    const longer = mk('lumen-cc-AbC123456'); // not a mkdtemp name
    const bare = mk('lumen-cc-'); // no suffix
    const asFile = mk('lumen-cc-File01', { file: true });
    const userDir = mk('my-lumen-cc-AbC123');
    const removed = await sweepStale({ live: new Set([live]) });
    const gone = (p) => !fs.existsSync(p);
    check('sweep: old lumen-cc-* / lumen-cc1-* folders removed', gone(oldCc) && gone(oldCc1) && removed.length === 2, J(removed));
    check('sweep: fresh, live, differently named or non-directory entries stay', !gone(fresh) && !gone(live) && !gone(other) && !gone(longer) && !gone(bare) && !gone(asFile) && !gone(userDir), '');
    for (const p of [fresh, live, other, longer, bare, asFile, userDir]) fs.rmSync(p, { recursive: true, force: true });
    check('sweep of a missing temp folder is harmless', (await sweepStale({ tmp: path.join(base, 'nope') })).length === 0);
  }

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
function J(v) { return JSON.stringify(v); }

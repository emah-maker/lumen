// Shared by scripts/land.js and scripts/release.js: running git / gh / npm, the main checkout's path, electron processes, CI polling.
// Side-effecting; the logic worth testing lives in release-lib.js.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class Stop extends Error {} // a clear reason to stop; the scripts print it and exit 1

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (step, msg) => console.log(`[${stamp()}] ${step.padEnd(9)} ${msg}`);

// Run a command and return { status, stdout, stderr } (no throw). npm and npx are .cmd files on Windows and need a shell there.
function run(cmd, args, opts = {}) {
  const shell = process.platform === 'win32' && /^(npm|npx)$/.test(cmd);
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: opts.env || process.env, shell, input: opts.input, maxBuffer: 64 * 1024 * 1024, stdio: opts.inherit ? 'inherit' : undefined });
  return { status: r.status === null ? 1 : r.status, out: r.stdout || '', stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error };
}
const must = (r, what) => { if (r.status !== 0) throw new Stop(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).split('\n').slice(-4).join(' | ')}`); return r.stdout; };
const git = (cwd, ...args) => run('git', args, { cwd });
const gh = (cwd, ...args) => run('gh', args, { cwd });
// A network failure worth retrying, from gh (GitHub's GraphQL "Something went wrong", HTTP 502/503/504/429, timeouts, dropped connections)
// or from git (DNS, TLS, "RPC failed", "the remote end hung up", early EOF). A permanent failure (auth, a rejected push, not found) never matches.
const TRANSIENT = /something went wrong|\bHTTP (429|5\d\d)\b|bad gateway|service unavailable|gateway time-?out|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|connection (reset|refused|was reset|closed)|could not resolve host|couldn't resolve host|unable to access|early eof|rpc failed|remote end hung up|failed to connect|unexpected disconnect|network is unreachable|temporary failure in name resolution|tls handshake|ssl_|schannel|broken pipe|could not read from remote repository|i\/o timeout|no such host/i;
const PERMANENT = /authentication failed|permission denied|returned error: (401|403|404)|\[rejected\]|non-fast-forward|fetch first|already exists|not mergeable|repository not found|could not find|\bHTTP (401|403|404|422)\b|bad credentials/i;
const isTransient = (r) => { if (r.status === 0) return false; const t = `${r.stderr || ''} ${r.stdout || ''} ${r.error ? r.error.message : ''}`; return TRANSIENT.test(t) && !PERMANENT.test(t); };

// The retry policy for network steps: NET_TRIES attempts, the wait before retry n is baseMs * 2^(n-1), capped (2 s, 4 s, 8 s, 16 s, 30 s ...).
const NET_TRIES = 5;
const backoffMs = (attempt, { baseMs = 2000, capMs = 30000 } = {}) => Math.min(capMs, baseMs * 2 ** (Math.max(1, attempt) - 1));

// Calls `call()` (returns { status, ... }) up to `tries` times while it fails transiently. Before each retry `recheck()` may return a finished result
// ({ status: 0, stdout }) when the failed call actually went through (a merge that landed, a PR that was created, a push that arrived): that counts as success.
async function retryCmd(call, { tries = NET_TRIES, baseMs = 2000, capMs = 30000, recheck = null, nap = sleep, log = () => {}, label = 'command', classify = isTransient } = {}) {
  let r;
  for (let i = 1; i <= tries; i++) {
    r = call();
    if (r.status === 0 || !classify(r) || i === tries) return r;
    const wait = backoffMs(i, { baseMs, capMs });
    log(`${label} hit a network error (attempt ${i} of ${tries}); retrying in ${Math.round(wait / 1000)}s`);
    await nap(wait);
    const done = recheck ? await recheck() : null;
    if (done) return done;
  }
  return r;
}

// gh with retries on transient errors (3 attempts unless a caller asks for more).
const ghRetry = (cwd, args, { tries = 3, backoffMs: baseMs = 2000, runner = gh, ...rest } = {}) => retryCmd(() => runner(cwd, ...args), { tries, baseMs, label: `gh ${args.slice(0, 2).join(' ')}`, ...rest });
// git with retries (fetch, push, ls-remote): NET_TRIES attempts.
const gitRetry = (cwd, args, { runner = git, ...rest } = {}) => retryCmd(() => runner(cwd, ...args), { label: `git ${args[0]}`, ...rest });
async function ghJsonRetry(cwd, args, opts = {}) {
  const out = must(await ghRetry(cwd, args, opts), `gh ${args.slice(0, 2).join(' ')}`);
  try { return JSON.parse(out || 'null'); } catch { throw new Stop(`gh ${args.slice(0, 2).join(' ')} gave unreadable output`); }
}

function ghJson(cwd, ...args) {
  const out = must(gh(cwd, ...args), `gh ${args.slice(0, 2).join(' ')}`);
  try { return JSON.parse(out || 'null'); } catch { throw new Stop(`gh ${args.slice(0, 2).join(' ')} gave unreadable output`); }
}

// The main checkout, wherever the script runs from (a worktree's own root is not it).
function mainCheckout(from) {
  const common = must(git(from, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'git rev-parse');
  return path.resolve(common, '..');
}
const worktreesDir = (main) => path.join(main, '.claude', 'worktrees');

// Worktrees as [{ dir, branch, head }].
function listWorktrees(cwd) {
  const out = must(git(cwd, 'worktree', 'list', '--porcelain'), 'git worktree list');
  return out.split(/\n\n+/).map((block) => {
    const w = {};
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ');
      if (k === 'worktree') w.dir = v.join(' ');
      else if (k === 'branch') w.branch = v.join(' ').replace('refs/heads/', '');
      else if (k === 'HEAD') w.head = v.join(' ');
    }
    return w;
  }).filter((w) => w.dir);
}

// [{ pid, exe, cmd }] for every running electron process (Windows: electron.exe; elsewhere any process whose command names electron).
function listElectron() {
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const r = run('powershell', ['-NoProfile', '-Command', ps]);
    if (r.status !== 0 || !r.stdout) return [];
    const data = JSON.parse(r.stdout);
    return (Array.isArray(data) ? data : [data]).map((p) => ({ pid: p.ProcessId, exe: p.ExecutablePath || '', cmd: p.CommandLine || '' }));
  }
  const r = run('ps', ['-axo', 'pid=,command=']);
  return r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && /electron/i.test(m[2]) && !/\bps -axo\b/.test(m[2])).map((m) => ({ pid: Number(m[1]), exe: m[2].split(' ')[0], cmd: m[2] }));
}

// Stop one process tree by PID.
function killTree(pid) {
  if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// CI for one commit: { state: 'none' | 'pending' | 'failed' | 'success', runs }. Polls gh's run list with status and conclusion
// (not `gh run watch --exit-status`: that exits early when a run carries an annotation warning).
async function ciState(cwd, sha, opts = {}) {
  const runs = await ghJsonRetry(cwd, ['run', 'list', '--commit', sha, '--json', 'databaseId,status,conclusion,workflowName,url'], { tries: NET_TRIES, ...opts });
  if (!runs || !runs.length) return { state: 'none', runs: [] };
  const bad = runs.find((r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped');
  if (bad) return { state: 'failed', runs, bad };
  if (runs.every((r) => r.status === 'completed')) return { state: 'success', runs };
  return { state: 'pending', runs };
}

async function waitForCi(cwd, sha, { appearMs = 10 * 60000, timeoutMs = 40 * 60000, every = 20000, log = () => {} } = {}) {
  const t0 = Date.now();
  let last = '';
  let blind = 0;
  for (;;) {
    let s;
    try { s = await ciState(cwd, sha, { log }); blind = 0; } catch (err) {
      // GitHub unreachable even after the retries (an outage): keep polling for a while instead of stopping the release.
      if (++blind > 10) throw err;
      log(`could not read CI state (${err.message.slice(0, 80)}); polling again (${blind} of 10)`);
      await sleep(every);
      continue;
    }
    if (s.state === 'success') return s;
    if (s.state === 'failed') throw new Stop(`CI failed on ${sha.slice(0, 8)}: ${s.bad.workflowName} (${s.bad.conclusion}) ${s.bad.url}`);
    const waited = Date.now() - t0;
    if (s.state === 'none' && waited > appearMs) throw new Stop(`no CI run appeared for ${sha.slice(0, 8)} after ${Math.round(appearMs / 60000)} min`);
    if (waited > timeoutMs) throw new Stop(`CI still ${s.state} on ${sha.slice(0, 8)} after ${Math.round(timeoutMs / 60000)} min`);
    const line = s.state === 'none' ? 'waiting for a CI run to start' : `CI running (${s.runs.map((r) => r.workflowName).join(', ')})`;
    if (line !== last) { log(line); last = line; }
    await sleep(every);
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

module.exports = { Stop, sleep, say, run, must, git, gh, ghJson, ghRetry, ghJsonRetry, gitRetry, retryCmd, backoffMs, NET_TRIES, isTransient, mainCheckout, worktreesDir, listWorktrees, listElectron, killTree, alive, ciState, waitForCi, readJson };

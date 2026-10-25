// Shared by every place that shells out to a user-installed CLI (claude-code.js, grok-build.js,
// features/ai-agents.js's "Add to <agent>" buttons): finding a binary on PATH and stopping a child
// process tree. Kept pure and CLI-agnostic — install hints, auth parsing, argv shape, etc. stay in
// each engine, since those really do differ per CLI.
const fs = require('fs');

// [hidden spawn] The one place Lumen starts an external program (claude, codex, grok, agy, ant, reg, powershell, where, taskkill, ...).
// Why: Lumen.exe is a GUI process with no console. When it starts a console program, Windows makes a console for the
// child, and with Windows Terminal as the default terminal app that console is handed to a visible Terminal window
// (one popped up for `agy.exe --version`, tab title = the exe path, "error 0x800700e8"). libuv hides the console
// (CREATE_NO_WINDOW) only when windowsHide is set AND none of the child's stdio is inherited
// (libuv src/win/process.c: "Avoid creating console window if stdio is not inherited"), so every call here:
//   - sets windowsHide: true (SW_HIDE + CREATE_NO_WINDOW),
//   - never uses a shell (shell: false; a shell is one more console program),
//   - never inherits stdio (a missing stdio is 'pipe'; 'inherit' becomes 'ignore'),
//   - lets callers pass everything else (cwd, env, detached, timeout, windowsVerbatimArguments).
// test/units/hidden-spawn-units.js fails if any other file in src/ (bar a short, justified allowlist) touches child_process.
// child_process is required on first use: nothing here costs startup time.
let cp = null;
const real = () => cp || (cp = require('child_process'));

// [working directory] Windows keeps every process's current directory open, so a program Lumen starts that inherits a cwd inside the
// install folder (the Start-menu shortcut's "Start in") stops the next update from renaming that folder for as long as it runs: Teams
// opened by a msteams: link held it for days. So Lumen leaves the install folder at start-up (leaveInstallDir, called first thing in
// main.js: every child, shell.openExternal and shell.openPath then inherit a neutral cwd), and no spawn below keeps one inside it.
// The install folder is the exe's folder, or the whole .app bundle on macOS. (An unpackaged run's exe is Electron's own, so the checkout
// the developer stands in is not "inside the install".)
// (Paths are read with the rules of the platform they belong to, not the host's: path.win32 for 'win32', path.posix otherwise.)
const pathFor = (platform) => (platform === 'win32' ? require('path').win32 : require('path').posix);
function installRoot(execPath = process.execPath, platform = process.platform) {
  const p = String(execPath || '');
  if (platform === 'darwin') { const m = /^(.*?\.app)(?:[\\/]|$)/.exec(p); if (m) return m[1]; }
  return p ? pathFor(platform).dirname(p) : '';
}
function insideInstall(dir, execPath = process.execPath, platform = process.platform) {
  const path = pathFor(platform);
  const root = installRoot(execPath, platform);
  if (!dir || !root) return false;
  const fold = (x) => { const r = path.resolve(String(x)).replace(/[\\/]+$/, ''); return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r; };
  const d = fold(dir); const r = fold(root);
  return d === r || d.startsWith(r + path.sep);
}
// Move the process out of the install folder when it is in it. Returns the folder it moved to, or '' (nothing to do / could not).
function leaveInstallDir({ cwd = () => process.cwd(), chdir = (d) => process.chdir(d), execPath = process.execPath, platform = process.platform, home = () => require('os').homedir(), userData } = {}) {
  let here;
  try { here = cwd(); } catch { here = ''; } // (a deleted cwd throws: also not somewhere to stay)
  if (here && !insideInstall(here, execPath, platform)) return '';
  for (const to of [userData, home()]) {
    if (!to || insideInstall(to, execPath, platform)) continue;
    try { chdir(to); return to; } catch { /* the next one */ }
  }
  return '';
}

// Options every spawn gets. The caller's own values win for cwd/env/etc., but not for these four, and never a cwd inside the install.
// (ctx: { execPath, platform, cwd } stand in for this process's, for tests.)
function hiddenOptions(options, ctx = {}) {
  const o = { ...(options || {}) };
  const execPath = ctx.execPath ?? process.execPath; const platform = ctx.platform ?? process.platform;
  if (o.cwd === undefined) { let here = ctx.cwd ?? ''; if (ctx.cwd === undefined) { try { here = process.cwd(); } catch { /* none */ } } if (insideInstall(here, execPath, platform)) o.cwd = require('os').homedir(); }
  else if (insideInstall(o.cwd, execPath, platform)) o.cwd = require('os').homedir();
  o.windowsHide = true;
  o.shell = false;
  if (o.stdio === undefined) o.stdio = 'pipe';
  else if (o.stdio === 'inherit') o.stdio = 'ignore';
  else if (Array.isArray(o.stdio)) o.stdio = o.stdio.map((s) => (s === 'inherit' || s === process.stdin || s === process.stdout || s === process.stderr ? 'ignore' : s));
  return o;
}

function spawn(file, args, options) { return real().spawn(file, args || [], hiddenOptions(options)); }
function spawnSync(file, args, options) { return real().spawnSync(file, args || [], hiddenOptions(options)); }
// A hidden test copy of Lumen (electron . with CLAUDE_BROWSER_TEST) must not run the user's real claude / codex / grok / agy / ant for its
// status and version checks: agy self-updates when run, and a console it makes can surface on the user's screen. Only a program inside the
// test's own temp folder (a stub) runs; LUMEN_TEST_REAL_CLIS=1 lets a manual suite that needs the real CLI through.
const REAL_CLI = /^(claude|codex|grok|agy|ant|antigravity|gh)$/i;
function testBlocksRealCli(file) {
  if (!process.versions.electron || !process.defaultApp || process.env.CLAUDE_BROWSER_TEST !== '1' || process.env.LUMEN_TEST_REAL_CLIS === '1') return false;
  const path = require('path');
  const name = path.basename(String(file)).replace(/.(exe|cmd|bat|ps1)$/i, '');
  if (!REAL_CLI.test(name)) return false;
  const tmp = path.resolve(require('os').tmpdir()).toLowerCase();
  const inTmp = (p) => path.resolve(p).toLowerCase().startsWith(tmp + path.sep);
  if (path.isAbsolute(String(file))) return !inTmp(file);
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const hit = dirs.find((d) => ['', '.exe', '.cmd', '.bat'].some((ext) => { try { return fs.statSync(path.join(d, String(file) + ext)).isFile(); } catch { return false; } }));
  return !(hit && inTmp(hit));
}
function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; } else if (typeof options === 'function') { callback = options; options = {}; }
  if (testBlocksRealCli(file)) { setImmediate(() => callback && callback(Object.assign(new Error(`spawn ${file} ENOENT (a test run does not start the real CLI)`), { code: 'ENOENT' }), '', '')); return {}; }
  const o = hiddenOptions(options);
  delete o.stdio; // execFile always pipes; Node rejects the option on some versions
  return real().execFile(file, args || [], o, callback);
}
function execFileSync(file, args, options) {
  return real().execFileSync(file, args || [], hiddenOptions(options));
}

// ---- probes: "is it installed, what version" ----
// ERROR_NO_DATA (232, 0x800700E8 "the pipe is being closed") and EBUSY / EAGAIN / ETXTBSY / EPERM are what a program that is
// being replaced (agy self-updating) answers. Those mean "ask again later", never "not installed".
const TRANSIENT_CODES = new Set(['EBUSY', 'EAGAIN', 'ETXTBSY', 'EPIPE', 'EPERM', 'EACCES', 'UNKNOWN']);
function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (err.errno === 232 || err.errno === -232 || err.errno === 2147942632 || err.errno === -2147942632) return true;
  return /0x800700e8|2147942632|ERROR_NO_DATA|pipe is being closed/i.test(String(err.message || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `attempt()` (an async function that resolves { ok, err? } or throws), once more after `delayMs` if the failure is
// transient or the program was not found (it may be mid-update). Returns the last result plus { transient } so the caller does
// not cache "not installed" for a transient failure. A probe failure is never shown to the user: this only returns data.
async function retryProbe(attempt, { retries = 1, delayMs = 750, wait = sleep } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { last = await attempt(); } catch (err) { last = { ok: false, err }; }
    if (last && last.ok) return { ...last, transient: false };
    const err = last && last.err;
    const again = isTransient(err) || (err && err.code === 'ENOENT');
    if (!again || i === retries) return { ...(last || { ok: false }), transient: isTransient(err) };
    await wait(delayMs);
  }
  return { ok: false, transient: false };
}

// `<bin> <args>` as a probe: { ok, stdout, stderr, err, transient }. Hidden, piped, timed, retried once.
function probe(file, args, options = {}, retry = {}) {
  return retryProbe(() => new Promise((resolve) => {
    try {
      execFile(file, args, options, (err, stdout, stderr) => resolve({ ok: !err, err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (err) { resolve({ ok: false, err, stdout: '', stderr: '' }); }
  }), retry);
}


// ---- finding and stopping CLIs ----

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ---- starting a CLI that may be mid-update ----
// [start retry] An npm / native self-update rewrites claude.exe (codex, grok and agy do the same) for a few seconds: a spawn in that window
// fails with UNKNOWN (Node throws it; Windows could not open the half-written file), EBUSY, EACCES, EPERM, ETXTBSY or ENOENT, and a minute later
// the same file runs fine. That is the CLI updating, not security software, so startChild waits and starts it again (1 s, 2 s, 3 s), looking the
// program up afresh each time (an update can move it, e.g. npm -> native ~/.local/bin). Every CLI engine starts its child through it.
const START_CODES = new Set(['UNKNOWN', 'EBUSY', 'EACCES', 'EPERM', 'ETXTBSY', 'ENOENT']);
const START_DELAYS = [1000, 2000, 3000];
const RECENT_MS = 2 * 60 * 1000; // a program rewritten this recently is "updating"
const stamp = (f) => { try { const s = fs.statSync(f); return { m: s.mtimeMs, n: s.size }; } catch { return null; } };
const sameStamp = (a, b) => Boolean(a && b && a.m === b.m && a.n === b.n);
const START_MARK = /\[lumen-start:(unchanged|changed)\]/;

// One spawn: { child } when it started (or may have: a child object with no error in the next tick), { err, child? } when it did not.
// Node throws some failures (UNKNOWN) and emits others (EACCES, ENOENT) on the child a tick later.
function tryStart(spawnFn, file, args, options) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(file, args, options); } catch (err) { resolve({ err }); return; }
    if (!child || typeof child.once !== 'function' || typeof child.pid === 'number') { resolve({ child }); return; }
    const onError = (err) => resolve({ err, child });
    child.once('error', onError);
    setImmediate(() => { child.removeListener('error', onError); resolve({ child }); });
  });
}

// spawnFn(file, args, options) like child_process.spawn. again(): async () => ({ file, args? }) | null, the program looked up afresh before each
// retry. onWait(attempt, ms): for a "trying again" status line. Resolves { child, file, tries }; on a final failure the error (marked with
// [lumen-start:unchanged|changed], read by startFailure) is thrown when Node threw it, else emitted on the returned child for the engine's own
// 'error' handler, exactly as an unretried spawn would have.
async function startChild({ spawn: spawnFn, file, args, options, again = null, onWait = null, wait = sleep, signal = null, delays = START_DELAYS, now = Date.now }) {
  const first = stamp(file);
  let tries = 0;
  for (;;) {
    const r = await tryStart(spawnFn, file, args, options);
    if (!r.err) return { child: r.child, file, tries };
    const err = r.err;
    const seen = stamp(file);
    const recent = Boolean(seen && now() - seen.m < RECENT_MS);
    const retry = START_CODES.has(err.code) && (err.code !== 'ENOENT' || Boolean(first) || recent) && tries < delays.length && !signal?.aborted;
    if (!retry) {
      if (START_CODES.has(err.code) && tries) err.message = `${err.message} [lumen-start:${sameStamp(first, seen) && !recent ? 'unchanged' : 'changed'}]`;
      if (!r.child) throw err;
      setImmediate(() => r.child.emit('error', err));
      return { child: r.child, file, tries };
    }
    const ms = delays[tries++];
    try { onWait?.(tries, ms); } catch { /* optional */ }
    await wait(ms);
    let next = null;
    try { next = await again?.(); } catch { /* keep the last path */ }
    if (next?.file) { file = next.file; if (next.args) args = next.args; }
  }
}

// What a spawn failure's text says. null: not a failed start. { blocked }: Windows / the security software really refused (a virus or Smart App
// Control / AppLocker verdict, or EPERM / EACCES that stayed after the retries with the file untouched); otherwise the CLI was updating or briefly locked.
const BLOCK_TEXT = /contains a virus|potentially unwanted software|Smart App Control|SmartScreen|blocked this (app|file)|application control policy|AppLocker|Software Restriction|ERROR_VIRUS_INFECTED|0x800700e1|0x800700e2/i;
function startFailure(text) {
  const t = String(text || '');
  const code = /\bspawn\b[^\n]*?\b(UNKNOWN|EBUSY|EACCES|EPERM|ETXTBSY|EFTYPE)\b/i.exec(t)?.[1]?.toUpperCase();
  const blockText = BLOCK_TEXT.test(t);
  if (!code && !blockText) return null;
  const mark = START_MARK.exec(t)?.[1] || '';
  return { code: code || '', retried: Boolean(mark), blocked: blockText || ((code === 'EPERM' || code === 'EACCES') && mark === 'unchanged') };
}
// The words for a failed start, or null when `text` is not one. name: "Claude Code", exe: "claude.exe".
function describeStart(text, { name, exe }) {
  const f = startFailure(text);
  if (!f) return null;
  const line = String(text).split('\n').find((l) => /spawn|virus|Smart App Control|blocked|AppLocker|0x8007/i.test(l)) || String(text).split('\n')[0];
  const first = line.replace(START_MARK, '').trim().slice(0, 160);
  if (f.blocked) return { text: `Windows or your security software would not let Lumen run ${name} (${first}). Allow ${exe} in your security software, or reinstall ${name}, then press Retry.`, summary: `${name} was blocked from starting` };
  return { text: `${name} didn’t start (it may have just updated).${f.retried ? ' Lumen tried again.' : ''} Press Retry.`, summary: `${name} didn’t start` };
}

// Where on PATH a command lives (`where` on Windows, `which` elsewhere). Never a shell.
function lookup(name) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

// Stop a CLI child (and whatever it spawned under it, e.g. an MCP bridge) started with detached:true
// (POSIX) — taskkill /T on Windows since detached there doesn't give a killable process group.
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

// The model part of a local engine's picker id: 'claudecode:opus' -> 'opus', 'grokbuild:default'
// (or a bare 'claudecode:') -> 'default', meaning the CLI's own default (no model flag at all). So does the engine's own Auto
// ('claudecode:auto'): until Auto has chosen a model for a message (agent.js routeAuto) nothing is picked, and never 'auto' as a model name.
const engineModel = (id) => { const m = String(id || '').split(':').slice(1).join(':'); return !m || m === 'auto' ? 'default' : m; };
// A model name that is safe to put after --model / -m: never empty, never starting with '-' (the
// argv never goes through a shell, but a leading dash would still read as another flag).
const validModel = (model) => /^[a-z0-9][\w.[\]-]*$/i.test(String(model || ''));

// Tokens and cost of one run, from a CLI's stream-json result message (usage + modelUsage;
// Claude Code and Grok Build both send it). The cost is what
// the tokens would cost at API list prices; on a Claude plan nothing is billed, but it is the
// measure the plan's limits are closest to.
function usageOf(result) {
  if (!result || typeof result !== 'object') return null;
  const u = result.usage || {};
  const rows = Object.values(result.modelUsage || {}).filter((m) => m && typeof m === 'object');
  const models = Object.keys(result.modelUsage || {});
  // Grok Build's result (verified, grok 1.0.41) carries the same snake_case `usage` and camelCase
  // `modelUsage` rows as Claude Code's. If a version leaves `usage` out, the per-model rows add up.
  const fromRows = (key) => rows.reduce((a, m) => a + (Number(m[key]) || 0), 0);
  const pick = (top, rowKey) => Number(u[top]) || (u[top] == null ? fromRows(rowKey) : 0);
  return {
    inputTokens: pick('input_tokens', 'inputTokens'),
    outputTokens: pick('output_tokens', 'outputTokens'),
    cacheReadTokens: pick('cache_read_input_tokens', 'cacheReadInputTokens'),
    cacheWriteTokens: pick('cache_creation_input_tokens', 'cacheCreationInputTokens'),
    costUSD: Number(result.total_cost_usd) || 0,
    contextWindow: Math.max(0, ...rows.map((m) => Number(m.contextWindow) || 0)),
    models,
  };
}

// Per-turn totals from a kept process's result messages. Whether a result's total_cost_usd / usage
// count one message or the whole process so far is not documented for stream-json input, so both are
// handled: when this is a later result of the same process and EVERY counter (cost and each usage
// field) is >= the previous result's, the totals are read as cumulative and the previous ones are
// subtracted; any counter that went down proves per-turn semantics and latches it for the process
// (state.perTurn). Unavoidable false positive: per-turn totals that all happen to grow are read as
// cumulative until one shrinks. modelUsage rows are subtracted the same way (contextWindow is not a counter).
// state: { last, perTurn } kept on the process. Returns the result to report (the input when unchanged).
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const ROW_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD', 'webSearchRequests'];
function perTurnResult(result, state) {
  if (!result || typeof result !== 'object' || !state) return result;
  const prev = state.last;
  state.last = result;
  if (!prev || state.perTurn) return result;
  const num = (v) => Number(v) || 0;
  const pairs = [[num(result.total_cost_usd), num(prev.total_cost_usd)], ...USAGE_KEYS.map((k) => [num(result.usage?.[k]), num(prev.usage?.[k])])];
  // A counter that went down, or totals identical to the last result's (a real turn always adds tokens),
  // can only be per-turn numbers.
  if (pairs.some(([now, before]) => now < before) || pairs.every(([now, before]) => now === before)) { state.perTurn = true; return result; }
  const out = { ...result, total_cost_usd: Math.max(0, num(result.total_cost_usd) - num(prev.total_cost_usd)) };
  if (result.usage && typeof result.usage === 'object') {
    out.usage = { ...result.usage };
    for (const k of USAGE_KEYS) if (result.usage[k] != null) out.usage[k] = num(result.usage[k]) - num(prev.usage?.[k]);
  }
  if (result.modelUsage && typeof result.modelUsage === 'object') {
    out.modelUsage = {};
    for (const [model, row] of Object.entries(result.modelUsage)) {
      const before = prev.modelUsage?.[model] || {};
      out.modelUsage[model] = { ...row };
      for (const k of ROW_KEYS) if (typeof row?.[k] === 'number') out.modelUsage[model][k] = Math.max(0, row[k] - num(before[k]));
    }
  }
  return out;
}

// [full access] A CLI that does not know a flag Lumen's full-access mode passes says so on stderr (clap: "unexpected argument
// '--x' found" / "invalid value 'x' for '--y'"; Go's flag package: "flag provided but not defined: -x"; others: "unknown option").
// Full access must never quietly run without its flags while Settings says it is on, so that failure is told plainly.
const FLAG_REJECTED = /unexpected argument|invalid value .* for '--|flag provided but not defined|unknown (flag|option|argument)|unrecognized (flag|option|argument)|no such option|bad option/i;
function fullAccessRejected(text, { name, setting }) {
  if (!FLAG_REJECTED.test(String(text || ''))) return null;
  return { text: `${name} didn't accept the options Lumen uses to give it full access to this computer (${String(text).trim().split('\n')[0].slice(0, 160)}). Nothing ran. Update ${name}, or turn off "${setting}" in Settings > AI.` };
}

module.exports = { installRoot, insideInstall, leaveInstallDir, testBlocksRealCli, spawn, spawnSync, execFile, execFileSync, hiddenOptions, isTransient, retryProbe, probe, exists, startChild, startFailure, describeStart, lookup, killTree, engineModel, validModel, usageOf, perTurnResult, FLAG_REJECTED, fullAccessRejected };

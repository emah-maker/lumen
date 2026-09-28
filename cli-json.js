// One-shot JSON answers from the user's own AI CLIs (Claude Code, Grok Build), for small text tasks
// such as "Organize Tabs with AI": text in, JSON matching a schema out, no API key needed.
//
// These runs get no tools at all, unlike the sidebar engines (claude-code.js, grok-build.js): no
// built-in tools, no MCP servers (not even Lumen's), no project folder. Claude Code gets --tools ""
// and --strict-mcp-config with no --mcp-config; Grok Build gets the same built-in denials as the
// sidebar engine (taken from grok-build.js's argv, so the two lists can't drift apart) and its own
// GROK_HOME whose config.toml names no MCP servers. Input goes in on stdin or in a file, never on a
// shell command line, and the answer is checked against the schema's shape before it is used.

const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { killTree, validModel } = require('./cli-utils');

const TIMEOUT_MS = 60000;

// ---------- Claude Code ----------

function claudeArgs({ system, schema, model = 'haiku' }) {
  return [
    '-p',
    '--output-format', 'json',
    '--tools', '', // no built-in tools
    '--strict-mcp-config', // and no MCP servers: none are given
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    '--system-prompt', system, // replaces Claude Code's own (coding) system prompt
    '--json-schema', JSON.stringify(schema),
  ];
}

// ---------- Grok Build ----------

// The sidebar engine's built-in tool denials, read from its argv.
function grokDenials() {
  const base = require('./grok-build').buildArgs({ promptFile: 'p', sessionId: 's', systemPrompt: 's', cwd: 'c' });
  const values = (flag) => base.flatMap((v, i) => (v === flag ? [base[i + 1]] : []));
  return [
    '--disallowed-tools', values('--disallowed-tools').join(','),
    ...values('--deny').flatMap((t) => ['--deny', t]),
  ];
}

function grokArgs({ system, schema, model = 'default', promptFile, cwd }) {
  return [
    '--json-schema', JSON.stringify(schema), // implies --output-format json
    ...grokDenials(),
    '--permission-mode', 'dontAsk',
    '--no-subagents', '--no-plan', '--disable-web-search',
    '--max-turns', '2',
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    '--cwd', cwd,
    '--system-prompt-override', system,
    '--prompt-file', promptFile,
  ];
}

// config.toml for the organize GROK_HOME: no MCP servers, and none of Grok's imports of the user's
// Claude Code / Cursor setups.
function grokConfig() {
  const off = ['skills', 'rules', 'agents', 'mcps', 'hooks'].map((s) => `${s} = false`);
  return [
    '# Written by Lumen before each one-shot Grok Build answer (cli-json.js). Edits are overwritten.',
    '[compat.claude]', ...off, '',
    '[compat.cursor]', ...off, '',
    '[permission]', 'deny = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]', '',
    '[cli]', 'auto_update = false', '',
    '[marketplace]', 'default_skills_installs_purged = true', 'official_marketplace_auto_installed = true', '',
  ].join('\n');
}
const grokHomeFor = (userData) => path.join(userData, 'grok-oneshot');
const grokDirFor = (userData) => path.join(userData, 'grok-oneshot-cwd');

// ---------- running and reading the answer ----------

// Runs one CLI process. Resolves its stdout; rejects on a timeout (the process tree is stopped) or a
// non-zero exit, with stderr/stdout attached for describeFailure.
function runCli({ bin, argv, input = null, env, cwd, timeoutMs = TIMEOUT_MS, spawn = nodeSpawn, kill = killTree }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env, cwd });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`), { timedOut: true }));
      else if (code !== 0) reject(Object.assign(new Error(`exit ${code}`), { code, output: `${stderr}\n${stdout}` }));
      else resolve(stdout);
    });
    if (input !== null) {
      child.stdin.on('error', () => {}); // the CLI exiting early closes the pipe
      child.stdin.end(input);
    }
  });
}

// The JSON answer in a CLI's --output-format json result: Claude Code's structured_output, Grok
// Build's structuredOutput, else the reply text itself parsed as JSON.
function parseResult(stdout) {
  let out;
  try { out = JSON.parse(String(stdout).trim()); } catch { throw new Error('The CLI did not return JSON.'); }
  if (!out || typeof out !== 'object') throw new Error('The CLI did not return JSON.');
  if (out.is_error) throw Object.assign(new Error('The CLI reported an error.'), { output: String(out.result || '') });
  const answer = out.structured_output ?? out.structuredOutput;
  if (answer && typeof answer === 'object') return answer;
  const text = String(out.result ?? out.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(text); } catch { throw new Error('The CLI’s answer was not valid JSON.'); }
}

// { groups: [{ name, tab_ids }] }, the shape Organize asks for; anything else is refused.
function checkGroups(answer) {
  const groups = answer?.groups;
  const ok = Array.isArray(groups) && groups.every((g) => g && typeof g.name === 'string' && Array.isArray(g.tab_ids) && g.tab_ids.every(Number.isInteger));
  if (!ok) throw new Error('The CLI’s answer did not have the expected groups.');
  return groups;
}

// One answer. engine: 'claudecode' | 'grokbuild'; bin: the CLI found by that engine's detect().
// userData: Lumen's user-data folder (Grok Build's own home lives there).
async function completeJSON({ engine, bin, model, system, user, schema, userData, timeoutMs = TIMEOUT_MS, run = runCli }) {
  if (engine === 'claudecode') {
    const { describeFailure } = require('./claude-code');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc1-')); // an empty folder: no project settings or files
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      return parseResult(await run({ bin, argv: claudeArgs({ system, schema, model }), input: user, env, cwd, timeoutMs }));
    } catch (err) {
      throw err.output !== undefined ? new Error(describeFailure(err.output, err.code).text) : err;
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  if (engine === 'grokbuild') {
    const gb = require('./grok-build');
    const home = grokHomeFor(userData);
    const cwd = grokDirFor(userData);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), grokConfig(), { mode: 0o600 });
    const userHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
    let authBefore = null;
    try { authBefore = gb.linkAuth(userHome, home); } catch {} // no login shared: the run reports "not signed in"
    const promptFile = path.join(cwd, `prompt-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(promptFile, gb.promptBlocks(user), { mode: 0o600 });
    const env = { ...gb.buildEnv({ userData }), GROK_HOME: home, HOME: cwd, USERPROFILE: cwd, RUST_LOG: 'off' };
    try {
      return parseResult(await run({ bin, argv: grokArgs({ system, schema, model, promptFile, cwd }), env, cwd, timeoutMs }));
    } catch (err) {
      throw err.output !== undefined ? new Error(gb.describeFailure(err.output, err.code).text) : err;
    } finally {
      try { fs.rmSync(promptFile, { force: true }); } catch {}
      try { gb.settleAuth(userHome, home, authBefore); } catch {}
    }
  }
  throw new Error(`No one-shot runner for ${engine}.`);
}

module.exports = { claudeArgs, grokArgs, grokConfig, runCli, parseResult, checkGroups, completeJSON, TIMEOUT_MS };

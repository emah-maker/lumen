// Shared by every place that shells out to a user-installed CLI (claude-code.js, grok-build.js,
// features/ai-agents.js's "Add to <agent>" buttons): finding a binary on PATH and stopping a child
// process tree. Kept pure and CLI-agnostic — install hints, auth parsing, argv shape, etc. stay in
// each engine, since those really do differ per CLI.
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

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
// (or a bare 'claudecode:') -> 'default', meaning the CLI's own default (no model flag at all).
const engineModel = (id) => String(id || '').split(':').slice(1).join(':') || 'default';
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

module.exports = { exists, lookup, killTree, engineModel, validModel, usageOf };

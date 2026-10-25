// "Connect <app>" in one click (Settings > AI and agents > "Let other apps use Lumen", and the Allow prompt of a Claude Code that has no token):
// make (or reuse) the app's token app and put Lumen into the app's own config WITH its token file, so it connects verified and never asks again.
//  - Claude Code: through its real CLI (`claude mcp remove` then `claude mcp add --scope user`), never a hand-edited ~/.claude.json and never
//    a project-scope .mcp.json (that one gets committed).
//  - Claude Desktop, Cursor, VS Code: their user-level JSON file, only the "lumen" entry, written atomically with the old file kept as <file>.bak,
//    and only when the file reads as plain JSON (a file with comments or a typo is left alone and the user pastes the text instead).
// Pure of Electron: ext (features/external-apps.js), the bridge command, and the CLI finder/runner come in as arguments.
const fs = require('fs');
const path = require('path');
const { APPS } = require('./external-apps');
const { writeJsonAtomic } = require('../settings/settings-file');

// The token app of that kind (a token and a file of its own), made the first time and reused after: clicking twice never piles up apps.
// A record whose token file went missing (deleted by hand) is replaced: its secret can no longer reach the bridge.
function ensureTokenApp(ext, kind) {
  const existing = ext.list().find((a) => a.app === kind && a.kind === 'token');
  if (existing) {
    const file = ext.tokenFileOf(existing.id);
    let ok = false;
    try { ok = fs.statSync(file).size > 0; } catch { /* missing */ }
    if (ok) return { app: existing, tokenFile: file, created: false };
    ext.revoke(existing.id);
  }
  const made = ext.add({ name: APPS[kind], app: kind });
  return { app: made.app, tokenFile: made.tokenFile, created: true };
}

const lastLine = (text, fallback) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ') || fallback;

// Claude Code. find() -> { command, args, env? } | null; run(argv) -> Promise<{ ok, out }> runs that CLI.
async function connectClaudeCode({ ext, command, args, find, run }) {
  const { app, tokenFile } = ensureTokenApp(ext, 'claude-code');
  const found = await find();
  if (!found) return { ok: false, noCli: true, app, tokenFile, error: 'Claude Code isn’t installed here, so Lumen can’t set it up. Run the command below in a terminal instead.' };
  const go = (argv) => run(found, argv);
  const env = ['-e', 'ELECTRON_RUN_AS_NODE=1'];
  const removed = await go(['mcp', 'remove', 'lumen', '--scope', 'user']); // (fails when there was none: fine)
  const added = await go(['mcp', 'add', 'lumen', '--scope', 'user', ...env, '-e', `LUMEN_CLIENT_TOKEN_FILE=${tokenFile}`, '--', command, ...args]);
  if (!added.ok) {
    if (removed.ok) await go(['mcp', 'add', 'lumen', '--scope', 'user', ...env, '--', command, ...args]); // put back what was there (no key, but it worked)
    return { ok: false, app, tokenFile, error: `Claude Code didn’t take it (${lastLine(added.out, 'no reason given')}). Run the command below in a terminal instead.` };
  }
  return { ok: true, app, tokenFile, message: 'Claude Code is connected with its own key. Restart Claude Code sessions (or /mcp, then Reconnect).' };
}

// The JSON apps. `file`: the app's user-level config (external-apps.js configPath).
const JSON_APPS = { 'claude-desktop': 'mcpServers', cursor: 'mcpServers', vscode: 'servers' };
function connectJsonApp(kind, { ext, command, args, file }) {
  const key = JSON_APPS[kind];
  if (!key) return { ok: false, error: 'Lumen can’t set that app up by itself yet. Copy the text below instead.' };
  const label = APPS[kind];
  if (!file) return { ok: false, error: `Lumen doesn’t know where ${label} keeps its config here. Copy the text below instead.` };
  if (!fs.existsSync(path.dirname(file))) return { ok: false, error: `${label} doesn’t seem to be installed (there is no ${path.dirname(file)} folder). Copy the text below instead.` };
  let data = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw; // (a byte-order mark is not JSON)
    existed = true;
    data = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: `Lumen couldn’t read ${file} as plain JSON, so it left the file alone. Copy the text below into it instead.` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data[key] !== undefined && (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key])))) return { ok: false, error: `${file} doesn’t look like a ${label} config (no “${key}” list), so Lumen left it alone. Copy the text below instead.` };
  const { app, tokenFile } = ensureTokenApp(ext, kind);
  const entry = { ...(kind === 'vscode' ? { type: 'stdio' } : {}), command, args, env: { ELECTRON_RUN_AS_NODE: '1', LUMEN_CLIENT_TOKEN_FILE: tokenFile } };
  const message = `${label} is connected with its own key. Restart ${label} to pick it up.`;
  if (JSON.stringify(data[key]?.lumen) === JSON.stringify(entry)) return { ok: true, app, tokenFile, path: file, message };
  try {
    if (existed) fs.copyFileSync(file, `${file}.bak`); // (the last file as it was, before this click)
    writeJsonAtomic(file, { ...data, [key]: { ...(data[key] || {}), lumen: entry } }, 2);
  } catch (err) { return { ok: false, app, tokenFile, error: `Couldn’t write ${file} (${err.message}). Copy the text below instead.` }; }
  return { ok: true, app, tokenFile, path: file, backup: existed ? `${file}.bak` : null, message };
}

module.exports = { ensureTokenApp, connectClaudeCode, connectJsonApp, JSON_APPS };

// Plain Node: "Connect <app>" in one click (features/external-apps-connect.js) and the Allow prompt's offer for a token-less Claude Code
// (features/external-apps.js). A fake `claude` records its arguments (never the real CLI, never a real config); the JSON apps edit temp files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('../helpers/_tmp-cleanup');
const { createExternalApps, isClaudeCodeName } = require('../../src/features/external-apps');
const connect = require('../../src/features/external-apps-connect');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ea-connect-'));
const key = crypto.randomBytes(32);
const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
  decryptString: (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
};
const makeExt = () => createExternalApps({ file: path.join(tmp(), 'external-apps.json'), safeStorage: fakeStorage });
const bridge = { command: 'C:\\Program Files\\Lumen\\Lumen.exe', args: ['C:\\Program Files\\Lumen\\resources\\app\\mcp.js'] };
const found = { command: 'claude', args: [] };
// A fake `claude`: records each argv; reply(argv) -> { ok, out } (default: everything works).
const fakeCli = (reply = () => ({ ok: true, out: 'ok' })) => { const cli = { calls: [], find: async () => found, run: async (_found, argv) => { cli.calls.push(argv); return reply(argv); } }; return cli; };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------- the name check
  check('Claude Code names: its own, spaced, and with Lumen’s mark', isClaudeCodeName('claude-code') && isClaudeCodeName('Claude Code') && isClaudeCodeName('Claude Code (no token)') && isClaudeCodeName('claude-code (no token) (no token)'));
  check('other names are not Claude Code', !isClaudeCodeName('Claude Desktop') && !isClaudeCodeName('Claude Code Helper') && !isClaudeCodeName('') && !isClaudeCodeName('Cursor'));

  // ---------- the prompt offers the setup for a token-less Claude Code
  {
    const prompts = [];
    const ext = createExternalApps({ file: path.join(tmp(), 'e.json'), safeStorage: fakeStorage, onPrompt: (e) => { if (e.type === 'open') prompts.push(e.prompt); } });
    const s = { clientName: 'Claude Code', engine: null, controller: new AbortController() };
    await ext.admit(s, {}, { defer: true });
    ext.admitForCall(s);
    await tick();
    check('a token-less Claude Code’s prompt carries claudeCode: true', prompts.at(-1)?.claudeCode === true && ext.pendingPrompts()[0].claudeCode === true, JSON.stringify(prompts));
    const o = { clientName: 'Fake App', engine: null, controller: new AbortController() };
    await ext.admit(o, {}, { defer: true });
    ext.admitForCall(o);
    await tick();
    check('another app’s prompt does not', prompts.at(-1)?.name === 'Fake App' && prompts.at(-1).claudeCode === false);
    ext.answer(prompts.find((p) => p.claudeCode).id, 'always');
    await tick();
    check('a remembered token-less Claude Code is listed with claudeCode: true (Settings offers the key there too)', ext.list().some((a) => a.kind === 'remembered' && a.claudeCode === true), JSON.stringify(ext.list()));
  }

  // ---------- Claude Code through its CLI
  {
    const ext = makeExt();
    const cli = fakeCli();
    const r = await connect.connectClaudeCode({ ext, ...bridge, ...cli });
    const tokenFile = ext.tokenFileOf(r.app.id);
    check('Claude Code: ok, with the message the user reads', r.ok && /connected with its own key/.test(r.message) && /Restart Claude Code/.test(r.message), JSON.stringify(r));
    check('it makes the claude-code token app and its token file', ext.list().length === 1 && r.app.app === 'claude-code' && r.app.kind === 'token' && fs.readFileSync(tokenFile, 'utf8').startsWith('lmn_'), JSON.stringify(ext.list()));
    check('it runs `mcp remove lumen --scope user`, then `mcp add` at user scope', cli.calls.length === 2 && cli.calls[0].join(' ') === 'mcp remove lumen --scope user' && cli.calls[1].slice(0, 5).join(' ') === 'mcp add lumen --scope user', JSON.stringify(cli.calls));
    check('the add carries ELECTRON_RUN_AS_NODE, the token FILE (never the secret) and the bridge after --', JSON.stringify(cli.calls[1].slice(5)) === JSON.stringify(['-e', 'ELECTRON_RUN_AS_NODE=1', '-e', `LUMEN_CLIENT_TOKEN_FILE=${tokenFile}`, '--', bridge.command, ...bridge.args]), JSON.stringify(cli.calls[1]));
    check('never project scope, never the secret itself', !cli.calls.flat().some((a) => /project|local/.test(a)) && !cli.calls.flat().some((a) => /^lmn_/.test(a)));
    const r2 = await connect.connectClaudeCode({ ext, ...bridge, ...fakeCli() });
    check('a second click reuses the app and the token (no second app)', r2.ok && ext.list().length === 1 && r2.app.id === r.app.id && r2.tokenFile === tokenFile);
    fs.rmSync(tokenFile);
    const r3 = await connect.connectClaudeCode({ ext, ...bridge, ...fakeCli() });
    check('a token file deleted by hand: the app is made again with a file that exists', r3.ok && ext.list().length === 1 && r3.app.id !== r.app.id && fs.existsSync(r3.tokenFile), JSON.stringify(r3));
  }
  {
    const ext = makeExt();
    const r = await connect.connectClaudeCode({ ext, ...bridge, find: async () => null, run: async () => { throw new Error('must not run'); } });
    check('no claude CLI: not ok, says so, and hands back the token file for the copy command', !r.ok && r.noCli && /isn’t installed/.test(r.error) && fs.existsSync(r.tokenFile), JSON.stringify(r));
  }
  {
    const ext = makeExt();
    let adds = 0;
    const flaky = fakeCli((argv) => (argv[1] === 'add' && ++adds === 1 ? { ok: false, out: 'boom: bad flag' } : { ok: true, out: '' }));
    const r = await connect.connectClaudeCode({ ext, ...bridge, ...flaky });
    check('a failed add puts the old (token-less) entry back and reports the reason', !r.ok && /boom: bad flag/.test(r.error) && flaky.calls.length === 3 && !flaky.calls[2].join(' ').includes('LUMEN_CLIENT_TOKEN_FILE'), JSON.stringify(flaky.calls));
    const none = fakeCli((argv) => (argv[1] === 'add' ? { ok: false, out: 'nope' } : { ok: false, out: 'No user-scoped server' }));
    const r2 = await connect.connectClaudeCode({ ext, ...bridge, ...none });
    check('nothing was removed (there was none): no put-back is attempted', !r2.ok && none.calls.length === 2);
  }

  // ---------- the JSON apps
  for (const [kind, container, nameOf] of [['claude-desktop', 'mcpServers', 'claude_desktop_config.json'], ['cursor', 'mcpServers', 'mcp.json'], ['vscode', 'servers', 'mcp.json']]) {
    const ext = makeExt();
    const dir = tmp();
    const file = path.join(dir, nameOf);
    const before = { theme: 'dark', [container]: { other: { command: 'node', args: ['x.js'] } }, extra: [1, 2] };
    fs.writeFileSync(file, JSON.stringify(before, null, 4));
    const old = fs.readFileSync(file, 'utf8');
    const r = connect.connectJsonApp(kind, { ext, ...bridge, file });
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tokenFile = ext.tokenFileOf(r.app?.id);
    check(`${kind}: ok, only the "lumen" entry added, everything else untouched`, r.ok && now.theme === 'dark' && JSON.stringify(now.extra) === '[1,2]' && JSON.stringify(now[container].other) === JSON.stringify(before[container].other) && Object.keys(now[container]).join() === 'other,lumen', JSON.stringify(now));
    check(`${kind}: the entry names the bridge and the token file, not the secret`, now[container].lumen.command === bridge.command && now[container].lumen.env.LUMEN_CLIENT_TOKEN_FILE === tokenFile && now[container].lumen.env.ELECTRON_RUN_AS_NODE === '1' && (kind !== 'vscode' || now[container].lumen.type === 'stdio') && !fs.readFileSync(file, 'utf8').includes(fs.readFileSync(tokenFile, 'utf8')));
    check(`${kind}: the old file is kept as .bak, byte for byte`, fs.readFileSync(`${file}.bak`, 'utf8') === old);
    const stamp = fs.statSync(file).mtimeMs;
    const r2 = connect.connectJsonApp(kind, { ext, ...bridge, file });
    check(`${kind}: a second click changes nothing (same app, same file)`, r2.ok && r2.app.id === r.app.id && fs.statSync(file).mtimeMs === stamp && ext.list().length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const ext = makeExt();
    const dir = tmp();
    const file = path.join(dir, 'mcp.json');
    const r = connect.connectJsonApp('cursor', { ext, ...bridge, file });
    check('a missing file in an existing folder is created (no .bak, nothing to keep)', r.ok && JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.lumen.command === bridge.command && !fs.existsSync(`${file}.bak`) && r.backup === null);
    const commented = path.join(dir, 'vs.json');
    fs.writeFileSync(commented, '{\n  // my servers\n  "servers": {}\n}');
    const r2 = connect.connectJsonApp('vscode', { ext, ...bridge, file: commented });
    check('a file that is not plain JSON (comments) is left alone, with a reason', !r2.ok && /left the file alone/.test(r2.error) && fs.readFileSync(commented, 'utf8').includes('// my servers') && !fs.existsSync(`${commented}.bak`), JSON.stringify(r2));
    const odd = path.join(dir, 'odd.json');
    fs.writeFileSync(odd, '{"mcpServers": ["a"]}');
    check('a list where the servers object belongs is left alone', !connect.connectJsonApp('cursor', { ext, ...bridge, file: odd }).ok && fs.readFileSync(odd, 'utf8') === '{"mcpServers": ["a"]}');
    const gone = connect.connectJsonApp('claude-desktop', { ext, ...bridge, file: path.join(dir, 'nope', 'claude_desktop_config.json') });
    check('no app folder: not installed, nothing created', !gone.ok && /doesn’t seem to be installed/.test(gone.error) && !fs.existsSync(path.join(dir, 'nope')));
    check('an app with no one-click gets a clear no', !connect.connectJsonApp('claude-code', { ext, ...bridge, file }).ok);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

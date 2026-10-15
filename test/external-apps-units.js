// Plain Node: other apps using Lumen (features/external-apps.js, automation/client-token.js) and the MCP server's hooks for them
// (automation/mcp.js identify / onInitialize). Fake safeStorage and a fake MCP client over the real channel; no Electron.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
require('./_tmp-cleanup');
const { createExternalApps, setupFor, configPath, TOKEN_PLACEHOLDER, RUN_QUIET_MS } = require('../src/features/external-apps');
const clientToken = require('../src/automation/client-token');
const mcp = require('../src/automation/mcp');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ea-units-'));

// A reversible stand-in for safeStorage: not the token's text, and unreadable without decryptString.
const key = crypto.randomBytes(32);
const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
  decryptString: (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
};
// Timers by hand, so the "finished" notice needs no waiting.
function clock() {
  let t = 1000; const timers = [];
  return { now: () => t, set: (fn, ms) => { const x = { fn, at: t + ms, unref() {} }; timers.push(x); return x; }, clear: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); }, advance(ms) { t += ms; for (const x of [...timers].filter((y) => y.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); } } };
}
function make(extra = {}) {
  const dir = tmp(); const c = clock(); const events = { changes: 0, prompts: [], finished: [] };
  const ext = createExternalApps({ file: path.join(dir, 'external-apps.json'), safeStorage: fakeStorage, now: c.now, setTimer: c.set, clearTimer: c.clear, onChange: () => { events.changes++; }, onPrompt: (e) => { if (e.type === 'open') events.prompts.push(e); }, onFinished: (a) => events.finished.push(a.name), ...extra });
  return { dir, c, ext, events, file: path.join(dir, 'external-apps.json') };
}
const session = (extra = {}) => ({ clientName: 'Fake App', engine: null, controller: new AbortController(), disconnect() { this.cut = true; }, ...extra });
const nonce = 'abc123';
const proofFor = (token) => clientToken.hello(token, nonce);

(async () => {
  // ---------- tokens
  {
    const { ext, file } = make();
    const made = ext.add({ name: 'Fake App', app: 'claude-desktop' });
    check('Add app returns a token of the lmn_<id>_<secret> shape, once', /^lmn_[a-f0-9]{12}_[a-f0-9]{48}$/.test(made.token) && !('token' in made.app), JSON.stringify(made.app));
    const disk = fs.readFileSync(file, 'utf8');
    const secret = made.token.split('_')[2];
    check('the token is not on disk in plain text (encrypted)', !disk.includes(made.token) && !disk.includes(secret) && JSON.parse(disk).apps[0].secret.length > 40, disk);
    check('a restart reads the same apps back', createExternalApps({ file, safeStorage: fakeStorage }).list().length === 1 && createExternalApps({ file, safeStorage: fakeStorage }).identify({ client: made.app.id, nonce, proof: proofFor(made.token).lumenClientProof })?.client === made.app.id);
    check('list() never carries a secret', !JSON.stringify(ext.list()).includes('secret') && !JSON.stringify(ext.list()).includes(secret));
    check('the right proof identifies the app', ext.identify({ client: made.app.id, nonce, ...(({ lumenClientProof }) => ({ proof: lumenClientProof }))(proofFor(made.token)) })?.client === made.app.id);
    check('a wrong proof is refused (false)', ext.identify({ client: made.app.id, nonce, proof: 'x'.repeat(64) }) === false);
    check('the proof of another nonce is refused', ext.identify({ client: made.app.id, nonce: 'other', proof: proofFor(made.token).lumenClientProof }) === false);
    check('an unknown id is refused', ext.identify({ client: 'ffffffffffff', nonce, proof: proofFor(made.token).lumenClientProof }) === false);
    check('no app token is an unmanaged agent (null), as before', ext.identify({}) === null && ext.identify({ client: undefined }) === null);
    let threw = false;
    try { ext.add({ name: 'fake app' }); } catch { threw = true; }
    check('two apps cannot share a name', threw);
    let noKeychain = false;
    try { createExternalApps({ file: path.join(tmp(), 'x.json'), safeStorage: { isEncryptionAvailable: () => false } }).add({ name: 'A' }); } catch { noKeychain = true; }
    check('without a system keychain no token is made (never kept in the clear)', noKeychain);
  }

  // ---------- revoke, stop, take over, finished
  {
    const { ext, events, c } = make();
    const a = ext.add({ name: 'Fake App' });
    const s = session({ client: a.app.id });
    check('a session that proved its token is admitted and named after the app', (await ext.admit(s, {})) === null && s.clientName === 'Fake App' && ext.connectedCount() === 1);
    const call = ext.beginCall(s);
    check('a call is allowed and carries a signal', !call.refuse && call.signal && call.signal.aborted === false);
    check('state lists the app as working', JSON.stringify(ext.state().active.map((x) => x.name)) === '["Fake App"]');
    ext.stop(a.app.id);
    check('Stop aborts the call in flight and cuts the connection', call.signal.aborted === true && s.cut === true && ext.connectedCount() === 0);
    call.end();
    check('after Stop the pill is gone', ext.state().active.length === 0);
    const s2 = session({ client: a.app.id });
    await ext.admit(s2, {});
    const c2 = ext.beginCall(s2);
    ext.takeOver(a.app.id);
    check('Take over aborts the call in flight and keeps the connection', c2.signal.aborted === true && !s2.cut);
    const refused = ext.beginCall(s2);
    check('a paused app is refused with the reason', /took over/.test(refused.refuse), JSON.stringify(refused));
    check('a paused app shows as paused', ext.state().active[0]?.paused === true);
    ext.resume(a.app.id);
    const c3 = ext.beginCall(s2);
    check('Resume lets calls through again, with a fresh signal', !c3.refuse && c3.signal.aborted === false);
    c3.end(); c2.end();
    c.advance(RUN_QUIET_MS - 100);
    check('no "finished" notice while it may still be working', events.finished.length === 0);
    c.advance(200);
    check('one quiet "finished" notice once its calls stop', events.finished.join() === 'Fake App', events.finished.join());
    const before = events.finished.length;
    const c4 = ext.beginCall(s2); const c5 = ext.beginCall(s2); c4.end(); c.advance(RUN_QUIET_MS + 10);
    check('no notice while another call of it is still running', events.finished.length === before);
    c5.end(); c.advance(RUN_QUIET_MS + 10);
    check('...and one when the last call ends', events.finished.length === before + 1);
    check('ask-before-acting is the app\'s own choice and reaches the call', ext.beginCall(s2).ask === false && (ext.setAsk(a.app.id, true), ext.beginCall(s2).ask === true));
    const s3 = session({ client: a.app.id }); await ext.admit(s3, {});
    ext.revoke(a.app.id);
    check('Revoke cuts every connection of the app at once', s3.cut === true && ext.connectedCount() === 0);
    check('a revoked app is refused on its next call', /revoked/.test(ext.beginCall(s3).refuse || ''));
    check('a revoked app\'s token no longer proves anything', ext.identify({ client: a.app.id, nonce, proof: proofFor(a.token).lumenClientProof }) === false);
    check('a revoked app cannot start a session', /revoked/.test(await ext.admit(session({ client: a.app.id }), {}) || ''));
    check('the list is empty after Revoke', ext.list().length === 0);
  }

  // ---------- unknown apps without a token: as before, or asked
  {
    const { ext, events } = make();
    ext.setPrompting(() => false);
    check('an unmanaged agent connects as before while "ask" is off', (await ext.admit(session({ clientName: 'Claude Code' }), {})) === null && !ext.beginCall(session()).refuse);
  }
  {
    const { ext, events } = make();
    ext.setPrompting(() => true);
    const s = session({ clientName: 'Fake App' });
    const pending = ext.admit(s, {});
    check('a new app waits for the user: a prompt is raised', events.prompts.length === 1 && events.prompts[0].prompt.name === 'Fake App' && ext.state().prompts.length === 1);
    check('it cannot call a tool while it waits', /not been allowed/.test(ext.beginCall(s).refuse || ''));
    const again = ext.admit(session({ clientName: 'fake app' }), {});
    check('a second connection of the same name shares the prompt', events.prompts.length === 1);
    ext.answer(events.prompts[0].prompt.id, 'allow');
    check('Allow lets it through, and the one waiting behind it', (await pending) === null && (await again) === null && s.externalId);
    check('Allow is remembered by name (no second prompt)', (await ext.admit(session({ clientName: 'Fake App' }), {})) === null && events.prompts.length === 1);
    check('the allowed app is listed, by name, with no token', ext.list()[0]?.kind === 'name' && ext.list()[0].ask === false);
    check('the pill shows it once it works', (() => { const call = ext.beginCall(s); const on = ext.state().active[0]?.name === 'Fake App'; call.end(); return on; })());
    const s2 = session({ clientName: 'Other App' });
    const p2 = ext.admit(s2, {});
    ext.answer(events.prompts[1].prompt.id, 'allow-ask');
    await p2;
    check('"Allow, ask before it acts" is kept on the app', ext.list().find((a) => a.name === 'Other App').ask === true && ext.beginCall(s2).ask === true);
    const s3 = session({ clientName: 'Bad App' });
    const p3 = ext.admit(s3, {});
    ext.answer(events.prompts[2].prompt.id, 'deny');
    check('Deny refuses it with a reason', /not allowed/.test((await p3) || ''));
    check('a Deny holds: the same app is not asked again at once', /not allowed/.test((await ext.admit(session({ clientName: 'Bad App' }), {})) || '') && events.prompts.length === 3);
    check('a denied app has no record', !ext.list().some((a) => a.name === 'Bad App'));
  }
  {
    const { ext, events, c } = make();
    ext.setPrompting(() => true);
    const p = ext.admit(session({ clientName: 'Slow App' }), {});
    c.advance(120000);
    check('an unanswered prompt is a Deny, and not remembered', /not allowed/.test((await p) || '') && ext.state().prompts.length === 0);
  }

  // ---------- the setup text
  {
    const cmd = { command: process.execPath, args: [path.join(__dirname, '..', 'mcp.js')] };
    const withToken = setupFor({ ...cmd, token: 'lmn_aaaaaaaaaaaa_' + 'b'.repeat(48) });
    const placeholder = setupFor({ ...cmd });
    for (const id of ['claude-desktop', 'cursor']) {
      const j = JSON.parse(withToken[id].text);
      check(`${id}: valid JSON with the bridge command, its argument and the token`, j.mcpServers.lumen.command === cmd.command && j.mcpServers.lumen.args[0] === cmd.args[0] && j.mcpServers.lumen.env.ELECTRON_RUN_AS_NODE === '1' && j.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN.startsWith('lmn_'));
    }
    const vs = JSON.parse(withToken.vscode.text);
    check('vscode: valid JSON, "servers" with type stdio', vs.servers.lumen.type === 'stdio' && vs.servers.lumen.command === cmd.command && vs.servers.lumen.env.LUMEN_CLIENT_TOKEN.startsWith('lmn_'));
    check('claude-code: a `claude mcp add` command with the token and the bridge', /^claude(\.cmd)? mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -e LUMEN_CLIENT_TOKEN=lmn_\w+ -- /.test(withToken['claude-code'].text) && withToken['claude-code'].text.includes('mcp.js'), withToken['claude-code'].text);
    check('without a token the placeholder stands in and the JSON is still valid', ['claude-desktop', 'cursor', 'vscode'].every((id) => JSON.parse(placeholder[id].text)) && placeholder['claude-code'].text.includes(TOKEN_PLACEHOLDER));
    check('the text with no token holds no real token', !/lmn_[a-f0-9]{12}_/.test(Object.values(placeholder).map((x) => x.text).join('\n')));
    const home = path.join(os.tmpdir(), 'home');
    check('config paths: Claude Desktop, Cursor and VS Code in their standard places', configPath('claude-desktop', { platform: 'win32', env: { APPDATA: 'C:\\A' }, home }).endsWith(path.join('Claude', 'claude_desktop_config.json'))
      && configPath('claude-desktop', { platform: 'darwin', env: {}, home }).includes('Application Support') && configPath('cursor', { platform: 'linux', env: {}, home }) === path.join(home, '.cursor', 'mcp.json')
      && configPath('vscode', { platform: 'win32', env: { APPDATA: 'C:\\A' }, home }).endsWith(path.join('Code', 'User', 'mcp.json')) && configPath('claude-code', { home }) === null);
  }

  // ---------- the MCP server's hooks, over the real channel with a fake client
  {
    const userData = tmp();
    const { ext, events } = make();
    ext.setPrompting(() => true);
    const made = ext.add({ name: 'Fake App' });
    const server = mcp.startServer({ userData, tools: [{ name: 'list_tabs', description: 'x', input_schema: { type: 'object' } }], callTool: async (name, args, s) => { const call = ext.beginCall(s); if (call.refuse) return { content: [{ type: 'text', text: call.refuse }], isError: true }; try { return { content: [{ type: 'text', text: 'ok' }], isError: false }; } finally { call.end(); } },
      enabled: () => true, onEvent: () => {}, identify: (h) => (h.client === undefined ? null : ext.identify(h)), onInitialize: (s, i) => ext.admit(s, i), onClose: (s) => ext.detach(s) });
    await new Promise((r) => setTimeout(r, 100));
    const sharedToken = fs.readFileSync(mcp.tokenPath(userData), 'utf8').trim();
    // A client the way the bridge is one: proves the shared token, then (with an app token) its own.
    const connect = (appToken, { engine } = {}) => new Promise((resolve) => {
      const socket = net.connect(mcp.channelPath(userData));
      const out = { socket, lines: [], closed: false };
      const waiting = new Map();
      let authed = null; let buffer = '';
      socket.setEncoding('utf8');
      socket.on('close', () => { out.closed = true; resolve({ ...out, authed: authed || 'closed' }); });
      socket.on('error', () => {});
      socket.on('data', (d) => {
        buffer += d; let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
          if (msg.lumenChallenge) socket.write(`${JSON.stringify({ lumenProof: mcp.proofFor(sharedToken, msg.lumenChallenge), lumenEngine: engine, ...clientToken.hello(appToken, msg.lumenChallenge) })}\n`);
          else if (msg.lumenAuth) { authed = msg.lumenAuth; if (authed === 'ok') resolve({ ...out, authed, request: (method, params) => new Promise((res) => { const id = Math.random(); waiting.set(id, res); socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }), isClosed: () => out.closed }); }
          else { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
        }
      });
    });
    const init = (c, name = 'Fake App') => c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name } });
    const call = (c) => c.request('tools/call', { name: 'list_tabs', arguments: {} });

    const bad = await connect(clientToken.make().token);
    check('an unknown token is refused at the door', bad.authed === 'denied', bad.authed);
    const wrong = await connect(`lmn_${made.app.id}_${'0'.repeat(48)}`);
    check('a known id with the wrong secret is refused', wrong.authed === 'denied', wrong.authed);
    const garbage = await connect('not-a-token');
    check('a malformed token is refused', garbage.authed === 'denied', garbage.authed);

    const good = await connect(made.token);
    check('the right token connects', good.authed === 'ok');
    const r = await init(good, 'something else');
    check('it initializes, and Lumen names it after the app, not what it says', r.result?.serverInfo?.name === 'lumen' && ext.list()[0].connected === 1 && ext.list()[0].name === 'Fake App', JSON.stringify(r));
    const callOne = await call(good);
    check('its calls run', callOne.result?.isError === false, JSON.stringify(callOne));
    ext.stop(made.app.id);
    await new Promise((r2) => setTimeout(r2, 150));
    check('Stop closes its connection', good.isClosed());

    const again = await connect(made.token);
    check('after Stop it may connect again (it is still approved)', again.authed === 'ok');
    await init(again);
    ext.revoke(made.app.id);
    await new Promise((r2) => setTimeout(r2, 150));
    check('Revoke closes its connection at once', again.isClosed());
    const after = await connect(made.token);
    check('and its token is refused from then on', after.authed === 'denied', after.authed);

    // Lumen's own engines and unmanaged agents are unchanged.
    const legacy = await connect(undefined);
    check('a bridge with no app token still connects (older setups)', legacy.authed === 'ok');
    const pendingInit = init(legacy, 'Claude Code');
    await new Promise((r2) => setTimeout(r2, 100));
    check('with "ask" on, it waits for the user before it may start', events.prompts.some((p) => p.prompt.name === 'Claude Code'));
    ext.answer(events.prompts.find((p) => p.prompt.name === 'Claude Code').prompt.id, 'allow');
    const li = await pendingInit;
    check('Allow lets it start, named as it says', li.result?.serverInfo?.name === 'lumen');
    const skip = await connect(undefined);
    const skipped = await call(skip);
    check('a client that skips initialize gets no tools', skipped.result?.isError === true && /not been allowed/.test(skipped.result.content[0].text), JSON.stringify(skipped));
    const engine = await connect(undefined, { engine: 'claude-code-1' });
    const ei = await init(engine, 'claude-code');
    const ec = await call(engine);
    check('Lumen\'s own engine session is never asked about or counted', ei.result?.serverInfo?.name === 'lumen' && ec.result?.isError === false && !events.prompts.some((p) => p.prompt.name === 'claude-code'), JSON.stringify(ei));
    server.disconnectAll(); server.close();
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

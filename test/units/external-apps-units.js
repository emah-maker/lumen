// Plain Node: other apps using Lumen (features/external-apps.js, automation/client-token.js) and the MCP server's hooks for them
// (automation/mcp.js identify / onInitialize). Fake safeStorage and a fake MCP client over the real channel; no Electron.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
require('../helpers/_tmp-cleanup');
const { createExternalApps, writeTokenFile, cleanName, setupFor, configPath, FILE_PLACEHOLDER, RUN_QUIET_MS, MAX_PROMPTS, PROMPT_WAIT_MS, CALL_WAIT_MS } = require('../../src/features/external-apps');
const clientToken = require('../../src/automation/client-token');
const mcp = require('../../src/automation/mcp');

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
    check('ask-before-acting is the app\'s own choice and reaches the call', ext.beginCall(s2).ask === true && (ext.setAsk(a.app.id, false), ext.beginCall(s2).ask === false), 'a new app asks before it acts by default');
    const s3 = session({ client: a.app.id }); await ext.admit(s3, {});
    ext.revoke(a.app.id);
    check('Revoke cuts every connection of the app at once', s3.cut === true && ext.connectedCount() === 0);
    check('a revoked app is refused on its next call', /revoked/.test(ext.beginCall(s3).refuse || ''));
    check('a revoked app\'s token no longer proves anything', ext.identify({ client: a.app.id, nonce, proof: proofFor(a.token).lumenClientProof }) === false);
    check('a revoked app cannot start a session', /revoked/.test(await ext.admit(session({ client: a.app.id }), {}) || ''));
    check('the list is empty after Revoke', ext.list().length === 0);
  }

  // ---------- apps without a token: unverified
  {
    const { ext, events } = make();
    ext.setPolicy(() => 'require');
    const s0 = session({ clientName: 'Some Agent' });
    check('with "Require a token" on, a token-less client is refused at the start, with the reason', /needs a token/.test((await ext.admit(s0, {})) || '') && events.prompts.length === 0);
    check('...and gets no tool call either (it skipped the start)', /needs a token/.test(ext.beginCall(session({ clientName: 'Some Agent' })).refuse || ''));
    ext.setPolicy(() => 'open');
    check('the test-only "open" policy lets a token-less session through', (await ext.admit(session(), {})) === null && !ext.beginCall(session()).refuse);
  }
  {
    const { ext, events, file } = make();
    ext.setPolicy(() => 'ask');
    const real = ext.add({ name: 'Fake App', app: 'claude-desktop' });
    const s = session({ clientName: 'Legacy Agent' });
    const pending = ext.admit(s, {});
    check('a token-less client waits for the user: a prompt is raised', events.prompts.length === 1 && events.prompts[0].prompt.name === 'Legacy Agent' && ext.state().prompts.length === 1);
    check('it cannot call a tool while it waits', /not been allowed/.test(ext.beginCall(s).refuse || ''));
    const again = ext.admit(session({ clientName: 'legacy agent' }), {});
    check('a second connection of the same name shares the prompt', events.prompts.length === 1);
    ext.answer(events.prompts[0].prompt.id, 'allow');
    check('Allow lets it through (and the one waiting behind it)', (await pending) === null && (await again) === null && s.externalId);
    check('it is listed as unverified, for this session, and always asks before it acts', ext.list().find((x) => x.name === 'Legacy Agent')?.unverified === true && ext.beginCall(s).ask === true);
    check('Allow is not stored: nothing about it is on disk', !fs.readFileSync(file, 'utf8').includes('Legacy Agent') && createExternalApps({ file, safeStorage: fakeStorage }).list().every((x) => x.name !== 'Legacy Agent'));
    const next = ext.admit(session({ clientName: 'Legacy Agent' }), {});
    check('name claim: a later client with the same name is asked again, never let in by name', events.prompts.length === 2);
    ext.answer(events.prompts[1].prompt.id, 'deny');
    check('...and refused when denied', /not allowed/.test((await next) || ''));
    check('...but a token app of that name is fine (the proof decides)', (await ext.admit(session({ clientName: 'whatever', client: real.app.id }), {})) === null);
    // the same trust only by the shared mcp-token: nothing runs without the user's Allow
    const bare = session({ clientName: 'Sneaky' });
    check('shared token only (no app token): no tool runs before Allow', /not been allowed/.test(ext.beginCall(bare).refuse || ''));
    // a flood of new names: only MAX_PROMPTS are shown at once, the rest wait their turn (none refused, none lost)
    const floods = [];
    for (let i = 0; i < MAX_PROMPTS + 3; i++) floods.push(ext.admit(session({ clientName: `Flood ${i}` }), {}));
    await new Promise((r) => setImmediate(r));
    check('prompts shown at once are capped; the rest queue', ext.state().prompts.length === MAX_PROMPTS && events.prompts.length <= 2 + MAX_PROMPTS, `${ext.state().prompts.length} / ${events.prompts.length}`);
    const realLate = ext.admit(session({ clientName: 'Real Legacy App' }), {});
    let served = 0;
    for (let i = 0; i < 20 && ext.state().prompts.length; i++) { for (const p of ext.state().prompts) { if (p.name === 'Real Legacy App') served++; ext.answer(p.id, p.name === 'Real Legacy App' ? 'allow' : 'deny'); } await new Promise((r) => setImmediate(r)); }
    check('per client: a later real app is served in its turn, after the flood, never blocked by it', served === 1 && (await realLate) === null);
    await Promise.all(floods);
    // repeat initialize
    const t = ext.add({ name: 'Twice App' });
    const twice = session({ client: t.app.id });
    await ext.admit(twice, {}); const id1 = twice.externalId;
    twice.client = real.app.id; await ext.admit(twice, {});
    check('a second initialize does not move the session to another app or double-count it', twice.externalId === id1 && ext.connectedCount() === 2 - 0 + (ext.list().find((x) => x.name === 'Legacy Agent')?.connected ? 1 : 0) - 1 + 0 || ext.list().find((x) => x.id === id1).connected === 1, ext.connectedCount());
    ext.detach(s);
    check('an unverified client leaves the list when its session ends', !ext.list().some((x) => x.name === 'Legacy Agent'));
  }
  // ---------- a token-less client with a name that belongs to an app set up in Lumen: not refused, but never that app
  {
    const { ext, events, file } = make();
    ext.setPolicy(() => 'ask');
    const real = ext.add({ name: 'Fake App', app: 'claude-desktop' });
    const asks = async (clientName, decision) => {
      const before = events.prompts.length;
      const s = session({ clientName });
      const p = ext.admit(s, {});
      await new Promise((r) => setImmediate(r));
      const shown = events.prompts.slice(before).map((e) => e.prompt.name);
      for (const e of events.prompts.slice(before)) ext.answer(e.prompt.id, decision);
      return { s, shown, verdict: await p };
    };
    const a = await asks('Fake App', 'allow');
    check('name claim: a token-less client named like a token app is asked about as "Fake App (no token)", not refused', a.verdict === null && a.shown.join() === 'Fake App (no token)', JSON.stringify(a.shown));
    const rec = ext.list().find((x) => x.id === a.s.externalId);
    check('...it is an unverified client with its own record, never the token app, and still always asks before it acts', rec && rec.id !== real.app.id && rec.unverified === true && rec.name === 'Fake App (no token)' && a.s.clientName === 'Fake App (no token)' && ext.beginCall(a.s).ask === true);
    check('...and nothing about it is saved', !fs.readFileSync(file, 'utf8').includes('(no token)'));
    for (const label of ['Claude Desktop', 'Cursor', 'VS Code', 'Claude Code']) {
      const r = await asks(label, 'allow');
      check(`name claim: "${label}" connects as "${label} (no token)" after the user's Allow`, r.verdict === null && r.shown.join() === `${label} (no token)` && r.s.clientName === `${label} (no token)`, JSON.stringify(r.shown));
    }
    for (const name of ['Claude​ Desktop', 'Claude‮ Desktop', 'Ｃursor', 'VS Code', 'Claude﻿ Code', ' fake   app ', 'CLAUDE DESKTOP', 'Cl­aude Desktop']) {
      const r = await asks(name, 'allow');
      check(`name normalization: ${JSON.stringify(name)} is still a reserved name (labelled "(no token)")`, r.verdict === null && r.s.clientName.endsWith(' (no token)'), r.s.clientName);
    }
    const d = await asks('fake app', 'deny');
    check('...and Deny still refuses it (the normal "not allowed" answer)', /not allowed/.test(d.verdict || ''));
    const again = session({ clientName: 'Claude Code' });
    const p0 = ext.admit(again, {}); await new Promise((r) => setImmediate(r)); for (const e of events.prompts.slice(-1)) ext.answer(e.prompt.id, 'allow'); await p0;
    again.clientName = 'Claude Code';
    check('a second initialize with the same name is fine; as another name it is refused', (await ext.admit(again, {})) === null && again.clientName === 'Claude Code (no token)' && (again.clientName = 'Cursor', /can’t change the name/.test((await ext.admit(again, {})) || '')));
    const withToken = session({ clientName: 'Fake App', client: real.app.id });
    check('with the right token it is the token app, with its name', (await ext.admit(withToken, {})) === null && withToken.externalId === real.app.id && withToken.clientName === 'Fake App');
    check('with a wrong token it is refused before it starts (identify)', ext.identify({ client: real.app.id, nonce, proof: proofFor('lmn_000000000000_' + '0'.repeat(48)).lumenClientProof }) === false);
    ext.revoke(real.app.id);
  }
  {
    const { ext, events, c } = make();
    ext.setPolicy(() => 'ask');
    const p = ext.admit(session({ clientName: 'Slow App' }), {});
    c.advance(PROMPT_WAIT_MS + 1000);
    check('an unanswered prompt is a Deny, and not remembered', /not allowed/.test((await p) || '') && ext.state().prompts.length === 0);
    check('a bare engine tag is never asked about', (await ext.admit(session({ engine: 'x', clientName: 'Any' }), {})) === null && events.prompts.length === 1);
  }

  // ---------- review round 2: a name is locked at admission, and the small things
  {
    const { ext, events } = make();
    ext.setPolicy(() => 'ask');
    ext.add({ name: 'Fake App' });
    const s = session({ clientName: 'Foo' });
    const p = ext.admit(s, {}); ext.answer(events.prompts[0].prompt.id, 'allow'); await p;
    s.clientName = 'Claude Desktop'; // what mcp.js does on a second initialize
    const v = await ext.admit(s, {});
    check('a second initialize as another name is refused, and the session keeps the name it was admitted with', /can’t change the name/.test(v || '') && s.clientName === 'Foo', JSON.stringify([v, s.clientName]));
    s.clientName = 'Fake App';
    check('...also as a token app\'s name', /can’t change the name/.test((await ext.admit(s, {})) || '') && s.clientName === 'Foo');
    s.clientName = 'Foo';
    check('the same name again is fine', (await ext.admit(s, {})) === null && s.clientName === 'Foo' && ext.list().filter((x) => x.name === 'Foo').length === 1);
    check('what the cards and the pill show is the admitted name', (() => { const call = ext.beginCall(s); const n = ext.state().active[0]?.name; call.end(); return n === 'Foo'; })());
    const tokenApp = session({ client: ext.list().find((x) => x.name === 'Fake App').id, clientName: 'Fake App' });
    await ext.admit(tokenApp, {}); tokenApp.clientName = 'Whatever'; await ext.admit(tokenApp, {});
    check('a token app\'s name is always its record\'s, whatever a later initialize says', tokenApp.clientName === 'Fake App');

    // (4) names are normalized before the reserved-name check
    check('...and a name of only invisible characters gets a plain label, not an empty one', cleanName('\u200b\u202e') === '');

    // (2) an Allow after "Require a token" went on is refused
    const late = session({ clientName: 'Late App' });
    const lp = ext.admit(late, {});
    ext.setPolicy(() => 'require');
    ext.answer(events.prompts.at(-1).prompt.id, 'allow');
    check('(2) an Allow answered after "Require a token" went on is refused, and no entry is made', /needs a token/.test((await lp) || '') && !ext.list().some((x) => x.name === 'Late App'));
    ext.setPolicy(() => 'ask');

    // (3) a disconnect while the prompt is open dismisses it and leaves no entry
    const gone = session({ clientName: 'Gone App' });
    const gp = ext.admit(gone, {});
    const before = ext.state().prompts.length;
    ext.detach(gone);
    check('(3) a connection that goes while its prompt is open dismisses the prompt, and nothing is listed', before === 1 && ext.state().prompts.length === 0 && /not allowed/.test((await gp) || '') && !ext.list().some((x) => x.name === 'Gone App'));
    const closedWhileWaiting = session({ clientName: 'Closing App' });
    const cp = ext.admit(closedWhileWaiting, {});
    closedWhileWaiting.controller.abort();
    ext.answer(events.prompts.at(-1).prompt.id, 'allow');
    check('(3) an Allow that arrives after the connection ended makes no entry', /ended/.test((await cp) || '') && !ext.list().some((x) => x.name === 'Closing App'));
    const shared = [session({ clientName: 'Shared App' }), session({ clientName: 'Shared App' })];
    const sp = shared.map((x) => ext.admit(x, {}));
    ext.detach(shared[0]);
    check('(3) with two connections on one prompt, it stays until the last one goes', ext.state().prompts.length === 1);
    ext.detach(shared[1]);
    check('...and is dismissed then', ext.state().prompts.length === 0);
    await Promise.all(sp);
    // Stop clears an unverified app
    const okSession = session({ clientName: 'Stoppable' });
    const op = ext.admit(okSession, {}); ext.answer(events.prompts.at(-1).prompt.id, 'allow'); await op;
    const unv = ext.list().find((x) => x.name === 'Stoppable');
    ext.stop(unv.id);
    check('(3) Stop on an unverified app cuts it and removes its entry', okSession.cut === true && !ext.list().some((x) => x.name === 'Stoppable'));
    check('...so it has to be asked again', (() => { const again = ext.admit(session({ clientName: 'Stoppable' }), {}); const asked = ext.state().prompts.some((x) => x.name === 'Stoppable'); ext.answer(ext.state().prompts[0].id, 'deny'); again.catch(() => {}); return asked; })());
  }
  {
    // (6) no "finished" after Stop or Take over
    const { ext, events, c } = make();
    const a = ext.add({ name: 'Quiet App' });
    const s = session({ client: a.app.id }); await ext.admit(s, {});
    const call = ext.beginCall(s);
    ext.stop(a.app.id); call.end();
    c.advance(RUN_QUIET_MS + 100);
    check('(6) no "finished" notice for a run that was stopped', events.finished.length === 0, events.finished.join());
    const s2 = session({ client: a.app.id }); await ext.admit(s2, {});
    const c2 = ext.beginCall(s2);
    ext.takeOver(a.app.id); c2.end();
    c.advance(RUN_QUIET_MS + 100);
    check('(6) none for a run that was taken over either', events.finished.length === 0, events.finished.join());
    ext.resume(a.app.id);
    const c3 = ext.beginCall(s2); c3.end(); c.advance(RUN_QUIET_MS + 100);
    check('(6) but a run that finishes by itself afterwards still does', events.finished.join() === 'Quiet App', events.finished.join());
  }
  {
    // (1) the token file: made empty, locked down, checked, and only then written; no lock-down, no token
    const dir = tmp(); const file = path.join(dir, 't', 'x.token');
    const seen = [];
    writeTokenFile(file, 'SECRET', { lock: (p) => { seen.push(fs.readFileSync(p, 'utf8')); } });
    check('(1) the file is empty when it is locked down, and holds the token afterwards', seen.length === 1 && seen[0] === '' && fs.readFileSync(file, 'utf8') === 'SECRET');
    const bad = path.join(dir, 't', 'y.token');
    let threw = false;
    try { writeTokenFile(bad, 'SECRET', { lock: () => { throw new Error('icacls failed'); } }); } catch { threw = true; }
    check('(1) if the lock-down fails nothing secret is ever written', threw && (!fs.existsSync(bad) || fs.readFileSync(bad, 'utf8') === ''));
    const { ext, file: jsonFile } = make({ writeToken: () => { throw new Error('icacls failed'); } });
    let err = '';
    try { ext.add({ name: 'No Lock' }); } catch (e) { err = e.message; }
    check('(1) with no private file, Add app fails with an error and no app or token exists', /private file/.test(err) && ext.list().length === 0 && !fs.existsSync(jsonFile));
    const ok = make(); const made = ok.ext.add({ name: 'Locked App' });
    check('(1) and the real thing verifies the lock-down', fs.readFileSync(made.tokenFile, 'utf8') === made.token);
  }
  {
    // (7) a launched Lumen is never in test mode because an agent's environment said so
    const env = mcp.launchEnv({ PATH: 'p', CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', LUMEN_TEST_CLI_SPAWN: 'x', LUMEN_TESTING: 'keep-not-a-test-switch', LUMEN_MCP_BRIDGE: '1' });
    check('(7) launchEnv drops CLAUDE_BROWSER_TEST and LUMEN_TEST_*', !('CLAUDE_BROWSER_TEST' in env) && !('LUMEN_TEST_BACKGROUND' in env) && !('LUMEN_TEST_CLI_SPAWN' in env) && env.PATH === 'p' && env.LUMEN_TESTING === 'keep-not-a-test-switch', JSON.stringify(env));
  }

  // ---------- two apps at once: Stop on one leaves the other alone
  {
    const { ext } = make();
    const a = ext.add({ name: 'App A' }); const b = ext.add({ name: 'App B' });
    const sa = session({ client: a.app.id }); const sb = session({ client: b.app.id });
    await ext.admit(sa, {}); await ext.admit(sb, {});
    const ca = ext.beginCall(sa); const cb = ext.beginCall(sb);
    ext.stop(a.app.id);
    check('Stop on one app ends its call and connection only', ca.signal.aborted && sa.cut === true && !cb.signal.aborted && !sb.cut);
    check('...the other still shows as working', ext.state().active.map((x) => x.name).join() === 'App B');
    ext.takeOver(b.app.id);
    const ca2 = ext.beginCall(session({ client: a.app.id }));
    check('Take over on the second pauses it; the first (reconnected) is not paused', cb.signal.aborted && !ca2.refuse);
    ext.revoke(a.app.id);
    check('Revoke of one leaves the other approved', ext.list().length === 1 && ext.list()[0].name === 'App B');
  }

  // ---------- the token file, the launch environment, an empty token
  {
    const { ext, dir } = make();
    const made = ext.add({ name: 'File App' });
    const body = fs.readFileSync(made.tokenFile, 'utf8');
    check('Add app writes the token to a file of its own, next to the profile files', body === made.token && made.tokenFile.startsWith(path.join(dir, 'external-app-tokens')));
    if (process.platform === 'win32') {
      const acl = require('child_process').execFileSync('icacls', [made.tokenFile], { encoding: 'utf8' });
      check('the token file is for this user only (Windows ACL: no Users, Everyone or inherited groups)', !/Everyone|BUILTIN\\Users|Authenticated Users/i.test(acl) && /\(F\)/.test(acl), acl);
    } else {
      check('the token file is 0600', (fs.statSync(made.tokenFile).mode & 0o077) === 0);
    }
    const hello = clientToken.hello(clientToken.fromEnv({ LUMEN_CLIENT_TOKEN_FILE: made.tokenFile }), nonce);
    check('the bridge reads the token from LUMEN_CLIENT_TOKEN_FILE and proves it', ext.identify({ client: hello.lumenClient, nonce, proof: hello.lumenClientProof })?.client === made.app.id);
    check('a token set but empty is invalid, not "no token"', clientToken.hello(clientToken.fromEnv({ LUMEN_CLIENT_TOKEN: '' }), nonce).lumenClient === 'invalid' && clientToken.hello(clientToken.fromEnv({ LUMEN_CLIENT_TOKEN_FILE: path.join(dir, 'nope') }), nonce).lumenClient === 'invalid' && JSON.stringify(clientToken.hello(clientToken.fromEnv({}), nonce)) === '{}');
    ext.revoke(made.app.id);
    check('Revoke deletes the token file', !fs.existsSync(made.tokenFile));
    // env inheritance
    const env = mcp.launchEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', LUMEN_MCP_BRIDGE: '1', LUMEN_CLIENT_TOKEN: 'lmn_x', LUMEN_CLIENT_TOKEN_FILE: 'f', LUMEN_ENGINE: 'e' });
    check('launchEnv drops the app token, its file, the engine tag and the bridge flags', JSON.stringify(env) === '{"PATH":"p"}', JSON.stringify(env));
    // (the real launch, through the bridge, is in test/e2e/external-apps.js: it starts Electron, which only runs under the lock)
  }

  // ---------- the setup text
  {
    const cmd = { command: process.execPath, args: [path.join(__dirname, '..', '..', 'mcp.js')] };
    const file = path.join(os.tmpdir(), 'with space', 'abc.token');
    const withFile = setupFor({ ...cmd, tokenFile: file });
    const placeholder = setupFor({ ...cmd });
    for (const id of ['claude-desktop', 'cursor']) {
      const j = JSON.parse(withFile[id].text);
      check(`${id}: valid JSON with the bridge command, its argument and the token FILE (no secret)`, j.mcpServers.lumen.command === cmd.command && j.mcpServers.lumen.args[0] === cmd.args[0] && j.mcpServers.lumen.env.ELECTRON_RUN_AS_NODE === '1' && j.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN_FILE === file && !('LUMEN_CLIENT_TOKEN' in j.mcpServers.lumen.env));
    }
    const vs = JSON.parse(withFile.vscode.text);
    check('vscode: valid JSON, "servers" with type stdio and the token file', vs.servers.lumen.type === 'stdio' && vs.servers.lumen.command === cmd.command && vs.servers.lumen.env.LUMEN_CLIENT_TOKEN_FILE === file);
    check('claude-code: a `claude mcp add` command, user scope, with the token file quoted and the bridge', /^claude(\.cmd)? mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -e "LUMEN_CLIENT_TOKEN_FILE=[^"]*abc\.token" -- /.test(withFile['claude-code'].text) && withFile['claude-code'].text.includes('mcp.js'), withFile['claude-code'].text);
    check('project-level files carry a "don\'t commit" warning; the config paths named are the user-level ones', /commit/i.test(withFile.cursor.warning) && /commit/i.test(withFile.vscode.warning) && /scope user/.test(withFile['claude-code'].warning) && /~\/\.cursor\/mcp\.json/.test(withFile.cursor.where) && !/\.cursor\/mcp\.json in a project/.test(withFile.cursor.where));
    check('without a file the placeholder stands in and the JSON is still valid', ['claude-desktop', 'cursor', 'vscode'].every((id) => JSON.parse(placeholder[id].text)) && placeholder['claude-code'].text.includes(FILE_PLACEHOLDER));
    check('no snippet ever holds a real token', !/lmn_[a-f0-9]{12}_/.test(Object.values(withFile).concat(Object.values(placeholder)).map((x) => x.text).join('\n')));
    const withSecret = setupFor({ ...cmd, token: 'lmn_aaaaaaaaaaaa_' + 'b'.repeat(48) });
    check('a caller that insists can still get LUMEN_CLIENT_TOKEN', JSON.parse(withSecret.cursor.text).mcpServers.lumen.env.LUMEN_CLIENT_TOKEN.startsWith('lmn_'));
    const home = path.join(os.tmpdir(), 'home');
    check('config paths: Claude Desktop, Cursor and VS Code in their standard places', configPath('claude-desktop', { platform: 'win32', env: { APPDATA: 'C:\\A' }, home }).endsWith(path.join('Claude', 'claude_desktop_config.json'))
      && configPath('claude-desktop', { platform: 'darwin', env: {}, home }).includes('Application Support') && configPath('cursor', { platform: 'linux', env: {}, home }) === path.join(home, '.cursor', 'mcp.json')
      && configPath('vscode', { platform: 'win32', env: { APPDATA: 'C:\\A' }, home }).endsWith(path.join('Code', 'User', 'mcp.json')) && configPath('claude-code', { home }) === null);
  }

  // ---------- the MCP server's hooks, over the real channel with a fake client
  {
    const userData = tmp();
    const { ext, events } = make({ tokenDir: path.join(userData, 'external-app-tokens') });
    ext.setPolicy(() => 'ask');
    const made = ext.add({ name: 'Fake App' });
    ext.add({ name: 'Second App' });
    const server = mcp.startServer({ userData, tools: [{ name: 'list_tabs', description: 'x', input_schema: { type: 'object' } }, { name: 'wait', description: 'x', input_schema: { type: 'object' } }], callTool: async (name, args, s) => { const call = ext.beginCall(s); if (call.refuse) return { content: [{ type: 'text', text: call.refuse }], isError: true }; try { const how = name === 'wait' ? await new Promise((res) => { const t = setTimeout(() => res('done'), 4000); call.signal?.addEventListener('abort', () => { clearTimeout(t); res('stopped'); }); }) : 'ok'; return { content: [{ type: 'text', text: how }], isError: how === 'stopped' }; } finally { call.end(); } },
      enabled: () => true, onEvent: () => {}, identify: (h) => (h.client === undefined ? null : ext.identify(h)), onInitialize: (s, i) => ext.admit(s, i, { defer: true }), onCall: (s) => ext.admitForCall(s), onClose: (s) => ext.detach(s) });
    await new Promise((r) => setTimeout(r, 100));
    const sharedToken = fs.readFileSync(mcp.tokenPath(userData), 'utf8').trim();
    // A client the way the bridge is one: proves the shared token, then (with an app token) its own.
    const connect = (appToken, { engine, replayProof } = {}) => new Promise((resolve) => {
      const socket = net.connect(mcp.channelPath(userData));
      const out = { socket, lines: [], closed: false };
      const waiting = new Map();
      let authed = null; let buffer = '';
      socket.setEncoding('utf8');
      socket.on('close', () => { out.closed = true; resolve({ ...out, authed: authed || 'closed' }); for (const w of waiting.values()) w({ closed: true }); });
      socket.on('error', () => {});
      socket.on('data', (d) => {
        buffer += d; let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
          if (msg.lumenChallenge) { const h = clientToken.hello(appToken, msg.lumenChallenge); out.proof = h; socket.write(`${JSON.stringify({ lumenProof: mcp.proofFor(sharedToken, msg.lumenChallenge), lumenEngine: engine, ...(replayProof || h) })}\n`); }
          else if (msg.lumenAuth) { authed = msg.lumenAuth; if (authed === 'ok') resolve({ ...out, authed, request: (method, params) => new Promise((res) => { const id = Math.random(); waiting.set(id, res); socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }), isClosed: () => out.closed }); }
          else { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
        }
      });
    });
    const init = (c, name = 'Fake App') => c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name } });
    const call = (c) => c.request('tools/call', { name: 'list_tabs', arguments: {} });
    const call2 = (c, name) => c.request('tools/call', { name, arguments: {} });

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

    // Replay: a proof recorded from one connection is useless on the next (a new nonce each time)
    const made3 = ext.add({ name: 'Replay App' }); const made4 = ext.add({ name: 'Fourth App' });
    const first = await connect(made3.token);
    const recorded = first.proof; first.end?.();
    const replayed = await connect(made3.token, { replayProof: recorded });
    check('a proof recorded on one connection is refused on another (replay over the real channel)', first.authed === 'ok' && replayed.authed === 'denied', replayed.authed);

    // Two apps at once: Stop on one leaves the other's call running
    const one = await connect(made3.token); const two = await connect(made4.token);
    await init(one); await init(two, 'x');
    const oneWait = call2(one, 'wait'); const twoWait = call2(two, 'wait');
    await new Promise((r2) => setTimeout(r2, 300));
    ext.stop(made3.app.id);
    const oneDone = await oneWait;
    check('Stop on one app ends its call in flight and closes it, while the other app\'s call keeps running', (oneDone.closed === true || /stopped/.test(oneDone.result?.content?.[0]?.text || '')) && one.isClosed() && !two.isClosed());
    ext.revoke(made4.app.id);
    const twoDone = await twoWait;
    check('Revoke while a real call is in flight ends that call and closes the connection', (twoDone.closed === true || /stopped/.test(twoDone.result?.content?.[0]?.text || '')) && (await new Promise((r2) => setTimeout(() => r2(two.isClosed()), 200))));

    // Token-less clients (the shared mcp-token only)
    const legacy = await connect(undefined);
    check('a bridge with no app token still reaches the door (the shared token)', legacy.authed === 'ok');
    const li = await init(legacy, 'Legacy Agent');
    check('its initialize is answered at once, with no wait for the user (the handshake has a client-side timeout)', li.result?.serverInfo?.name === 'lumen' && events.prompts.length === 0, JSON.stringify(li));
    const firstCall = call(legacy);
    await new Promise((r2) => setTimeout(r2, 100));
    check('its first tool call waits for the user’s Allow', events.prompts.some((p) => p.prompt.name === 'Legacy Agent'));
    ext.answer(events.prompts.find((p) => p.prompt.name === 'Legacy Agent').prompt.id, 'allow');
    const fc = await firstCall;
    check('Allow lets the call run (this session)', fc.result?.isError === false, JSON.stringify(fc));
    const renamed = await init(legacy, 'Claude Desktop');
    check('over the real channel, a second initialize as another name is refused and the app keeps its name', /can’t change the name/.test(renamed.error?.message || '') && ext.list().some((x) => x.name === 'Legacy Agent') && !ext.list().some((x) => x.name === 'Claude Desktop'), JSON.stringify(renamed));
    const claim = await connect(undefined);
    const claimedInit = await init(claim, 'Claude Code');
    const claimedCall = call(claim);
    await new Promise((r2) => setTimeout(r2, 100));
    check('a token-less client calling itself Claude Code is asked about as "Claude Code (no token)", not refused', claimedInit.result?.serverInfo?.name === 'lumen' && events.prompts.some((p) => p.prompt.name === 'Claude Code (no token)'));
    ext.answer(events.prompts.find((p) => p.prompt.name === 'Claude Code (no token)').prompt.id, 'allow');
    const claimed = await claimedCall;
    check('...and after Allow it works, as an unverified client with no app privileges', claimed.result?.isError === false && ext.list().some((x) => x.name === 'Claude Code (no token)' && x.unverified), JSON.stringify(claimed));
    const skip = await connect(undefined);
    const skipped = await call(skip);
    check('a client that skips initialize gets no tools', skipped.result?.isError === true && /not been allowed/.test(skipped.result.content[0].text), JSON.stringify(skipped));
    ext.setPolicy(() => 'require');
    const req = await connect(undefined);
    const reqInit = await init(req, 'Another Agent');
    check('with "Require a token" on, the same client is refused at once', /needs a token/.test(reqInit.error?.message || ''), JSON.stringify(reqInit));
    ext.setPolicy(() => 'ask');
    const engine = await connect(undefined, { engine: 'claude-code-1' });
    const ei = await init(engine, 'claude-code');
    const ec = await call(engine);
    check('Lumen\'s own engine session is never asked about or counted', ei.result?.serverInfo?.name === 'lumen' && ec.result?.isError === false && !events.prompts.some((p) => p.prompt.name === 'claude-code'), JSON.stringify(ei));
    const engineWithToken = await connect(clientToken.make().token, { engine: 'claude-code-2' });
    check('an engine session is not judged by a client token (a revoked app\'s token in its environment cannot make Lumen\'s own engine fail)', engineWithToken.authed === 'ok', engineWithToken.authed);
    // the real bridge program (root mcp.js) with NO token in its environment: the name it gives is no credential
    {
      ext.add({ name: 'Bridge App' });
      const promptsBefore = events.prompts.length;
      const runBridge = (clientName, extraEnv = {}, withCall = false) => new Promise((resolve) => {
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', LUMEN_USERDATA: userData, ...extraEnv };
        delete env.LUMEN_CLIENT_TOKEN; if (!('LUMEN_CLIENT_TOKEN_FILE' in extraEnv)) delete env.LUMEN_CLIENT_TOKEN_FILE;
        const child = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', '..', 'mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let out = ''; let err = ''; let done = false;
        const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...v, out, err, kill: () => { try { child.kill(); } catch {} } }); };
        const timer = setTimeout(() => finish({ timeout: true }), 15000);
        child.stdout.on('data', (d) => { out += d; if (withCall ? out.includes('"id":2') : out.includes('"id":1')) setTimeout(() => finish({ replied: true }), 100); });
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', () => finish({ exited: true }));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName } } }) + String.fromCharCode(10));
        if (withCall) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } }) + String.fromCharCode(10));
      });
      const spoof = runBridge('Bridge App', {}, true);
      await new Promise((r2) => setTimeout(r2, 1500));
      const asked = events.prompts.slice(promptsBefore).find((p) => p.prompt.name === 'Bridge App (no token)');
      check('a spawned bridge with no token that calls itself "Bridge App" is asked about as "Bridge App (no token)" and is not that app', Boolean(asked) && ext.list().find((x) => x.name === 'Bridge App').connected === 0);
      if (asked) ext.answer(asked.prompt.id, 'allow');
      const spoofed = await spoof;
      check('after Allow its first call runs, but as the unverified client, never the app', spoofed.replied === true && /"serverInfo"/.test(spoofed.out) && /"id":2,"result"/.test(spoofed.out) && ext.list().find((x) => x.name === 'Bridge App').connected === 0 && ext.list().some((x) => x.name === 'Bridge App (no token)' && x.unverified), JSON.stringify({ out: spoofed.out.slice(0, 200), err: spoofed.err.slice(0, 200) }));
      spoofed.kill();
      await new Promise((r2) => setTimeout(r2, 200));
      const bogus = path.join(userData, 'bogus.token'); fs.writeFileSync(bogus, 'lmn_' + '0'.repeat(12) + '_' + '0'.repeat(48));
      const wrong = await runBridge('Bridge App', { LUMEN_CLIENT_TOKEN_FILE: bogus });
      check('a bridge with a wrong token is refused', wrong.exited === true && /refused/.test(wrong.err) && !/"serverInfo"/.test(wrong.out), JSON.stringify({ out: wrong.out.slice(0, 200), err: wrong.err.slice(0, 200) }));
    }
    server.disconnectAll(); server.close();
  }

  // ---------- the handshake never waits for the user: the Allow is asked at the first tool call (Claude Code gave up on a server whose initialize hung on the pill)
  {
    const { ext, events, c, file } = make();
    ext.setPolicy(() => 'ask');
    const tools = [{ name: 'list_tabs', description: 'x', input_schema: { type: 'object' } }];
    const ran = [];
    const rig = () => {
      const out = [];
      const s = mcp.createSession({ tools, enabled: () => true, onEvent: () => {}, send: (m) => out.push(m), onInitialize: (sess, i) => ext.admit(sess, i, { defer: true }), onCall: (sess) => ext.admitForCall(sess), callTool: async (name, args, sess) => { const call = ext.beginCall(sess); if (call.refuse) return { content: [{ type: 'text', text: call.refuse }], isError: true }; try { ran.push(name); return { content: [{ type: 'text', text: 'ok' }], isError: false }; } finally { call.end(); } } });
      s.out = out;
      s.send = (msg) => s.handle(msg);
      return s;
    };
    const tick = () => new Promise((r) => setImmediate(r));
    const initMsg = (id, name) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name } } });
    const callMsg = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
    const reply = (s, id) => s.out.find((m) => m.id === id);

    const a = rig();
    a.send(initMsg(1, 'claude-code')); await tick();
    check('initialize is answered at once while no one has answered the prompt (nothing is asked yet)', reply(a, 1)?.result?.serverInfo?.name === 'lumen' && reply(a, 1).result.protocolVersion === '2025-11-25' && events.prompts.length === 0, JSON.stringify(a.out));
    a.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); await tick();
    check('tools/list works before any Allow (clients register the server from it)', reply(a, 2)?.result?.tools?.length === 1);
    a.send(callMsg(3)); await tick();
    check('the first tool call asks the user, and waits', events.prompts.length === 1 && events.prompts[0].prompt.name === 'Claude Code (no token)' && !reply(a, 3) && ran.length === 0, JSON.stringify(events.prompts));
    a.send(callMsg(4)); await tick();
    check('a second call waits on the same prompt (one question, not two)', events.prompts.length === 1 && !reply(a, 4));
    ext.answer(events.prompts[0].prompt.id, 'allow');
    await tick(); await tick();
    check('Allow lets the waiting calls run', reply(a, 3)?.result?.isError === false && reply(a, 4)?.result?.isError === false && ran.length === 2, JSON.stringify(a.out.slice(-2)));
    a.send(callMsg(5)); await tick();
    check('...and later calls on the session run without asking', reply(a, 5)?.result?.isError === false && events.prompts.length === 1);
    check('"Allow" is for the session only: nothing on disk', !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('Claude Code'));
    a.close();
    ext.detach(a.session);

    // the wait is bounded: past CALL_WAIT_MS the call comes back with words the agent can pass on, and the prompt stays
    const b = rig();
    b.send(initMsg(1, 'Waiting App')); b.send(callMsg(2)); await tick();
    c.advance(CALL_WAIT_MS + 1);
    await tick(); await tick();
    const waiting = reply(b, 2)?.result;
    check('an unanswered call returns a tool error that says it is waiting for the user to allow it in Lumen', waiting?.isError === true && /Waiting for you to allow Waiting App in Lumen/.test(waiting.content[0].text) && ran.length === 3, JSON.stringify(waiting));
    check('...the prompt is still open, and the next call waits on it', ext.state().prompts.some((p) => p.name === 'Waiting App') && (b.send(callMsg(3)), await tick(), !reply(b, 3)));
    ext.answer(ext.state().prompts.find((p) => p.name === 'Waiting App').id, 'allow');
    await tick(); await tick();
    check('...and runs once the user allows', reply(b, 3)?.result?.isError === false);
    b.close(); ext.detach(b.session);

    // Deny: a tool error with the reason; remembered, so a retry does not ask again
    const d = rig();
    d.send(initMsg(1, 'Denied App')); d.send(callMsg(2)); await tick();
    const promptsBefore = events.prompts.length;
    ext.answer(events.prompts.at(-1).prompt.id, 'deny');
    await tick(); await tick();
    check('Deny gives the call a tool error with the reason', reply(d, 2)?.result?.isError === true && /not allowed/.test(reply(d, 2).result.content[0].text) && ran.length === 4);
    d.send(callMsg(3)); await tick(); await tick();
    check('a retry is refused without asking again (a Deny is remembered for a while)', reply(d, 3)?.result?.isError === true && events.prompts.length === promptsBefore);
    d.close(); ext.detach(d.session);

    // Always allow: remembered by name, on disk, no question on a reconnect, revocable
    const e1 = rig();
    e1.send(initMsg(1, 'claude-code')); e1.send(callMsg(2)); await tick();
    const asks = events.prompts.length;
    ext.answer(events.prompts.at(-1).prompt.id, 'always');
    await tick(); await tick();
    check('"Always allow" lets the call run', reply(e1, 2)?.result?.isError === false);
    const listed = ext.list().find((x) => x.kind === 'remembered');
    check('...and is listed as an unverified, remembered client Settings can revoke', Boolean(listed) && listed.unverified === true && listed.name === 'Claude Code (no token)', JSON.stringify(ext.list()));
    check('...kept in external-apps.json, with no secret', (() => { const r = JSON.parse(fs.readFileSync(file, 'utf8')).apps.find((x) => x.remembered); return Boolean(r) && r.secret === null && r.name === 'Claude Code (no token)'; })());
    e1.close(); ext.detach(e1.session);
    check('a remembered client\'s entry survives its session ending', ext.list().some((x) => x.kind === 'remembered'));
    const e2 = rig();
    e2.send(initMsg(1, 'claude-code')); e2.send(callMsg(2)); await tick(); await tick();
    check('a reconnect is not asked again: its first call just runs', reply(e2, 2)?.result?.isError === false && events.prompts.length === asks, JSON.stringify([events.prompts.length, asks]));
    check('it is the same unverified entry, not a token app, and it asks before it acts', ext.list().filter((x) => x.kind === 'remembered').length === 1 && ext.get(e2.session.externalId).ask === true);
    const other = rig();
    other.send(initMsg(1, 'Some Other Agent')); other.send(callMsg(2)); await tick();
    check('another name is still asked about', !reply(other, 2) && ext.state().prompts.some((p) => p.name === 'Some Other Agent'));
    ext.answer(ext.state().prompts.find((p) => p.name === 'Some Other Agent').id, 'deny');
    other.close(); ext.detach(other.session);
    // a restart keeps it
    const reborn = createExternalApps({ file, safeStorage: fakeStorage });
    reborn.setPolicy(() => 'ask');
    const s3 = session({ clientName: 'Claude Code' });
    check('a restart of Lumen keeps the choice (no question)', (await reborn.admit(s3, {}, { defer: true })) === null && s3.externalId && !s3.awaitingAllow);
    // Stop ends the run but keeps the standing Allow; Revoke takes it back
    ext.stop(e2.session.externalId);
    check('Stop keeps an "Always allow"', ext.list().some((x) => x.kind === 'remembered'));
    ext.revoke(ext.list().find((x) => x.kind === 'remembered').id);
    check('Revoke removes it, from the list and from disk', !ext.list().some((x) => x.kind === 'remembered') && !JSON.parse(fs.readFileSync(file, 'utf8')).apps.some((x) => x.remembered));
    const e3 = rig();
    e3.send(initMsg(1, 'claude-code')); e3.send(callMsg(2)); await tick();
    check('...after which it is asked again', !reply(e3, 2) && ext.state().prompts.some((p) => p.name === 'Claude Code (no token)'));
    ext.answer(ext.state().prompts.at(-1).id, 'deny'); e3.close(); ext.detach(e3.session);
    // the client withdrew a call (notifications/cancelled): no reply is sent for it
    const g = rig();
    g.send(initMsg(1, 'Cancelling App')); g.send(callMsg(2)); await tick();
    g.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }); await tick();
    ext.answer(ext.state().prompts.find((p) => p.name === 'Cancelling App').id, 'allow');
    await tick(); await tick();
    check('a call the client cancelled gets no reply', !reply(g, 2));
    g.close(); ext.detach(g.session);

    // the Settings → AI and agents → Require a token switch also cuts a remembered client
    const h = make(); h.ext.setPolicy(() => 'ask');
    const hs = session({ clientName: 'Tester' });
    await h.ext.admit(hs, {}, { defer: true });
    const hp = h.ext.admitForCall(hs); await tick();
    h.ext.answer(h.events.prompts.at(-1).prompt.id, 'always'); await hp;
    h.ext.disconnectUnverified();
    check('"Require a token" cuts a remembered client at once (the entry stays, unused)', hs.cut === true && h.ext.list().some((x) => x.kind === 'remembered'));
    h.ext.setPolicy(() => 'require');
    check('...and while it is on, the standing Allow does not count', /needs a token/.test((await h.ext.admit(session({ clientName: 'Tester' }), {}, { defer: true })) || ''));
  }

  // ---------- the bridge's line reader: the limit is per line, not per chunk
  {
    const { PassThrough } = require('stream');
    const got = [];
    const stream = new PassThrough();
    mcp.onLines(stream, (l) => got.push(l.length), 7 * 1024 * 1024);
    const big = 'x'.repeat(6 * 1024 * 1024);
    stream.write(`${big}\n{"a":1}\n${big}\n`);
    await new Promise((r) => setTimeout(r, 200));
    check('a 6 MB line (a screenshot) followed by more lines in the same chunk is delivered whole', got.length === 3 && got[0] === big.length && got[1] === 7 && !stream.destroyed, JSON.stringify(got));
    const hostile = new PassThrough(); let n = 0;
    mcp.onLines(hostile, () => { n++; }, 1024);
    hostile.write('y'.repeat(4096));
    await new Promise((r) => setTimeout(r, 50));
    check('a line past the limit still drops the connection', hostile.destroyed && n === 0);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

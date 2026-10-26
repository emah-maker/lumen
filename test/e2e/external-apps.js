// Other apps using Lumen, in the real app (Settings → AI and agents → "Let other apps use Lumen"). A fake MCP client in Node stands in for Claude
// Desktop, Cursor and the rest (no real external app is started, and nothing outside the temp profile is touched):
//   - off by default; the switch, the status line and the per-app setup tabs in the Settings page
//   - Add app: the token is encrypted on disk and kept in a user-only file; the setup text names that file and holds no secret
//   - unknown / wrong token refused; the right one connects
//   - an app without a token: refused when tokens are required (the default from this page); else asked as an unverified app, per session
//   - the name-claim attack, a replayed proof, two apps at once, and the environment of a Lumen the bridge starts
//   - the toolbar pill "<app> is working" with Stop and Take over; Stop cuts it off, Take over pauses it, Resume lets it on
//   - a quiet "<app> finished in Lumen" after a run
//   - Revoke (in Settings) closes its connection at once and refuses the token afterwards
//   - Lumen's own engine sessions are not asked about
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('../helpers/settings-tab');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mcp = require('../../src/automation/mcp');
const clientToken = require('../../src/automation/client-token');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-lumen-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const errors = [];
  try {
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await sleep(500);
    await app.evaluate(() => { global.__externalStrict = true; }); // (no test-only open door for token-less sessions)
    const info = () => app.evaluate(() => global.__externalApps.info());

    // ---- a fake MCP client, the way the bridge connects (shared token proof, then the app's own)
    const connect = (appToken, { engine } = {}) => new Promise((resolve) => {
      const sharedToken = fs.readFileSync(mcp.tokenPath(profile), 'utf8').trim();
      const socket = net.connect(mcp.channelPath(profile));
      let authed = null; let buffer = ''; let closed = false;
      const waiting = new Map();
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('close', () => { closed = true; resolve({ authed: authed || 'closed', isClosed: () => true }); for (const w of waiting.values()) w({ closed: true }); });
      socket.on('data', (d) => {
        buffer += d; let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
          if (msg.lumenChallenge) socket.write(`${JSON.stringify({ lumenProof: mcp.proofFor(sharedToken, msg.lumenChallenge), lumenEngine: engine, ...clientToken.hello(appToken, msg.lumenChallenge) })}\n`);
          else if (msg.lumenAuth) {
            authed = msg.lumenAuth;
            if (authed === 'ok') resolve({ authed, isClosed: () => closed, end: () => socket.destroy(), request: (method, params) => new Promise((res) => { const id = Math.random(); waiting.set(id, res); socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }) });
          } else { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
        }
      });
    });
    const init = (c, name) => c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name } });
    const wait = (c, seconds) => c.request('tools/call', { name: 'wait', arguments: { seconds } });
    const textOf = (r) => (r.result?.content || []).map((x) => x.text).join(' ');
    const pills = () => ui.$$eval('#external-pills .external-pill', (els) => els.map((e) => ({ text: e.querySelector('.external-pill-text')?.textContent, buttons: [...e.querySelectorAll('button')].map((b) => b.textContent.replace(/^[^A-Za-z]+/, '')) })));

    // ---- Settings page: off by default
    const fresh = await info();
    check('off by default: the master switch is off, no apps, nothing asked', fresh.enabled === false && fresh.apps.length === 0 && fresh.requireToken === false, JSON.stringify(fresh));
    const inSettings = await openSettingsTab(app, 'external-apps');
    check('the Settings section exists, titled "Let other apps use Lumen"', await waitFor(() => inSettings("document.querySelector('#sub-external-apps .pane-title')?.textContent === 'Let other apps use Lumen'")), 'no title');
    await waitFor(() => inSettings("document.querySelector('#ea-status')?.textContent !== ''"));
    check('status says Off', (await inSettings("document.querySelector('#ea-status').textContent")) === 'Off', await inSettings("document.querySelector('#ea-status').textContent"));
    const offHello = await connect(undefined);
    const offInit = offHello.authed === 'ok' ? await init(offHello, 'Anything') : null;
    check('while off, a connecting app is told connections are off', offHello.authed === 'ok' && /turned off/.test(offInit?.error?.message || ''), JSON.stringify(offInit));
    offHello.end?.();

    // ---- the four setup tabs, and the text each shows
    const tabs = await inSettings("[...document.querySelectorAll('#ea-setup [role=tab]')].map((b) => b.textContent)");
    check('tabs for Claude Desktop, Cursor, VS Code and Claude Code', JSON.stringify(tabs) === JSON.stringify(['Claude Desktop', 'Cursor', 'VS Code', 'Claude Code']), JSON.stringify(tabs));
    const snippetOf = async (label) => { await inSettings(`[...document.querySelectorAll('#ea-setup [role=tab]')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`); return inSettings("document.querySelector('#ea-snippet').textContent"); };
    const cd = await snippetOf('Claude Desktop');
    let cdJson = null; try { cdJson = JSON.parse(cd); } catch {}
    check('Claude Desktop: the text is JSON with the bridge command and a token FILE placeholder (never a secret)', cdJson?.mcpServers?.lumen?.command && cdJson.mcpServers.lumen.args[0].endsWith('mcp.js') && /PATH-OF-THE-TOKEN-FILE/.test(cdJson.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN_FILE), cd);
    const cu = JSON.parse(await snippetOf('Cursor'));
    const vs = JSON.parse(await snippetOf('VS Code'));
    check('Cursor and VS Code: JSON in their own shapes (mcpServers / servers)', cu.mcpServers?.lumen?.command && vs.servers?.lumen?.type === 'stdio', JSON.stringify([cu, vs]).slice(0, 200));
    await snippetOf('Cursor');
    check('...as a warning on the page', /Don’t commit this file/.test(await inSettings("document.querySelector('#ea-config-warning')?.textContent || ''")), await inSettings("document.querySelector('#ea-config-warning')?.textContent"));
    const cc = await snippetOf('Claude Code');
    check('Claude Code: a `claude mcp add` command', /^claude(\.cmd)? mcp add lumen --scope user /.test(cc), cc);
    check('"Open the config file" is offered where the path is standard (not for Claude Code)', (await inSettings("!document.querySelector('#ea-open')")) === true);
    await snippetOf('Claude Desktop');
    const open = await inSettings("window.lumenSettings.ai.externalApps.openConfig('claude-desktop')");
    check('...and in tests it only names the path, never opens the real file', open.ok && open.test === true && /claude_desktop_config\.json$/.test(open.path), JSON.stringify(open));

    // ---- turn it on
    await inSettings("document.querySelector('#ea-switch').click()");
    check('the switch turns it on, and requires a token for every app (a new user)', await waitFor(async () => { const i = await info(); return i.enabled && i.requireToken; }), JSON.stringify(await info()));
    check('status says On · no apps connected', await waitFor(async () => /On · no apps connected/.test(await inSettings("document.querySelector('#ea-status').textContent"))), await inSettings("document.querySelector('#ea-status').textContent"));

    const bare = await connect(undefined);
    const bareInit = await init(bare, 'Some Agent');
    check('a token-less client is refused (a token is required), with the reason, and no prompt', /needs a token/.test(bareInit.error?.message || '') && (await app.evaluate(() => global.__externalApps.ext.state().prompts.length)) === 0, JSON.stringify(bareInit));
    const bareSkip = await wait(await connect(undefined), 1);
    check('...also when it skips the start', bareSkip.result?.isError === true && /needs a token/.test(textOf(bareSkip)), JSON.stringify(bareSkip));

    // ---- Add app
    await inSettings("(() => { const n = document.querySelector('#ea-name'); n.value = 'Fake App'; document.querySelector('#ea-add').click(); })()");
    check('Add app shows a note, not a token', await waitFor(() => inSettings("Boolean(document.querySelector('#ea-fresh'))")), 'no note');
    const shown = await inSettings("document.querySelector('#ea-snippet').textContent");
    const appId = (await info()).apps[0].id;
    const tokenFile = await app.evaluate((_e, id) => global.__externalApps.tokenFile(id), appId);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const shownJson = JSON.parse(shown);
    check('the setup text names the token file and holds no secret', shownJson.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN_FILE === tokenFile && /^lmn_[a-f0-9]{12}_[a-f0-9]{48}$/.test(token) && !shown.includes(token), shown);
    const disk = fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8');
    check('the token is encrypted in external-apps.json, and in no settings file', !disk.includes(token) && !disk.includes(token.split('_')[2]) && JSON.parse(disk).apps[0].secret.length > 40 && !fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(token), disk.slice(0, 200));
    check('the token file is where Lumen keeps it, for this user only', tokenFile.startsWith(path.join(profile, 'external-app-tokens')) && (process.platform === 'win32' ? !/Everyone|BUILTIN\\Users|Authenticated Users/i.test(require('child_process').execFileSync('icacls', [tokenFile], { encoding: 'utf8' })) : (fs.statSync(tokenFile).mode & 0o077) === 0));
    check('a new app asks before it acts by default', (await info()).apps[0].ask === true && (await inSettings("document.querySelector('.ea-app input[type=checkbox]').checked")) === true);
    const pageText = await inSettings("document.body.innerText + document.querySelector('#ea-snippet').textContent");
    check('the token is shown nowhere on the page', !pageText.includes(token) && !pageText.includes(token.split('_')[2]));
    check('the app is listed', (await inSettings("document.querySelector('.ea-app')?.dataset.app")) === 'Fake App');

    // ---- doors
    const unknown = await connect(clientToken.make().token);
    check('an unknown token is refused', unknown.authed === 'denied', unknown.authed);
    const wrong = await connect(`lmn_${(await info()).apps[0].id}_${'1'.repeat(48)}`);
    check('a known app with the wrong secret is refused', wrong.authed === 'denied', wrong.authed);
    const good = await connect(token);
    check('the right token connects', good.authed === 'ok', good.authed);
    const initRes = await init(good, 'claude-ai');
    check('it starts, and Lumen calls it by the name you gave it', initRes.result?.serverInfo?.name === 'lumen' && (await info()).apps[0].connected === 1, JSON.stringify(initRes));
    check('status follows: On · 1 app connected', await waitFor(async () => /On · 1 app connected/.test(await inSettings("document.querySelector('#ea-status').textContent")), 8000), await inSettings("document.querySelector('#ea-status').textContent"));

    // ---- the pill, Take over, Resume, Stop
    check('no pill while it is idle', (await pills()).length === 0);
    const longCall = wait(good, 8);
    check('the pill says "Fake App is working", with Stop and Take over', await waitFor(async () => { const p = await pills(); return p[0]?.text === 'Fake App is working' && p[0].buttons.join() === 'Take over,Stop'; }), JSON.stringify(await pills()));
    await ui.click('#external-pills .external-takeover');
    check('Take over pauses it: the pill says paused, with Resume', await waitFor(async () => { const p = await pills(); return p[0]?.text === "Paused: you're in control" && p[0].buttons.includes('Resume'); }), JSON.stringify(await pills()));
    const cut = await longCall;
    check('the call in flight ends, saying it was stopped', cut.result?.isError === true && /Stopped by the user/.test(textOf(cut)), JSON.stringify(cut));
    const refused = await wait(good, 1);
    check('a call while paused is refused, with the reason', refused.result?.isError === true && /took over/.test(textOf(refused)), JSON.stringify(refused));
    check('its connection stays open while paused', !good.isClosed());
    await ui.click('#external-pills .external-resume');
    check('Resume lets it on again', await waitFor(async () => (await pills()).length === 0));
    check('...and a short toast says it resumed', await waitFor(async () => /Resumed: Fake App is working again/.test(await ui.$eval('.external-toast', (e) => e.textContent).catch(() => '')), 4000), 'no toast');
    const resumed = await wait(good, 1);
    check('a call after Resume runs', resumed.result?.isError === false && /Done waiting/.test(textOf(resumed)), JSON.stringify(resumed));
    check('a quiet "Fake App finished in Lumen" follows the run', await waitFor(async () => (await app.evaluate(() => global.__externalApps.notes)).some((n) => n.body === 'Fake App finished in Lumen'), 12000), JSON.stringify(await app.evaluate(() => global.__externalApps.notes)));
    const long2 = wait(good, 8);
    await waitFor(async () => (await pills()).length === 1);
    await ui.click('#external-pills .external-stop');
    await long2;
    check('Stop cuts it off: the connection closes and the pill goes', await waitFor(async () => good.isClosed() && (await pills()).length === 0), JSON.stringify(await pills()));
    const back = await connect(token);
    check('it is still approved after Stop: it can connect again', back.authed === 'ok', back.authed);
    await init(back, 'claude-ai');

    // ---- an app without a token: unverified, asked one by one, per session
    check('the page warns nothing while tokens are required', (await inSettings("document.querySelector('#ea-warning').hidden")) === true);
    await inSettings("document.querySelector('#ea-require').click()");
    check('turning "Require a token" off is saved, and the page warns', await waitFor(async () => (await info()).requireToken === false && (await inSettings("!document.querySelector('#ea-warning').hidden && /any program on this computer/.test(document.querySelector('#ea-warning').textContent) && !document.querySelector('#ea-require-now').hidden"))), JSON.stringify(await info()));
    const legacy = await connect(undefined);
    const li = await init(legacy, 'Legacy App'); // (answered at once: the handshake never waits for the pill)
    const legacyCall = wait(legacy, 6); // (the first tool call is what waits for the user's Allow)
    check('the toolbar pill says "“Legacy App” wants to use Lumen (unverified)" with Allow this time, Always allow and Deny, and its title has the whole warning', await waitFor(async () => { const t = await ui.$eval('#external-bar', (e) => (e.hidden ? '' : e.innerText + '\n' + e.title)).catch(() => ''); return /“Legacy App” wants to use Lumen \(unverified\)/.test(t) && /Unverified app “Legacy App” wants to use Lumen\. It has no token/.test(t) && /Allow this time/.test(t) && /Always allow/.test(t) && /Deny/.test(t); }), await ui.$eval('#external-bar', (e) => e.innerText));
    check('an OS notification names it as unverified', (await app.evaluate(() => global.__externalApps.notes)).some((n) => /Unverified app “Legacy App” wants to use Lumen/.test(n.body)));
    await ui.click('#external-bar button.primary');
    check('the handshake was answered before any Allow, and Allow lets the call run; the bar goes', li.result?.serverInfo?.name === 'lumen' && (await waitFor(() => ui.$eval('#external-bar', (e) => e.hidden))), JSON.stringify(li));
    check('it shows a pill like any app, and the list says unverified and always asks before it acts', await waitFor(async () => (await pills()).some((p) => p.text === 'Legacy App is working') && /Unverified/.test(await inSettings("document.querySelector('.ea-app[data-app=\"Legacy App\"]')?.textContent || ''")) && (await app.evaluate(() => global.__externalApps.ext.list().find((a) => a.name === 'Legacy App')?.ask)) === true, 10000), JSON.stringify(await pills()));
    await ui.click('#external-pills .external-stop');
    await legacyCall;
    check('Allow is not remembered: nothing about it is on disk', !fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8').includes('Legacy App'));
    // the name-claim attack: same name again, then a token app's name, then a built-in app's
    const second = await connect(undefined);
    await init(second, 'Legacy App');
    const secondInit = wait(second, 1);
    check('a second client with the same name is asked again (never let in by name)', await waitFor(async () => /Legacy App/.test(await ui.$eval('#external-bar', (e) => (e.hidden ? '' : e.innerText)).catch(() => ''))));
    await ui.click('#external-bar button:last-child');
    const secondDone = await secondInit;
    check('Deny refuses its call, with the reason', secondDone.result?.isError === true && /not allowed/.test(textOf(secondDone)), JSON.stringify(secondDone));
    const allowNamed = async (clientName, label) => {
      const c = await connect(undefined);
      await init(c, clientName);
      const pending = wait(c, 1);
      const shown = await waitFor(async () => (await app.evaluate(() => global.__externalApps.ext.state().prompts)).some((p) => p.name === label));
      const id = (await app.evaluate(() => global.__externalApps.ext.state().prompts)).find((p) => p.name === label)?.id;
      if (id) await app.evaluate((_, i) => global.__externalApps.ext.answer(i, 'allow'), id);
      return { shown, done: await pending };
    };
    const asFake = await allowNamed('Fake App', 'Fake App (no token)');
    check('name claim: a token-less client calling itself "Fake App" (a token app) is asked about as "Fake App (no token)" and connects without the app token', asFake.shown && asFake.done.result?.isError === false, JSON.stringify(asFake));
    const asClaude = await allowNamed('claude-code', 'Claude Code (no token)');
    check('name claim: "claude-code" (the real Claude Code, a built-in app) connects as "Claude Code (no token)" after Allow, never refused', asClaude.shown && asClaude.done.result?.isError === false, JSON.stringify(asClaude));
    // "Always allow": remembered by name (on disk, revocable), and a reconnect is not asked again
    const alwaysC = await connect(undefined);
    await init(alwaysC, 'Always App');
    const alwaysCall = wait(alwaysC, 1);
    check('the pill offers Always allow, and choosing it lets the call run', await waitFor(async () => /Always App/.test(await ui.$eval('#external-bar', (e) => (e.hidden ? '' : e.innerText)).catch(() => ''))), 'no pill');
    await ui.click('#external-bar button:nth-last-child(2)');
    check('...the entry is kept as an unverified, remembered client, on disk', (await alwaysCall).result?.isError === false && (await app.evaluate(() => global.__externalApps.ext.list().some((a) => a.name === 'Always App' && a.kind === 'remembered' && a.unverified))) && fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8').includes('Always App'));
    alwaysC.end();
    const alwaysAgain = await connect(undefined);
    await init(alwaysAgain, 'Always App');
    const againRes = await wait(alwaysAgain, 1);
    check('a reconnect runs its first call with no question', againRes.result?.isError === false && (await app.evaluate(() => global.__externalApps.ext.state().prompts.length)) === 0, JSON.stringify(againRes));
    const alwaysId = await app.evaluate(() => global.__externalApps.ext.list().find((a) => a.name === 'Always App').id);
    await app.evaluate((_, id) => global.__externalApps.ext.revoke(id), alwaysId);
    alwaysAgain.end();
    const skipper = await connect(undefined);
    const skipped = await wait(skipper, 1);
    check('an app that skips the start gets no tools', skipped.result?.isError === true && /not been allowed/.test(textOf(skipped)), JSON.stringify(skipped));
    const eng = await connect(undefined, { engine: 'not-a-live-run' });
    const engInit = await init(eng, 'x');
    check('a made-up engine tag is refused (Lumen only serves a live run of its own), and asks nothing', eng.authed === 'ok' && /turned off/.test(engInit?.error?.message || '') && (await app.evaluate(() => global.__externalApps.ext.state().prompts.length)) === 0, JSON.stringify(engInit));

    // ---- replay over the real channel
    const rawChallenge = () => new Promise((resolve) => {
      const shared = fs.readFileSync(mcp.tokenPath(profile), 'utf8').trim();
      const sock = net.connect(mcp.channelPath(profile)); let buf = '';
      sock.setEncoding('utf8'); sock.on('error', () => {});
      sock.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i < 0) return; const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.lumenChallenge) resolve({ sock, nonce: m.lumenChallenge, shared }); else if (m.lumenAuth) sock.emit('verdict', m.lumenAuth); });
    });
    const c1 = await rawChallenge();
    const hello1 = clientToken.hello(token, c1.nonce);
    c1.sock.write(JSON.stringify({ lumenProof: mcp.proofFor(c1.shared, c1.nonce), ...hello1 }) + '\n');
    const v1 = await new Promise((r) => { c1.sock.once('verdict', r); setTimeout(() => r('none'), 3000); });
    c1.sock.destroy();
    const c2 = await rawChallenge();
    c2.sock.write(JSON.stringify({ lumenProof: mcp.proofFor(c2.shared, c2.nonce), ...hello1 }) + '\n'); // the recorded proof, on a new connection
    const v2 = await new Promise((r) => { c2.sock.once('verdict', r); setTimeout(() => r('none'), 3000); });
    c2.sock.destroy();
    check('replay: the first connection is accepted, the same proof on a second is denied', v1 === 'ok' && v2 === 'denied', v1 + ' / ' + v2);

    // ---- two apps at once: Stop on one leaves the other running
    await inSettings("document.querySelector('#ea-done')?.click()");
    await inSettings("(() => { const n = document.querySelector('#ea-name'); n.value = 'Second App'; document.querySelector('#ea-add').click(); })()");
    await waitFor(async () => (await info()).apps.some((a) => a.name === 'Second App'));
    const second2 = (await info()).apps.find((a) => a.name === 'Second App');
    const token2 = fs.readFileSync(await app.evaluate((_e, id) => global.__externalApps.tokenFile(id), second2.id), 'utf8').trim();
    const t1 = await connect(token); const t2 = await connect(token2);
    await init(t1, 'x'); await init(t2, 'y');
    const w1 = wait(t1, 8); const w2 = wait(t2, 3);
    await waitFor(async () => (await pills()).length === 2);
    await app.evaluate((_e, id) => global.__externalApps.ext.stop(id), appId);
    await w1;
    const w2r = await w2;
    check('Stop on one app closes it, while the other app\'s call runs to its end', t1.isClosed() && !t2.isClosed() && w2r.result?.isError === false && /Done waiting/.test(textOf(w2r)), JSON.stringify(w2r));
    t2.end?.();

    // ---- the environment of a Lumen the bridge has to start
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-launch-'));
    const out = path.join(dir, 'env.json'); const dump = path.join(dir, 'dump.js');
    fs.writeFileSync(dump, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env))); process.exit(0);`);
    const electronExe = require('electron');
    const bridge = require('child_process').spawn(electronExe, [path.join(__dirname, '..', '..', 'mcp.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LUMEN_MCP_BRIDGE: '1', CLAUDE_BROWSER_TEST: '1', LUMEN_USERDATA: dir, LUMEN_LAUNCH: JSON.stringify({ command: electronExe, args: [dump] }), LUMEN_CLIENT_TOKEN: token, LUMEN_CLIENT_TOKEN_FILE: tokenFile, LUMEN_ENGINE: 'some-tag', LUMEN_TEST_BACKGROUND: '1' }, stdio: 'ignore' });
    const keys = await waitFor(() => (fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null), 40000);
    try { bridge.kill(); } catch {}
    check('the Lumen a bridge starts has no LUMEN_CLIENT_TOKEN, LUMEN_CLIENT_TOKEN_FILE, LUMEN_ENGINE, LUMEN_TEST_* or CLAUDE_BROWSER_TEST in its environment', Array.isArray(keys) && keys.length > 3 && !keys.some((k) => /^(LUMEN_(CLIENT_TOKEN|ENGINE|TEST_)|CLAUDE_BROWSER_TEST)/.test(k)), JSON.stringify(keys));

    // ---- an older, unmanaged agent is still asked, and an empty token is refused (not treated as "no token")
    const emptyHello = clientToken.hello('', 'n');
    check('an empty token is invalid, not "no token"', emptyHello.lumenClient === 'invalid');

    // ---- Revoke
    await inSettings("document.querySelector('.ea-app[data-app=\"Fake App\"] .confirm-delete button').click()");
    await inSettings("document.querySelector('.ea-app[data-app=\"Fake App\"] .confirm-delete button').click()");
    check('Revoke closes its connection at once', await waitFor(() => back.isClosed(), 5000));
    const gone = await connect(token);
    check('...and its token is refused from then on', gone.authed === 'denied', gone.authed);
    check('...and its token file is deleted', !fs.existsSync(tokenFile));
    check('...and the list no longer has it', !(await info()).apps.some((a) => a.name === 'Fake App') && !fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8').includes('"Fake App"'));

    // ---- off again
    const live2 = await connect(token2); await init(live2, 'z');
    await inSettings("document.querySelector('#ea-switch').click()");
    check('switching it off cuts every connection', await waitFor(() => live2.isClosed(), 5000));
    check('no page errors in Lumen\'s window', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

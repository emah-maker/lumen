// Other apps using Lumen, in the real app (Settings > AI > "Let other apps use Lumen"). A fake MCP client in Node stands in for Claude
// Desktop, Cursor and the rest (no real external app is started, and nothing outside the temp profile is touched):
//   - off by default; the switch, the status line and the per-app setup tabs in the Settings page
//   - Add app: a token shown once, encrypted on disk; the setup text holds it only until the note is dismissed
//   - unknown / wrong token refused; the right one connects
//   - an app without a token: asked in the window (Allow / Deny), as before when asking is off
//   - the toolbar pill "<app> is using Lumen" with Stop and Take over; Stop cuts it off, Take over pauses it, Resume lets it on
//   - a quiet "<app> finished in Lumen" after a run
//   - Revoke (in Settings) closes its connection at once and refuses the token afterwards
//   - Lumen's own engine sessions are not asked about
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mcp = require('../src/automation/mcp');
const clientToken = require('../src/automation/client-token');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-lumen-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const errors = [];
  try {
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await sleep(500);
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
    const pills = () => ui.$$eval('#external-pills .external-pill', (els) => els.map((e) => ({ text: e.querySelector('.external-pill-text')?.textContent, buttons: [...e.querySelectorAll('button')].map((b) => b.textContent) })));

    // ---- Settings page: off by default
    const fresh = await info();
    check('off by default: the master switch is off, no apps, nothing asked', fresh.enabled === false && fresh.apps.length === 0 && fresh.prompt === false, JSON.stringify(fresh));
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
    check('Claude Desktop: the text is JSON with the bridge command and a token placeholder', cdJson?.mcpServers?.lumen?.command && cdJson.mcpServers.lumen.args[0].endsWith('mcp.js') && /PASTE/.test(cdJson.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN), cd);
    const cu = JSON.parse(await snippetOf('Cursor'));
    const vs = JSON.parse(await snippetOf('VS Code'));
    check('Cursor and VS Code: JSON in their own shapes (mcpServers / servers)', cu.mcpServers?.lumen?.command && vs.servers?.lumen?.type === 'stdio', JSON.stringify([cu, vs]).slice(0, 200));
    const cc = await snippetOf('Claude Code');
    check('Claude Code: a `claude mcp add` command', /^claude(\.cmd)? mcp add lumen --scope user /.test(cc), cc);
    check('"Open the config file" is offered where the path is standard (not for Claude Code)', (await inSettings("!document.querySelector('#ea-open')")) === true);
    await snippetOf('Claude Desktop');
    const open = await inSettings("window.lumenSettings.ai.externalApps.openConfig('claude-desktop')");
    check('...and in tests it only names the path, never opens the real file', open.ok && open.test === true && /claude_desktop_config\.json$/.test(open.path), JSON.stringify(open));

    // ---- turn it on
    await inSettings("document.querySelector('#ea-switch').click()");
    check('the switch turns it on (and asking about unknown apps with it)', await waitFor(async () => { const i = await info(); return i.enabled && i.prompt; }), JSON.stringify(await info()));
    check('status says On · no apps connected', await waitFor(async () => /On · no apps connected/.test(await inSettings("document.querySelector('#ea-status').textContent"))), await inSettings("document.querySelector('#ea-status').textContent"));

    // ---- Add app
    await inSettings("(() => { const n = document.querySelector('#ea-name'); n.value = 'Fake App'; document.querySelector('#ea-add').click(); })()");
    check('Add app shows the token note', await waitFor(() => inSettings("Boolean(document.querySelector('#ea-fresh'))")), 'no note');
    const shown = await inSettings("document.querySelector('#ea-snippet').textContent");
    const token = (shown.match(/lmn_[a-f0-9]{12}_[a-f0-9]{48}/) || [])[0];
    check('the text now holds the token, and its Copy button copies the same text', Boolean(token) && (await inSettings("document.querySelector('.ea-copy') !== null")), shown);
    const disk = fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8');
    check('the token is encrypted on disk (not in external-apps.json, nor in settings)', !disk.includes(token) && !disk.includes(token.split('_')[2]) && JSON.parse(disk).apps[0].secret.length > 40 && !fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(token), disk.slice(0, 200));
    await inSettings("document.querySelector('#ea-done').click()");
    const after = await inSettings("document.body.innerText + document.querySelector('#ea-snippet').textContent");
    check('after "I\'ve copied it" the token is shown nowhere', !after.includes(token) && /PASTE/.test(after), after.slice(0, 120));
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
    check('the pill says "Fake App is using Lumen", with Stop and Take over', await waitFor(async () => { const p = await pills(); return p[0]?.text === 'Fake App is using Lumen' && p[0].buttons.join() === 'Take over,Stop'; }), JSON.stringify(await pills()));
    await ui.click('#external-pills .external-takeover');
    check('Take over pauses it: the pill says paused, with Resume', await waitFor(async () => { const p = await pills(); return p[0]?.text === 'Fake App is paused' && p[0].buttons.includes('Resume'); }), JSON.stringify(await pills()));
    const cut = await longCall;
    check('the call in flight ends (stopped)', /Stopped/.test(textOf(cut)) || cut.result?.isError === true, JSON.stringify(cut));
    const refused = await wait(good, 1);
    check('a call while paused is refused, with the reason', refused.result?.isError === true && /took over/.test(textOf(refused)), JSON.stringify(refused));
    check('its connection stays open while paused', !good.isClosed());
    await ui.click('#external-pills .external-resume');
    check('Resume lets it on again', await waitFor(async () => (await pills()).length === 0));
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

    // ---- an app without a token: asked, or as before
    check('the "ask" setting is on, so an unmanaged app is asked', (await info()).prompt === true);
    const legacy = await connect(undefined);
    const legacyInit = init(legacy, 'Legacy App');
    check('the window shows "Legacy App wants to use Lumen" with Allow, Allow ask first and Deny', await waitFor(async () => { const t = await ui.$eval('#external-bar', (e) => (e.hidden ? '' : e.innerText)).catch(() => ''); return /Legacy App wants to use Lumen/.test(t) && /Allow/.test(t) && /Deny/.test(t); }), await ui.$eval('#external-bar', (e) => e.innerText));
    check('an OS notification names it', (await app.evaluate(() => global.__externalApps.notes)).some((n) => /Legacy App wants to use Lumen/.test(n.body)));
    await ui.click('#external-bar button.primary');
    const li = await legacyInit;
    check('Allow lets it start; the bar goes', li.result?.serverInfo?.name === 'lumen' && (await waitFor(() => ui.$eval('#external-bar', (e) => e.hidden))), JSON.stringify(li));
    const denied = await connect(undefined);
    const deniedInit = init(denied, 'Bad App');
    await waitFor(async () => /Bad App wants/.test(await ui.$eval('#external-bar', (e) => e.innerText).catch(() => '')));
    await ui.click('#external-bar button:last-child');
    const di = await deniedInit;
    check('Deny refuses it, with the reason', /not allowed/.test(di.error?.message || ''), JSON.stringify(di));
    const skipper = await connect(undefined);
    const skipped = await wait(skipper, 1);
    check('an app that skips the start gets no tools', skipped.result?.isError === true && /not been allowed/.test(textOf(skipped)), JSON.stringify(skipped));
    const eng = await connect(undefined, { engine: 'not-a-live-run' });
    const engInit = await init(eng, 'x');
    check('Lumen\'s own sessions are not asked about (a stale tag is refused as before)', eng.authed === 'ok' && /turned off|./.test(engInit?.error?.message || 'x') && (await app.evaluate(() => global.__externalApps.ext.state().prompts.length)) === 0, JSON.stringify(engInit));

    // ---- asking off: an unmanaged app connects as it always did
    await inSettings("document.querySelector('#ea-prompt').click()");
    check('turning "ask" off is saved', await waitFor(async () => (await info()).prompt === false));
    const plain = await connect(undefined);
    const plainInit = await init(plain, 'Older Agent');
    const plainCall = await wait(plain, 1);
    check('an older, unmanaged agent connects and works as before', plainInit.result?.serverInfo?.name === 'lumen' && plainCall.result?.isError === false, JSON.stringify([plainInit, plainCall]).slice(0, 300));
    plain.end?.();

    // ---- Revoke
    await inSettings("document.querySelector('.ea-app[data-app=\"Fake App\"] .confirm-delete button').click()");
    await inSettings("document.querySelector('.ea-app[data-app=\"Fake App\"] .confirm-delete button').click()");
    check('Revoke closes its connection at once', await waitFor(() => back.isClosed(), 5000));
    const gone = await connect(token);
    check('...and its token is refused from then on', gone.authed === 'denied', gone.authed);
    check('...and the list no longer has it', !(await info()).apps.some((a) => a.name === 'Fake App') && !fs.readFileSync(path.join(profile, 'external-apps.json'), 'utf8').includes('"Fake App"'));

    // ---- off again
    await inSettings("document.querySelector('#ea-switch').click()");
    check('switching it off cuts every connection', await waitFor(() => legacy.isClosed(), 5000));
    check('no page errors in Lumen\'s window', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

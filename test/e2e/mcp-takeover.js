// The user can always take over an outside agent's window (features/agent-windows.js, main.js "agent windows").
// An agent (MCP) opens a page that needs a person (a sign-in code); the user must be able to click and type in that
// page, and the agent must be told plainly, on its next call to that tab, that the user took over (never fight them).
// Real app on a temp profile with a fake MCP client, as test/e2e/mcp-window.js. Everything runs hidden.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const root = path.join(__dirname, '..', '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-takeover-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_AGENT_WINDOW_GRACE_MS: '1500', LUMEN_AGENT_HOLD_MS: '1500', ANTHROPIC_API_KEY: 'sk-ant-test' };

  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/dl/')) { res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="${req.url.slice(4).split('?')[0]}"`); res.end('agent file'); return; } // a download
    const name = (req.url || '/').replace(/^\//, '').split('?')[0].toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body style="margin:0"><h1>PAGE-${name}</h1><input id="code" aria-label="code ${name}" style="position:absolute;left:40px;top:120px;width:300px;height:40px"><button id="b" style="position:absolute;left:40px;top:200px;width:200px;height:40px" onclick="document.title='clicked ${name}'">Press ${name}</button></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({ args: [root], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await ui.waitForTimeout(500);
  await ui.evaluate(() => window.assistant.setMcpEnabled(true));
  await app.evaluate(() => { global.__settings.backend.set('agentsNoAsk', true); global.__externalStrict = true; }); // (the agent is a known app, as for a real user: it has a pill with Take over / Resume)

  const connect = async (title) => {
    const bridge = spawn(require('electron'), [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const waiting = new Map();
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    });
    let nextId = 1;
    const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, resolve);
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
    });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: title.toLowerCase().replace(/\W+/g, '-'), title, version: '1.0' } });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await request('tools/list', {});
    const text = (r) => (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { bridge, call: (name, args = {}) => request('tools/call', { name, arguments: args }), text, end: () => bridge.stdin.end() };
  };

  // An unverified app asks before it acts: the user's Allow, as in mcp-window.js.
  let approving = true;
  const approver = (async () => {
    while (approving) {
      for (const p of app.windows()) await p.evaluate(() => { const b = document.querySelector('.approval:not(.resolved):not(.answered) .btn.primary'); if (b) b.click(); }).catch(() => {});
      await sleep(150);
    }
  })();
  const windows = () => app.evaluate(() => global.__windows.list());
  const agentWins = async () => (await windows()).filter((w) => w.agent);
  const agentUi = async () => { for (const p of app.windows()) if (await p.evaluate(() => document.body.classList.contains('agent-window')).catch(() => false)) return p; return null; };
  const pageEval = (contentsId, code) => app.evaluate(({ webContents }, { id, c }) => webContents.fromId(id).executeJavaScript(c), { id: contentsId, c: code });

  const A = await connect('Claude Code');
  const first = A.call('navigate', { url: `${base}/signin` });
  const prompt = await waitFor(async () => (await app.evaluate(() => global.__externalApps.ext.state().prompts))[0]);
  await app.evaluate((_e, id) => global.__externalApps.answer(id, 'allow'), prompt?.id);
  let r = await first;
  check('the agent opened its window on the sign-in page', !r.result.isError && (await agentWins()).length === 1, A.text(r));
  const aw = (await agentWins())[0];
  const tab = aw.tabs[0];
  const probe = await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), tab.contentsId);
  check('the page loaded', /signin/.test(probe), probe);

  // The user takes over: they come to the window, click in the code field and type.
  const diag = await app.evaluate((_e, id) => {
    const rec = global.__agentWindows.recOf(id);
    return { used: rec.agent.used, focused: rec.win.isFocused(), minimized: rec.win.isMinimized() };
  }, aw.windowId);
  console.log('before takeover', JSON.stringify(diag));

  await app.evaluate((_e, id) => { const rec = global.__agentWindows.recOf(id); if (rec.win.isMinimized()) rec.win.restore(); rec.win.focus(); }, aw.windowId);
  await sleep(300);
  const click = (x, y) => app.evaluate(({ webContents }, { id, x, y }) => {
    const wc = webContents.fromId(id);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }, { id: tab.contentsId, x, y });
  const typeKeys = async (word) => {
    for (const ch of word) {
      await app.evaluate(({ webContents }, { id, c }) => { const wc = webContents.fromId(id); wc.sendInputEvent({ type: 'keyDown', keyCode: c }); wc.sendInputEvent({ type: 'char', keyCode: c }); wc.sendInputEvent({ type: 'keyUp', keyCode: c }); }, { id: tab.contentsId, c: ch });
      await sleep(25);
    }
  };
  await click(100, 140);
  await sleep(200);
  await typeKeys('123456');
  await sleep(300);
  const field = await pageEval(tab.contentsId, '({ value: document.getElementById("code").value, active: document.activeElement.id })');
  check('the user\'s click focused the field and their typing reached the page', field.value === '123456' && field.active === 'code', JSON.stringify(field));
  const after = await app.evaluate((_e, id) => { const rec = global.__agentWindows.recOf(id); return { used: rec.agent?.used, focused: rec.win.isFocused() }; }, aw.windowId);
  check('the window is marked as used by the user', after.used === true, JSON.stringify(after));

  // The agent's next call to that tab is told the user took over.
  r = await A.call('read_page', { tab_id: tab.id });
  console.log('read_page after takeover:', A.text(r).slice(0, 300));
  r = await A.call('type_text', { text: '999999', element_id: 1, tab_id: tab.id });
  check('the agent typing into the tab the user took over gets a clear error', r.result.isError === true && /user took over/i.test(A.text(r)), A.text(r));
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('...and so does a click', r.result.isError === true && /user took over/i.test(A.text(r)), A.text(r));
  const still = await pageEval(tab.contentsId, 'document.getElementById("code").value');
  check('...and the user\'s code is untouched', still === '123456', still);

  // The pill in the agent's window: Take over / Resume are obvious, and Resume gives the tab back.
  const aui = await agentUi();
  const appId = (await app.evaluate(() => global.__externalApps.info())).apps[0].id;
  const pill = () => aui.evaluate(() => { const p = document.querySelector('#external-pills .external-pill'); return p ? { state: p.dataset.state, text: p.querySelector('.external-pill-text').textContent, main: [...p.querySelectorAll('button')].map((b) => b.textContent.replace(/^[^A-Za-z]+/, '')), chip: document.getElementById('agent-window-chip').textContent } : null; });
  const working = A.call('wait', { seconds: 6 });
  check('while the agent works its pill says so, with Take over', await waitFor(async () => { const p = await pill(); return p && p.state === 'working' && /is working/.test(p.text) && p.main[0] === 'Take over'; }), JSON.stringify(await pill()));
  await aui.click('#external-pills .external-takeover');
  check('Take over: the pill and the window badge say you are in control, the button becomes Resume', await waitFor(async () => { const p = await pill(); return p && p.state === 'paused' && p.text === "Paused: you're in control" && p.main[0] === 'Resume' && p.chip === "Paused: you're in control"; }), JSON.stringify(await pill()));
  await working;
  r = await A.call('read_page');
  check('while paused the agent is refused, saying the user took over', r.result.isError === true && /took over/.test(A.text(r)), A.text(r));
  // (paused: the user can type, e.g. a password; the agent cannot)
  await click(100, 140); await typeKeys('7');
  check('while paused the user can still type in the page', (await pageEval(tab.contentsId, 'document.getElementById("code").value')) === '1234567', await pageEval(tab.contentsId, 'document.getElementById("code").value'));
  await aui.click('#external-pills .external-resume');
  check('Resume: a toast says so, the paused look goes', await waitFor(async () => /Resumed: .* is working again/.test(await aui.$eval('.external-toast', (e) => e.textContent).catch(() => '')) && !(await aui.evaluate(() => document.body.classList.contains('external-paused'))) && (await aui.evaluate(() => document.getElementById('agent-window-chip').textContent)) === (await aui.evaluate(() => document.getElementById('agent-window-chip').dataset.base)), 4000), await aui.evaluate(() => document.getElementById('agent-window-chip').textContent));
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('after Resume the tab is the agent tab again', !r.result.isError, A.text(r));

  // The agent's own click can reach a page late (a window behind others or minimized): input in an agent window the user is not in
  // is never theirs, so it cannot lock the agent out of its own tab.
  const user0 = (await windows()).find((w) => !w.agent);
  const leave = () => app.evaluate((_e, id) => { const rec = global.__agentWindows.recOf(id); rec.win.blur(); }, aw.windowId);
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.focus(); }, user0.windowId);
  await leave();
  await sleep(200);
  check('the agent window is not focused now', !(await app.evaluate((_e, id) => global.__agentWindows.recOf(id).win.isFocused(), aw.windowId)));
  await click(100, 140);
  await sleep(200);
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('a click in the page while the user is not in the window does not take the tab from the agent', !r.result.isError, A.text(r));

  // The user takes the tab over again, then leaves the window: a little after their last input the tab is the agent's again.
  await app.evaluate((_e, id) => { const rec = global.__agentWindows.recOf(id); rec.win.focus(); }, aw.windowId);
  await sleep(300);
  await click(100, 140);
  await sleep(200);
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('the user clicked in it again: held', r.result.isError === true && /user took over/i.test(A.text(r)), A.text(r));
  await leave();
  await sleep(300);
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('...still held just after they leave', r.result.isError === true && /user took over/i.test(A.text(r)), A.text(r));
  await sleep(1600);
  r = await A.call('click', { text: 'Press SIGNIN', tab_id: tab.id });
  check('...and the agent\'s again once the hold has passed', !r.result.isError, A.text(r));

  // "<client> is working" in the user's own window, clicked: the agent's window comes forward, where it is working.
  const userWin = (await windows()).find((w) => !w.agent);
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.focus(); }, userWin.windowId);
  const busy = A.call('wait', { seconds: 5 });
  check('the user\'s window shows the agent working, as something to click', Boolean(await waitFor(() => ui.$('#external-pills .external-pill.external-show'), 6000)));
  await ui.click('#external-pills .external-pill-text');
  check('...and a click brings the agent\'s window forward', await waitFor(() => app.evaluate((_e, id) => global.__agentWindows.recOf(id).win.isFocused(), aw.windowId), 4000));
  await busy;

  // A new tab of its own is still the agent's to work in.
  r = await A.call('open_tab', { url: `${base}/other` });
  check('the agent can still open a new tab of its own', !r.result.isError, A.text(r));
  r = await A.call('read_page');
  check('...and read it', !r.result.isError && /PAGE-OTHER/.test(A.text(r)), A.text(r).slice(0, 300));

  // A download the agent starts waits for the user's yes, asked in the user's own window; nothing reaches the folder before.
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agent-dl-'));
  await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dlDir);
  const asked = () => app.evaluate(() => global.__dialogs.currentId());
  r = await A.call('navigate', { url: `${base}/dl/report.txt` });
  check('a download in the agent\'s window asks the user first', await waitFor(async () => (await asked()) !== null, 8000), A.text(r).slice(0, 200));
  await sleep(400);
  check('...and nothing reaches the folder while unanswered', fs.readdirSync(dlDir).length === 0, fs.readdirSync(dlDir).join(','));
  await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 1 }));
  check('after Download it is saved in the Downloads folder', await waitFor(() => fs.existsSync(path.join(dlDir, 'report.txt')) && fs.readFileSync(path.join(dlDir, 'report.txt'), 'utf8') === 'agent file', 8000), fs.readdirSync(dlDir).join(','));
  r = await A.call('navigate', { url: `${base}/dl/other.txt` });
  await waitFor(async () => (await asked()) !== null, 8000);
  await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 0 }));
  await sleep(800);
  check('after Cancel nothing is saved', !fs.existsSync(path.join(dlDir, 'other.txt')), fs.readdirSync(dlDir).join(','));

  // The user's own tabs stay out of reach (#352).
  const user = (await windows()).find((w) => !w.agent);
  r = await A.call('read_tabs', { tab_ids: [user.tabs[0].id] });
  check('the user\'s own tabs are still off limits', !/PAGE-HOME/.test(A.text(r)), A.text(r).slice(0, 200));

  // The user closes their own window while the agent still works: the agent's window stays open (and Lumen with it) until its session ends.
  const mine = (await windows()).find((w) => !w.agent);
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.close(); }, mine.windowId);
  await sleep(1000);
  check('closing the user\'s last window leaves the window of an agent still at work open', (await app.evaluate(() => global.__agentWindows.count()).catch(() => 0)) === 1);
  r = await A.call('read_page');
  check('...and the agent goes on working in it', !r.result.isError, A.text(r).slice(0, 200));
  A.end();
  // Its session ends (the grace period is 1.5 s here). The user used this window above (took a tab over), so it is theirs to keep: an ordinary
  // window now, and Lumen keeps running in it. (An unused one closes, and Lumen quits with its last window.)
  check('once the agent\'s session ends, the window the user used stays, as their own', await waitFor(async () => (await app.evaluate(() => global.__agentWindows.count())) === 0 && (await windows()).length === 1, 15000), JSON.stringify(await windows().catch(() => null)));
  // A window the user only brought up to look at (no click or key in it) is kept too: they may still be reading it, or about to type.
  const B = await connect('Claude Code'); // (a new session of the same app)
  const bFirst = B.call('navigate', { url: `${base}/home` });
  const bPrompt = await waitFor(async () => (await app.evaluate(() => global.__externalApps.ext.state().prompts))[0], 8000);
  if (bPrompt) await app.evaluate((_e, id) => global.__externalApps.answer(id, 'allow'), bPrompt.id);
  r = await bFirst;
  const bw = (await agentWins())[0];
  check('a second agent gets a window of its own', !r.result.isError && Boolean(bw), B.text(r).slice(0, 200));
  await app.evaluate((_e, id) => global.__agentWindows.recOf(id).win.emit('focus'), bw.windowId);
  B.end();
  await sleep(3000); // past the 1.5 s grace
  const bKept = (await windows()).find((w) => w.windowId === bw.windowId);
  check('once its session ends, a window the user brought up to look at stays, as their own', Boolean(bKept) && !bKept.agent, JSON.stringify(await windows()));
  approving = false;
  await approver;
  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close().catch(() => {});
  try { if (app.process().exitCode === null) app.process().kill(); } catch { /* gone */ } // (the agent window the test used stays as the user's own, so Lumen keeps running: never leave it behind)
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// An outside agent (MCP) works in a window of its own (features/agent-windows.js, main.js "agent windows").
// Real app on a temp profile, a fake MCP client (as test/mcp.js) and the sidebar's fake model (as test/tabchats.js)
// working at the same time, the user typing in their own window meanwhile:
//  - no cross-talk: the agent's tools see and act on its window's tabs only; the user's tabs and the sidebar AI's tab
//    are never listed, read, switched to, closed or clicked, whatever id the agent names
//  - the user is not disturbed: their front tab, window, sidebar, address bar focus and typed text stay as they were,
//    and no window takes focus
//  - two clients get two windows; a window ends with its session (after a grace), unless the user used it
//  - the window closes by hand and the next call makes a new one; it is not in the saved session
//  - the agent's pages are muted, ask nothing (alert/confirm/popups), and keep working while the window is minimized
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
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const root = path.join(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcpwin-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_AGENT_WINDOW_GRACE_MS: '1500', ANTHROPIC_API_KEY: 'sk-ant-test' };

  // Pages: /NAME shows PAGE-NAME with a field and a button; /dialogs asks things, opens a popup and plays nothing.
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').split('?')[0].toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    if (name === 'DIALOGS') {
      res.end('<!doctype html><title>Dialogs</title><body><h1>PAGE-DIALOGS</h1><script>alert("hello"); document.title = "confirm=" + confirm("sure?") + " prompt=" + prompt("name?"); try { window.open("/popup", "p", "width=300,height=200"); } catch {}</script></body>');
      return;
    }
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1><p>This is page ${name}.</p><input id="f" aria-label="field ${name}"><button id="b" onclick="document.title='clicked ${name}'">Press ${name}</button></body>`);
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
  await app.evaluate(({ app: electronApp }) => {
    global.__focusEvents = [];
    electronApp.on('browser-window-focus', (_e, w) => global.__focusEvents.push(w.id));
  });

  // ---- the sidebar's fake model: open a tab, read it, finish. The first step waits until the test lets it go.
  await app.evaluate(() => {
    global.__seen = null;
    let release;
    const held = new Promise((r) => { release = r; });
    global.__releaseAi = () => release();
    global.__aiStarted = false;
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const results = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
      const usage = { input_tokens: 100, output_tokens: 20 };
      const tool = (name, input) => ({
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } }; if (!results.length) { global.__aiStarted = true; await held; } },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: `tu-${results.length}`, name, input }], usage }),
      });
      if (results.length === 0) return tool('open_tab', { url: `${global.__base}/aitab` });
      if (results.length === 1) return tool('read_page', {});
      global.__seen = /PAGE-(\w+)/.exec(JSON.stringify(results.at(-1).content))?.[1] || 'none';
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'AI finished' } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'AI finished' }], usage }),
      };
    } } } });
  });
  await app.evaluate((_e, b) => { global.__base = b; }, base);

  // ---- a fake MCP client, as an agent launches it
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
    return {
      bridge,
      call: (name, args = {}) => request('tools/call', { name, arguments: args }),
      text,
      end: () => bridge.stdin.end(),
    };
  };

  // Approval cards show in the user's window; this answers them (Allow) the way the user would.
  let approving = true;
  let paused = false;
  const approver = (async () => {
    while (approving) {
      if (!paused) await ui.evaluate(() => { const b = document.querySelector('.approval:not(.resolved):not(.answered) .btn.primary'); if (b) b.click(); }).catch(() => {});
      await sleep(120);
    }
  })();

  const windows = () => app.evaluate(() => global.__windows.list());
  const agentWins = async () => (await windows()).filter((w) => w.agent);
  const userWin = async () => (await windows()).find((w) => !w.agent);
  const snapshot = async () => { const u = await userWin(); return JSON.stringify({ tabs: u.tabs.map((t) => [t.id, t.url]), active: u.activeId, current: u.current }); };
  const agentUi = async () => { for (const p of app.windows()) if (await p.evaluate(() => document.body.classList.contains('agent-window')).catch(() => false)) return p; return null; };

  // ---- the user's side: a page with a field, the omnibox with half a thought typed in it
  const userTab = (await userWin()).tabs[0];
  await app.evaluate(({ webContents }, { id, url }) => webContents.fromId(id).loadURL(url), { id: userTab.contentsId, url: `${base}/user` });
  await waitFor(async () => /user/i.test((await userWin()).tabs[0].url));
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.getElementById("f").focus()'), userTab.contentsId);
  const before = await snapshot();
  const userField = () => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('({ value: document.getElementById("f").value, active: document.activeElement.id })'), userTab.contentsId);
  const typeInUserField = async (word) => {
    for (const ch of word) {
      await app.evaluate(({ webContents }, { id, c }) => { const wc = webContents.fromId(id); wc.sendInputEvent({ type: 'keyDown', keyCode: c }); wc.sendInputEvent({ type: 'char', keyCode: c }); wc.sendInputEvent({ type: 'keyUp', keyCode: c }); }, { id: userTab.contentsId, c: ch });
      await sleep(25);
    }
  };

  // ---- 1. Nothing opens until the agent needs a tab
  const A = await connect('Claude Code');
  // Listing the tools warms the agent's window (ai-agents.js onListed), so its first navigate does not wait for one.
  check('a connected agent that listed the tools gets its window made ahead of its first call', await waitFor(async () => (await agentWins()).length === 1), JSON.stringify(await windows()));
  check('...a window never made current or focused', !(await agentWins())[0]?.current && !(await agentWins())[0]?.focused, JSON.stringify(await agentWins()));
  let r = await A.call('list_tabs');
  check('list_tabs: the warm window own (blank) tab, still one window', (await agentWins()).length === 1 && !/a1/.test(A.text(r)), A.text(r));

  // ---- 2. The sidebar AI starts working in the user's tab (held mid-run) while the agent drives
  await ui.evaluate(() => window.assistant.setAutoAllow?.(true)).catch(() => {});
  await ui.evaluate(() => window.showSidebar(false));
  await sleep(700);
  await ui.evaluate(() => window.showSidebar(true));
  await sleep(600);
  await ui.fill('#prompt', 'AI please read this');
  await ui.press('#prompt', 'Enter');
  check('the sidebar AI is working in the user\'s tab', await waitFor(() => app.evaluate(() => global.__aiStarted)), 'not started');
  await ui.evaluate(() => window.showSidebar(false)); // closed: an approval card must not pop it open
  await sleep(700);
  const sidebarHidden = () => ui.evaluate(() => document.body.classList.contains('sidebar-hidden'));
  check('sidebar closed before the agent starts', await sidebarHidden(), 'open');

  // The agent works while the user types in their own field.
  const typed = typeInUserField('hello world');
  r = await A.call('navigate', { url: `${base}/a1` });
  check('navigate works and answers with the page', !r.result.isError && /Page A1/.test(A.text(r)), JSON.stringify(r).slice(0, 300));
  let agents = await agentWins();
  check('the agent got a window of its own', agents.length === 1, JSON.stringify(agents));
  check('...titled with whose it is', agents[0]?.agent === 'Claude Code' && /Claude Code/.test(agents[0].title), JSON.stringify(agents[0]));
  check('...with the page in it', agents[0]?.tabs.length === 1 && /a1/.test(agents[0].tabs[0].url), JSON.stringify(agents[0]?.tabs));
  check('the window carries a badge', await waitFor(async () => { const p = await agentUi(); return p && (await p.evaluate(() => document.getElementById('agent-window-chip')?.textContent)) === 'Claude Code\'s window'; }), 'no badge');
  await typed;
  r = await A.call('read_page');
  check('read_page reads the agent\'s page', /PAGE-A1/.test(A.text(r)) && !/PAGE-USER/.test(A.text(r)), A.text(r).slice(0, 200));
  r = await A.call('click', { text: 'Press A1' });
  check('a click acts in the agent\'s window (the approval card went to the user, quietly)', !r.result.isError, A.text(r));
  r = await A.call('read_page');
  check('...and changed that page', /clicked A1/.test(A.text(r)) || /clicked A1/.test(JSON.stringify((await agentWins())[0])), A.text(r).slice(0, 200));
  check('an approval did not open the sidebar', await sidebarHidden(), 'opened');
  r = await A.call('type_text', { text: 'agent text', element_id: undefined });
  const agentTyped = !r.result.isError;
  check('type_text works', agentTyped || /element|field|focus/i.test(A.text(r)), A.text(r));
  r = await A.call('screenshot');
  const img = r.result.content?.find((c) => c.type === 'image');
  check('screenshot of the agent\'s page', Boolean(img && img.data.length > 1000), JSON.stringify(r).slice(0, 200));

  // The user, meanwhile.
  const field = await userField();
  check('the user\'s typing went into the user\'s field, whole', field.value === 'hello world' && field.active === 'f', JSON.stringify(field));
  check('the user\'s tabs, front tab and window are as they were', (await snapshot()) === before, `${await snapshot()} vs ${before}`);
  const agentWinId = (await agentWins())[0].windowId;
  check('no window took focus while the agent worked: the agent window never had it', !(await app.evaluate(() => global.__focusEvents)).includes(agentWinId) && !(await agentWins())[0].focused, JSON.stringify(await app.evaluate(() => global.__focusEvents)));
  check('the agent\'s window is not the current window', !(await agentWins())[0].current && (await userWin()).current, JSON.stringify(await windows()));

  // ---- 3. The agent cannot reach the user's tabs, nor the AI's
  r = await A.call('list_tabs');
  const listed = JSON.parse(A.text(r));
  check('list_tabs lists the agent\'s window only', listed.length === 1 && /a1/.test(listed[0].url), A.text(r));
  const userTabId = (await userWin()).tabs[0].id;
  await ui.click('#address'); // the user types in the address bar while the agent keeps calling
  const typingAddress = ui.keyboard.type('address bar text', { delay: 45 });
  r = await A.call('switch_tab', { tab_id: userTabId });
  check('switch_tab to a user tab id is refused', r.result.isError === true && /No tab with id/.test(A.text(r)), A.text(r));
  r = await A.call('close_tab', { tab_id: userTabId });
  check('close_tab of a user tab id is refused', r.result.isError === true, A.text(r));
  check('...and the user\'s tab is still there', (await snapshot()) === before, await snapshot());
  r = await A.call('read_tabs', { tab_ids: [userTabId] });
  check('read_tabs does not read the user\'s tab', !/PAGE-USER/.test(A.text(r)), A.text(r).slice(0, 300));
  r = await A.call('group_tabs', { name: 'mine', tab_ids: [userTabId] });
  check('group_tabs does not take the user\'s tab', r.result.isError === true, A.text(r));
  r = await A.call('open_tab', { url: `${base}/a2` });
  agents = await agentWins();
  check('open_tab opens in the agent\'s window, in front there', !r.result.isError && agents[0].tabs.length === 2 && agents[0].activeId === agents[0].tabs[1].id, JSON.stringify(agents[0]));
  check('...and nowhere else', (await snapshot()) === before, await snapshot());
  r = await A.call('read_page');
  check('the next call works in the new tab', /PAGE-A2/.test(A.text(r)), A.text(r).slice(0, 200));
  await A.call('switch_tab', { tab_id: agents[0].tabs[0].id });
  r = await A.call('read_page');
  check('switch_tab moves between the agent\'s own tabs', /PAGE-A1/.test(A.text(r)), A.text(r).slice(0, 200));
  await typingAddress;
  const addressNow = await ui.evaluate(() => ({ active: document.activeElement?.id, value: document.getElementById('address').value }));
  check('typing in the address bar was not interrupted (focus and text intact)', addressNow.active === 'address' && addressNow.value === 'address bar text', JSON.stringify(addressNow));
  await ui.evaluate(() => { const a = document.getElementById('address'); a.value = ''; a.blur(); });
  await A.call('web_search', { query: 'lumen test' }).catch(() => null);
  check('the user\'s window gained no tab from the agent\'s calls', (await snapshot()) === before, await snapshot());

  // ---- 4. The sidebar AI finishes in its own tab, unaffected
  await app.evaluate(() => global.__releaseAi());
  const aiDone = await waitFor(() => app.evaluate(() => global.__seen), 20000);
  check('the sidebar AI read its own tab (not the agent\'s)', aiDone === 'AITAB', aiDone);
  const u2 = await userWin();
  check('the AI opened its tab in the user\'s window, the agent\'s window has none of it', u2.tabs.some((t) => /aitab/.test(t.url)) && !(await agentWins())[0].tabs.some((t) => /aitab/.test(t.url)), JSON.stringify(await windows()));
  const aiTabs = await app.evaluate(() => global.__aiTabs.select({}).map((x) => ({ rec: x.rec.win.id, url: x.tab.view.webContents.getURL() })));
  check('"close the tabs the AI opened" sees only the sidebar AI\'s tab', aiTabs.length === 1 && /aitab/.test(aiTabs[0].url) && aiTabs[0].rec === u2.windowId, JSON.stringify(aiTabs));
  await ui.evaluate(() => window.browser.hideAiTabs(true)); // "hide the tabs the AI opened" on: it must not hide the agent's tabs
  await sleep(500);
  const strip = await (await agentUi()).evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((e) => ({ ai: e.classList.contains('ai-opened') || e.dataset.ai || '', hidden: e.hidden })));
  check('the agent\'s tabs are not marked or hidden as AI tabs', strip.length >= 2 && strip.every((t) => !t.hidden && !t.ai), JSON.stringify(strip));
  r = await A.call('read_page');
  await ui.evaluate(() => window.browser.hideAiTabs(false));
  check('the agent is unaffected by the AI\'s tab', /PAGE-A1/.test(A.text(r)), A.text(r).slice(0, 200));

  // ---- 5. Its pages are muted and ask nothing; a popup does not open a window; works minimized
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const countBefore = await windowCount();
  r = await A.call('navigate', { url: `${base}/dialogs` });
  check('a page that alerts, confirms and prompts does not hold the agent up', !r.result.isError && /Dialogs|confirm=|PAGE-DIALOGS/.test(A.text(r)), A.text(r));
  r = await A.call('list_tabs');
  check('...its confirm was answered no and its prompt cancelled, by themselves', /confirm=false prompt=null/.test(A.text(r)), A.text(r));
  await sleep(400);
  check("a popup from the agent's page opened no window", (await windowCount()) === countBefore, `${countBefore} -> ${await windowCount()}`);
  const muted = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => /127\.0\.0\.1/.test(w.getURL())).map((w) => [w.getURL().replace(/.*\//, ''), w.isAudioMuted()]));
  const agentUrls = new Set((await agentWins())[0].tabs.map((t) => t.url.replace(/.*\//, '')));
  check('the agent\'s pages are muted', muted.filter(([url]) => agentUrls.has(url) && url !== 'user').every(([, m]) => m), JSON.stringify(muted));
  const aw = (await agentWins())[0];
  await app.evaluate((_e, id) => global.__agentWindows.recOf(id).win.minimize(), aw.windowId);
  await sleep(300);
  await A.call('navigate', { url: `${base}/a3` });
  r = await A.call('screenshot');
  const shot = r.result.content?.find((c) => c.type === 'image');
  check('while minimized the agent still loads pages and takes screenshots', Boolean(shot && shot.data.length > 1000), JSON.stringify(r).slice(0, 200));
  await A.call('click', { text: 'Press A3' });
  r = await A.call('read_page');
  check('...and clicks work', /PAGE-A3/.test(A.text(r)) && !(r.result.isError), A.text(r).slice(0, 200));

  // ---- 6. Not in the saved session
  await sleep(3800);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session || {};
  const savedUrls = JSON.stringify(saved);
  check('the agent\'s window is not in the saved session', !/\/a1|\/a2|\/a3/.test(savedUrls) && /user/.test(savedUrls), savedUrls.slice(0, 300));

  // ---- 7. A second client gets a second window
  const B = await connect('Codex');
  await B.call('navigate', { url: `${base}/b1` });
  agents = await agentWins();
  check('a second client gets a window of its own', agents.length === 2 && agents.some((w) => w.agent === 'Codex' && w.tabs.length === 1 && /b1/.test(w.tabs[0].url)), JSON.stringify(agents.map((w) => [w.agent, w.tabs.map((t) => t.url)])));
  // Its approval card is quiet: the sidebar stays closed, the AI button gets a badge, nothing takes focus, and it waits for the user.
  paused = true;
  const pendingClick = B.call('click', { text: 'Press B1' });
  await ui.waitForSelector('.approval:not(.resolved)', { state: 'attached', timeout: 10000 });
  const quiet = await ui.evaluate(() => ({ hidden: document.body.classList.contains('sidebar-hidden'), badge: document.getElementById('toggle-sidebar').classList.contains('approval-pending'), title: document.querySelector('.approval:not(.resolved) .approval-title')?.textContent }));
  check('an agent approval card does not open the sidebar: the AI button shows a badge instead', quiet.hidden && quiet.badge, JSON.stringify(quiet));
  check('...and it names the agent and the site', /Codex/.test(quiet.title) && /127[.]0[.]0[.]1/.test(quiet.title), quiet.title);
  check('...and no agent window took focus while it waited', !(await app.evaluate(() => global.__focusEvents)).some((id) => id !== 1), JSON.stringify(await app.evaluate(() => global.__focusEvents)));
  paused = false;
  r = await pendingClick;
  check('...and the action waited for the user, then went through', !r.result.isError, B.text(r));
  r = await B.call('list_tabs');
  check('...which lists its own tabs only', JSON.parse(B.text(r)).length === 1 && /b1/.test(B.text(r)), B.text(r));
  r = await A.call('list_tabs');
  check('...and the first client does not see it', JSON.parse(A.text(r)).every((t) => !/b1/.test(t.url)), A.text(r));
  const aTabId = (await agentWins()).find((w) => w.agent === 'Claude Code').tabs[0].id;
  r = await B.call('close_tab', { tab_id: aTabId });
  check('one client cannot close the other\'s tab', r.result.isError === true && (await agentWins()).find((w) => w.agent === 'Claude Code').tabs.some((t) => t.id === aTabId), A.text(r));
  r = await B.call('switch_tab', { tab_id: aTabId });
  check('...nor switch to it', r.result.isError === true, B.text(r));
  check('the user\'s tabs are still untouched', (await snapshot()).includes(`"active":${(await userWin()).activeId}`) && (await userWin()).tabs.length === 2, await snapshot());

  // ---- 8. The user closes an agent window by hand: the next call makes a new one
  const bWin = (await agentWins()).find((w) => w.agent === 'Codex');
  await app.evaluate((_e, id) => global.__agentWindows.recOf(id).win.close(), bWin.windowId);
  await waitFor(async () => !(await agentWins()).some((w) => w.agent === 'Codex'));
  check('closing an agent window by hand closes it', !(await agentWins()).some((w) => w.agent === 'Codex'), JSON.stringify(await agentWins()));
  r = await B.call('navigate', { url: `${base}/b2` });
  const bAgain = (await agentWins()).find((w) => w.agent === 'Codex');
  check('the next call makes a new window, and the result is right', !r.result.isError && /Page B2/.test(B.text(r)) && bAgain && bAgain.windowId !== bWin.windowId, JSON.stringify(bAgain));

  // ---- 9. The session ends: unused window closes after the grace; a window the user used stays
  A.end();
  await waitFor(async () => !(await agentWins()).some((w) => w.agent === 'Claude Code'), 8000);
  check('a session that ended closes its unused window (after a grace period)', !(await agentWins()).some((w) => w.agent === 'Claude Code') && (await agentWins()).some((w) => w.agent === 'Codex'), JSON.stringify((await agentWins()).map((w) => w.agent)));
  const bUi = await agentUi();
  await bUi.click('#tabs'); // the user clicks in it
  await sleep(200);
  B.end();
  await waitFor(async () => (await windows()).find((w) => w.windowId === bAgain.windowId)?.agent === null, 15000);
  const kept = (await windows()).find((w) => w.windowId === bAgain.windowId);
  check('a window the user used stays when the session ends, as an ordinary window', Boolean(kept) && kept.agent === null && /^Lumen/.test(kept.title), JSON.stringify(kept));
  check('...and its badge goes', !(await bUi.evaluate(() => document.body.classList.contains('agent-window'))), 'badge still there');

  // A pinned tab keeps its window too.
  const C = await connect('Cursor');
  await C.call('navigate', { url: `${base}/c1` });
  const cWin = (await agentWins())[0];
  await app.evaluate((_e, { w, t }) => global.__windows.pin(w, t, true), { w: cWin.windowId, t: cWin.tabs[0].id });
  C.end();
  await waitFor(async () => (await windows()).find((w) => w.windowId === cWin.windowId)?.agent === null, 15000);
  const cKept = (await windows()).find((w) => w.windowId === cWin.windowId);
  check('a window with a pinned tab stays when the session ends', Boolean(cKept) && cKept.agent === null, JSON.stringify(cKept));

  // ---- 10. Turning agents off ends their windows
  const D = await connect('Claude Code');
  await D.call('navigate', { url: `${base}/d1` });
  check('a new session gets a window again', (await agentWins()).length === 1, JSON.stringify(await agentWins()));
  await ui.evaluate(() => window.assistant.setMcpEnabled(false));
  await sleep(500);
  await waitFor(async () => (await agentWins()).length === 0, 6000);
  check('turning "Allow AI agents to connect" off closes the agent windows', (await agentWins()).length === 0, JSON.stringify(await agentWins()));

  approving = false;
  await approver;
  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

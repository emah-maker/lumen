// AI controls: "Turn off AI on this site" and "Undo tab changes".
// Per site: with AI off on a site, the page isn't attached to messages, every tool refuses its tabs
// (sidebar runs, batch steps, an outside agent over the real MCP bridge), list_tabs shows them as an
// id only, addresses there are refused, a page that moves there drops the tool's result, and
// Organize Tabs leaves those tabs out. Turning AI back on restores it all.
// Undo: a sidebar run's opened tabs close, closed tabs reopen in their group, navigations go back,
// groups and the tab switch are reversed; typing on a site is listed as not undoable; once only.
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { openSettingsTab } = require('./settings-tab');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return v; };

  const server = http.createServer((req, res) => {
    const to = new URL(req.url, 'http://x').searchParams.get('to');
    if (req.url.startsWith('/redirect') && to) { res.writeHead(302, { Location: to }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/link')) { res.end(`<title>Link</title><a id="go" href="${to}">Go there</a>`); return; }
    if (req.url.startsWith('/form')) { res.end('<title>Form</title><label>Name <input id="name"></label>'); return; }
    res.end(`<title>Page ${req.url}</title><h1>Secret ${req.url}</h1><p>Private text on this page.</p>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const on = `http://127.0.0.1:${port}`; // AI stays on here
  const off = `http://localhost:${port}`; // AI gets turned off on "localhost"

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aicontrols-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  const root = path.join(__dirname, '..');
  const app = await electron.launch({ args: [root], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  await app.evaluate(() => {
    global.__setTabGrouping('off'); // automatic grouping by site would regroup the tabs Undo takes out
    const agent = global.__agent;
    agent.browser.effectiveModel = (m) => m; // a fake Claude below; skip the connected-model check
    const base = agent.getOptions;
    agent.getOptions = () => ({ ...base(), pageContext: true });
  });

  // A sidebar run with a fake Claude that asks for `toolUses` in order (approvals auto-allowed in
  // test mode). Returns the user message it was sent, the tool results and the 'done' event.
  const run = (opts) => app.evaluate(async (_e, { toolUses, startUrl }) => {
    const agent = global.__agent;
    agent.reset();
    const tab = agent.browser.activeTab();
    if (startUrl) {
      await tab.webContents.loadURL(startUrl).catch(() => {});
      for (let i = 0; i < 100 && tab.webContents.getURL() !== startUrl; i++) await new Promise((r) => setTimeout(r, 50));
    }
    agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    let turn = 0;
    let sent = null;
    agent.getClient = () => ({ beta: { messages: { stream: (req) => {
      sent ||= JSON.stringify(req.messages[0].content);
      const t = turn++;
      const message = t < toolUses.length
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${t}`, name: toolUses[t].name, input: toolUses[t].input }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } });
    const events = [];
    await agent.run('do it', (e) => events.push(e));
    const results = agent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ error: Boolean(b.is_error), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 400) }));
    return { sent, results, done: events.find((e) => e.type === 'done'), url: agent.browser.activeTab()?.webContents.getURL() };
  }, opts);

  // One tool call, pinned to the active tab, the way an outside agent's call runs.
  const exec = (name, input) => app.evaluate(async (_e, [n, i]) => {
    const agent = global.__agent;
    try { return { ok: true, text: String(await agent.inTask(agent.browser.activeTab()?.id, new AbortController().signal, () => agent.execute(n, i))) }; } catch (err) { return { ok: false, text: err.message }; }
  }, [name, input]);
  const refused = (r) => !r.ok && /turned off AI on localhost|where the user turned off AI/.test(r.text);

  // ---- 1. Turning AI off (the sidebar's call, through the UI's IPC gate)
  await ui.evaluate(() => window.lumenExtras.setAiSite('localhost', true));
  const state = await ui.evaluate((u) => window.lumenExtras.aiSiteState(u), `${off}/x`);
  check('a site is turned off by name and covers its addresses', state.site === 'localhost' && state.off === true, JSON.stringify(state));
  check('another site stays on', (await ui.evaluate((u) => window.lumenExtras.aiSiteState(u), `${on}/x`)).off === false, 'on-site reported off');

  // ---- 2. Page context and browser state
  let r = await run({ startUrl: `${off}/inbox`, toolUses: [] });
  check('no page text is attached for a site with AI off', !/Private text|Secret/.test(r.sent), r.sent);
  check('its title and address are not sent either', !r.sent.includes('localhost') && /turned off AI on this tab's site/.test(r.sent), r.sent);
  const chip = await waitFor(() => ui.evaluate(() => { const c = document.getElementById('page-context'); return c && !c.hidden && c.classList.contains('ai-off') ? c.textContent : null; }));
  check('the sidebar chip says AI is off on the site', /AI is off on:.*localhost/.test(chip || ''), chip);

  // ---- 3. Every tool refuses the tab (sidebar run: the refusal comes back as the tool's error)
  r = await run({ startUrl: `${off}/inbox`, toolUses: [
    { name: 'read_page', input: {} },
    { name: 'find', input: { query: 'Secret' } },
    { name: 'screenshot', input: {} },
    { name: 'run_script', input: { code: 'return document.title' } },
    { name: 'click', input: { text: 'Secret' } },
    { name: 'scroll', input: { direction: 'down' } },
    { name: 'batch', input: { steps: [{ do: 'scroll', direction: 'down' }] } },
    { name: 'navigate', input: { url: `${on}/elsewhere` } },
  ] });
  check('read_page, find, screenshot, run_script, click, scroll, batch and navigate are all refused', r.results.length === 8 && r.results.every((x) => x.error && /turned off AI on localhost/.test(x.text)), JSON.stringify(r.results));
  check('nothing from the page reached the model', !r.results.some((x) => /Private text|Secret \//.test(x.text)), JSON.stringify(r.results));
  check('the tab stayed where it was', r.url === `${off}/inbox`, r.url);

  // From a tab where AI is on: addresses and tabs on the off site are refused; list_tabs hides them.
  const offTab = await app.evaluate(() => global.__agent.browser.activeTab().id);
  await app.evaluate((_e, u) => { const t = global.__agent.browser.openTab(u); return t.id; }, `${on}/home`);
  await waitFor(() => app.evaluate(() => !global.__agent.browser.activeTab().webContents.isLoading()));
  const listed = JSON.parse((await exec('list_tabs', {})).text);
  const hidden = listed.find((t) => t.id === offTab);
  check('list_tabs shows a tab with AI off as its id only', hidden && hidden.ai_off === true && !('url' in hidden) && !('title' in hidden), JSON.stringify(listed));
  check('switch_tab to it is refused', refused(await exec('switch_tab', { tab_id: offTab })), 'switched');
  check('close_tab on it is refused', refused(await exec('close_tab', { tab_id: offTab })), 'closed');
  check('group_tabs with it is refused', refused(await exec('group_tabs', { name: 'X', tab_ids: [offTab] })), 'grouped');
  check('navigate to the site is refused', refused(await exec('navigate', { url: `${off}/page` })), 'navigated');
  check('open_tab on the site is refused', refused(await exec('open_tab', { url: `${off}/page` })), 'opened');
  check('read_urls of the site is refused', refused(await exec('read_urls', { urls: [`${off}/page`] })), 'read');
  const redirected = await exec('navigate', { url: `${on}/redirect?to=${encodeURIComponent(`${off}/landed`)}` });
  check('a redirect onto the site drops the result', refused(redirected) && !/Private text/.test(redirected.text), JSON.stringify(redirected));
  await exec('navigate', { url: `${on}/link?to=${encodeURIComponent(`${off}/via-batch`)}` });
  const batched = await exec('batch', { steps: [{ do: 'click', text: 'Go there' }] });
  check('a batch step that lands on the site drops the batch result', refused(batched) && !/Private text/.test(batched.text), JSON.stringify(batched));
  const readVia = await exec('read_urls', { urls: [`${on}/redirect?to=${encodeURIComponent(`${off}/secret`)}`] });
  check('read_urls that redirects onto the site shows no content', readVia.ok && /turned off AI on this site/.test(readVia.text) && !/Private text/.test(readVia.text), JSON.stringify(readVia));

  // ---- 4. An outside agent over the real MCP bridge gets the same refusals
  await ui.evaluate(() => window.assistant.setMcpEnabled(true));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), offTab);
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
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => resolve({ timeout: method }), 30000);
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent' } });
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const mcpText = (m) => (m.result?.content || []).map((c) => c.text || '').join('\n');
  const mcpRead = await request('tools/call', { name: 'read_page', arguments: {} });
  check('MCP: read_page on a tab with AI off is refused', mcpRead.result?.isError && /turned off AI on localhost/.test(mcpText(mcpRead)), JSON.stringify(mcpRead).slice(0, 300));
  const mcpBatch = await request('tools/call', { name: 'batch', arguments: { steps: [{ do: 'scroll', direction: 'down' }] } });
  check('MCP: batch there is refused', mcpBatch.result?.isError && /turned off AI/.test(mcpText(mcpBatch)), JSON.stringify(mcpBatch).slice(0, 300));
  const mcpTabs = await request('tools/call', { name: 'list_tabs', arguments: {} });
  check('MCP: list_tabs shows no address or title from the site', !mcpText(mcpTabs).includes('localhost') && /"ai_off":true/.test(mcpText(mcpTabs)), mcpText(mcpTabs));
  bridge.kill();

  // ---- 5. Organize Tabs with AI leaves those tabs out
  // Two tabs where AI is on (the tabs above moved onto the off site), so there is something to group.
  for (const page of ['first', 'second']) await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((res) => (t.webContents.isLoading() ? t.webContents.once('did-stop-loading', res) : res())); }, `${on}/${page}`);
  const organized = await app.evaluate(async () => {
    const agent = global.__agent;
    const keyBefore = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake'; // keeps Organize on the API path (the fake client below)
    agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    let sentList = null;
    const baseClient = agent.getClient;
    agent.getClient = () => ({ messages: { create: async (req) => {
      sentList = req.messages[0].content;
      const ids = [...sentList.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ groups: [{ name: 'Mine', tab_ids: ids }] }) }] };
    } } });
    await global.__organizeTabs();
    agent.getClient = baseClient;
    if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = keyBefore;
    for (const t of agent.browser.listTabs()) if (t.group) agent.browser.ungroupTabs([t.id]);
    return sentList;
  });
  check('Organize Tabs sends nothing about tabs on the site', organized !== null && !organized.includes('localhost') && !organized.includes(`"id":${offTab},`), organized);

  // ---- 6. Settings lists the site; turning AI back on restores the tools
  const inSettings = await openSettingsTab(app);
  check('Settings list the site under "Sites where AI is off"', await inSettings("[...document.querySelectorAll('#ai-off-sites .item')].some((i) => i.dataset.site === 'localhost')"), 'not listed');
  await inSettings("[...document.querySelectorAll('#ai-off-sites .item')].find((i) => i.dataset.site === 'localhost').querySelector('button').click()");
  await waitFor(async () => (await ui.evaluate((u) => window.lumenExtras.aiSiteState(u), `${off}/x`)).off === false);
  await app.evaluate((_e, sid) => global.__agent.browser.closeTab(sid), inSettings.id);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), offTab);
  const back = await exec('read_page', {});
  check('turned back on (from Settings): read_page works there again', back.ok && /Private text/.test(back.text), JSON.stringify(back).slice(0, 200));
  r = await run({ startUrl: `${off}/inbox`, toolUses: [] });
  check('and the page is attached to messages again', /Private text/.test(r.sent), r.sent);

  // ---- 7. Undo: open, navigate, close, group, switch; typing is listed as not undoable
  const setup = await app.evaluate(async (_e, u) => {
    const b = global.__agent.browser;
    for (const t of b.listTabs()) b.closeTab(t.id);
    const wait = (wc) => new Promise((res) => (wc.isLoading() ? wc.once('did-stop-loading', res) : res()));
    const a = b.openTab(`${u}/a`); await wait(a.webContents);
    const x = b.openTab(`${u}/x`); await wait(x.webContents);
    const y = b.openTab(`${u}/y`); await wait(y.webContents);
    const z = b.openTab(`${u}/form`); await wait(z.webContents);
    b.groupTabs('Keep', [x.id]);
    b.switchTab(a.id);
    return { a: a.id, x: x.id, y: y.id, z: z.id };
  }, on);
  r = await run({ toolUses: [
    { name: 'navigate', input: { url: `${on}/b` } },
    { name: 'close_tab', input: { tab_id: setup.x } },
    { name: 'group_tabs', input: { name: 'AI group', tab_ids: [setup.y] } },
    { name: 'switch_tab', input: { tab_id: setup.z } },
    { name: 'type_text', input: { element_id: 0, text: 'hello' } },
    { name: 'open_tab', input: { url: `${on}/new` } },
  ] });
  const undo = r.done?.undo;
  check('the reply reports what can be undone', undo && undo.undoable >= 5, JSON.stringify(r.done));
  check('typing on a site is listed as not undoable', undo?.lasting?.some((l) => /typed text on 127\.0\.0\.1/.test(l)), JSON.stringify(undo));
  const before = await app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, group: t.group, active: t.active })));
  const result = await app.evaluate((_e, id) => global.__agent.undoRun(id), undo?.id);
  await waitFor(() => app.evaluate((_e, u) => {
    const tabs = global.__agent.browser.listTabs();
    return !tabs.some((t) => t.url === `${u}/new`) && tabs.some((t) => t.url === `${u}/x`) && tabs.some((t) => t.url === `${u}/a`);
  }, on));
  const after = await app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, group: t.group, active: t.active })));
  check('undo closes the tab it opened', !after.some((t) => t.url === `${on}/new`) && before.some((t) => t.url === `${on}/new`), JSON.stringify(after));
  check('undo reopens the tab it closed, in its group', after.some((t) => t.url === `${on}/x` && t.group === 'Keep'), JSON.stringify(after));
  check('undo takes the tab back to the page it was on', after.some((t) => t.id === setup.a && t.url === `${on}/a`), JSON.stringify(after));
  check('undo takes the tab out of the group it made', after.find((t) => t.id === setup.y)?.group === null, JSON.stringify(after));
  check('undo switches back to the tab you were on', after.find((t) => t.active)?.id === setup.a, JSON.stringify(after));
  check('undo says what it did and what it couldn\'t', result.ok && result.done.length >= 4 && result.lasting.some((l) => /typed text/.test(l)), JSON.stringify(result));
  const again = await app.evaluate((_e, id) => global.__agent.undoRun(id), undo?.id);
  check('a run is undone only once', again.ok === false, JSON.stringify(again));

  // ---- 8. The sidebar's button, end to end (a real message through the UI)
  await app.evaluate(async (_e, u) => {
    const agent = global.__agent;
    agent.reset();
    const tab = agent.browser.activeTab();
    await tab.webContents.loadURL(`${u}/start`).catch(() => {});
    agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    let turn = 0;
    agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = turn++ === 0
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_nav', name: 'navigate', input: { url: `${u}/moved` } }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Moved it.' }] };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } });
  }, on);
  await ui.evaluate(() => ask('move it')); // app.js: the sidebar's own send
  const button = await waitFor(() => ui.evaluate(() => Boolean([...document.querySelectorAll('.run-undo button')].find((b) => b.textContent === 'Undo tab changes'))));
  check('the sidebar shows "Undo tab changes" under the reply', button, 'no button');
  if (button) {
    await ui.evaluate(() => [...document.querySelectorAll('.run-undo button')].find((b) => b.textContent === 'Undo tab changes').click());
    const url = await waitFor(() => app.evaluate((_e, u) => { const now = global.__agent.browser.activeTab().webContents.getURL(); return now === `${u}/start` ? now : null; }, on));
    check('clicking it takes the tab back', url === `${on}/start`, url);
    const listedResult = await waitFor(() => ui.evaluate(() => document.querySelector('.run-undo-result')?.textContent || null));
    check('and lists what it did', /Took a tab back to 127\.0\.0\.1/.test(listedResult || ''), listedResult);
  }

  check('no page errors in the UI', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

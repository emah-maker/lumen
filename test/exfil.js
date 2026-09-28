// Exfiltration guard: once a run has read page content, taking the browser to a host the user hasn't
// approved (navigate / open_tab / read_urls) asks first; approved hosts and runs that read nothing go
// freely; outside (MCP) agents are always asked; list_tabs hides query strings and Lumen's own tabs.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${req.url}</title><h1>Secret ${req.url}</h1><p>Private text on this page.</p>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  // Same server, different hosts as far as approvals go: 127.0.0.1:<port> and localhost:<port>.
  const home = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const homeHost = `127.0.0.1:${port}`;
  const otherHost = `localhost:${port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-exfil-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  await app.evaluate(() => {
    const agent = global.__agent;
    agent.browser.autoApprove = () => false; // the test switch normally auto-allows everything
    agent.browser.effectiveModel = (m) => m; // a fake Claude below; skip the connected-model check
    const base = agent.getOptions;
    global.__pageContext = true;
    agent.getOptions = () => ({ ...base(), pageContext: global.__pageContext });
  });

  // One sidebar run with a fake Claude that asks for `toolUses` in order, answering every approval
  // card with `answer`. Starts from a fresh chat (no approved hosts) unless keepHosts.
  const run = (opts) => app.evaluate(async (_e, { toolUses, answer, startUrl, approve = [], pageContext = true, fresh = true }) => {
    const agent = global.__agent;
    if (fresh) agent.reset(); // New chat; fresh: false sends another message in the same chat
    for (const h of approve) agent.approvedHosts.add(h);
    global.__pageContext = pageContext;
    const tab = agent.browser.activeTab();
    if (startUrl) await tab.webContents.loadURL(startUrl).catch(() => {});
    agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    let turn = 0;
    agent.getClient = () => ({ beta: { messages: { stream: () => {
      const t = turn++;
      const message = t < toolUses.length
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${t}`, name: toolUses[t].name, input: toolUses[t].input }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } });
    const events = [];
    await agent.run('do it', (e) => {
      events.push(e);
      if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, answer), 20);
    });
    const results = agent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ error: Boolean(b.is_error), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 300) }));
    return {
      approvals: events.filter((e) => e.type === 'approval').map(({ host, action, title }) => ({ host, action, title })),
      results,
      url: agent.browser.activeTab().webContents.getURL(),
      tabs: agent.browser.listTabs().length,
    };
  }, opts);

  // 1. Read the page, then navigate to a new host: a card, and "Don't allow" keeps the tab where it was.
  let r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [
    { name: 'read_page', input: {} },
    { name: 'navigate', input: { url: `${other}/collect?data=secret` } },
  ] });
  check('read_page then navigate to a new host shows an approval card', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.approvals[0].action === 'open', JSON.stringify(r.approvals));
  check('the card names the agent and the host', r.approvals[0]?.title === `Claude wants to open ${otherHost}`, JSON.stringify(r.approvals));
  check('denied: the navigation did not happen', r.url.startsWith(home) && r.results[1]?.error && /did not allow Claude to open/.test(r.results[1].text), JSON.stringify(r));

  // 2. Same, approved: the tab goes there.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: true, toolUses: [
    { name: 'read_page', input: {} },
    { name: 'navigate', input: { url: `${other}/collect` } },
  ] });
  check('allowed: the navigation happens', r.approvals.length === 1 && r.url.startsWith(other), JSON.stringify(r));

  // 3. Host already approved in this chat: no card.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [otherHost], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'navigate', input: { url: `${other}/collect` } },
  ] });
  check('an already-approved host gets no card', r.approvals.length === 0 && r.url.startsWith(other), JSON.stringify(r));

  // 4. A run that read nothing navigates freely (and the taint from earlier runs doesn't carry over).
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [
    { name: 'navigate', input: { url: `${other}/somewhere` } },
  ] });
  check('an untainted run navigates without a card', r.approvals.length === 0 && r.url.startsWith(other), JSON.stringify(r));

  // 4b. Page content read in one message stays in the chat: a later message in the same chat is
  // still asked; New chat starts clean.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [{ name: 'read_page', input: {} }] });
  r = await run({ fresh: false, pageContext: false, answer: false, toolUses: [{ name: 'navigate', input: { url: `${other}/collect` } }] });
  check('a read in message 1 still asks before navigating in message 2 of the same chat', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.url.startsWith(home), JSON.stringify(r));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [{ name: 'navigate', input: { url: `${other}/collect` } }] });
  check('after New chat, the same navigation goes without a card', r.approvals.length === 0 && r.url.startsWith(other), JSON.stringify(r));

  // 5. The page text attached to the message counts as reading it.
  r = await run({ startUrl: `${home}/inbox`, pageContext: true, answer: false, toolUses: [
    { name: 'navigate', input: { url: `${other}/collect` } },
  ] });
  check('with the page attached, navigating to a new host asks', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.url.startsWith(home), JSON.stringify(r));

  // 6. open_tab after list_tabs asks too; denied, no tab opens.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [
    { name: 'list_tabs', input: {} },
    { name: 'open_tab', input: { url: `${other}/x` } },
  ] });
  check('list_tabs then open_tab to a new host asks', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.results[1]?.error, JSON.stringify(r));

  // 7. read_urls to two new hosts: one card per host. (Going back to the page's own host still asks:
  // it isn't approved, and the page itself could be the one collecting.)
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: true, toolUses: [
    { name: 'find', input: { query: 'Secret' } },
    { name: 'read_urls', input: { urls: [`${other}/a`, `${home}/b`, `${other}/c`] } },
  ] });
  check('read_urls asks once per new host', r.approvals.length === 2 && r.approvals.map((a) => a.host).sort().join() === [homeHost, otherHost].sort().join() && !r.results[1]?.error, JSON.stringify(r));

  // 8. Auto-allow covers the sidebar's AI; an outside MCP agent is still asked, taint kept per session.
  const mcp = await app.evaluate(async (_e, { home: h, other: o }) => {
    const agent = global.__agent;
    agent.browser.autoApprove = () => true;
    const events = [];
    const emit = (e) => { events.push(e); if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, false), 20); };
    const session = { approvedHosts: new Set(), clientName: 'Test MCP' };
    const signal = new AbortController().signal;
    const allow = (input) => ({ hosts: session.approvedHosts, who: session.clientName, external: true, input, run: session });
    const out = {};
    await agent.inTask(agent.browser.activeTab().id, signal, () => agent.ensureAllowed('read_page', emit, signal, allow({})));
    // A separate call (its own task scope), same session: still tainted.
    out.denied = await agent.inTask(agent.browser.activeTab().id, signal, () => agent.ensureAllowed('navigate', emit, signal, allow({ url: `${o}/leak` })).then(() => null, (err) => err.message));
    // The sidebar's own run with auto-allow on: no card.
    const sidebarRun = {};
    await agent.inTask(agent.browser.activeTab().id, signal, async () => {
      await agent.ensureAllowed('read_page', emit, signal, { run: sidebarRun });
      await agent.ensureAllowed('navigate', emit, signal, { input: { url: `${h}/ok` }, run: sidebarRun });
    });
    agent.browser.autoApprove = () => false;
    out.approvals = events.filter((e) => e.type === 'approval').map(({ host, title }) => ({ host, title }));
    return out;
  }, { home, other });
  check('an outside MCP agent is asked even with auto-allow on', mcp.approvals.length === 1 && mcp.approvals[0].host === otherHost && mcp.approvals[0].title === `Test MCP wants to open ${otherHost}` && /did not allow Test MCP to open/.test(mcp.denied), JSON.stringify(mcp));

  // 9. list_tabs: no query strings or fragments, no Lumen pages (new tab, settings, history, file://).
  const tabs = await app.evaluate(async (_e, h) => {
    const agent = global.__agent;
    agent.browser.openTab(`${h}/search?q=private+stuff&token=abc#section`);
    agent.browser.openTab(); // a new-tab page
    global.__settings?.open?.();
    await new Promise((r) => setTimeout(r, 1500));
    const raw = agent.browser.listTabs();
    const seen = JSON.parse(await agent.execute('list_tabs', {}));
    const web = seen.find((t) => t.url === `${h}/search`);
    const internal = raw.find((t) => /^file:/.test(t.url) && !/newtab\.html/.test(t.url)); // settings
    const switched = web ? await agent.execute('switch_tab', { tab_id: web.id }) : '';
    const refused = internal ? await agent.execute('switch_tab', { tab_id: internal.id }).then((x) => x, (err) => `ERR ${err.message}`) : 'no internal tab';
    return { raw: raw.map((t) => t.url), seen: seen.map((t) => t.url), switched, refused, internal: internal?.url || null };
  }, home);
  check('list_tabs shows the web tab without its query or fragment', tabs.seen.includes(`${home}/search`), JSON.stringify(tabs));
  check('list_tabs has no query strings or fragments', tabs.seen.every((u) => !/[?#]/.test(u)), JSON.stringify(tabs.seen));
  check('list_tabs has no internal or file:// tabs (and there were some); a blank new tab shows as ""', tabs.seen.every((u) => u === '' || /^https?:/.test(u)) && tabs.seen.includes('') && Boolean(tabs.internal), JSON.stringify(tabs));

  check('switch_tab reports the URL without its query or fragment', tabs.switched.endsWith(`${home}/search`), tabs.switched);
  check('switch_tab refuses Lumen pages and file:// tabs', /^ERR No tab with id/.test(tabs.refused), tabs.refused);

  check('no UI errors', errors.length === 0, errors.join('; '));
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

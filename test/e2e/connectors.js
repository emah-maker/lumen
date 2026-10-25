// Connectors in Lumen (features/connectors/, agent.js `connector` tool, Settings → You and AI → Connectors), with no real network:
// stand-in Canvas and Gmail's draft request on 127.0.0.1 (test/fixtures/fake-connectors.js), a stand-in MCP server for the GitHub preset, a fake model.
//  - the settings page is ONE page for everything the AI can reach: the gallery (Canvas, Gmail, Calendar, Drive, Sheets; GitHub, Notion and
//    Todoist as one-click MCP presets; no "coming soon" placeholders) with a "Custom MCP servers" section under it, and no second MCP page;
//  - connecting Canvas (the signed-in session), Gmail (a stand-in Google) and the GitHub preset (a pasted token, added as an MCP server) works from it;
//    the token on disk is encrypted, and the page never gets it back;
//  - connected, the AI has ONE `connector` tool listing just the built-in apps; a read returns the data with a readable step label and no card;
//    the preset's tools are ordinary MCP tools (github__…) that ask on a card;
//  - a write (make a draft) always asks, with the details and no "Always allow", even with auto-allow on; deny sends nothing;
//  - an outside MCP agent is offered no connector tool and is refused if it asks; Bypass permissions, agents that don't ask and hands-off mode never answer a write;
//    disconnecting removes the secret, the tool and the AI's way in.
// Before/after pictures of the page: set CONNECTORS_SHOTS to a folder and it saves the settings page there as <name>.png.
// Run it through the machine-wide lock: node scripts/test/e2e-lock.js run -- node test/e2e/connectors.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startFakes, TOKENS } = require('../fixtures/fake-connectors');
const { openSettingsTab } = require('../helpers/settings-tab');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

// A stand-in for GitHub's MCP server: streamable HTTP, answers only to the bearer token, one tool, and counts the calls it gets.
function mcpServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${TOKENS.github}`) { res.writeHead(401); res.end(); return; }
      const msg = JSON.parse(body);
      seen.push(msg.method === 'tools/call' ? `${msg.method}:${msg.params.name}` : msg.method);
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'gh', version: '1' } });
      if (msg.method === 'tools/list') return reply({ tools: [{ name: 'list_pull_requests', description: 'Pull requests you can see.', inputSchema: { type: 'object', properties: { state: { type: 'string' } } } }] });
      if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'PR #12 Add dark mode' }] });
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

async function main() {
  const fakes = await startFakes();
  const gh = await mcpServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    await app.evaluate(async (_e, { urls, mcpUrl }) => {
      global.__connectorEndpoints = { canvas: urls.canvas, github: mcpUrl };
      // A stand-in for Google (Gmail only): the full sign-in, drafts allowed, one unread message; a draft is posted to the stand-in so a test can count them.
      global.__connectorsGoogle = {
        status: async () => ({ oauth: true, oneClick: false, session: false, email: 'ada@example.com' }),
        api: async (p) => {
          if (p.startsWith('/users/me/messages?')) return { messages: [{ id: '18c0ffee01' }] };
          return { id: '18c0ffee01', snippet: 'Your grade', internalDate: String(Date.now()), labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'Prof <prof@school.edu>' }, { name: 'Subject', value: 'Grades' }] } };
        },
        drafts: () => true,
        allowDrafts: async () => {},
        compose: async (body) => { const r = await fetch(`${urls.gmail}/draft`, { method: 'POST', body: JSON.stringify(body) }); return r.json(); },
        send: async () => { throw new Error('never'); },
        feed: async () => ({ status: 200, body: '' }),
        connect: async () => { throw new Error('no client'); },
        disconnect: async () => {},
      };
      const agent = global.__agent;
      agent.browser.autoApprove = () => true; // auto-allow ON: a write must still ask
      agent.browser.effectiveModel = (m) => m;
      const base = agent.getOptions;
      agent.getOptions = () => ({ ...base(), pageContext: false });
    }, { urls: fakes.urls, mcpUrl: gh.url });

    console.log('--- one page for everything the AI can reach');
    const inSettings = await openSettingsTab(app, 'you-and-ai');
    await waitFor(async () => (await inSettings("document.querySelectorAll('[data-connector]').length")) > 5);
    const shot = async (name, target = '#ai-connectors') => {
      if (!process.env.CONNECTORS_SHOTS) return;
      fs.mkdirSync(process.env.CONNECTORS_SHOTS, { recursive: true });
      await inSettings(`location.hash = '#connectors'; new Promise((r) => setTimeout(() => { document.querySelector(${JSON.stringify(target)})?.scrollIntoView({ block: 'start' }); r(true); }, 300))`);
      const b64 = await app.evaluate(async (_e, id) => (await global.__settings.contents(id).capturePage()).toPNG().toString('base64'), inSettings.id);
      fs.writeFileSync(path.join(process.env.CONNECTORS_SHOTS, `${name}.png`), Buffer.from(b64, 'base64'));
    };
    const gallery = await inSettings("JSON.stringify({ cats: [...document.querySelectorAll('.conn-cat h3')].map((h) => h.textContent), cards: [...document.querySelectorAll('[data-connector]')].map((c) => [c.dataset.connector, c.dataset.status, c.querySelector('.conn-status')?.textContent, c.querySelector('button')?.textContent]) })");
    const g = JSON.parse(gallery);
    await shot('connectors-after-start');
    check('settings: a gallery grouped by Mail and calendar, School, Files and docs, Work, Tasks, then Custom MCP servers in the same page', g.cats.join() === 'Mail and calendar,School,Files and docs,Work,Tasks,Custom MCP servers', gallery);
    check('settings: every card starts Not connected with a Connect button; GitHub, Notion and Todoist are there as presets, and nothing says "coming soon"', g.cards.find((c) => c[0] === 'canvas')?.slice(1).join('|') === 'off|Not connected|Connect' && ['github', 'notion', 'todoist', 'drive', 'sheets', 'gmail', 'gcal'].every((id) => g.cards.find((c) => c[0] === id)?.[2] === 'Not connected' && g.cards.find((c) => c[0] === id)?.[3] === 'Connect') && !g.cards.some((c) => ['slack', 'spotify'].includes(c[0])) && !/coming soon/i.test(await inSettings("document.getElementById('ai-connectors').textContent")), gallery);
    check('settings: the custom MCP servers are inside the Connectors page (one list), and there is no second page for them', await inSettings("Boolean(document.querySelector('#ai-connectors #ai-mcp-servers #mcp-server-add')) && !document.querySelector('[data-sub=mcp-servers]') && !document.getElementById('sub-mcp-servers')") === true, '');
    const permsText = await inSettings("(document.querySelector('[data-connector=todoist] .conn-details')?.textContent || '')");
    check('settings: a preset card says what the AI can read and that its tools come from the service’s own MCP server, before anything is connected', /Your tasks, projects, labels and sections/.test(permsText) && /MCP server/.test(permsText) && /sign in on the service’s own page/i.test(permsText), permsText);
    check('nothing is connected yet, so the AI is offered no connector tool', await app.evaluate(() => global.__connectors.defs().length === 0 && !global.__mcpTools.map((t) => t.name).includes('connector')), '');

    // One sidebar run with a fake Claude asking for `toolUses` in order; every card gets `answer`.
    const run = (opts) => app.evaluate(async (_e, { toolUses, answer = true }) => {
      const agent = global.__agent;
      agent.reset();
      agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
      let turn = 0;
      const requests = [];
      const toolNames = [];
      agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        requests.push(params.tools.filter((t) => t.name === 'connector').map((t) => ({ name: t.name, description: t.description, enum: t.input_schema.properties.app.enum })));
        if (!toolNames.length) toolNames.push(...params.tools.map((t) => t.name));
        const t = turn++;
        const message = t < toolUses.length
          ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${t}`, name: toolUses[t].name || 'connector', input: toolUses[t].input }] }
          : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
      } } } });
      const events = [];
      await agent.run('use my connected apps', (e) => {
        events.push(e);
        if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, answer), 20);
      });
      const results = agent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => ({ error: Boolean(b.is_error), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) }));
      return { events: events.filter((e) => e.type === 'approval' || e.type === 'notice' || e.type === 'tool'), results, requests, toolNames };
    }, opts);

    console.log('--- Canvas: the signed-in session');
    // Connect Canvas from the page, signed out first: it is saved as "Needs sign-in" and nothing is read.
    await inSettings("window.confirm = () => true; document.getElementById('conn-canvas-connect').click(); true");
    await waitFor(async () => (await inSettings("Boolean(document.getElementById('conn-canvas-domain'))")) === true);
    await inSettings("document.getElementById('conn-canvas-domain').value = 'school.instructure.com'; document.getElementById('conn-canvas-go').click(); true");
    await waitFor(async () => (await inSettings("document.querySelector('[data-connector=canvas]')?.dataset.status")) === 'needs-signin');
    check('Canvas, signed out: the card says Needs sign-in and offers Sign in', (await inSettings("document.querySelector('[data-connector=canvas] .conn-status')?.textContent")) === 'Needs sign-in' && /Sign in/.test(await inSettings("[...document.querySelectorAll('[data-connector=canvas] button')].map((b) => b.textContent).join()")), '');
    const signedOut = await run({ toolUses: [{ input: { app: 'canvas', action: 'courses' } }] });
    check('Canvas, signed out: the AI is told to have the user sign in, and the login redirect was not followed', signedOut.results[0]?.error && /isn’t signed in/.test(signedOut.results[0].text) && !fakes.seen.some((r) => r.service === 'canvas' && /login/.test(r.url)), JSON.stringify(signedOut.results));
    // The user signs in to Canvas in Lumen: its session cookie.
    await app.evaluate(async ({ session }, { url, cookie }) => { const [name, value] = cookie.split('='); await session.defaultSession.cookies.set({ url, name, value }); }, { url: fakes.urls.canvas, cookie: fakes.cookie });
    const courses = await run({ toolUses: [{ input: { app: 'canvas', action: 'courses' } }] });
    check('Canvas, after signing in: the same call returns the courses (both pages), marked as untrusted data', !courses.results[0]?.error && /Fundamentals of Computer Science/.test(courses.results[0].text) && /Linear Algebra/.test(courses.results[0].text) && /<untrusted_page_content source="connector:canvas\/courses">/.test(courses.results[0].text), JSON.stringify(courses.results));
    check('Canvas: the card is Connected · Ada Student again after a re-read of the list', await waitFor(async () => (await app.evaluate(() => global.__connectors.list().connectors.find((c) => c.id === 'canvas').status)) === 'connected'), '');

    console.log('--- Gmail (a stand-in Google) and the GitHub preset (a pasted token)');
    await inSettings("document.getElementById('conn-gmail-connect').click(); true");
    await waitFor(async () => (await inSettings("Boolean(document.getElementById('conn-gmail-go'))")) === true);
    await inSettings("document.getElementById('conn-gmail-go').click(); true");
    await waitFor(async () => (await inSettings("document.querySelector('[data-connector=gmail]')?.dataset.status")) === 'connected');
    check('Gmail shows Connected · account', (await inSettings("document.querySelector('[data-connector=gmail] .conn-status')?.textContent")) === 'Connected · ada@example.com', '');
    await inSettings("document.getElementById('conn-github-connect').click(); true");
    await waitFor(async () => (await inSettings("Boolean(document.getElementById('conn-github-secret'))")) === true);
    check('GitHub: the token field is a password field', (await inSettings("document.getElementById('conn-github-secret').type")) === 'password', '');
    await inSettings("document.getElementById('conn-github-secret').value = 'hunter2'; document.getElementById('conn-github-go').click(); true");
    check('GitHub: a token that does not look like one is refused on the card, before it goes anywhere', await waitFor(async () => /doesn’t look like a GitHub token/.test(await inSettings("document.querySelector('[data-connector=github] .conn-form .note[aria-live]')?.textContent || ''"))) && !gh.seen.length, gh.seen.join());
    await inSettings(`document.getElementById('conn-github-secret').value = ${JSON.stringify(TOKENS.github)}; document.getElementById('conn-github-go').click(); true`);
    await waitFor(async () => (await inSettings("document.querySelector('[data-connector=github]')?.dataset.status")) === 'connected');
    check('GitHub shows Connected with its tool count, and its tools are listed on the card with Always allow', (await inSettings("document.querySelector('[data-connector=github] .conn-status')?.textContent")) === 'Connected · 1 tool' && (await inSettings("document.querySelector('[data-connector=github] #conn-github-tools li')?.textContent.trim()")) === 'list_pull_requests' && (await inSettings("Boolean(document.querySelector('[data-connector=github] #conn-github-tools input[aria-label=\"Always allow list_pull_requests\"]'))")) === true, await inSettings("document.querySelector('[data-connector=github]')?.outerHTML.slice(0, 600)"));
    check('GitHub: the server was started with the token as a bearer header, and is not listed under Custom MCP servers (its card manages it)', gh.seen.includes('initialize') && gh.seen.includes('tools/list') && (await inSettings("Boolean(document.querySelector('#mcp-servers [data-mcp-server=github]'))")) === false, gh.seen.join());
    // A custom server, added with the same form as before, under the cards.
    await inSettings("document.getElementById('mcp-server-add').click(); true");
    await waitFor(async () => (await inSettings("Boolean(document.getElementById('mcp-form-type'))")) === true);
    await inSettings(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); }; set('mcp-form-type', 'http'); set('mcp-form-name', 'mine'); set('mcp-form-url', ${JSON.stringify(gh.url)}); set('mcp-form-header-name', 'Authorization'); set('mcp-form-header-value', ${JSON.stringify(`Bearer ${TOKENS.github}`)}); document.getElementById('mcp-form-save').click(); return true; })()`);
    check('Custom MCP servers: a server added there is listed in the same page (with Edit, Remove and a switch)', await waitFor(async () => (await inSettings("Boolean(document.querySelector('#ai-connectors #mcp-servers [data-mcp-server=mine] .switch'))")) === true), await inSettings("document.getElementById('mcp-servers')?.outerHTML.slice(0, 400)"));
    await shot('connectors-after-connected', '[data-connector=github]');
    const pageHtml = String(await inSettings('document.documentElement.outerHTML'));
    check('settings: the page never holds a token or the session cookie', !pageHtml.includes(TOKENS.github) && !pageHtml.includes('fake-canvas-session'), 'secret in page');
    const disk = fs.readFileSync(path.join(profile, 'connectors.json'), 'utf8');
    const mcpDisk = fs.readFileSync(path.join(profile, 'mcp-servers.json'), 'utf8');
    const b64 = (t) => Buffer.from(t).toString('base64');
    check('on disk: the GitHub token is in neither file in plain text or plain base64 (the MCP file holds it sealed); connectors.json has only Canvas and Gmail’s settings', !disk.includes(TOKENS.github) && !mcpDisk.includes(TOKENS.github) && !mcpDisk.includes(b64(`Bearer ${TOKENS.github}`)) && !mcpDisk.includes(b64(TOKENS.github)) && /school\.instructure\.com/.test(disk) && !/github/.test(disk) && /"header"/.test(mcpDisk), `${disk}\n${mcpDisk}`);
    check('the list the page gets holds no token', await app.evaluate(async (_e, t) => !JSON.stringify(global.__connectors.list()).includes(t) && !JSON.stringify(global.__mcpClient.list()).includes(t), TOKENS.github), '');

    console.log('--- the AI uses them');
    const read = await run({ toolUses: [{ input: { app: 'canvas', action: 'upcoming', args: { days: 14 } } }, { input: { app: 'gmail', action: 'unread' } }] });
    const r0 = read.requests[0]?.[0];
    check('the model gets ONE connector tool, listing just the built-in apps that are connected, with a short description; the preset’s tool is an ordinary MCP tool beside it', read.requests[0]?.length === 1 && JSON.stringify(r0.enum) === '["canvas","gmail"]' && /canvas:/.test(r0.description) && /gmail:/.test(r0.description) && !/github:/.test(r0.description) && r0.description.length < 1500 && read.toolNames.includes('github__list_pull_requests') && read.toolNames.includes('mine__list_pull_requests'), JSON.stringify([r0, read.toolNames.filter((n) => /__/.test(n))]));
    check('a read returns the data (Canvas assignments, Gmail unread mail)', read.results.length === 2 && read.results.every((r) => !r.error) && /Lab 5 report \(Fundamentals of Computer Science\)/.test(read.results[0].text) && /Grades/.test(read.results[1].text), JSON.stringify(read.results));
    const labels = read.events.filter((e) => e.type === 'tool' && e.name === 'connector').map((e) => e.label);
    check('each step reads "Using Canvas · Upcoming assignments"', JSON.stringify(labels) === '["Using Canvas · Upcoming assignments","Using Gmail · Unread mail"]', JSON.stringify(labels));
    check('a read asks for no card', !read.events.some((e) => e.type === 'approval'), JSON.stringify(read.events.filter((e) => e.type === 'approval')));
    check('Canvas was read with the signed-in session only', fakes.seen.filter((r) => r.service === 'canvas').slice(-3).every((r) => r.cookie.includes('canvas_session=') && !r.auth), '');
    const bad = await run({ toolUses: [{ input: { app: 'canvas', action: 'drop_course' } }, { input: { app: 'gmail', action: 'search', args: {} } }, { input: { app: 'drive', action: 'files' } }] });
    check('a bad action, a missing argument and an app that is not connected are answered as errors the model can fix', bad.results.every((r) => r.error) && /Unknown action/.test(bad.results[0].text) && /Missing argument: query/.test(bad.results[1].text) && /Unknown app/.test(bad.results[2].text), JSON.stringify(bad.results));
    const called = gh.seen.filter((m) => m === 'tools/call:list_pull_requests').length;
    const ghDenied = await run({ toolUses: [{ name: 'github__list_pull_requests', input: { state: 'open' } }], answer: false });
    const ghCard = ghDenied.events.find((e) => e.type === 'approval');
    check('a preset’s tool asks on a card with what it would send (a read of GitHub through MCP is not free), and denying it sends nothing', ghCard?.action === 'tool' && /github/i.test(ghCard.title) && /open/.test(ghCard.args) && ghDenied.results[0]?.error && gh.seen.filter((m) => m === 'tools/call:list_pull_requests').length === called, JSON.stringify({ ghCard, r: ghDenied.results }));
    const ghAllowed = await run({ toolUses: [{ name: 'github__list_pull_requests', input: { state: 'open' } }], answer: true });
    check('allowing it runs the tool, and the answer comes back marked as untrusted', !ghAllowed.results[0]?.error && /PR #12 Add dark mode/.test(ghAllowed.results[0].text) && /untrusted_page_content/.test(ghAllowed.results[0].text) && gh.seen.filter((m) => m === 'tools/call:list_pull_requests').length === called + 1, JSON.stringify(ghAllowed.results));

    console.log('--- a write asks first');
    const drafts = () => fakes.seen.filter((r) => r.service === 'gmail' && r.method === 'POST').length;
    const draftArgs = { to: 'prof@school.edu', subject: 'Question', body: 'Hello Professor' };
    const denied = await run({ toolUses: [{ input: { app: 'gmail', action: 'create_draft', args: draftArgs } }], answer: false });
    const card = denied.events.find((e) => e.type === 'approval');
    check('create_draft shows a card with what it will do, with auto-allow on, and no "Always allow"', card?.action === 'tool' && /Gmail/.test(card.title) && /prof@school\.edu/.test(card.args) && /Hello Professor/.test(card.args) && card.noAlways === true && card.note === 'connector' && card.fields?.list?.map((f) => f.key).join() === 'to,cc,subject,body', JSON.stringify(card));
    check('deny: nothing is sent to Gmail, and the model is told', drafts() === 0 && denied.results[0]?.error && /did not allow/.test(denied.results[0].text), JSON.stringify({ posts: drafts(), r: denied.results }));
    const allowed = await run({ toolUses: [{ input: { app: 'canvas', action: 'courses' } }, { input: { app: 'gmail', action: 'create_draft', args: draftArgs } }], answer: true });
    const card2 = allowed.events.find((e) => e.type === 'approval');
    check('allow: the draft is made, and the card knows the chat had read connected data', drafts() === 1 && /Draft made, not sent/.test(allowed.results[1]?.text) && card2?.tainted === true, JSON.stringify({ posts: drafts(), r: allowed.results, card2 }));
    const always = await run({ toolUses: [{ input: { app: 'gmail', action: 'create_draft', args: { ...draftArgs, subject: 'One' } } }, { input: { app: 'gmail', action: 'create_draft', args: { ...draftArgs, subject: 'Two' } } }], answer: 'always' });
    check('answering "always" doesn’t skip the next one: every write asks', always.events.filter((e) => e.type === 'approval').length === 2, JSON.stringify(always.events.filter((e) => e.type === 'approval')));
    const cardDom = await ui.evaluate(() => {
      showApproval(9101, 'Gmail', { action: 'tool', title: 'Claude wants to: Use Gmail: Make a draft', args: 'A new email in your Gmail Drafts.\nBuy', tainted: false, noAlways: true, note: 'connector' });
      const c = [...document.querySelectorAll('.approval-tool')].pop();
      const out = { always: Boolean(c.querySelector('.approval-always')), detail: c.querySelector('.approval-detail')?.textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent) };
      resolveApproval(9101, false);
      return out;
    });
    check('the card in the chat: names the change, says it happens in your account, has no Always button', !cardDom.always && /your account/.test(cardDom.detail) && cardDom.buttons.includes('Allow once'), JSON.stringify(cardDom));

    console.log('--- nobody else gets in: outside agents, bypass, agents that do not ask, hands-off');
    const viaMcp = await app.evaluate(async () => {
      const sess = { approvedHosts: new Set(), clientName: 'ConnectorsCheck', controller: new AbortController() };
      const names = global.__mcpTools.map((t) => t.name);
      const read = await global.__mcpCallTool('connector', { app: 'gmail', action: 'unread' }, sess);
      const write = await global.__mcpCallTool('connector', { app: 'gmail', action: 'create_draft', args: { to: 'a@b.org', subject: 'From outside', body: 'x' } }, sess);
      const gate = {};
      for (const [k, input] of [['read', { app: 'gmail', action: 'unread' }], ['write', { app: 'gmail', action: 'create_draft', args: { to: 'a@b.org', subject: 'x', body: 'x' } }]]) {
        try { await global.__agent.ensureAllowed('connector', () => {}, new AbortController().signal, { external: true, noAsk: true, who: 'Codex', input }); gate[k] = 'passed'; } catch (e) { gate[k] = e.message; }
      }
      const preset = await global.__mcpCallTool('github__list_pull_requests', {}, sess);
      return { listed: names.includes('connector') || names.includes('github__list_pull_requests'), read: { text: (read.content || []).map((x) => x.text).join(' '), isError: read.isError }, write: { text: (write.content || []).map((x) => x.text).join(' '), isError: write.isError }, preset: { text: (preset.content || []).map((x) => x.text).join(' '), isError: preset.isError }, gate, windows: global.__windows.list().length };
    });
    const posts = () => fakes.seen.filter((r) => r.service === 'gmail' && r.method === 'POST').length;
    check('an MCP agent is not offered the connector tool or the preset’s tools, and a call to them is refused for reads and writes alike (nothing sent)', !viaMcp.listed && viaMcp.read.isError && !/Grades/.test(viaMcp.read.text) && viaMcp.write.isError && viaMcp.preset.isError && /Unknown tool/.test(`${viaMcp.read.text} ${viaMcp.write.text} ${viaMcp.preset.text}`) && /Unknown tool/.test(viaMcp.gate.read) && /Unknown tool/.test(viaMcp.gate.write) && !fakes.seen.some((r) => /From outside/.test(r.body)), JSON.stringify(viaMcp));
    const postsBeforeBypass = posts();
    await app.evaluate(() => { global.__agent.browser.bypassPermissions = () => true; });
    const bypassed = await run({ toolUses: [{ input: { app: 'gmail', action: 'create_draft', args: { ...draftArgs, subject: 'Bypass try' } } }], answer: false });
    check('Bypass permissions does not answer a connector write: the card still comes, and denying it sends nothing', bypassed.events.some((e) => e.type === 'approval' && e.action === 'tool' && /Bypass try/.test(e.args)) && posts() === postsBeforeBypass && bypassed.results[0]?.error, JSON.stringify(bypassed));
    await app.evaluate(() => { global.__agent.browser.bypassPermissions = () => false; });
    const noAsk = await app.evaluate(async () => {
      const input = { app: 'gmail', action: 'create_draft', args: { to: 'a@b.org', subject: 'Quiet agent', body: 'x' } };
      try { await global.__agent.ensureAllowed('connector', () => {}, new AbortController().signal, { noAsk: true, who: 'Claude', input }); return 'passed'; } catch (e) { return e.message; }
    });
    check('an agent set not to ask (a background task, an agent’s own window) cannot make a draft: it has to be told to ask the user', /needs the user to say yes/.test(noAsk) && posts() === postsBeforeBypass, noAsk);
    await app.evaluate(() => { global.__agent.browser.handsOff = () => true; });
    const hands = await run({ toolUses: [{ input: { app: 'gmail', action: 'create_draft', args: { ...draftArgs, subject: 'Hands off try' } } }, { input: { app: 'gmail', action: 'unread' } }], answer: true });
    check('hands-off mode blocks the write (no card, nothing sent) but not the read', !hands.events.some((e) => e.type === 'approval') && posts() === postsBeforeBypass && hands.results[0]?.error && /hands-off/.test(hands.results[0].text) && !hands.results[1]?.error, JSON.stringify(hands));
    await app.evaluate(() => { global.__agent.browser.handsOff = () => false; });

    console.log('--- a run Lumen started itself (Claude Code and the other command-line engines) gets the tool; nobody else does');
    // A fake Lumen-owned CLI run: its per-run tag is what the MCP server knows it by (features/ai-agents.js runTools). An outside client has none.
    const cli = (answer, { bypass = false } = {}) => app.evaluate(async (_e, { answer: ans, bypass: byp }) => {
      const agent = global.__agent;
      agent.reset();
      agent.browser.bypassPermissions = () => byp;
      agent.messages.settings = { model: 'claudecode:default', adhdMode: true };
      const out = { events: [] };
      const text = (r) => (r.content || []).map((b) => b.text).join(' ');
      agent.claudeCodeTurn = async (_m, _t, _i, signal, emit) => {
        const tee = (e) => { out.events.push(e); if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, ans), 20); emit(e); };
        global.__fakeEngine = { owns: (t) => t === 'run-tag-1', active: { emit: tee, signal, scope: agent.runScope } };
        const own = { engine: 'run-tag-1', approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() };
        const outside = { approvedHosts: new Set(), clientName: 'Some other app', controller: new AbortController() };
        const forged = { engine: 'guessed-tag', approvedHosts: new Set(), clientName: 'Forger', controller: new AbortController() };
        out.listed = { own: global.__mcpToolsFor(own).includes('connector'), outside: global.__mcpToolsFor(outside).includes('connector'), forged: global.__mcpToolsFor(forged).includes('connector') };
        const read = await global.__mcpCallTool('connector', { app: 'gmail', action: 'unread' }, own);
        out.read = { text: text(read), isError: read.isError };
        const write = await global.__mcpCallTool('connector', { app: 'gmail', action: 'create_draft', args: { to: 'prof@school.edu', subject: 'From the CLI', body: 'x' } }, own);
        out.write = { text: text(write), isError: write.isError };
        const outRead = await global.__mcpCallTool('connector', { app: 'gmail', action: 'unread' }, outside);
        const outWrite = await global.__mcpCallTool('connector', { app: 'gmail', action: 'create_draft', args: { to: 'prof@school.edu', subject: 'From outside', body: 'x' } }, outside);
        const forgedRead = await global.__mcpCallTool('connector', { app: 'gmail', action: 'unread' }, forged);
        out.outside = [outRead, outWrite, forgedRead].map((r) => ({ isError: r.isError, text: text(r) }));
      };
      await new Promise((resolve) => agent.run('use my apps', (e) => { if (e.type === 'done') resolve(); }));
      global.__fakeEngine = null;
      agent.browser.bypassPermissions = () => false;
      return out;
    }, { answer, bypass });
    const before = posts();
    const cliDenied = await cli(false, { bypass: true });
    check('a Lumen-owned CLI run is offered the connector tool; an outside client and a forged tag are not', cliDenied.listed?.own === true && cliDenied.listed.outside === false && cliDenied.listed.forged === false, JSON.stringify(cliDenied.listed));
    check('…it can read (untrusted data), and the same call from an outside client or a forged tag is refused', !cliDenied.read?.isError && /Grades/.test(cliDenied.read.text) && /untrusted_page_content/.test(cliDenied.read.text) && cliDenied.outside?.every((r) => r.isError && /Unknown tool/.test(r.text)), JSON.stringify(cliDenied));
    const cliCard = cliDenied.events.find((e) => e.type === 'approval');
    check('…its write shows the card (even with Bypass permissions on, and with no Always allow) and denying it sends nothing', cliCard?.action === 'tool' && /From the CLI/.test(cliCard.args) && cliCard.noAlways === true && cliDenied.write?.isError && posts() === before && !fakes.seen.some((r) => /From outside/.test(r.body)), JSON.stringify({ cliCard, write: cliDenied.write }));
    const cliAllowed = await cli(true);
    check('…and allowing the card makes the draft', !cliAllowed.write?.isError && /Draft made, not sent/.test(cliAllowed.write.text) && posts() === before + 1, JSON.stringify(cliAllowed.write));

    console.log('--- disconnect');
    await inSettings("window.confirm = () => true; document.getElementById('conn-github-disconnect').click(); true");
    await waitFor(async () => (await inSettings("document.querySelector('[data-connector=github]')?.dataset.status")) === 'off');
    check('GitHub disconnected from the page: the card is Not connected again and its MCP server is gone (the custom one stays)', (await inSettings("document.querySelector('[data-connector=github] .conn-status')?.textContent")) === 'Not connected' && await app.evaluate(() => global.__mcpClient.list().map((s) => s.name).join()) === 'mine' && (await inSettings("Boolean(document.querySelector('#mcp-servers [data-mcp-server=mine]'))")) === true, await app.evaluate(() => global.__mcpClient.list().map((s) => s.name).join()));
    check('its token is gone from the MCP file too', !fs.readFileSync(path.join(profile, 'mcp-servers.json'), 'utf8').includes('"preset"'), fs.readFileSync(path.join(profile, 'mcp-servers.json'), 'utf8'));
    const afterOne = await run({ toolUses: [{ input: { app: 'github', action: 'prs' } }] });
    check('the model’s tools no longer list GitHub (not as an app, not as a tool), and a call to the connector for it fails without reaching GitHub', afterOne.requests[0]?.[0] && !/github:/.test(afterOne.requests[0][0].description) && !afterOne.requests[0][0].enum.includes('github') && !afterOne.toolNames.includes('github__list_pull_requests') && afterOne.results[0]?.error && /Unknown app/.test(afterOne.results[0].text), JSON.stringify(afterOne));
    await inSettings("document.querySelector('#mcp-servers [data-mcp-server=mine] .item button:nth-of-type(3)')?.click(); true"); // Remove (confirm is stubbed)
    for (const id of ['gmail', 'canvas']) {
      await inSettings(`document.getElementById('conn-${id}-disconnect').click(); true`);
      await waitFor(async () => (await inSettings(`document.querySelector('[data-connector=${id}]')?.dataset.status`)) === 'off');
    }
    const none = await run({ toolUses: [] });
    const disk3 = fs.readFileSync(path.join(profile, 'connectors.json'), 'utf8');
    check('everything disconnected: the model gets no connector tool, the MCP list drops it, the file holds nothing', none.requests[0]?.length === 0 && !(await app.evaluate(() => global.__mcpTools.map((t) => t.name).includes('connector'))) && JSON.stringify(JSON.parse(disk3).connected) === '{}' && !disk3.includes('Bearer'), disk3);
    check('no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await app.close().catch(() => {});
    await fakes.stop();
    gh.server.closeAllConnections?.();
    gh.server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 500);
}).catch((err) => { console.log(`FAIL  no exceptions  -> ${err.stack}`); process.exit(1); });

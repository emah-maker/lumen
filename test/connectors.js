// Connectors in Lumen (features/connectors/, agent.js `connector` tool, Settings → You and AI → Connectors), with no real network:
// stand-in Canvas, GitHub and Todoist on 127.0.0.1 (test/fixtures/fake-connectors.js), a fake model in place of Claude.
//  - the settings page shows the gallery; connecting Canvas (the signed-in session), GitHub and Todoist (a pasted token) works from it;
//  - the token on disk is encrypted, and the page never gets it back;
//  - connected, the AI has ONE `connector` tool listing just those apps; a read returns the data with a readable step label and no card;
//  - a write (add a task) always asks, with the details and no "Always allow", even with auto-allow on; deny sends nothing;
//  - an outside MCP agent is offered no connector tool and is refused if it asks; Bypass permissions, agents that don't ask and hands-off mode never answer a write; disconnecting removes the token, the tool and the AI's way in.
// Run it through the machine-wide lock: node scripts/e2e-lock.js run -- node test/connectors.js
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakes, TOKENS } = require('./fixtures/fake-connectors');
const { openSettingsTab } = require('./settings-tab');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

async function main() {
  const fakes = await startFakes();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    await app.evaluate(async ({ session }, urls) => {
      global.__connectorEndpoints = { canvas: urls.canvas, github: urls.github, todoist: urls.todoist };
      const agent = global.__agent;
      agent.browser.autoApprove = () => true; // auto-allow ON: a write must still ask
      agent.browser.effectiveModel = (m) => m;
      const base = agent.getOptions;
      agent.getOptions = () => ({ ...base(), pageContext: false });
    }, fakes.urls);

    console.log('--- the gallery');
    const inSettings = await openSettingsTab(app, 'you-and-ai');
    await waitFor(async () => (await inSettings("document.querySelectorAll('[data-connector]').length")) > 5);
    const gallery = await inSettings("JSON.stringify({ cats: [...document.querySelectorAll('.conn-cat h3')].map((h) => h.textContent), cards: [...document.querySelectorAll('[data-connector]')].map((c) => [c.dataset.connector, c.dataset.status, c.querySelector('.conn-status')?.textContent, c.querySelector('button')?.textContent]) })");
    const g = JSON.parse(gallery);
    check('settings: a gallery grouped by Mail and calendar, School, Files and docs, Work, Tasks, Music', g.cats.join() === 'Mail and calendar,School,Files and docs,Work,Tasks,Music', gallery);
    check('settings: every card starts Not connected with a Connect button; the unfinished ones say Coming soon', g.cards.find((c) => c[0] === 'canvas')?.slice(1).join('|') === 'off|Not connected|Connect' && g.cards.find((c) => c[0] === 'github')?.[2] === 'Not connected' && g.cards.find((c) => c[0] === 'drive')?.[2] === 'Coming soon' && g.cards.find((c) => c[0] === 'spotify')?.[3] === 'Coming soon', gallery);
    const permsText = await inSettings("(document.querySelector('[data-connector=todoist] .conn-details')?.textContent || '')");
    check('settings: a card says exactly what the AI can read and do before anything is connected', /Your tasks and projects/.test(permsText) && /Add a task \(asks you first\)/.test(permsText) && /Disconnect deletes it/.test(permsText), permsText);
    check('nothing is connected yet, so the AI is offered no connector tool', await app.evaluate(() => global.__connectors.defs().length === 0 && !global.__mcpTools.map((t) => t.name).includes('connector')), '');

    // One sidebar run with a fake Claude asking for `toolUses` in order; every card gets `answer`.
    const run = (opts) => app.evaluate(async (_e, { toolUses, answer = true }) => {
      const agent = global.__agent;
      agent.reset();
      agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
      let turn = 0;
      const requests = [];
      agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        requests.push(params.tools.filter((t) => t.name === 'connector').map((t) => ({ name: t.name, description: t.description, enum: t.input_schema.properties.app.enum })));
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
      return { events: events.filter((e) => e.type === 'approval' || e.type === 'notice' || e.type === 'tool'), results, requests };
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

    console.log('--- GitHub and Todoist: a pasted token');
    for (const [id, token] of [['github', TOKENS.github], ['todoist', TOKENS.todoist]]) {
      await inSettings(`document.getElementById('conn-${id}-connect').click(); true`);
      await waitFor(async () => (await inSettings(`Boolean(document.getElementById('conn-${id}-secret'))`)) === true);
      const type = await inSettings(`document.getElementById('conn-${id}-secret').type`);
      check(`${id}: the token field is a password field`, type === 'password', type);
      await inSettings(`document.getElementById('conn-${id}-secret').value = ${JSON.stringify(token)}; document.getElementById('conn-${id}-go').click(); true`);
      await waitFor(async () => (await inSettings(`document.querySelector('[data-connector=${id}]')?.dataset.status`)) === 'connected');
    }
    check('GitHub and Todoist show Connected · account', (await inSettings("document.querySelector('[data-connector=github] .conn-status')?.textContent")) === 'Connected · ada-dev' && (await inSettings("document.querySelector('[data-connector=todoist] .conn-status')?.textContent")) === 'Connected · ada@example.com', '');
    const pageHtml = String(await inSettings("document.documentElement.outerHTML"));
    check('settings: the page never holds a token or the session cookie', !pageHtml.includes(TOKENS.github) && !pageHtml.includes(TOKENS.todoist) && !pageHtml.includes('fake-canvas-session'), 'secret in page');
    const disk = fs.readFileSync(path.join(profile, 'connectors.json'), 'utf8');
    const b64 = (t) => Buffer.from(t).toString('base64');
    check('on disk: the tokens are encrypted (no plaintext, no plain base64), only the account and settings are readable', !disk.includes(TOKENS.github) && !disk.includes(TOKENS.todoist) && !disk.includes(b64(TOKENS.github)) && !disk.includes(b64(TOKENS.todoist)) && /"secret": "/.test(disk) && /school\.instructure\.com/.test(disk), disk);
    check('…and no other file in the profile holds a token', ['settings.json', 'mcp-servers.json'].every((n) => { try { return !fs.readFileSync(path.join(profile, n), 'utf8').includes(TOKENS.github); } catch { return true; } }), '');
    const secretWrong = await app.evaluate(async (_e, t) => !JSON.stringify(global.__connectors.list()).includes(t), TOKENS.github);
    check('the list the page gets holds no token', secretWrong, '');

    console.log('--- the AI uses them');
    const read = await run({ toolUses: [{ input: { app: 'canvas', action: 'upcoming', args: { days: 14 } } }, { input: { app: 'github', action: 'prs' } }, { input: { app: 'todoist', action: 'tasks' } }] });
    const r0 = read.requests[0]?.[0];
    check('the model gets ONE connector tool, listing just the connected apps, with a short description', read.requests[0]?.length === 1 && JSON.stringify(r0.enum) === '["canvas","github","todoist"]' && /canvas:/.test(r0.description) && /github:/.test(r0.description) && /todoist:/.test(r0.description) && !/gmail:|notion:/.test(r0.description) && r0.description.length < 900, JSON.stringify(r0));
    check('a read returns the data (Canvas assignments, GitHub pull requests, Todoist tasks)', read.results.length === 3 && read.results.every((r) => !r.error) && /Lab 5 report \(Fundamentals of Computer Science\)/.test(read.results[0].text) && /Add dark mode/.test(read.results[1].text) && /Read chapter 4/.test(read.results[2].text), JSON.stringify(read.results));
    const labels = read.events.filter((e) => e.type === 'tool' && e.name === 'connector').map((e) => e.label);
    check('each step reads "Using Canvas · Upcoming assignments"', JSON.stringify(labels) === '["Using Canvas · Upcoming assignments","Using GitHub · Your pull requests","Using Todoist · Your tasks"]', JSON.stringify(labels));
    check('a read asks for no card', !read.events.some((e) => e.type === 'approval'), JSON.stringify(read.events.filter((e) => e.type === 'approval')));
    check('the requests went only to the three stand-in services, with the right credential each', fakes.seen.filter((r) => r.service === 'github').every((r) => r.auth === `Bearer ${TOKENS.github}`) && fakes.seen.filter((r) => r.service === 'todoist').every((r) => r.auth === `Bearer ${TOKENS.todoist}`) && fakes.seen.filter((r) => r.service === 'canvas').slice(-3).every((r) => r.cookie.includes('canvas_session=') && !r.auth), '');
    const bad = await run({ toolUses: [{ input: { app: 'canvas', action: 'drop_course' } }, { input: { app: 'github', action: 'pr', args: { repo: 'ada/x' } } }, { input: { app: 'gmail', action: 'unread' } }] });
    check('a bad action, a missing argument and an app that is not connected are answered as errors the model can fix', bad.results.every((r) => r.error) && /Unknown action/.test(bad.results[0].text) && /Missing argument: number/.test(bad.results[1].text) && /Unknown app/.test(bad.results[2].text), JSON.stringify(bad.results));

    console.log('--- a write asks first');
    const postsBefore = () => fakes.seen.filter((r) => r.service === 'todoist' && r.method === 'POST').length;
    const denied = await run({ toolUses: [{ input: { app: 'todoist', action: 'add_task', args: { content: 'Buy a stapler', due: 'tomorrow 9am' } } }], answer: false });
    const card = denied.events.find((e) => e.type === 'approval');
    check('add_task shows a card with what it will do, with auto-allow on, and no "Always allow"', card?.action === 'tool' && /Todoist/.test(card.title) && /Buy a stapler/.test(card.args) && /tomorrow 9am/.test(card.args) && card.noAlways === true && card.note === 'connector' && card.fields?.list?.map((f) => f.key).join() === 'content,due', JSON.stringify(card));
    check('deny: nothing is sent to Todoist, and the model is told', postsBefore() === 0 && denied.results[0]?.error && /did not allow/.test(denied.results[0].text), JSON.stringify({ posts: postsBefore(), r: denied.results }));
    const allowed = await run({ toolUses: [{ input: { app: 'canvas', action: 'courses' } }, { input: { app: 'todoist', action: 'add_task', args: { content: 'Buy a stapler', due: 'tomorrow 9am' } } }], answer: true });
    const card2 = allowed.events.find((e) => e.type === 'approval');
    check('allow: the task is added, and the card knows the chat had read connected data', postsBefore() === 1 && /Added: \d+\s+Buy a stapler/.test(allowed.results[1]?.text) && card2?.tainted === true, JSON.stringify({ posts: postsBefore(), r: allowed.results, card2 }));
    const always = await run({ toolUses: [{ input: { app: 'todoist', action: 'add_task', args: { content: 'One' } } }, { input: { app: 'todoist', action: 'add_task', args: { content: 'Two' } } }], answer: 'always' });
    check('answering "always" doesn’t skip the next one: every write asks', always.events.filter((e) => e.type === 'approval').length === 2, JSON.stringify(always.events.filter((e) => e.type === 'approval')));
    const cardDom = await ui.evaluate(() => {
      showApproval(9101, 'Todoist', { action: 'tool', title: 'Claude wants to: Use Todoist: Add a task', args: 'Add this task to Todoist:\nBuy', tainted: false, noAlways: true, note: 'connector' });
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
      const read = await global.__mcpCallTool('connector', { app: 'github', action: 'prs' }, sess);
      const write = await global.__mcpCallTool('connector', { app: 'todoist', action: 'add_task', args: { content: 'From outside' } }, sess);
      const gate = {};
      for (const [k, input] of [['read', { app: 'github', action: 'prs' }], ['write', { app: 'todoist', action: 'add_task', args: { content: 'x' } }]]) {
        try { await global.__agent.ensureAllowed('connector', () => {}, new AbortController().signal, { external: true, noAsk: true, who: 'Codex', input }); gate[k] = 'passed'; } catch (e) { gate[k] = e.message; }
      }
      return { listed: names.includes('connector'), read: { text: (read.content || []).map((x) => x.text).join(' '), isError: read.isError }, write: { text: (write.content || []).map((x) => x.text).join(' '), isError: write.isError }, gate, windows: global.__windows.list().length };
    });
    const posts = () => fakes.seen.filter((r) => r.service === 'todoist' && r.method === 'POST').length;
    check('an MCP agent is not offered the connector tool, and a call to it is refused for reads and writes alike (nothing sent)', !viaMcp.listed && viaMcp.read.isError && !/Add dark mode/.test(viaMcp.read.text) && viaMcp.write.isError && /Unknown tool/.test(`${viaMcp.read.text} ${viaMcp.write.text}`) && /Unknown tool/.test(viaMcp.gate.read) && /Unknown tool/.test(viaMcp.gate.write) && !fakes.seen.some((r) => r.service === 'todoist' && /From outside/.test(r.body)), JSON.stringify(viaMcp));
    const postsBeforeBypass = posts();
    await app.evaluate(() => { global.__agent.browser.bypassPermissions = () => true; });
    const bypassed = await run({ toolUses: [{ input: { app: 'todoist', action: 'add_task', args: { content: 'Bypass try' } } }], answer: false });
    check('Bypass permissions does not answer a connector write: the card still comes, and denying it sends nothing', bypassed.events.some((e) => e.type === 'approval' && e.action === 'tool' && /Bypass try/.test(e.args)) && posts() === postsBeforeBypass && bypassed.results[0]?.error, JSON.stringify(bypassed));
    await app.evaluate(() => { global.__agent.browser.bypassPermissions = () => false; });
    const noAsk = await app.evaluate(async () => {
      const input = { app: 'todoist', action: 'add_task', args: { content: 'Quiet agent' } };
      try { await global.__agent.ensureAllowed('connector', () => {}, new AbortController().signal, { noAsk: true, who: 'Claude', input }); return 'passed'; } catch (e) { return e.message; }
    });
    check('an agent set not to ask (a background task, an agent’s own window) cannot add a task: it has to be told to ask the user', /needs the user to say yes/.test(noAsk) && posts() === postsBeforeBypass, noAsk);
    await app.evaluate(() => { global.__agent.browser.handsOff = () => true; });
    const hands = await run({ toolUses: [{ input: { app: 'todoist', action: 'add_task', args: { content: 'Hands off try' } } }, { input: { app: 'todoist', action: 'tasks' } }], answer: true });
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
        const read = await global.__mcpCallTool('connector', { app: 'github', action: 'prs' }, own);
        out.read = { text: text(read), isError: read.isError };
        const write = await global.__mcpCallTool('connector', { app: 'todoist', action: 'add_task', args: { content: 'From the CLI' } }, own);
        out.write = { text: text(write), isError: write.isError };
        const outRead = await global.__mcpCallTool('connector', { app: 'github', action: 'prs' }, outside);
        const outWrite = await global.__mcpCallTool('connector', { app: 'todoist', action: 'add_task', args: { content: 'From outside' } }, outside);
        const forgedRead = await global.__mcpCallTool('connector', { app: 'github', action: 'prs' }, forged);
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
    check('…it can read (untrusted data), and the same call from an outside client or a forged tag is refused', !cliDenied.read?.isError && /Add dark mode/.test(cliDenied.read.text) && /untrusted_page_content/.test(cliDenied.read.text) && cliDenied.outside?.every((r) => r.isError && /Unknown tool/.test(r.text)), JSON.stringify(cliDenied));
    const cliCard = cliDenied.events.find((e) => e.type === 'approval');
    check('…its write shows the card (even with Bypass permissions on, and with no Always allow) and denying it sends nothing', cliCard?.action === 'tool' && /From the CLI/.test(cliCard.args) && cliCard.noAlways === true && cliDenied.write?.isError && posts() === before && !fakes.seen.some((r) => /From outside/.test(r.body)), JSON.stringify({ cliCard, write: cliDenied.write }));
    const cliAllowed = await cli(true);
    check('…and allowing the card adds the task', !cliAllowed.write?.isError && /Added: \d+\s+From the CLI/.test(cliAllowed.write.text) && posts() === before + 1, JSON.stringify(cliAllowed.write));

    console.log('--- disconnect');
    await inSettings("window.confirm = () => true; document.getElementById('conn-github-disconnect').click(); true");
    await waitFor(async () => (await inSettings("document.querySelector('[data-connector=github]')?.dataset.status")) === 'off');
    check('GitHub disconnected from the page: the card is Not connected again', (await inSettings("document.querySelector('[data-connector=github] .conn-status')?.textContent")) === 'Not connected', '');
    const disk2 = fs.readFileSync(path.join(profile, 'connectors.json'), 'utf8');
    check('its token is gone from the file (the others stay)', !/github/.test(disk2) && /todoist/.test(disk2) && /canvas/.test(disk2), disk2);
    const afterOne = await run({ toolUses: [{ input: { app: 'github', action: 'prs' } }] });
    check('the model’s tool no longer lists GitHub, and a call to it fails without reaching GitHub', afterOne.requests[0]?.[0] && !/github:/.test(afterOne.requests[0][0].description) && !afterOne.requests[0][0].enum.includes('github') && afterOne.results[0]?.error && /Unknown app/.test(afterOne.results[0].text), JSON.stringify(afterOne));
    for (const id of ['todoist', 'canvas']) {
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
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 500);
}).catch((err) => { console.log(`FAIL  no exceptions  -> ${err.stack}`); process.exit(1); });

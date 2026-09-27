// The sidebar AI keeps working in the tab it started on (switching tabs mid-task can't redirect its
// actions), the model it uses is the one the picker shows, long chats are trimmed to fit, and a few
// reply-formatting cases (markdown tables, numbered lists, deep headings).
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${req.url}</title><h1>${req.url}</h1><button onclick="document.title='clicked ${req.url}'">Go</button>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // Only an OpenAI key: no Claude. The picker and the agent must agree on an OpenAI model.
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const picked = await ui.evaluate(async () => (await window.assistant.getSettings()).model);
  const used = await app.evaluate(() => global.__agent.getOptions().model);
  check('with only an OpenAI key, the picker shows an OpenAI model', /^openai:/.test(String(picked)), picked);
  check('and the agent uses that same model (not Claude)', used === picked, `${used} vs ${picked}`);

  // Tab lock. Tab A is in front when the task starts; the user switches to tab B while the model is
  // thinking; the click the model then asks for must land in tab A.
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/a`);
  await app.evaluate((_e, u) => { global.__tabB = global.__agent.browser.openTab(u); }, `${base}/b`);
  await sleep(800);
  const tabA = await app.evaluate(() => global.__agent.browser.listTabs().find((t) => t.url.endsWith('/a')).id);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), tabA);
  await app.evaluate(() => {
    global.__release = null;
    let turn = 0;
    global.__agent.setModel('claude-opus-5');
    global.__agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    global.__agent.browser.effectiveModel = (m) => m; // a fake Claude below; skip the connected-model check
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      turn++;
      const message = turn === 1
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'click', input: { text: 'Go' } }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return {
        async *[Symbol.asyncIterator]() { if (turn === 1) await new Promise((r) => { global.__release = r; }); },
        finalMessage: async () => message,
      };
    } } } });
    global.__events = [];
    global.__runDone = new Promise((resolve) => global.__agent.run('click Go', (e) => { global.__events.push(e); if (e.type === 'done') resolve(); }));
  });
  await sleep(700);
  await app.evaluate(() => global.__agent.browser.switchTab(global.__tabB.id)); // the user looks at another tab
  await sleep(300);
  await app.evaluate(() => global.__release?.());
  await app.evaluate(() => global.__runDone);
  await sleep(500);
  const titles = await app.evaluate(() => global.__agent.browser.listTabs().map((t) => [t.url.replace(/^.*\//, '/'), t.title, t.active]));
  const a = titles.find(([u]) => u === '/a');
  const b = titles.find(([u]) => u === '/b');
  check('the click landed in the tab the task started in', a?.[1] === 'clicked /a', JSON.stringify(titles));
  check('the tab the user switched to was left alone', b?.[1] === 'Page /b', JSON.stringify(titles));
  check('and the user stays on the tab they chose', b?.[2] === true, JSON.stringify(titles));

  // A task whose tab closes stops with a clear message instead of acting elsewhere.
  await app.evaluate(async (_e, id) => {
    const agent = global.__agent;
    global.__closedResult = await agent.inTask(id, new AbortController().signal, async () => {
      agent.browser.closeTab(id);
      try { await agent.execute('read_page', {}); return 'read another tab'; } catch (err) { return err.message; }
    });
  }, tabA);
  check('a closed task tab is reported, not swapped for another tab', /was closed/.test(await app.evaluate(() => global.__closedResult)), await app.evaluate(() => global.__closedResult));

  // Context budget: a chat far over the budget sends only its newest turns, starting at a user message.
  const fit = await app.evaluate(() => {
    const fitContext = global.__fitContext;
    const big = 'x'.repeat(50000);
    const msgs = [];
    for (let i = 0; i < 40; i++) { msgs.push({ role: 'user', content: [{ type: 'text', text: `q${i} ${big}` }] }); msgs.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] }); }
    const out = fitContext(msgs, 600000);
    return { n: out.length, firstRole: out[0].role, note: out[0].content[0].text, last: out[out.length - 1].content[0].text };
  });
  check('a long chat is trimmed to fit, oldest turns first', fit.n < 80 && fit.n > 2 && fit.firstRole === 'user' && /left out/.test(fit.note) && fit.last === 'a39', JSON.stringify(fit));

  // Markdown: a sentence with | after a table stays text; numbered lists keep counting; #### is a heading.
  const md = await ui.evaluate(() => window.renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\nx | y is not a row\n\n1. one\n\n```\ncode\n```\n\n2. two\n\n#### Deep'));
  check('a line with | after a table is not pulled into it', (md.match(/<tr>/g) || []).length === 2 && md.includes('<p>x | y is not a row</p>'), md);
  check('a numbered list split by a code block keeps counting', md.includes('<ol start="2">'), md);
  check('#### renders as a heading', md.includes('<h4>Deep</h4>'), md);

  check('no UI errors', errors.length === 0, errors.join('; '));
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

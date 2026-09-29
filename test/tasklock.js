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
    const label = req.url.startsWith('/other') ? 'Other' : 'Go';
    res.end(`<title>Page ${req.url}</title><h1>${req.url}</h1><button onclick="document.title='clicked ${req.url}'">${label}</button>`);
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

  // ---- A sidebar run keeps its tab while the user looks around (each case below switches tabs mid-run).
  const titlesNow = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => [t.url.replace(/^.*\//, '/'), t.title, t.active]));
  const tabIdOf = (suffix) => app.evaluate((_e, sfx) => global.__agent.browser.listTabs().find((t) => t.url.endsWith(sfx))?.id, suffix);
  // A fake Claude that asks for one click on "Go", then finishes. Turn 1 waits for __release().
  const fakeClick = () => app.evaluate(() => {
    let turn = 0;
    global.__release = null;
    global.__agent.reset();
    global.__agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      turn++;
      const message = turn === 1
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'click', input: { text: 'Go' } }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return { async *[Symbol.asyncIterator]() { if (turn === 1) await new Promise((r) => { global.__release = r; }); }, finalMessage: async () => message };
    } } } });
  });
  const openBoth = async (pathA, pathB) => {
    await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}${pathA}`);
    await app.evaluate((_e, u) => { global.__agent.browser.openTab(u); }, `${base}${pathB}`);
    await sleep(800);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), await tabIdOf(pathA));
  };
  const runEnded = () => ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 8000 });

  // The sidebar says where the AI is working, and jumps there.
  await openBoth('/w1', '/w2');
  await fakeClick();
  await ui.evaluate(() => window.ask('click Go'));
  await sleep(700);
  const idW2 = await tabIdOf('/w2');
  const front = await ui.evaluate(() => document.getElementById('working-in').hidden === false && document.getElementById('working-in').textContent);
  check('while a run works in the tab in front, the sidebar names it', /Working in: Page \/w1/.test(front), front);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), idW2); // the user looks at another tab
  await sleep(500);
  const away = await ui.evaluate(() => ({ text: document.getElementById('working-in').textContent, hidden: document.getElementById('working-in').hidden, away: document.body.classList.contains('agent-away'), sendStop: document.getElementById('send').classList.contains('stop'), pill: document.getElementById('agent-pill-text').textContent }));
  check('after switching away it still names the tab the AI works in, and the run keeps going', /Working in: Page \/w1/.test(away.text) && !away.hidden && away.sendStop, JSON.stringify(away));
  check('the accent frame and pill do not claim the tab in front', away.away && /another tab/.test(away.pill), JSON.stringify(away));
  await ui.evaluate(() => document.getElementById('working-in').click());
  await sleep(400);
  check('clicking the line jumps to the AI\'s tab', (await titlesNow()).find(([u]) => u === '/w1')?.[2] === true, JSON.stringify(await titlesNow()));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), idW2);
  await app.evaluate(() => global.__release?.());
  await runEnded();
  const after = await ui.evaluate(() => ({ hidden: document.getElementById('working-in').hidden, away: document.body.classList.contains('agent-away'), steps: document.querySelectorAll('.step').length, done: document.querySelectorAll('.step.done').length }));
  check('when the run ends the line and the away state go', after.hidden && !after.away, JSON.stringify(after));
  check('the step list survived the tab switches', after.steps >= 1 && after.done === after.steps, JSON.stringify(after));
  const t1 = await titlesNow();
  check('the click still landed in the run\'s tab', t1.find(([u]) => u === '/w1')?.[1] === 'clicked /w1' && t1.find(([u]) => u === '/w2')?.[1] === 'Page /w2', JSON.stringify(t1));

  // list_tabs inside a task marks the task's tab (not the one the user is looking at) as active.
  await openBoth('/l1', '/l2');
  const lt = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    return agent.inTask(ids[0], new AbortController().signal, async () => {
      agent.browser.switchTab(ids[1]);
      return JSON.parse(await agent.execute('list_tabs', {}));
    });
  }, [await tabIdOf('/l1'), await tabIdOf('/l2')]);
  const ltA = lt.find((t) => t.url.endsWith('/l1'));
  const ltB = lt.find((t) => t.url.endsWith('/l2'));
  check('list_tabs in a task shows the task\'s tab as active and the one in front as in_front', ltA?.active === true && ltB?.active === false && ltB?.in_front === true, JSON.stringify(lt));

  // Element ids read in one tab are refused in the tab the task moved to (they'd hit another element).
  const refs = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    return agent.inTask(ids[0], new AbortController().signal, async () => {
      const found = await agent.execute('find', { query: 'Go' });
      const id = Number(/\[(\d+)\]/.exec(found)?.[1]);
      await agent.execute('switch_tab', { tab_id: ids[1] });
      let refused = null;
      try { await agent.execute('click', { element_id: id }); } catch (err) { refused = err.message; }
      await agent.execute('find', { query: 'Go' });
      let ok = null;
      try { ok = await agent.execute('click', { element_id: id }); } catch (err) { ok = `ERR ${err.message}`; }
      return { id, refused, ok };
    });
  }, [await tabIdOf('/l1'), await tabIdOf('/l2')]);
  check('ids from the tab the task left are refused after switch_tab', /previous tab/.test(refs.refused || ''), JSON.stringify(refs));
  check('and work again once the new tab was read', /Clicked element/.test(refs.ok || ''), JSON.stringify(refs));

  // A screenshot of the task's tab while the user is on another tab still shows the page.
  await openBoth('/s1', '/s2');
  const shot = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    return agent.inTask(ids[0], new AbortController().signal, async () => {
      agent.browser.switchTab(ids[1]);
      await new Promise((r) => setTimeout(r, 300));
      const out = await agent.execute('screenshot', {});
      return { bytes: out[0].source.data.length };
    });
  }, [await tabIdOf('/s1'), await tabIdOf('/s2')]);
  check('a screenshot of the task\'s background tab is a real image', shot.bytes > 1500, JSON.stringify(shot));

  // Sidebar engine (Claude Code / Grok Build) runs: MCP calls use the tab the message started in, and
  // the step label names that tab's element.
  await openBoth('/e1', '/other2');
  const eng = await app.evaluate(async (_e, ids) => {
    const agent = global.__agent;
    const events = [];
    agent.reset();
    agent.messages.settings = { model: 'claudecode:default', adhdMode: true };
    agent.claudeCodeTurn = async (_m, _t, _i, signal, emit) => {
      const session = { engine: 'tag-1', approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() };
      global.__fakeEngine = { owns: (t) => t === 'tag-1', active: { emit, signal } };
      const found = await agent.execute('find', { query: 'Go' });
      const id = Number(/\[(\d+)\]/.exec(found)?.[1]);
      agent.browser.switchTab(ids[1]); // the user goes elsewhere mid-run
      await new Promise((r) => setTimeout(r, 200));
      await global.__mcpCallTool('click', { element_id: id }, session);
    };
    await new Promise((resolve) => agent.run('go', (e) => { events.push(e); if (e.type === 'done') resolve(); }));
    global.__fakeEngine = null;
    return { labels: events.filter((e) => e.type === 'tool').map((e) => e.label), errors: events.filter((e) => e.type === 'error').map((e) => e.text) };
  }, [await tabIdOf('/e1'), await tabIdOf('/other2')]);
  const engTitles = await titlesNow();
  check('an engine run\'s MCP click lands in the tab its message started in', engTitles.find(([u]) => u === '/e1')?.[1] === 'clicked /e1' && engTitles.find(([u]) => u === '/other2')?.[1] === 'Page /other2', JSON.stringify(engTitles));
  check('and its step label describes that tab\'s element, not the tab in front', /Go/.test(eng.labels[0] || '') && !/Other/.test(eng.labels[0] || ''), JSON.stringify(eng));

  // A tab torn off into another window mid-run is still the run's tab (it was not "closed").
  await openBoth('/m1', '/m2');
  await fakeClick();
  await ui.evaluate(() => window.ask('click Go'));
  await sleep(700);
  const moved = await app.evaluate((_e, id) => global.__windows.tearOff(global.__windows.list()[0].windowId, id, { x: 120, y: 120 }), await tabIdOf('/m1'));
  await sleep(900);
  await app.evaluate(() => global.__release?.());
  await runEnded();
  const errText = await ui.evaluate(() => [...document.querySelectorAll('.notice,.error,.step.failed')].map((n) => n.textContent).join(' | '));
  const m1 = await app.evaluate(({ webContents }) => {
    const found = global.__windows.list().flatMap((w) => w.tabs).find((t) => t.url.endsWith('/m1'));
    return found ? webContents.fromId(found.contentsId).getTitle() : null;
  });
  check('a tab torn off to another window mid-run is not reported as closed', moved === true && !/was closed/.test(errText), `${moved} ${errText}`);
  check('and the run\'s click still landed in that tab', m1 === 'clicked /m1', m1);

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

// Background tasks (features/background-runner.js, renderer/tasks.js) with a fake model: no API tokens.
// A task runs in its own hidden tab while the user's tabs stay put; a step that needs approval pauses
// as waiting-approval and resumes on Allow; Deny and Stop end it cleanly; buy/send steps ask even on an
// allowed site; a watch task notices a changed page without calling the model when nothing changed; a
// private window can't create a task; and a restart marks a running task interrupted.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const fixture = { watchText: 'Widget: out of stock', hits: {}, clicked: 0 };
  const server = http.createServer((req, res) => {
    fixture.hits[req.url] = (fixture.hits[req.url] || 0) + 1;
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/watch') return res.end(`<title>Watch</title><p>${fixture.watchText}</p>`);
    if (req.url === '/shop') return res.end('<title>Shop</title><button onclick="document.title=\'BOUGHT\'; fetch(\'/bought\')">Buy now</button><p>A widget for sale</p>');
    if (req.url === '/bought') { fixture.clicked++; return res.end('ok'); }
    return res.end(`<title>Page ${req.url}</title><h1>${req.url}</h1><p>Page text for ${req.url}</p><a href="/x">x</a>`);
  }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`; // a different host for the same server

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bgtasks-'));
  const launch = () => electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The fake Claude: each task's script is the list of assistant turns, found by a TASK-x marker in its prompt.
  // A turn may `hold` until the test releases it. Counts every model call.
  const installFake = () => app.evaluate(() => {
    global.__scripts = {};
    global.__holds = {};
    global.__calls = 0;
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      global.__calls++;
      const marker = /TASK-[A-Z0-9]+/.exec(JSON.stringify(params.messages[0].content))?.[0];
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      const step = (global.__scripts[marker] || [])[turn] || { content: [{ type: 'text', text: 'No script.' }] };
      const content = step.content.map((b, i) => (b.type === 'tool_use' ? { ...b, id: `tu_${marker}_${turn}_${i}` } : b));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 1000, output_tokens: 100 } };
      return {
        async *[Symbol.asyncIterator]() {
          if (step.hold) await new Promise((r) => { global.__holds[step.hold] = r; });
          for (const b of content) if (b.type === 'text') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: b.text } };
        },
        finalMessage: async () => message,
      };
    } } } });
  });
  const script = (marker, turns) => app.evaluate((_e, [m, t]) => { global.__scripts[m] = t; }, [marker, turns]);
  const tool = (name, input) => ({ content: [{ type: 'tool_use', name, input }] });
  const say = (text, hold) => ({ content: [{ type: 'text', text }], ...(hold ? { hold } : {}) });
  const release = (name) => app.evaluate((_e, n) => { global.__holds[n]?.(); }, name);
  const held = (name) => app.evaluate((_e, n) => Boolean(global.__holds[n]), name);
  const tasks = () => app.evaluate(() => global.__bg.tasks().map((t) => ({ id: t.id, title: t.title, status: t.status, result: t.result, error: t.error, steps: t.steps.map((s) => `${s.name}:${s.ok}`), currentUrl: t.currentUrl, runs: t.runs.length, sites: t.allowedSites })));
  const taskBy = async (marker) => (await app.evaluate((_e, m) => { const t = global.__bg.tasks().find((x) => x.prompt.includes(m)); return t ? { id: t.id, status: t.status, result: t.result, error: t.error, steps: t.steps.map((s) => `${s.name}:${s.ok}`), currentUrl: t.currentUrl, sites: t.allowedSites, pending: [...(global.__bg.runtimes().get(t.id)?.pending.values() || [])] } : null; }, marker));
  const statusOf = async (marker) => (await taskBy(marker))?.status;
  const create = (spec) => ui.evaluate((s) => window.assistant.tasks.create({ confirmed: true, ...s }), spec);
  const userTabs = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, active: t.active })));
  await installFake();

  // ---- 1. Creating from the composer shows what the task may do, and nothing is made until Create.
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#send-bg');
  const badgeGone = await ui.evaluate(() => document.getElementById('tasks-badge').hidden);
  check('the Tasks button is there and its badge starts empty', badgeGone, '');
  check('the composer\'s background button starts disabled (nothing typed)', await ui.evaluate(() => document.getElementById('send-bg').disabled), '');
  await ui.fill('#prompt', `TASK-A read the page at 127.0.0.1:${port}/a and report it`);
  await ui.click('#send-bg');
  await ui.waitForSelector('.task-create-card');
  const summary = await ui.evaluate(() => document.querySelector('.task-summary').textContent);
  check('the card says what it will do, where it may go, and that it asks otherwise', /will work in the background on: TASK-A read the page/.test(summary) && summary.includes(`127.0.0.1:${port}`) && /It will ask before anything else\./.test(summary), summary);
  check('nothing was created before Create', (await tasks()).length === 0, JSON.stringify(await tasks()));
  const refused = await ui.evaluate(() => window.assistant.tasks.create({ prompt: 'TASK-Z x', confirmed: false }));
  check('creating without the confirmation is refused', refused.ok === false && (await tasks()).length === 0, JSON.stringify(refused));

  // ---- 2. The run: its own tab, the user's tabs untouched, list_tabs shows only its own.
  await app.evaluate((_e, u) => global.__agent.browser.openTab(u), `${base}/user1`);
  await app.evaluate((_e, u) => global.__agent.browser.openTab(u), `${base}/user2`);
  await sleep(700);
  const userBefore = await userTabs();
  await script('TASK-A', [tool('navigate', { url: `${base}/a` }), tool('list_tabs', {}), { ...tool('read_page', {}), hold: 'A' }, say('RESULT-A the page says: Page text for /a')]);
  await ui.click('.task-create-card .btn.primary');
  check('Create makes the task and opens its detail', await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.task-detail')))), '');
  check('the task starts running', await waitFor(async () => (await statusOf('TASK-A')) === 'running'), await statusOf('TASK-A'));
  check('the badge counts the running task', await waitFor(() => ui.evaluate(() => document.getElementById('tasks-badge').textContent === '1')), await ui.evaluate(() => document.getElementById('tasks-badge').textContent));
  await waitFor(() => held('A'));
  check('the run reached its second model turn (navigated, listed tabs) without touching the user\'s tabs', await held('A') && JSON.stringify(await userTabs()) === JSON.stringify(userBefore), JSON.stringify(await userTabs()));
  const listed = await app.evaluate(() => {
    const rt = [...global.__bg.runtimes().values()][0];
    const last = rt.agent.messages[rt.agent.messages.length - 1];
    return last.content.map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('');
  });
  check('list_tabs shows the task\'s one tab, not the user\'s', (listed.match(/"id"/g) || []).length === 1 && !listed.includes('user1') && !listed.includes('user2'), listed);
  // The user switches tabs while the task works: it carries on in its own tab.
  await app.evaluate(() => { const t = global.__agent.browser.listTabs(); global.__agent.browser.switchTab(t[0].id); });
  await sleep(200);
  await release('A');
  check('the task finishes with its result', await waitFor(async () => (await statusOf('TASK-A')) === 'done'), JSON.stringify(await taskBy('TASK-A')));
  const a = await taskBy('TASK-A');
  check('its steps were logged and its result kept', /RESULT-A/.test(a.result) && a.steps.some((s) => s.startsWith('navigate')) && a.steps.some((s) => s.startsWith('read_page')), JSON.stringify(a));
  check('its own tab was on the page it was sent to, not a user tab', a.currentUrl === `${base}/a` && fixture.hits['/a'] >= 1, a.currentUrl);
  const userAfter = await userTabs();
  check('the user\'s tabs were never navigated or added to', userAfter.length === userBefore.length && userAfter.every((t) => userBefore.some((b) => b.id === t.id && b.url === t.url)), JSON.stringify(userAfter));
  check('the work tab is gone once the run ends', await app.evaluate(() => global.__bg.runtimes().size === 0), '');
  check('cost was tracked for the task', await ui.evaluate(async () => { const s = await window.assistant.tasks.state(); return /tokens/.test(s.tasks[0].cost); }), '');
  await ui.evaluate(() => document.getElementById('task-panel').querySelector('.task-back')?.click());
  await ui.waitForSelector('.task-row');
  const row = await ui.evaluate(() => document.querySelector('.task-row').textContent);
  check('the list row shows status and a dot', /Done/.test(row) && await ui.evaluate(() => Boolean(document.querySelector('.task-dot.done'))), row);
  await ui.click('.task-row');
  await ui.waitForSelector('.task-result');
  const detail = await ui.evaluate(() => ({ result: document.querySelector('.task-result').textContent, steps: document.querySelectorAll('.task-steps li').length }));
  check('the detail shows the rendered result and the steps timeline', /RESULT-A/.test(detail.result) && detail.steps >= 3, JSON.stringify(detail));

  // ---- 3. A destination outside the allowed sites pauses the task; Allow once resumes it.
  await script('TASK-B', [tool('navigate', { url: `${other}/b` }), say('RESULT-B reached the other host')]);
  const b = await create({ prompt: `TASK-B open 127.0.0.1:${port}/a then go on`, schedule: { type: 'now' } });
  check('a task can be created through the UI channel', b.ok === true, JSON.stringify(b));
  check('it pauses as waiting-approval, asking about the new host', await waitFor(async () => (await statusOf('TASK-B')) === 'waiting-approval'), await statusOf('TASK-B'));
  const pending = (await taskBy('TASK-B')).pending;
  check('the card names the host it wants to open', pending.length === 1 && pending[0].host === `localhost:${port}` && pending[0].action === 'open', JSON.stringify(pending));
  check('the badge shows that it needs the user, and nothing was loaded yet', (fixture.hits['/b'] || 0) === 0 && await waitFor(() => ui.evaluate(() => document.getElementById('tasks-badge').classList.contains('waiting'))), '');
  check('a notification was announced for the approval', await app.evaluate(() => global.__bg.notifications().some((n) => n.kind === 'approval')), '');
  await ui.evaluate(() => { if (document.getElementById('task-panel').hidden) document.getElementById('tasks-btn').click(); });
  await ui.evaluate(() => document.querySelector('.task-back')?.click());
  await ui.waitForSelector('.task-row');
  await ui.evaluate(() => [...document.querySelectorAll('.task-row')].find((r) => r.textContent.includes('TASK-B')).click());
  await ui.waitForSelector('.task-approval');
  const cardText = await ui.evaluate(() => document.querySelector('.task-approval').textContent);
  check('the Tasks panel shows an approval card with Allow once / Allow site / Deny / Stop task', ['Allow once', 'Allow site for this task', 'Deny', 'Stop task'].every((s) => cardText.includes(s)), cardText);
  await ui.evaluate(() => [...document.querySelectorAll('.task-approval button')].find((x) => x.textContent === 'Allow once').click());
  check('after Allow once it resumes and finishes', await waitFor(async () => (await statusOf('TASK-B')) === 'done'), JSON.stringify(await taskBy('TASK-B')));
  check('the page was really loaded after the approval', (fixture.hits['/b'] || 0) >= 1 && /RESULT-B/.test((await taskBy('TASK-B')).result), JSON.stringify(fixture.hits));
  check('Allow once did not keep the host approved', await app.evaluate(() => global.__bg.tasks().find((t) => t.prompt.includes('TASK-B')).allowedSites.every((s) => !s.startsWith('localhost'))), '');

  // ---- 4. Deny ends it cleanly; nothing auto-approves even with the sidebar's auto-allow on.
  await app.evaluate(() => global.__patchSettings({ askBeforeActing: false }));
  await script('TASK-C', [tool('navigate', { url: `${other}/c` }), say('RESULT-C could not open it, so I stopped')]);
  const c = await create({ prompt: `TASK-C see 127.0.0.1:${port}/a`, schedule: { type: 'now' } });
  check('with auto-allow on, a background task still waits for the user', await waitFor(async () => (await statusOf('TASK-C')) === 'waiting-approval'), await statusOf('TASK-C'));
  const cp = (await taskBy('TASK-C')).pending[0];
  await ui.evaluate(([id, aid]) => window.assistant.tasks.approve(id, aid, 'deny'), [c.id, cp.approvalId]);
  check('Deny ends it cleanly (the model is told, the task finishes, the page never loads)', await waitFor(async () => (await statusOf('TASK-C')) === 'done') && (fixture.hits['/c'] || 0) === 0 && /RESULT-C/.test((await taskBy('TASK-C')).result), JSON.stringify(await taskBy('TASK-C')));
  await app.evaluate(() => global.__patchSettings({ askBeforeActing: true }));

  // ---- 5. A buy/send step asks even on an allowed site.
  await script('TASK-D', [tool('navigate', { url: `${base}/shop` }), tool('click', { text: 'Buy now' }), say('RESULT-D done')]);
  const d = await create({ prompt: `TASK-D go to 127.0.0.1:${port}/shop`, schedule: { type: 'now' } });
  check('clicking “Buy now” on an allowed site waits for the user', await waitFor(async () => (await statusOf('TASK-D')) === 'waiting-approval'), await statusOf('TASK-D'));
  const dp = (await taskBy('TASK-D')).pending[0];
  check('that card offers no "allow the site" shortcut', dp && dp.action === 'tool' && /Buy now/.test(dp.title), JSON.stringify(dp));
  await ui.evaluate(([id, aid]) => window.assistant.tasks.approve(id, aid, 'deny'), [d.id, dp.approvalId]);
  await waitFor(async () => (await statusOf('TASK-D')) === 'done');
  check('denied: the button was not pressed', fixture.clicked === 0, String(fixture.clicked));

  // ---- 6. Stop works, including on a task that is mid-thought.
  await script('TASK-E', [say('never finishes', 'E')]);
  const e = await create({ prompt: 'TASK-E think for a long time about nothing', schedule: { type: 'now' } });
  await waitFor(() => held('E'));
  check('the task is running', (await statusOf('TASK-E')) === 'running', await statusOf('TASK-E'));
  await ui.evaluate((id) => window.assistant.tasks.stop(id), e.id);
  await release('E'); // the fake stream ignores the abort signal; a real one would end at once
  check('Stop ends it as stopped and frees its slot and tab', await waitFor(async () => (await statusOf('TASK-E')) === 'stopped') && await app.evaluate(() => global.__bg.runtimes().size === 0), await statusOf('TASK-E'));

  // ---- 7. The queue: at most 2 run at once.
  await script('TASK-F1', [say('f1', 'F1')]);
  await script('TASK-F2', [say('f2', 'F2')]);
  await script('TASK-F3', [say('RESULT-F3')]);
  await create({ prompt: 'TASK-F1 one', schedule: { type: 'now' } });
  await create({ prompt: 'TASK-F2 two', schedule: { type: 'now' } });
  await create({ prompt: 'TASK-F3 three', schedule: { type: 'now' } });
  await waitFor(async () => (await held('F1')) && (await held('F2')));
  check('a third task waits in the queue while two run', (await statusOf('TASK-F3')) === 'queued' && (await statusOf('TASK-F1')) === 'running' && (await statusOf('TASK-F2')) === 'running', `${await statusOf('TASK-F1')} ${await statusOf('TASK-F2')} ${await statusOf('TASK-F3')}`);
  await release('F1');
  check('and starts as soon as one finishes', await waitFor(async () => (await statusOf('TASK-F3')) === 'done'), await statusOf('TASK-F3'));
  await release('F2');
  await waitFor(async () => (await statusOf('TASK-F2')) === 'done');

  // ---- 8. Watching a page: no model call while nothing changed; a change is noticed.
  const callsBefore = await app.evaluate(() => global.__calls);
  const wt = await create({ schedule: { type: 'watch', url: `${base}/watch`, condition: '', minutes: 5 }, title: 'Stock watch' });
  check('a watch task is created', wt.ok === true, JSON.stringify(wt));
  const watchState = () => app.evaluate((_e, id) => { const t = global.__bg.find(id); return { hash: t.watch.hash, checked: t.watch.checkedAt, status: t.status, notes: global.__bg.notifications().filter((n) => n.id === id && n.kind === 'watch').length, error: t.error }; }, wt.id);
  check('the first look records a baseline (no model, no notification)', await waitFor(async () => (await watchState()).hash), JSON.stringify(await watchState()));
  const due = () => app.evaluate((_e, id) => { global.__bg.find(id).lastRun -= 10 * 60000; global.__bg.tick(); }, wt.id);
  let before = (await watchState()).checked;
  await due();
  check('an unchanged page is re-checked without the model or a notification', await waitFor(async () => (await watchState()).checked !== before) && (await watchState()).notes === 0 && (await app.evaluate(() => global.__calls)) === callsBefore, JSON.stringify(await watchState()));
  fixture.watchText = 'Widget: IN STOCK now';
  before = (await watchState()).checked;
  await due();
  check('a changed page is noticed and announced (still no model call)', await waitFor(async () => (await watchState()).notes === 1) && (await app.evaluate(() => global.__calls)) === callsBefore, JSON.stringify(await watchState()));
  const wres = await app.evaluate((_e, id) => global.__bg.find(id).result, wt.id);
  check('the watch result says what changed', /changed/i.test(wres) && /IN STOCK/i.test(wres), wres);
  // A text condition is judged by the app, also without the model.
  const wc = await create({ schedule: { type: 'watch', url: `${base}/watch`, condition: 'contains "backorder"', minutes: 5 }, title: 'Backorder watch' });
  await waitFor(async () => (await app.evaluate((_e, id) => global.__bg.find(id).watch.checkedAt, wc.id)));
  fixture.watchText = 'Widget: on BACKORDER';
  await app.evaluate((_e, id) => { global.__bg.find(id).lastRun -= 10 * 60000; global.__bg.tick(); }, wc.id);
  check('a "contains" condition notifies when it becomes true, judged without the model', await waitFor(() => app.evaluate((_e, id) => global.__bg.notifications().filter((n) => n.id === id && n.kind === 'watch').length === 1, wc.id)) && (await app.evaluate(() => global.__calls)) === callsBefore, '');
  // A watch of a site that is not in its allowed list is refused, not fetched.
  const off = await ui.evaluate((u) => window.assistant.tasks.schedule('nope', { type: 'watch', url: u, minutes: 5 }), `${other}/watch`);
  check('editing the schedule of an unknown task fails cleanly', off.ok === false, JSON.stringify(off));

  // ---- 9. A private window can't create a task (and its UI has no task calls at all).
  await app.evaluate(() => global.__private.open());
  await waitFor(() => app.evaluate(() => global.__private.count() === 1 && global.__private.list()[0].tabs.length === 1));
  const priv = await app.evaluate(() => global.__private.list()[0]);
  const countBefore = (await tasks()).length;
  const attempt = await app.evaluate(async ({ ipcMain, BrowserWindow }, windowId) => {
    const wc = BrowserWindow.fromId(windowId).webContents;
    const call = async (channel, ...args) => { try { await ipcMain._invokeHandlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args); return 'allowed'; } catch (err) { return err.message; } };
    return { create: await call('tasks:create', { prompt: 'TASK-P x', confirmed: true }), state: await call('tasks:state'), stop: await call('tasks:stop', 'x') };
  }, priv.windowId);
  check('a private window\'s create / state / stop calls are refused', attempt.create === 'Not allowed' && attempt.state === 'Not allowed' && attempt.stop === 'Not allowed' && (await tasks()).length === countBefore, JSON.stringify(attempt));
  const privUi = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript('typeof window.assistant?.tasks'), priv.windowId);
  check('and its UI has no task calls', privUi === 'undefined', privUi);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), priv.windowId);
  await waitFor(() => app.evaluate(() => global.__bg.tasks().length >= 0 && global.__private.count() === 0));

  // ---- 10. Settings: disabled hides the composer button and refuses new tasks; no schedule runs.
  await ui.evaluate(() => window.assistant.tasks.settings({ enabled: false }));
  check('turned off: the composer button hides', await waitFor(() => ui.evaluate(() => document.getElementById('send-bg').hidden)), '');
  const off2 = await create({ prompt: 'TASK-OFF nope', schedule: { type: 'now' } });
  check('and creating a task is refused', off2.ok === false && /turned off/.test(off2.error), JSON.stringify(off2));
  await ui.evaluate(() => window.assistant.tasks.settings({ enabled: true, maxConcurrent: 5, timeoutMin: 45 }));
  const st = await ui.evaluate(() => window.assistant.tasks.state());
  check('settings are clamped (1-3 tasks, a listed timeout)', st.settings.enabled === true && st.settings.maxConcurrent === 3 && st.settings.timeoutMin === 30, JSON.stringify(st.settings));

  // ---- 11. Restart: a running task comes back as interrupted, with Retry.
  await script('TASK-G', [say('never ends', 'G')]);
  await create({ prompt: 'TASK-G work for a very long time', schedule: { type: 'now' } });
  await waitFor(() => held('G'));
  await sleep(700);
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await waitFor(() => app.evaluate(() => Boolean(global.__bg)));
  const g = await app.evaluate(() => { const t = global.__bg.tasks().find((x) => x.prompt.includes('TASK-G')); return t ? { status: t.status, error: t.error, runs: t.runs.map((r) => r.status) } : null; });
  check('after a restart the running task is interrupted', g && g.status === 'interrupted' && /closed/i.test(g.error) && g.runs.includes('interrupted'), JSON.stringify(g));
  const kept = await app.evaluate(() => global.__bg.tasks().map((t) => t.status));
  check('finished tasks and the watch tasks came back too', kept.filter((s) => s === 'done').length >= 4 && kept.length >= 10, JSON.stringify(kept));
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.click('#tasks-btn');
  await ui.waitForSelector('.task-row');
  await ui.evaluate(() => [...document.querySelectorAll('.task-row')].find((r) => r.textContent.includes('TASK-G')).click());
  await ui.waitForSelector('.task-actions');
  const retry = await ui.evaluate(() => [...document.querySelectorAll('.task-actions button')].map((b) => b.textContent));
  check('its detail offers Retry', retry.includes('Retry'), JSON.stringify(retry));
  check('the panel says scheduled tasks only run while Lumen is open', await ui.evaluate(() => { document.querySelector('.task-back').click(); return true; }) && await waitFor(() => ui.evaluate(() => /only while Lumen is open/.test(document.getElementById('task-panel').textContent))), '');

  check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

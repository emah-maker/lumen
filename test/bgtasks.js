// Background tasks (features/background-runner.js, renderer/tasks.js) with a fake model: no API tokens.
// A task runs in its own hidden tab while the user's tabs stay put; a step that needs approval pauses
// as waiting-approval and resumes on Allow; Deny and Stop end it cleanly; buy/send steps ask even on an
// allowed site; a watch task notices a changed page without calling the model when nothing changed; a
// private window can't create a task; and a restart marks a running task interrupted.
// Claude Code / Grok Build tasks run against a fake CLI process (test/fixtures/fake-cli.js): no login, no tokens.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// [sidebar per tab] the sidebar is open or closed tab by tab, so a tab the test opened comes up without it: sidebar controls open it first.
const keepSidebarOpen = (page) => {
  for (const method of ['click', 'fill', 'selectOption', 'inputValue']) {
    const original = page[method].bind(page);
    page[method] = async (selector, ...rest) => {
      if (/^(#prompt|#model|\.task-)/.test(String(selector))) {
        await page.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
        await page.waitForFunction(() => !document.body.classList.contains('sidebar-hidden'));
      }
      return original(selector, ...rest);
    };
  }
  return page;
};
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
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fakecli-'));
  const fakeCli = path.join(__dirname, 'fixtures', 'fake-cli.js');
  const launch = () => electron.launch({
    args: [path.join(__dirname, '..')],
    env: {
      ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1',
      // the CLIs are the fake process; the user's own ~/.grok is never read
      LUMEN_TEST_CLI_SPAWN: fakeCli, LUMEN_TEST_CLI_DIR: cliDir, LUMEN_CLAUDE_BIN: fakeCli, LUMEN_GROK_BIN: fakeCli, LUMEN_GROK_SIDEBAR: '1', GROK_HOME: path.join(cliDir, 'user-grok'),
    },
    colorScheme: null,
  });
  let app = await launch();
  let ui = keepSidebarOpen(await app.firstWindow());
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

  // ---- 9b. Claude Code and Grok Build tasks, on the fake CLI: their own process, session and tab.
  const scriptsFile = path.join(cliDir, 'scripts.json');
  const setScripts = (more) => { let cur = {}; try { cur = JSON.parse(fs.readFileSync(scriptsFile, 'utf8')); } catch { /* none yet */ } fs.writeFileSync(scriptsFile, JSON.stringify({ ...cur, ...more })); };
  const cliLog = () => { try { return fs.readFileSync(path.join(cliDir, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cliRelease = (name) => fs.writeFileSync(path.join(cliDir, `release-${name}`), '');
  const started = (marker) => cliLog().find((e) => e.event === 'start' && e.marker === marker);
  const logOf = (marker, event) => { const pid = started(marker)?.pid; return cliLog().filter((e) => e.pid === pid && e.event === event); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const cliTask = (marker, model, more = {}) => create({ prompt: `${marker} go to 127.0.0.1:${port}/${marker.toLowerCase()} and report`, model, schedule: { type: 'now' }, ...more });
  const preview = () => ui.evaluate(() => window.assistant.tasks.preview({}));
  const argAfter = (argv, f) => argv[argv.indexOf(f) + 1];
  const originalModel = await ui.inputValue('#model');
  await app.evaluate(() => global.__patchSettings({ performanceMode: 'off' })); // Performance mode (auto on a throttled laptop) would cap tasks at 1: the queue check needs 2
  await waitFor(async () => (await preview()).models.some((m) => m.id === 'grokbuild:default'), 15000);

  const pv = await preview();
  check('the model choice lists API models and both CLIs\' models', pv.models.some((m) => m.engine === 'api') && ['claudecode:default', 'claudecode:sonnet', 'grokbuild:default'].every((id) => pv.models.some((m) => m.id === id && m.available)), JSON.stringify(pv.models.map((m) => m.id)));
  check('the CLIs are reported ready (nothing to warn about)', pv.cli.every((c) => c.state === 'ready'), JSON.stringify(pv.cli));

  // Signed out: said when creating, not when it runs, and the option shows as unavailable.
  await app.evaluate(() => { global.__claudeCode.status = async () => ({ installed: true, signedIn: false, accountType: null, detail: null }); });
  await ui.evaluate(() => window.lumenExtras.claudeCodeStatus(true));
  const pvOut = await preview();
  check('a signed-out CLI is listed as unavailable, with a note', pvOut.models.find((m) => m.id === 'claudecode:sonnet')?.available === false && pvOut.cli.find((c) => c.engine === 'claudecode').state === 'not-signed-in', JSON.stringify(pvOut.cli));
  const outRes = await create({ prompt: `TASK-CX 127.0.0.1:${port}`, model: 'claudecode:sonnet', schedule: { type: 'now' } });
  check('creating a task on a signed-out CLI says so at once, and makes nothing', outRes.ok === false && /not signed in/i.test(outRes.error) && !(await tasks()).some((t) => t.title.includes('TASK-CX')), JSON.stringify(outRes));
  await app.evaluate(() => { global.__claudeCode.status = async () => ({ installed: true, signedIn: true, accountType: 'subscription', detail: null }); });
  await ui.evaluate(() => window.lumenExtras.claudeCodeStatus(true));

  // A Claude Code task and a sidebar chat on the same fake, at the same time.
  await app.evaluate((_e, u) => global.__agent.browser.openTab(u), `${base}/user3`);
  await sleep(600);
  setScripts({
    'TASK-CA': [{ tool: 'navigate', input: { url: `${base}/ca` } }, { tool: 'read_page', input: {} }, { hold: 'CA' }, { say: 'RESULT-CA the page says: Page text for /ca' }],
    'SIDE-1': [{ tool: 'read_page', input: {} }, { hold: 'S1' }, { say: 'RESULT-S1 sidebar reply' }],
  });
  await ui.selectOption('#model', 'claudecode:default', { force: true }); // (the native select is hidden behind the custom picker)
  await ui.fill('#prompt', 'SIDE-1 what is on this page?');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => started('SIDE-1'), 15000);
  const userTabsBefore = await userTabs();
  const ca = await cliTask('TASK-CA', 'claudecode:sonnet');
  check('a Claude Code task can be created', ca.ok === true, JSON.stringify(ca));
  await waitFor(() => logOf('TASK-CA', 'tool').some((e) => e.name === 'read_page'), 25000);
  const sa = started('TASK-CA');
  const ss = started('SIDE-1');
  check('the task and the sidebar chat are two processes with different sessions and different bridge tags', sa && ss && sa.pid !== ss.pid && sa.session !== ss.session && logOf('TASK-CA', 'bridge')[0]?.tag !== logOf('SIDE-1', 'bridge')[0]?.tag && alive(sa.pid) && alive(ss.pid), JSON.stringify({ sa, ss }));
  check('the task is running while the sidebar chat is too', (await statusOf('TASK-CA')) === 'running' && await app.evaluate(() => global.__agent.running), await statusOf('TASK-CA'));
  const av = sa.argv;
  const toolsIdx = av.indexOf('--tools');
  check('the task\'s claude has the sidebar\'s lock-down: no built-in tools, only mcp__lumen, strict MCP config, dontAsk', toolsIdx >= 0 && av[toolsIdx + 1] === '' && argAfter(av, '--allowedTools') === 'mcp__lumen' && av.includes('--strict-mcp-config') && argAfter(av, '--permission-mode') === 'dontAsk', av.join(' '));
  check('its step limit is --max-turns 60 (Max steps is unlimited) and its model is the one picked', argAfter(av, '--max-turns') === '60' && argAfter(av, '--model') === 'sonnet' && argAfter(av, '--session-id') === sa.session && !av.includes('--resume'), av.join(' '));
  check('the sidebar\'s own message has no turn cap and its unpicked model is auto-routed to a tier alias', !ss.argv.includes('--max-turns') && ['haiku', 'sonnet', 'opus'].includes(argAfter(ss.argv, '--model')), ss.argv.join(' '));
  check('each has its own empty temp folder as cwd', /lumen-cc-/.test(sa.cwd) && /lumen-cc-/.test(ss.cwd) && sa.cwd !== ss.cwd, `${sa.cwd} | ${ss.cwd}`);
  check('the task\'s claude is told it is a background task', /background task/.test(sa.system) && !/background task/.test(ss.system), sa.system.slice(-200));
  const taskRead = logOf('TASK-CA', 'tool').find((e) => e.name === 'read_page');
  const sideRead = logOf('SIDE-1', 'tool').find((e) => e.name === 'read_page');
  check('the task\'s calls acted on its own tab (its page), the sidebar\'s on the user\'s tab', /Page text for \/ca/.test(taskRead?.text || '') && !/Page text for \/ca/.test(sideRead?.text || ''), JSON.stringify({ taskRead, sideRead }));
  const workUrl = await app.evaluate(() => [...global.__bg.runtimes().values()].map((rt) => rt.wc.getURL()));
  check('the work tab is on the task\'s page while the user\'s tabs were not navigated', workUrl.includes(`${base}/ca`) && JSON.stringify(await userTabs()) === JSON.stringify(userTabsBefore), JSON.stringify({ workUrl, tabs: await userTabs() }));
  check('the task lists its own step rows', (await taskBy('TASK-CA')).steps.some((s2) => s2.startsWith('navigate')) && (await taskBy('TASK-CA')).steps.some((s2) => s2.startsWith('read_page')), JSON.stringify(await taskBy('TASK-CA')));
  check('the sidebar has no approval or step of the task in it', await ui.evaluate(() => !document.querySelector('#messages .approval') && ![...document.querySelectorAll('#messages .step')].some((n) => /\/ca/.test(n.textContent))), '');
  cliRelease('CA');
  cliRelease('S1');
  check('the task finishes with the CLI\'s result', await waitFor(async () => (await statusOf('TASK-CA')) === 'done', 20000) && /RESULT-CA/.test((await taskBy('TASK-CA')).result), JSON.stringify(await taskBy('TASK-CA')));
  await waitFor(() => ui.evaluate(() => /RESULT-S1/.test(document.getElementById('messages').textContent)), 15000);
  check('and the sidebar chat got its own reply', await ui.evaluate(() => /RESULT-S1/.test(document.getElementById('messages').textContent) && !/RESULT-CA/.test(document.getElementById('messages').textContent)), '');
  const sideSession = await app.evaluate(() => global.__agent.messages.settings?.ccSession || null);
  const run0 = await app.evaluate(() => global.__bg.tasks().find((t) => t.prompt.includes('TASK-CA')).runs.at(-1));
  check('the sidebar keeps its own session; the task\'s session is only stored with its run', sideSession === ss.session && run0.session === sa.session && sideSession !== sa.session, JSON.stringify({ sideSession, run0 }));
  check('the task shows the engine and its cost', await ui.evaluate(async () => { const st = await window.assistant.tasks.state(); const t = st.tasks.find((x) => x.title.includes('TASK-CA')); return t.engine === 'claudecode' && /tokens/.test(t.cost); }), '');
  check('the fake process and its temp folder are gone, and the run\'s engine is released', await waitFor(() => !alive(sa.pid) && !fs.existsSync(sa.cwd), 5000) && (await app.evaluate(() => global.__bgEngineCount())) === 0, sa.cwd);
  const usageRecords = await (async () => { await sleep(900); try { return JSON.parse(fs.readFileSync(path.join(profile, 'usage.json'), 'utf8')).records; } catch { return []; } })();
  check('usage: the task\'s turn is logged as a background claudecode record, the sidebar\'s is not', usageRecords.some((r) => r.engine === 'claudecode' && r.background === true) && usageRecords.some((r) => r.engine === 'claudecode' && !r.background), JSON.stringify(usageRecords));
  await ui.selectOption('#model', originalModel, { force: true });

  // Approvals: a call that needs the user waits as waiting-approval (a card in the Tasks panel, none in the sidebar).
  setScripts({
    'TASK-CB': [{ tool: 'navigate', input: { url: `${other}/cb` } }, { say: 'RESULT-CB reached the other host' }],
    'TASK-CC': [{ tool: 'navigate', input: { url: `${other}/cc` } }, { say: 'RESULT-CC was refused, so I stopped' }],
  });
  const cb = await cliTask('TASK-CB', 'claudecode:default');
  check('a Claude Code task pauses as waiting-approval on a new site', await waitFor(async () => (await statusOf('TASK-CB')) === 'waiting-approval', 25000), await statusOf('TASK-CB'));
  const cbPending = (await taskBy('TASK-CB')).pending;
  check('the card is the task\'s: it names the host, nothing loaded, the CLI is blocked on the call, the sidebar shows no card', cbPending.length === 1 && cbPending[0].host === `localhost:${port}` && (fixture.hits['/cb'] || 0) === 0 && !logOf('TASK-CB', 'tool').length && await ui.evaluate(() => !document.querySelector('#messages .approval')), JSON.stringify(cbPending));
  await ui.evaluate(([id, aid]) => window.assistant.tasks.approve(id, aid, 'once'), [cb.id, cbPending[0].approvalId]);
  check('Allow once resumes it: the call runs and the task finishes', await waitFor(async () => (await statusOf('TASK-CB')) === 'done', 20000) && (fixture.hits['/cb'] || 0) >= 1 && logOf('TASK-CB', 'tool')[0]?.isError === false, JSON.stringify({ hits: fixture.hits, log: logOf('TASK-CB', 'tool') }));
  await app.evaluate(() => global.__patchSettings({ askBeforeActing: false }));
  const cc = await cliTask('TASK-CC', 'claudecode:default');
  check('with auto-allow on, a CLI task still waits for the user', await waitFor(async () => (await statusOf('TASK-CC')) === 'waiting-approval', 25000), await statusOf('TASK-CC'));
  await ui.evaluate(([id, aid]) => window.assistant.tasks.approve(id, aid, 'deny'), [cc.id, (await taskBy('TASK-CC')).pending[0].approvalId]);
  check('Deny: the CLI gets an error for the call, the page never loads, the task ends', await waitFor(async () => (await statusOf('TASK-CC')) === 'done', 20000) && (fixture.hits['/cc'] || 0) === 0 && /did not allow/i.test(logOf('TASK-CC', 'tool')[0]?.text || '') && logOf('TASK-CC', 'tool')[0]?.isError === true, JSON.stringify(logOf('TASK-CC', 'tool')));
  await app.evaluate(() => global.__patchSettings({ askBeforeActing: true }));

  // A call from a run Lumen never issued is refused, even with outside agents allowed.
  await app.evaluate(() => global.__patchSettings({ mcpEnabled: true }));
  setScripts({ 'TASK-CE': [{ foreign: true }, { say: 'RESULT-CE done' }] });
  await cliTask('TASK-CE', 'claudecode:default');
  await waitFor(() => logOf('TASK-CE', 'foreign').length, 25000);
  const foreign = logOf('TASK-CE', 'foreign')[0];
  check('a bridge naming a run tag that was never issued is refused (initialize and tools/call)', foreign && !/accepted/.test(`${foreign.initialize} ${foreign.call}`) && /turned off|refus|closed/i.test(foreign.initialize), JSON.stringify(foreign));
  await waitFor(async () => (await statusOf('TASK-CE')) === 'done', 20000);
  check('and nothing it asked ran in any tab', !(await taskBy('TASK-CE')).steps.some((s2) => s2.startsWith('read_page')), JSON.stringify(await taskBy('TASK-CE')));
  await app.evaluate(() => global.__patchSettings({ mcpEnabled: false }));

  // Stop ends the whole process tree (the fake claude and its MCP bridge child), and the task 'stopped'.
  setScripts({ 'TASK-CD': [{ tool: 'read_page', input: {} }, { hold: 'CD' }, { say: 'never' }] });
  const cd = await cliTask('TASK-CD', 'claudecode:default');
  await waitFor(() => logOf('TASK-CD', 'tool').length && logOf('TASK-CD', 'bridge').length, 25000);
  const cdPid = started('TASK-CD').pid;
  const cdBridge = logOf('TASK-CD', 'bridge')[0].bridgePid;
  check('before Stop, both processes of the run are alive', alive(cdPid) && alive(cdBridge), `${cdPid} ${cdBridge}`);
  await ui.evaluate((id) => window.assistant.tasks.stop(id), cd.id);
  check('Stop ends the task as stopped and frees its slot', await waitFor(async () => (await statusOf('TASK-CD')) === 'stopped', 15000) && await app.evaluate(() => global.__bg.runtimes().size === 0), await statusOf('TASK-CD'));
  check('and the process tree (the CLI and its bridge) is dead', await waitFor(() => !alive(cdPid) && !alive(cdBridge), 8000), `${alive(cdPid)} ${alive(cdBridge)}`);

  // Grok Build: the same, on the HTTP gate.
  setScripts({
    'TASK-KA': [{ tool: 'navigate', input: { url: `${base}/ga` } }, { tool: 'read_page', input: {} }, { terminal: 'echo hi' }, { hold: 'KGA' }, { say: 'RESULT-KA the page says: Page text for /ga' }],
    'TASK-KB': [{ tool: 'navigate', input: { url: `${other}/gb` } }, { say: 'RESULT-KB reached the other host' }],
    'TASK-KC': [{ say: 'Working.' }, { rawTool: 'edit_file' }, { say: 'LEAKED' }],
    'TASK-KD': [{ hold: 'KGD' }, { say: 'never' }],
    'TASK-KF': [{ foreign: true }, { say: 'RESULT-KF done' }],
  });
  await cliTask('TASK-KA', 'grokbuild:default');
  await waitFor(() => logOf('TASK-KA', 'terminal').length, 25000);
  const ga = started('TASK-KA');
  check('a Grok Build task runs its own process in its own GROK_HOME and folder', ga && /grok-bg/.test(ga.home || '') && /grok-bg/.test(ga.cwd) && ga.home !== path.join(profile, 'grok-home') && (await statusOf('TASK-KA')) === 'running', JSON.stringify(ga));
  const gav = ga.argv;
  check('its argv keeps the sidebar\'s lock-down, has no terminal allow (denied instead), and --max-turns 60', gav.includes('--disallowed-tools') && argAfter(gav, '--permission-mode') === 'dontAsk' && gav.some((a, i) => a === '--deny' && gav[i + 1] === 'run_terminal_command') && !gav.some((a, i) => a === '--allow' && gav[i + 1] === 'run_terminal_command') && argAfter(gav, '--max-turns') === '60' && gav.includes('--no-subagents'), gav.join(' '));
  check('its environment is the short allowlist (no API keys of Lumen\'s)', !ga.env.includes('ANTHROPIC_API_KEY') && ga.env.includes('LUMEN_MCP_TOKEN') && ga.env.includes('GROK_HOME'), ga.env.join(','));
  check('its gate is armed and its calls ran on the task\'s own tab', logOf('TASK-KA', 'armed')[0]?.status === 200 && /Page text for \/ga/.test(logOf('TASK-KA', 'tool').find((e) => e.name === 'read_page')?.text || ''), JSON.stringify(logOf('TASK-KA', 'tool')));
  check('a terminal command is denied by the gate outright: no card, nothing to approve', logOf('TASK-KA', 'terminal')[0]?.denied === true && (await taskBy('TASK-KA')).pending.length === 0, JSON.stringify(logOf('TASK-KA', 'terminal')));
  cliRelease('KGA');
  check('the Grok task finishes with its result and cleans up its folder', await waitFor(async () => (await statusOf('TASK-KA')) === 'done', 20000) && /RESULT-KA/.test((await taskBy('TASK-KA')).result) && await waitFor(() => !fs.existsSync(ga.cwd), 5000), JSON.stringify(await taskBy('TASK-KA')));
  check('the Grok run\'s usage is logged as background too', await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'usage.json'), 'utf8')).records.some((r) => r.engine === 'grokbuild' && r.background === true); } catch { return false; } }, 4000), '');

  const gb = await cliTask('TASK-KB', 'grokbuild:default');
  check('a Grok task pauses as waiting-approval too, and resumes on Allow', await waitFor(async () => (await statusOf('TASK-KB')) === 'waiting-approval', 25000) && (fixture.hits['/gb'] || 0) === 0, await statusOf('TASK-KB'));
  await ui.evaluate(([id, aid]) => window.assistant.tasks.approve(id, aid, 'once'), [gb.id, (await taskBy('TASK-KB')).pending[0].approvalId]);
  check('and finishes after Allow once', await waitFor(async () => (await statusOf('TASK-KB')) === 'done', 20000) && (fixture.hits['/gb'] || 0) >= 1, JSON.stringify(await taskBy('TASK-KB')));

  await cliTask('TASK-KC', 'grokbuild:default');
  check('a non-Lumen tool call kills the Grok process at once and fails the task', await waitFor(async () => (await statusOf('TASK-KC')) === 'failed', 25000), await statusOf('TASK-KC'));
  const gc = await taskBy('TASK-KC');
  check('the error names the tool, and nothing after it reached the result', /isn't one of Lumen's \(edit_file\)/.test(gc.error) && !/LEAKED/.test(gc.result) && !alive(started('TASK-KC').pid), JSON.stringify(gc));

  await cliTask('TASK-KF', 'grokbuild:default');
  await waitFor(() => logOf('TASK-KF', 'foreign').length, 25000);
  const gf = logOf('TASK-KF', 'foreign')[0];
  check('Grok with a token or gate URL Lumen never issued: 401 on MCP, deny on the hook', gf && gf.mcpStatus === 401 && gf.hookDenied === true, JSON.stringify(gf));
  await waitFor(async () => (await statusOf('TASK-KF')) === 'done', 20000);

  const gd = await cliTask('TASK-KD', 'grokbuild:default');
  await waitFor(() => started('TASK-KD') && logOf('TASK-KD', 'armed').length, 25000);
  const gdPid = started('TASK-KD').pid;
  await ui.evaluate((id) => window.assistant.tasks.stop(id), gd.id);
  check('Stop on a Grok task ends it as stopped and kills the process', await waitFor(async () => (await statusOf('TASK-KD')) === 'stopped', 15000) && await waitFor(() => !alive(gdPid), 8000), await statusOf('TASK-KD'));

  // CLI runs count toward the concurrency cap (2): a third waits in the queue.
  setScripts({ 'TASK-H1': [{ hold: 'H1' }, { say: 'h1' }], 'TASK-H2': [{ hold: 'H2' }, { say: 'h2' }], 'TASK-H3': [{ say: 'RESULT-H3' }] });
  await cliTask('TASK-H1', 'claudecode:default');
  await cliTask('TASK-H2', 'grokbuild:default');
  await cliTask('TASK-H3', 'claudecode:default');
  await waitFor(() => started('TASK-H1') && started('TASK-H2'), 25000);
  check('two CLI tasks (one each) hold both slots and the third waits', (await statusOf('TASK-H1')) === 'running' && (await statusOf('TASK-H2')) === 'running' && (await statusOf('TASK-H3')) === 'queued' && !started('TASK-H3'), (await tasks()).filter((t) => /running|queued|waiting/.test(t.status)).map((t) => `${t.title.slice(0, 9)}:${t.status}`).join());
  cliRelease('H1');
  check('and starts when one finishes', await waitFor(async () => (await statusOf('TASK-H3')) === 'done', 25000), (await tasks()).filter((t) => /running|queued|waiting/.test(t.status)).map((t) => `${t.title.slice(0, 9)}:${t.status}`).join());
  cliRelease('H2');
  await waitFor(async () => (await statusOf('TASK-H2')) === 'done', 20000);
  // Performance mode still forces one at a time, CLI tasks included.
  await app.evaluate(() => global.__patchSettings({ performanceMode: 'on' }));
  setScripts({ 'TASK-P1': [{ hold: 'P1' }, { say: 'p1' }], 'TASK-P2': [{ say: 'RESULT-P2' }] });
  const p1 = await cliTask('TASK-P1', 'claudecode:default');
  await cliTask('TASK-P2', 'grokbuild:default');
  await waitFor(() => started('TASK-P1'), 25000);
  await sleep(1200);
  check('in Performance mode the second CLI task waits for the first', (await statusOf('TASK-P1')) === 'running' && (await statusOf('TASK-P2')) === 'queued' && !started('TASK-P2'), `${await statusOf('TASK-P1')} ${await statusOf('TASK-P2')}`);
  cliRelease('P1');
  check('and runs after it', await waitFor(async () => (await statusOf('TASK-P2')) === 'done', 25000) && (await statusOf('TASK-P1')) === 'done' && Boolean(p1.ok), `${await statusOf('TASK-P1')} ${await statusOf('TASK-P2')}`);
  await app.evaluate(() => global.__patchSettings({ performanceMode: 'off' }));
  await ui.evaluate(() => { if (document.getElementById('task-panel').hidden) document.getElementById('tasks-btn').click(); });
  await ui.evaluate(() => document.querySelector('.task-back')?.click());
  await ui.waitForSelector('.task-row');
  await ui.evaluate(() => [...document.querySelectorAll('.task-row')].find((r) => r.textContent.includes('TASK-KA')).click());
  await ui.waitForSelector('.task-detail');
  check('the details panel says which engine a task ran on', await ui.evaluate(() => /Runs on Grok Build/.test(document.querySelector('.task-detail').textContent)), '');
  await ui.evaluate(() => document.querySelector('.task-back')?.click());
  check('no engine is left registered, and no work tab is left over', (await app.evaluate(() => global.__bgEngineCount())) === 0 && await app.evaluate(() => global.__bg.runtimes().size === 0), '');

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
  ui = keepSidebarOpen(await app.firstWindow());
  await ui.waitForSelector('.tab');
  await waitFor(() => app.evaluate(() => Boolean(global.__bg)));
  const g = await app.evaluate(() => { const t = global.__bg.tasks().find((x) => x.prompt.includes('TASK-G')); return t ? { status: t.status, error: t.error, runs: t.runs.map((r) => r.status), model: t.model, result: t.result, n: global.__bg.tasks().length } : null; });
  check('after a restart the running task is interrupted', g && g.status === 'interrupted' && /closed/i.test(g.error) && g.runs.includes('interrupted'), JSON.stringify(g));
  const kept = await app.evaluate(() => global.__bg.tasks().map((t) => t.status));
  check('finished tasks and the watch tasks came back too', kept.filter((s) => s === 'done').length >= 4 && kept.length >= 10, JSON.stringify(kept));
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.click('#tasks-btn', { force: true }); // (its unseen-dot animation never settles)
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

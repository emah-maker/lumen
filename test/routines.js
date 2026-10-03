// Routines (features/routines.js, features/background-runner.js, renderer/routines.js) in the real app,
// with a fake model: no API tokens, no real accounts, no system notifications (test mode records them).
// Create a routine in the Tasks panel's Routines tab, run it now, see its result and history; a routine
// starts on its own at its time with one timer; a missed time runs once after a wake (powerMonitor
// 'resume'); never two copies at once; the concurrency cap; offline waits; approvals pause it with a
// notification; a disabled routine doesn't run; history is capped; an AI-off start page fails clearly;
// /routine and "Save as routine" open the editor; a private window can't reach the routines calls.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-routines-'));
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-routines-cli-'));
const cleanup = () => { for (const dir of [profile, cliDir]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); };
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${req.url}</title><h1>${req.url}</h1><p>Page text for ${req.url}</p>`);
  }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;

  const fakeCli = path.join(__dirname, 'fixtures', 'fake-cli.js');
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: {
      ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1',
      // the CLIs are the fake process: the user's own Claude Code / Grok are never found or run
      LUMEN_TEST_CLI_SPAWN: fakeCli, LUMEN_TEST_CLI_DIR: cliDir, LUMEN_CLAUDE_BIN: fakeCli, LUMEN_GROK_BIN: fakeCli, GROK_HOME: path.join(cliDir, 'user-grok'),
    },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The fake Claude (as in test/bgtasks.js): each routine's turns, found by a ROUTINE-x marker in its prompt.
  await app.evaluate(() => {
    global.__scripts = {};
    global.__holds = {};
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const marker = /ROUTINE-[A-Z0-9]+/.exec(JSON.stringify(params.messages[0].content))?.[0];
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      const step = (global.__scripts[marker] || [])[turn] || { content: [{ type: 'text', text: `Result for ${marker}.` }] };
      const content = step.content.map((b, i) => (b.type === 'tool_use' ? { ...b, id: `tu_${marker}_${turn}_${i}_${Date.now()}` } : b));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 100, output_tokens: 10 } };
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
  const say = (text, hold) => ({ content: [{ type: 'text', text }], ...(hold ? { hold } : {}) });
  const tool = (name, input) => ({ content: [{ type: 'tool_use', name, input }] });
  const release = (name) => app.evaluate((_e, n) => { global.__holds[n]?.(); delete global.__holds[n]; }, name);
  const held = (name) => app.evaluate((_e, n) => Boolean(global.__holds[n]), name);
  const routine = (marker) => app.evaluate((_e, m) => {
    const t = global.__bg.tasks().find((x) => x.prompt.includes(m));
    return t ? { id: t.id, status: t.status, enabled: t.enabled, result: t.result, error: t.error, schedule: t.schedule, routine: JSON.parse(JSON.stringify(t.routine)), sites: t.allowedSites } : null;
  }, marker);
  const save = (spec) => ui.evaluate((s) => window.assistant.tasks.saveRoutine({ confirmed: true, ...s }), spec);
  const notes = () => app.evaluate(() => global.__bg.notifications().map((n) => ({ ...n })));
  // Make a routine overdue: its last handled time three days back (as if Lumen had been closed).
  const overdue = (id, days = 3) => app.evaluate((_e, [i, d]) => { const t = global.__bg.find(i); t.routine.lastDue = Date.now() - d * 86400000; t.createdAt = Math.min(t.createdAt, t.routine.lastDue); }, [id, days]);
  const runRoutines = () => app.evaluate(() => global.__bg.runRoutines());

  // ---- 0. The routines calls answer the browser UI only.
  const gate = await app.evaluate(() => ['routines:save', 'routines:preview'].map((c) => global.__ipcGate.uiOnly.has(c)));
  check('routines:save and routines:preview are UI-only IPC channels', gate.every(Boolean), JSON.stringify(gate));
  check('with no routines there is no routine timer', await app.evaluate(() => global.__bg.routineTimer() === null), '');

  // ---- 1. The Routines tab, and a routine made with the editor.
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.click('#tasks-btn');
  await ui.waitForSelector('.task-tabs');
  await ui.click('#task-tab-routines');
  await ui.waitForSelector('.routine-new');
  const tab = await ui.evaluate(() => ({ text: document.getElementById('task-panel').textContent, selected: document.getElementById('task-tab-routines').getAttribute('aria-selected'), templates: document.querySelectorAll('.routine-templates .routine-template').length }));
  check('the Routines tab says routines run only while Lumen is open, and offers three templates', tab.selected === 'true' && /while Lumen is open/.test(tab.text) && /No routines yet/.test(tab.text) && tab.templates === 3, JSON.stringify(tab));
  await ui.keyboard.press('ArrowLeft');
  check('arrow keys move between the Tasks and Routines tabs', await waitFor(() => ui.evaluate(() => document.getElementById('task-tab-tasks').getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'task-tab-tasks')), '');
  await ui.click('#task-tab-routines');
  await ui.waitForSelector('.routine-new');
  await ui.click('.routine-new');
  await ui.waitForSelector('.routine-create .task-create-card');
  check('the editor offers the templates and focuses the request', await ui.evaluate(() => document.querySelectorAll('.routine-template-row .routine-template').length === 3 && document.activeElement?.tagName === 'TEXTAREA'), '');
  await ui.evaluate(() => [...document.querySelectorAll('.routine-template-row .routine-template')][0].click());
  const tpl = await ui.evaluate(() => ({ name: document.querySelector('.routine-create input[type=text]').value, repeat: document.querySelector('.routine-repeat').value, prompt: document.querySelector('.routine-create textarea').value }));
  check('the news template fills a name, a weekday schedule and a request', tpl.name === 'Morning news brief' && tpl.repeat === 'weekdays' && /news brief/.test(tpl.prompt), JSON.stringify(tpl));
  await ui.fill('.routine-create input[type=text]', 'My brief');
  await ui.fill('.routine-create textarea', `ROUTINE-A read 127.0.0.1:${port}/a and report it`);
  await ui.selectOption('.routine-repeat', 'daily');
  await ui.fill('.routine-create input[type=time]', '07:45');
  check('the editor shows the next three runs', await waitFor(() => ui.evaluate(() => /^Next runs: .+ · .+ · .+/.test(document.querySelector('.routine-next').textContent))), await ui.evaluate(() => document.querySelector('.routine-next').textContent));
  await ui.selectOption('.routine-repeat', 'cron');
  await ui.fill('.routine-create input[aria-label="Cron schedule"]', '* * * * *');
  check('a cron schedule more often than every 5 minutes is refused before saving', await waitFor(() => ui.evaluate(() => /at most every 5 minutes/.test(document.querySelector('.routine-next').textContent))), await ui.evaluate(() => document.querySelector('.routine-next').textContent));
  await ui.selectOption('.routine-repeat', 'daily');
  await ui.click('.routine-create .approval-actions .btn.primary');
  const a = await waitFor(() => routine('ROUTINE-A'));
  check('Save makes the routine: scheduled, daily at 7:45, its site allowed', a && a.status === 'scheduled' && a.schedule.repeat === 'daily' && a.schedule.time === '07:45' && a.sites.includes(`127.0.0.1:${port}`), JSON.stringify(a));
  check('and opens its page, with no history yet', await waitFor(() => ui.evaluate(() => /Run history/.test(document.querySelector('.task-detail')?.textContent || '') && /not run yet/.test(document.querySelector('.task-detail').textContent))), '');
  const timer = await app.evaluate(() => global.__bg.routineTimer() !== null);
  check('one routine timer is set (no polling)', timer, '');
  const nextRun = await ui.evaluate(async () => (await window.assistant.tasks.state()).tasks.find((t) => t.schedule.type === 'routine').nextRun);
  const expected = new Date(); expected.setHours(7, 45, 0, 0); if (expected.getTime() <= Date.now()) expected.setDate(expected.getDate() + 1);
  check('its next run is the next 7:45 in local time', nextRun === expected.getTime(), `${new Date(nextRun)} vs ${expected}`);

  // ---- 2. Run now: the result is kept in its history, and its finish is announced.
  await script('ROUTINE-A', [tool('navigate', { url: `${base}/a` }), say('RESULT-A the page says hello')]);
  await ui.evaluate(() => document.querySelector('.task-back').click());
  await ui.waitForSelector('.routine-run-now');
  await ui.click('.routine-item .routine-run-now');
  check('Run now runs it to done', await waitFor(async () => (await routine('ROUTINE-A'))?.status === 'done'), JSON.stringify(await routine('ROUTINE-A')));
  let ra = await routine('ROUTINE-A');
  check('the run is in its history: done, run by you, with its result', ra.routine.history.length === 1 && ra.routine.history[0].status === 'done' && ra.routine.history[0].trigger === 'manual' && /RESULT-A/.test(ra.routine.history[0].result), JSON.stringify(ra.routine));
  check('a manual run does not move its schedule', await ui.evaluate(async () => (await window.assistant.tasks.state()).tasks.find((t) => t.schedule.type === 'routine').nextRun) === nextRun, '');
  const n1 = (await notes()).filter((x) => x.id === ra.id);
  check('its finish was announced as a routine (no system notification is shown in tests)', n1.some((x) => x.kind === 'done' && /^Routine “My brief” finished/.test(x.text)), JSON.stringify(n1));
  check('the routine is also in the background tasks list', await ui.evaluate(async () => { document.getElementById('task-tab-tasks').click(); await new Promise((r) => setTimeout(r, 200)); return [...document.querySelectorAll('.task-row')].some((r) => /My brief/.test(r.textContent) && /Every day at 7:45/.test(r.textContent)); }), await ui.evaluate(() => document.getElementById('task-panel').textContent));
  await ui.evaluate(() => [...document.querySelectorAll('.task-row')].find((r) => /My brief/.test(r.textContent)).click());
  await ui.waitForSelector('.routine-history');
  const hist = await ui.evaluate(() => ({ items: document.querySelectorAll('.routine-history li').length, text: document.querySelector('.routine-history').textContent, actions: [...document.querySelectorAll('.task-actions button')].map((b) => b.textContent) }));
  check('its page shows the history and Edit routine / Pause schedule', hist.items === 1 && /Done · run by you/.test(hist.text) && hist.actions.includes('Edit routine') && hist.actions.includes('Pause schedule') && !hist.actions.includes('Edit schedule'), JSON.stringify(hist));
  await ui.evaluate(() => document.querySelector('.routine-run summary').click());
  check('a history entry opens to its result', await ui.evaluate(() => /RESULT-A/.test(document.querySelector('.routine-run[open] .routine-result')?.textContent || '')), '');

  // ---- 3. Edit: the editor comes back filled in; saving keeps its history.
  await ui.evaluate(() => [...document.querySelectorAll('.task-actions button')].find((b) => b.textContent === 'Edit routine').click());
  await ui.waitForSelector('.routine-create');
  const filled = await ui.evaluate(() => ({ name: document.querySelector('.routine-create input[type=text]').value, time: document.querySelector('.routine-create input[type=time]').value, repeat: document.querySelector('.routine-repeat').value }));
  check('Edit routine opens the editor filled in', filled.name === 'My brief' && filled.time === '07:45' && filled.repeat === 'daily', JSON.stringify(filled));
  await ui.selectOption('.routine-repeat', 'weekly');
  await ui.evaluate(() => { for (const i of document.querySelectorAll('.routine-days input')) i.checked = ['2', '4'].includes(i.value); });
  await ui.click('.routine-create .approval-actions .btn.primary');
  ra = await waitFor(async () => { const r = await routine('ROUTINE-A'); return r?.schedule.repeat === 'weekly' ? r : null; });
  check('saving the edit changes the schedule and keeps the history', ra && JSON.stringify(ra.schedule.days) === '[2,4]' && ra.routine.history.length === 1, JSON.stringify(ra));

  // ---- 4. On its own at its time: a one-off routine a moment from now starts by itself.
  await script('ROUTINE-B', [say('RESULT-B on time')]);
  const b = await save({ title: 'Soon', prompt: 'ROUTINE-B say something', schedule: { repeat: 'once', at: Date.now() + 1500 } });
  check('a one-off routine is saved', b.ok, JSON.stringify(b));
  check('it starts by itself at its time and finishes', await waitFor(async () => (await routine('ROUTINE-B'))?.status === 'done', 9000), JSON.stringify(await routine('ROUTINE-B')));
  const rb = await routine('ROUTINE-B');
  check('…recorded as a scheduled run, and it will not run again', rb.routine.history.length === 1 && rb.routine.history[0].trigger === 'schedule' && await ui.evaluate(async (id) => (await window.assistant.tasks.state()).tasks.find((t) => t.id === id).nextRun === null, rb.id), JSON.stringify(rb.routine));
  const once = await save({ title: 'Past', prompt: 'ROUTINE-Z x', schedule: { repeat: 'once', at: Date.now() - 60000 } });
  check('a one-off time in the past is refused', once.ok === false && /future/.test(once.error), JSON.stringify(once));

  // ---- 5. Catch-up after a wake: three missed days run once.
  await script('ROUTINE-C', [say('RESULT-C caught up')]);
  const c = await save({ title: 'Daily', prompt: 'ROUTINE-C daily thing', schedule: { repeat: 'daily', time: '06:00' } });
  await overdue(c.id);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  check('after the computer wakes, a missed routine runs', await waitFor(async () => (await routine('ROUTINE-C'))?.status === 'done'), JSON.stringify(await routine('ROUTINE-C')));
  await sleep(600);
  await runRoutines();
  await sleep(400);
  const rc = await routine('ROUTINE-C');
  check('…once, as a catch-up, however many times were missed', rc.routine.history.length === 1 && rc.routine.history[0].trigger === 'catch-up' && rc.routine.history[0].scheduledFor > 0, JSON.stringify(rc.routine));

  // ---- 6. Never two copies: due again while still running, the time is skipped.
  await script('ROUTINE-D', [say('RESULT-D slow', 'D')]);
  const d = await save({ title: 'Slow', prompt: 'ROUTINE-D slow work', schedule: { repeat: 'daily', time: '06:00' } });
  await overdue(d.id);
  await runRoutines();
  await waitFor(() => held('D'));
  await overdue(d.id);
  await runRoutines();
  const runningCopies = await app.evaluate((_e, id) => [...global.__bg.runtimes().keys()].filter((k) => k === id).length, d.id);
  const rd = await routine('ROUTINE-D');
  check('a routine due while its previous run is going is skipped, not started twice', runningCopies === 1 && rd.status === 'running' && rd.routine.history.some((h) => h.status === 'skipped'), JSON.stringify([runningCopies, rd]));
  await release('D');
  await waitFor(async () => (await routine('ROUTINE-D'))?.status === 'done');

  // ---- 7. The concurrency cap: with one slot, two due routines run one after the other.
  await ui.evaluate(() => window.assistant.tasks.settings({ maxConcurrent: 1 }));
  await script('ROUTINE-E', [say('RESULT-E', 'E')]);
  await script('ROUTINE-F', [say('RESULT-F', 'F')]);
  const e = await save({ title: 'E', prompt: 'ROUTINE-E one', schedule: { repeat: 'daily', time: '06:00' } });
  const f = await save({ title: 'F', prompt: 'ROUTINE-F two', schedule: { repeat: 'daily', time: '06:00' } });
  await overdue(e.id);
  await overdue(f.id);
  await runRoutines();
  await waitFor(async () => (await held('E')) || (await held('F')));
  await sleep(300);
  const both = [(await routine('ROUTINE-E')).status, (await routine('ROUTINE-F')).status].sort();
  check('one slot: one routine runs, the other waits queued', JSON.stringify(both) === JSON.stringify(['queued', 'running']), JSON.stringify(both));
  await release('E');
  await release('F');
  await waitFor(() => held('E').then(async (x) => x || held('F')));
  await release('E');
  await release('F');
  check('…and the second runs when the first is done', await waitFor(async () => (await routine('ROUTINE-E')).status === 'done' && (await routine('ROUTINE-F')).status === 'done'), JSON.stringify([await routine('ROUTINE-E'), await routine('ROUTINE-F')]));
  await ui.evaluate(() => window.assistant.tasks.settings({ maxConcurrent: 2 }));

  // ---- 8. Offline: a due routine waits for the connection.
  await script('ROUTINE-G', [say('RESULT-G back online')]);
  const g = await save({ title: 'G', prompt: 'ROUTINE-G online only', schedule: { repeat: 'daily', time: '06:00' } });
  await app.evaluate(() => global.__bg.setOnline(() => false));
  await overdue(g.id);
  await runRoutines();
  await sleep(400);
  const off = await routine('ROUTINE-G');
  check('offline, a due routine does not start, and the Routines tab says so', off.status === 'scheduled' && await ui.evaluate(async () => (await window.assistant.tasks.state()).offline === true), JSON.stringify(off));
  check('…while offline it looks again in a minute (one timer)', await app.evaluate(() => global.__bg.routineTimer() !== null), '');
  await app.evaluate(() => global.__bg.setOnline(() => true));
  await runRoutines();
  check('back online, it runs', await waitFor(async () => (await routine('ROUTINE-G')).status === 'done'), JSON.stringify(await routine('ROUTINE-G')));

  // ---- 9. Approvals: a step outside its sites pauses the routine and says it needs the user's OK.
  await script('ROUTINE-H', [tool('navigate', { url: `${other}/h` }), say('RESULT-H')]);
  const hr = await save({ title: 'Asks', prompt: `ROUTINE-H start at 127.0.0.1:${port}/a`, schedule: { repeat: 'daily', time: '06:00' } });
  await overdue(hr.id);
  await runRoutines();
  check('a step on a site it may not visit pauses it for approval', await waitFor(async () => (await routine('ROUTINE-H'))?.status === 'waiting-approval'), JSON.stringify(await routine('ROUTINE-H')));
  const asked = (await notes()).filter((x) => x.id === hr.id && x.kind === 'approval');
  check('…and the notification says the routine needs your OK', asked.length === 1 && /Routine “Asks” is paused: it needs your OK/.test(asked[0].text), JSON.stringify(asked));
  const card = await app.evaluate((_e, id) => [...global.__bg.runtimes().get(id).pending.values()][0], hr.id);
  await ui.evaluate(([id, approvalId]) => window.assistant.tasks.approve(id, approvalId, 'deny'), [hr.id, card.approvalId]);
  check('denied, the run ends without visiting it', await waitFor(async () => ['done', 'failed'].includes((await routine('ROUTINE-H')).status)), JSON.stringify(await routine('ROUTINE-H')));

  // ---- 10. Disable stops it; enabling again doesn't run the times it was off for.
  await script('ROUTINE-I', [say('RESULT-I')]);
  const ir = await save({ title: 'Off', prompt: 'ROUTINE-I do not run', schedule: { repeat: 'daily', time: '06:00' } });
  await ui.evaluate(() => { document.getElementById('task-panel').querySelector('.task-back')?.click(); });
  await ui.evaluate(() => document.getElementById('task-tab-routines')?.click());
  // (The list redraws once the save lands: wait for this routine's own row, not just any switch.)
  await ui.waitForFunction(() => [...document.querySelectorAll('.routine-item')].some((li) => /Off/.test(li.textContent) && li.querySelector('.routine-toggle')), null, { timeout: 8000 });
  await ui.evaluate(() => [...document.querySelectorAll('.routine-item')].find((li) => /Off/.test(li.textContent)).querySelector('.routine-toggle').click());
  check('the list\'s switch turns a routine off', await waitFor(async () => (await routine('ROUTINE-I')).enabled === false), '');
  await overdue(ir.id);
  await runRoutines();
  await sleep(500);
  check('a disabled routine does not run when due', (await routine('ROUTINE-I')).status === 'scheduled', JSON.stringify(await routine('ROUTINE-I')));
  await ui.evaluate((id) => window.assistant.tasks.enable(id, true), ir.id);
  await runRoutines();
  await sleep(500);
  const back = await routine('ROUTINE-I');
  check('turned back on, the times it was off for do not run', back.status === 'scheduled' && back.enabled && back.routine.lastDue > Date.now() - 5000, JSON.stringify(back));

  // ---- 11. History is capped.
  await app.evaluate((_e, id) => { const t = global.__bg.find(id); for (let i = 0; i < 25; i++) t.routine.history.push({ startedAt: i, endedAt: i, status: 'done', trigger: 'schedule', scheduledFor: null, result: `old ${i}`, error: '' }); }, c.id);
  await ui.evaluate((id) => window.assistant.tasks.run(id), c.id);
  await waitFor(async () => (await routine('ROUTINE-C')).status === 'running');
  await waitFor(async () => (await routine('ROUTINE-C')).status === 'done');
  const capped = await routine('ROUTINE-C');
  check('the history keeps the newest 20 runs', capped.routine.history.length === 20 && capped.routine.history[19].trigger === 'manual', capped.routine.history.length);

  // ---- 12. A start page with AI turned off: the routine does not run, and says why.
  await app.evaluate((_e, u) => global.__aiSites.set(u, true), `${other}/`);
  const j = await save({ title: 'Blocked', prompt: 'ROUTINE-J read it', startUrl: `${other}/start`, schedule: { repeat: 'daily', time: '06:00' } });
  await ui.evaluate((id) => window.assistant.tasks.run(id), j.id);
  check('a routine whose start page has AI off fails, saying so', await waitFor(async () => { const r = await routine('ROUTINE-J'); return r.status === 'failed' && /AI is turned off/.test(r.error); }), JSON.stringify(await routine('ROUTINE-J')));
  check('…and the failure is announced', (await notes()).some((x) => x.id === j.id && x.kind === 'failed' && /Routine “Blocked” failed: AI is turned off/.test(x.text)), JSON.stringify(await notes()));
  await app.evaluate((_e, u) => global.__aiSites.set(u, false), `${other}/`);

  // ---- 13. /routine every weekday at 7am: ... opens the editor filled in.
  await ui.evaluate(() => { document.querySelector('.task-close')?.click(); });
  await ui.fill('#prompt', '/routine ');
  await ui.waitForSelector('.slash-chip:not([hidden])');
  await ui.fill('#prompt', 'every weekday at 7am: ROUTINE-S brief me');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.routine-create');
  const slashed = await ui.evaluate(() => ({ repeat: document.querySelector('.routine-repeat').value, time: document.querySelector('.routine-create input[type=time]').value, prompt: document.querySelector('.routine-create textarea').value }));
  check('/routine reads the schedule in front of the request', slashed.repeat === 'weekdays' && slashed.time === '07:00' && slashed.prompt === 'ROUTINE-S brief me', JSON.stringify(slashed));
  await ui.keyboard.press('Escape');
  check('Escape closes the editor', await waitFor(() => ui.evaluate(() => !document.querySelector('.routine-create'))), '');

  // ---- 14. "Save as routine" on a reply.
  await script('ROUTINE-R', [say('Here is your answer.')]);
  await ui.evaluate(() => window.ask('ROUTINE-R what is new today?'));
  await ui.waitForSelector('.msg.assistant .reply-routine', { timeout: 10000 }).catch(() => {});
  const hasButton = await ui.evaluate(() => Boolean(document.querySelector('.msg.assistant .reply-routine')));
  check('a finished reply has Save as routine', hasButton, await ui.evaluate(() => document.getElementById('messages').innerHTML.slice(-600)));
  if (hasButton) {
    await ui.evaluate(() => [...document.querySelectorAll('.msg.assistant .reply-routine')].pop().click());
    await ui.waitForSelector('.routine-create');
    check('…which opens the editor with the request that led to it', await ui.evaluate(() => document.querySelector('.routine-create textarea').value === 'ROUTINE-R what is new today?'), await ui.evaluate(() => document.querySelector('.routine-create textarea').value));
    await ui.keyboard.press('Escape');
  }

  // ---- 15. A private window can't reach the routines calls.
  await app.evaluate(() => global.__private.open());
  await waitFor(() => app.evaluate(() => global.__private.count() === 1 && global.__private.list()[0].tabs.length === 1));
  const priv = await app.evaluate(() => global.__private.list()[0]);
  const attempt = await app.evaluate(async ({ ipcMain, BrowserWindow }, windowId) => {
    const wc = BrowserWindow.fromId(windowId).webContents;
    const call = async (channel, ...args) => { try { await ipcMain._invokeHandlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args); return 'allowed'; } catch (err) { return err.message; } };
    return { save: await call('routines:save', { prompt: 'ROUTINE-P x', schedule: { repeat: 'daily', time: '08:00' }, confirmed: true }), preview: await call('routines:preview', {}) };
  }, priv.windowId);
  check('a private window\'s routines calls are refused', attempt.save === 'Not allowed' && attempt.preview === 'Not allowed' && !(await routine('ROUTINE-P')), JSON.stringify(attempt));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), priv.windowId);

  // ---- 16. Deleting the routines leaves no timer.
  await app.evaluate(() => { for (const t of [...global.__bg.tasks()]) global.__bg.remove(t.id); });
  check('with every routine deleted, the routine timer is gone', await waitFor(() => app.evaluate(() => global.__bg.routineTimer() === null)), '');

  check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  cleanup();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });

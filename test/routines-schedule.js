// Scheduled routines from every AI surface (features/routines.js, features/background-runner.js, renderer/routines.js, the home page's
// Routines card, Settings → Routines), end to end in a hidden window with a stub AI provider and a fake clock (global.__clockOffset moves
// the runner's clock forward; the real timer is never waited for: the test calls runRoutines() the way the timer would). No real network,
// no real accounts (Canvas is a stand-in on 127.0.0.1), no system notifications (test mode records them).
//  1. In the sidebar: typing "every weekday at 8am …" offers to make a routine; Save makes it.
//  2. The routine shows on the home page's Routines card, in Settings, and in the Tasks panel (one store).
//  3. Time moves to its next run: it runs by itself, a notification is recorded, the result is on the card, in Settings and in its history.
//  4. A routine that needs an approval (a site outside its list, a "Buy now" click) waits and asks; nothing happens until the user says yes.
//  5. Missed runs: one run, marked late. Quiet hours hold a run until they end, then it runs once, late.
//  6. One-click templates are made switched off and never run until turned on; a Canvas routine reads the stand-in Canvas.
//  7. Switching a routine off in Settings shows in the sidebar and on the home card; deleting it leaves no timer.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startFakes } = require('./fixtures/fake-connectors');
const { openSettingsTab } = require('./settings-tab');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-routines-sched-'));
const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  let bought = 0; // how many times the shop page's Buy now button was really clicked
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/bought')) bought++;
    res.end(req.url.startsWith('/shop') ? '<title>Shop</title><h1>Shop</h1><button id="b" onclick="fetch(&quot;/bought&quot;)">Buy now</button>' : `<title>Page ${req.url}</title><h1>${req.url}</h1><p>Page text for ${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const fakes = await startFakes();

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The stub AI provider: each routine's turns come from a script found by a marker in its request (ROUTINE-x, or "app canvas" for the Canvas template).
  await app.evaluate((_e, urls) => {
    global.__connectorEndpoints = { canvas: urls.canvas };
    global.__scripts = {};
    global.__holds = {};
    global.__toolsSeen = {};
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      const text = JSON.stringify(params.messages[0].content);
      const marker = /ROUTINE-[A-Z0-9]+/.exec(text)?.[0] || (/app canvas/.test(text) ? 'CANVAS' : 'NONE');
      (global.__toolsSeen[marker] ||= new Set());
      for (const t of params.tools || []) global.__toolsSeen[marker].add(t.name);
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      const step = (global.__scripts[marker] || [])[turn] || { content: [{ type: 'text', text: `Result for ${marker}.` }] };
      const content = step.content.map((b, i) => (b.type === 'tool_use' ? { ...b, id: `tu_${marker}_${turn}_${i}_${Date.now()}` } : b));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 100, output_tokens: 10 } };
      return {
        async *[Symbol.asyncIterator]() { for (const b of content) if (b.type === 'text') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: b.text } }; },
        finalMessage: async () => message,
      };
    } } } });
  }, fakes.urls);
  const script = (marker, turns) => app.evaluate((_e, [m, t]) => { global.__scripts[m] = t; }, [marker, turns]);
  const say = (text) => ({ content: [{ type: 'text', text }] });
  const tool = (name, input) => ({ content: [{ type: 'tool_use', name, input }] });
  const routine = (marker) => app.evaluate((_e, m) => {
    const t = global.__bg.tasks().find((x) => x.prompt.includes(m));
    return t ? { id: t.id, title: t.title, status: t.status, enabled: t.enabled, result: t.result, error: t.error, schedule: t.schedule, routine: JSON.parse(JSON.stringify(t.routine)), pages: t.pages, sites: t.allowedSites } : null;
  }, marker);
  const notes = () => app.evaluate(() => global.__bg.notifications().map((n) => ({ ...n })));
  const runRoutines = () => app.evaluate(() => global.__bg.runRoutines()); // what the one timer does when it fires
  const view = () => app.evaluate(() => global.__bg.routineView({ history: true }));
  // The fake clock: Lumen's runner sees `ms` later than the real time. Returns the offset in force.
  const travelTo = (ms) => app.evaluate((_e, to) => { global.__clockOffset = to - Date.now(); return global.__clockOffset; }, ms);
  // The next local wall-clock time hh:mm that is after `from`, on a weekday when `weekday` is true.
  const nextClock = (from, hh, mm, weekday) => { const d = new Date(from); d.setHours(hh, mm, 0, 0); while (d.getTime() <= from || (weekday && [0, 6].includes(d.getDay()))) d.setDate(d.getDate() + 1); return d.getTime(); };

  // Quiet hours would hold a run if the test happened to start at night: they are off until test 5.
  const T0 = Date.now();

  // ---- 1. The sidebar: the phrase offer and the editor.
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', 'Every weekday at 8am ROUTINE-S1 check my email and summarize what needs a reply');
  check('typing "every weekday at 8am …" offers to make a routine', await waitFor(() => ui.evaluate(() => { const b = document.querySelector('.routine-offer'); return b && !b.hidden && /Make this a routine\?/.test(b.textContent) && /Weekdays at 8:00/.test(b.textContent); })), await ui.evaluate(() => document.querySelector('.routine-offer')?.outerHTML));
  check('…as a status message that does not take the focus', await ui.evaluate(() => document.querySelector('.routine-offer').getAttribute('role') === 'status' && document.activeElement?.id === 'prompt'), '');
  await ui.click('.routine-offer-yes');
  await ui.waitForSelector('.routine-create .task-create-card');
  const filled = await ui.evaluate(() => ({ repeat: document.querySelector('.routine-repeat').value, time: document.querySelector('.routine-create input[type=time]').value, prompt: document.querySelector('.routine-create textarea').value, next: document.querySelector('.routine-next').textContent }));
  check('the editor opens with the schedule and the request filled in, and shows the next runs', filled.repeat === 'weekdays' && filled.time === '08:00' && /^ROUTINE-S1 check my email/.test(filled.prompt), JSON.stringify(filled));
  await ui.fill('.routine-create input[type=text]', 'Email check');
  await ui.click('.routine-create .approval-actions .btn.primary');
  const s1 = await waitFor(() => routine('ROUTINE-S1'));
  check('Save makes a routine on weekdays at 8:00, on, waiting for its time', s1 && s1.schedule.repeat === 'weekdays' && s1.schedule.time === '08:00' && s1.enabled && s1.status === 'scheduled', JSON.stringify(s1));
  check('the message box was emptied and the routine has one timer', await ui.evaluate(() => document.getElementById('prompt').value === '') && await app.evaluate(() => global.__bg.routineTimer() !== null), '');
  // Escape closes the sidebar panel, leaving the chat.
  await ui.evaluate(() => document.querySelector('.task-close')?.click());

  // ---- 2. One store: the home card and Settings show it.
  await app.evaluate(() => global.__widgets.save({ type: 'routines' }));
  await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__homeTab = t; });
  const inHome = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
  check('the home page has a Routines card that lists the routine under Next runs', await waitFor(() => inHome("[...document.querySelectorAll('.w-card.routines .rt-next .rt-row')].some((b) => /Email check/.test(b.textContent))"), 12000), await inHome("document.querySelector('.w-card.routines')?.textContent"));
  check('…with a quick New routine button', await inHome("Boolean(document.querySelector('.w-card.routines .rt-add'))"), '');
  await inHome("document.querySelector('.w-card.routines .rt-add').click(); true");
  check('New routine on the card opens the editor in the sidebar', await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.routine-create .task-create-card')))), '');
  await ui.keyboard.press('Escape');
  check('Escape closes it again', await waitFor(() => ui.evaluate(() => !document.querySelector('.routine-create'))), '');
  const inSettings = await openSettingsTab(app, 'routines');
  const rowOf = (title) => `document.querySelector('#routines-list .rt-item[data-routine=' + JSON.stringify(${JSON.stringify(title)}) + ']')`;
  await waitFor(async () => (await inSettings(`Boolean(${rowOf('Email check')})`)) === true, 12000);
  const srow = JSON.parse(await inSettings(`(() => { const li = ${rowOf('Email check')}; return JSON.stringify({ on: li.querySelector('input[type=checkbox]').checked, schedule: li.querySelector('.rt-schedule').textContent, next: li.querySelector('.rt-next').textContent, buttons: [...li.querySelectorAll('button')].flatMap((b) => [...b.classList]) }); })()`));
  check('Settings lists the routine, on, with its schedule in words and its next run', srow.on === true && /Weekdays at 8:00/.test(srow.schedule) && srow.next.length > 4, JSON.stringify(srow));
  check('…with Edit, Run now and Delete, and a History disclosure', ['rt-edit', 'rt-run', 'rt-delete'].every((c) => srow.buttons.includes(c)) && (await inSettings(`Boolean(${rowOf('Email check')}.querySelector('details.rt-history'))`)) === true, JSON.stringify(srow));

  // ---- 3. Time moves on: it runs by itself at 8:00 and announces its result.
  await script('ROUTINE-S1', [say('RESULT-S1 two emails need a reply: Dana (budget) and Lee (travel).')]);
  const due = nextClock(T0, 8, 0, true);
  await travelTo(due + 20000); // 20 seconds after 8:00 on the next weekday
  await runRoutines();
  check('at its time it starts by itself and finishes', await waitFor(async () => (await routine('ROUTINE-S1'))?.status === 'done', 12000), JSON.stringify(await routine('ROUTINE-S1')));
  const done1 = await routine('ROUTINE-S1');
  const h1 = done1.routine.history;
  check('recorded as a scheduled run (not late) with its result', h1.length === 1 && h1[0].trigger === 'schedule' && h1[0].status === 'done' && /RESULT-S1/.test(h1[0].result) && h1[0].scheduledFor === due, JSON.stringify(h1));
  check('a notification says the routine finished', (await notes()).some((n) => n.id === done1.id && n.kind === 'done' && /^Routine “Email check” finished/.test(n.text) && !/ran late/.test(n.text)), JSON.stringify(await notes()));
  check('the next run is the next weekday 8:00 and the one timer is set again', await app.evaluate((_e, id) => global.__bg.find(id).status === 'done' && global.__bg.routineTimer() !== null, done1.id) && (await view()).routines.find((r) => r.id === done1.id).nextRun === nextClock(due + 20000, 8, 0, true), JSON.stringify((await view()).routines.map((r) => r.nextRun)));
  check('the home card shows the result under Latest results', await waitFor(() => inHome("[...document.querySelectorAll('.w-card.routines .rt-latest .rt-row')].some((b) => /Email check/.test(b.textContent) && /RESULT-S1/.test(b.textContent))"), 10000), await inHome("document.querySelector('.w-card.routines')?.textContent"));
  check('…and the next run moved to the next weekday', await waitFor(() => inHome("[...document.querySelectorAll('.w-card.routines .rt-next .rt-row')].some((b) => /Email check/.test(b.textContent) && /8:00/.test(b.textContent))")), '');
  await inHome("[...document.querySelectorAll('.w-card.routines .rt-latest .rt-row')].find((b) => /Email check/.test(b.textContent)).click(); true");
  check('clicking the result opens the routine and its result in the sidebar', await waitFor(() => ui.evaluate(() => /Email check/.test(document.getElementById('task-panel').textContent) && /RESULT-S1/.test(document.querySelector('.task-detail')?.textContent || ''))), await ui.evaluate(() => document.getElementById('task-panel')?.textContent.slice(0, 300)));
  await ui.evaluate(() => document.querySelector('.task-close')?.click());
  const srow2 = await waitFor(async () => { const r = JSON.parse(await inSettings(`(() => { window.dispatchEvent(new Event('focus')); const li = ${rowOf('Email check')}; return JSON.stringify({ last: li.querySelector('.rt-last').textContent, snippet: li.querySelector('.rt-snippet')?.textContent || '' }); })()`)); return /RESULT-S1/.test(r.snippet) ? r : null; }, 8000);
  check('Settings shows the last run and its result after the run', srow2 && /Done/.test(srow2.last), JSON.stringify(srow2));
  check('its History opens to the run, with the full result', (await inSettings(`${rowOf('Email check')}.querySelectorAll('details.rt-history .rt-run-entry').length`)) === 1 && /Dana \(budget\)/.test(await inSettings(`${rowOf('Email check')}.querySelector('details.rt-history pre.rt-result')?.textContent || ''`)), '');
  await ui.evaluate(() => window.assistant.tasks.state());
  check('the Tasks panel (sidebar) lists the same routine with its result', await ui.evaluate(async (id) => { const t = (await window.assistant.tasks.get(id)); return t.routine.history.length === 1 && /RESULT-S1/.test(t.result); }, done1.id), '');

  // ---- 4. Approvals: a scheduled run never acts silently.
  await script('ROUTINE-A1', [tool('navigate', { url: `${other}/outside` }), say('RESULT-A1 should not get here without a yes')]);
  const a1 = await ui.evaluate((p) => window.assistant.tasks.saveRoutine({ confirmed: true, title: 'Outside', prompt: `ROUTINE-A1 start at 127.0.0.1:${p}/a`, schedule: { repeat: 'daily', time: '09:00' } }), port);
  check('an approval routine is saved', a1.ok, JSON.stringify(a1));
  await travelTo(nextClock(Date.now() + (await app.evaluate(() => global.__clockOffset)), 9, 0) + 5000);
  await runRoutines();
  check('a site outside its list pauses the run and asks', await waitFor(async () => (await routine('ROUTINE-A1'))?.status === 'waiting-approval'), JSON.stringify(await routine('ROUTINE-A1')));
  await sleep(400);
  const waiting = await routine('ROUTINE-A1');
  check('while it waits nothing has been visited and the result is empty', !waiting.pages.some((p) => /localhost/.test(p.url || p)) && waiting.result === '', JSON.stringify(waiting.pages));
  check('the notification asks for the user’s OK', (await notes()).filter((n) => n.id === a1.id && n.kind === 'approval').length === 1, JSON.stringify(await notes()));
  check('the home card flags it as needing the user’s OK', await waitFor(() => inHome("[...document.querySelectorAll('.w-card.routines .rt-waiting')].some((li) => /Outside/.test(li.textContent) && /Needs your OK/.test(li.textContent))"), 8000), await inHome("document.querySelector('.w-card.routines')?.textContent"));
  check('the routine shows as needing approval on the Routines list', (await view()).routines.find((r) => r.id === a1.id).pending === 1, '');
  const card = await app.evaluate((_e, id) => [...global.__bg.runtimes().get(id).pending.values()][0], a1.id);
  await ui.evaluate(([id, approvalId]) => window.assistant.tasks.approve(id, approvalId, 'deny'), [a1.id, card.approvalId]);
  check('denied, it ends without the page ever being visited', await waitFor(async () => ['done', 'failed'].includes((await routine('ROUTINE-A1')).status)) && !(await routine('ROUTINE-A1')).pages.some((p) => /localhost/.test(p.url || p)), JSON.stringify(await routine('ROUTINE-A1')));

  await script('ROUTINE-A2', [tool('navigate', { url: `${base}/shop` }), tool('click', { text: 'Buy now' }), say('RESULT-A2 bought it')]);
  const a2 = await ui.evaluate((p) => window.assistant.tasks.saveRoutine({ confirmed: true, title: 'Shopper', prompt: `ROUTINE-A2 open 127.0.0.1:${p}/shop`, schedule: { repeat: 'daily', time: '10:00' } }), port);
  await travelTo(nextClock(Date.now() + (await app.evaluate(() => global.__clockOffset)), 10, 0) + 5000);
  await runRoutines();
  check('a step that would buy something waits for the user, even on a schedule', await waitFor(async () => { const r = await routine('ROUTINE-A2'); return r?.status === 'waiting-approval'; }, 12000), JSON.stringify(await routine('ROUTINE-A2')));
  const buy = await app.evaluate((_e, id) => [...global.__bg.runtimes().get(id).pending.values()][0], a2.id);
  check('…and the card names the click', /Buy now/.test(JSON.stringify(buy)), JSON.stringify(buy));
  await ui.evaluate(([id, approvalId]) => window.assistant.tasks.approve(id, approvalId, 'deny'), [a2.id, buy.approvalId]);
  await waitFor(async () => ['done', 'failed'].includes((await routine('ROUTINE-A2')).status));
  await sleep(500);
  check('denied, the Buy now button was never clicked', bought === 0, bought);
  // The same run again, this time allowed once: the click goes through (so the check above is not an empty one).
  await ui.evaluate((id) => window.assistant.tasks.run(id), a2.id);
  check('run again, it asks again', await waitFor(async () => (await routine('ROUTINE-A2')).status === 'waiting-approval', 12000), JSON.stringify(await routine('ROUTINE-A2')));
  const buy2 = await app.evaluate((_e, id) => [...global.__bg.runtimes().get(id).pending.values()][0], a2.id);
  await ui.evaluate(([id, approvalId]) => window.assistant.tasks.approve(id, approvalId, 'once'), [a2.id, buy2.approvalId]);
  check('allowed once by the user, the click happens', await waitFor(() => bought === 1), bought);
  await waitFor(async () => ['done', 'failed'].includes((await routine('ROUTINE-A2')).status));

  // ---- 5. Missed runs and quiet hours.
  await app.evaluate((_e, ids) => { for (const id of ids) global.__bg.remove(id); }, [a1.id, a2.id]); // (the two approval routines would be due again after three days and hold both slots)
  await script('ROUTINE-M1', [say('RESULT-M1 caught up')]);
  const m1 = await ui.evaluate(() => window.assistant.tasks.saveRoutine({ confirmed: true, title: 'Morning', prompt: 'ROUTINE-M1 brief', schedule: { repeat: 'daily', time: '06:00' } }));
  const clockNow = async () => Date.now() + (await app.evaluate(() => global.__clockOffset));
  await travelTo(nextClock(await clockNow(), 6, 0) + 3 * 86400000 + 3 * 3600000); // three days later: the PC slept
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume')); // the wake
  check('after a long sleep the missed routine runs', await waitFor(async () => (await routine('ROUTINE-M1'))?.status === 'done', 12000), JSON.stringify(await routine('ROUTINE-M1')));
  await runRoutines();
  await sleep(500);
  const mh = (await routine('ROUTINE-M1')).routine.history;
  check('…once, marked as ran late', mh.length === 1 && mh[0].trigger === 'catch-up', JSON.stringify(mh));
  check('…and the notification says it ran late', (await notes()).some((n) => n.id === m1.id && n.kind === 'done' && /ran late/.test(n.text)), JSON.stringify((await notes()).filter((n) => n.id === m1.id)));

  await ui.evaluate(() => window.assistant.tasks.settings({ quiet: { on: true, from: '22:00', to: '07:00' } }));
  check('quiet hours are saved', (await view()).quiet.on === true && (await view()).quiet.from === '22:00', JSON.stringify((await view()).quiet));
  await script('ROUTINE-Q1', [say('RESULT-Q1 after quiet hours')]);
  const q1 = await ui.evaluate(() => window.assistant.tasks.saveRoutine({ confirmed: true, title: 'Early', prompt: 'ROUTINE-Q1 early brief', schedule: { repeat: 'daily', time: '06:30' } }));
  const q6 = nextClock(await clockNow(), 6, 30);
  await travelTo(q6 + 60000); // 6:31, inside quiet hours
  await runRoutines();
  await sleep(500);
  const held = await routine('ROUTINE-Q1');
  check('a run due in quiet hours does not start', held.status === 'scheduled' && held.routine.history.length === 0, JSON.stringify(held));
  check('the single timer is set for the end of quiet hours (never longer than an hour)', await app.evaluate(() => global.__bg.routineTimer() !== null), '');
  await travelTo(nextClock(q6, 7, 0) + 5000); // 7:00:05
  await runRoutines();
  check('when quiet hours end it runs', await waitFor(async () => (await routine('ROUTINE-Q1'))?.status === 'done', 12000), JSON.stringify(await routine('ROUTINE-Q1')));
  await sleep(300);
  const qh = (await routine('ROUTINE-Q1')).routine.history;
  check('…once, marked as ran late', qh.length === 1 && qh[0].trigger === 'catch-up' && qh[0].scheduledFor === q6, JSON.stringify(qh));
  await ui.evaluate(() => window.assistant.tasks.settings({ quiet: { on: false } }));
  void q1;

  // ---- 6. Templates are made switched off; a Canvas routine reads the stand-in Canvas.
  await ui.evaluate(() => document.getElementById('more-actions').click());
  await ui.click('#tasks-btn');
  await ui.waitForSelector('.task-tabs');
  await ui.click('#task-tab-routines');
  await ui.waitForSelector('.routine-template-card');
  const cards = await ui.evaluate(() => [...document.querySelectorAll('.routine-template-card')].map((c) => ({ name: c.querySelector('.task-title').textContent, meta: c.textContent, disabled: c.querySelector('button').disabled })));
  check('the Routines tab has the four one-click templates', cards.map((c) => c.name).join('|') === 'Morning email check|Canvas: what’s due today|Daily news brief|Weekly calendar preview', JSON.stringify(cards));
  check('the Gmail and Canvas ones say they need a connector, the news one does not', /Needs Gmail/.test(cards[0].meta) && /Needs Canvas/.test(cards[1].meta) && !/Needs/.test(cards[2].meta) && /Needs Google Calendar/.test(cards[3].meta), JSON.stringify(cards));
  await ui.evaluate(() => document.querySelector('.routine-template-card .routine-template-add').click());
  const email = await waitFor(async () => (await view()).routines.find((r) => r.template === 'email'));
  check('one click adds "Morning email check", switched off, on weekdays at 8:00', email && email.enabled === false && email.schedule.repeat === 'weekdays' && email.schedule.time === '08:00' && email.title === 'Morning email check', JSON.stringify(email));
  check('its request names the Gmail connector and says what to do when it is not connected', await app.evaluate((_e, id) => { const t = global.__bg.find(id); return /app gmail/.test(t.prompt) && /Settings, then AI and agents, then Connectors/.test(t.prompt) && /never reply to, send, archive or delete/.test(t.prompt); }, email.id), '');
  check('the card now says it is added and cannot be added twice', await waitFor(() => ui.evaluate(() => { const b = document.querySelector('.routine-template-card .routine-template-add'); return b && b.disabled && /Already added/.test(b.textContent); })), '');
  await travelTo(nextClock(await clockNow(), 8, 0, true) + 5000);
  await runRoutines();
  await sleep(600);
  check('a template that is off never runs, however much time passes', (await app.evaluate((_e, id) => { const t = global.__bg.find(id); return [t.status, t.routine.history.length]; }, email.id)).join() === 'scheduled,0', '');
  // Turn it on: it runs at its next time, without the connector it says how to connect.
  await script('app gmail', [say('RESULT-EMAIL Gmail is not connected. Open Settings, You and AI, Connectors, then connect Gmail.')]);
  void script; // (the marker of the email template is a "ROUTINE-" free request: its stub reply is the default text)
  await ui.evaluate((id) => window.assistant.tasks.enable(id, true), email.id);
  check('turning it on shows it on in the list', (await view()).routines.find((r) => r.id === email.id).enabled === true, '');

  // Connect the stand-in Canvas (the user's own sign-in session cookie) and add the Canvas template.
  await app.evaluate(async ({ session }, { url, cookie }) => { const [name, value] = cookie.split('='); await session.defaultSession.cookies.set({ url, name, value }); }, { url: fakes.urls.canvas, cookie: fakes.cookie });
  const conn = await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.get('connectors:connect')({}, 'canvas', { domain: 'school.instructure.com' }));
  check('Canvas connects through the stand-in', conn && conn.ok !== false, JSON.stringify(conn));
  await ui.evaluate(() => document.getElementById('task-tab-tasks').click());
  await ui.evaluate(() => document.getElementById('task-tab-routines').click());
  check('the Canvas template card now says Canvas is connected', await waitFor(() => ui.evaluate(() => /Canvas is connected/.test(document.querySelectorAll('.routine-template-card')[1]?.textContent || ''))), await ui.evaluate(() => document.querySelectorAll('.routine-template-card')[1]?.textContent));
  await ui.evaluate(() => document.querySelectorAll('.routine-template-card .routine-template-add')[1].click());
  const canvas = await waitFor(async () => (await view()).routines.find((r) => r.template === 'canvas'));
  check('"Canvas: what’s due today" is added switched off at 7:30 on weekdays', canvas && !canvas.enabled && canvas.schedule.time === '07:30', JSON.stringify(canvas));
  await script('CANVAS', [tool('connector', { app: 'canvas', action: 'upcoming', days: 2 }), say('RESULT-CANVAS Lab 5 report is due tomorrow.')]);
  await ui.evaluate((id) => window.assistant.tasks.enable(id, true), canvas.id);
  await travelTo(nextClock(await clockNow(), 7, 30, true) + 5000);
  await runRoutines();
  check('turned on, the Canvas routine runs at 7:30 and finishes', await waitFor(async () => (await app.evaluate((_e, id) => global.__bg.find(id).status, canvas.id)) === 'done', 12000), await app.evaluate((_e, id) => JSON.stringify([global.__bg.find(id).status, global.__bg.find(id).error]), canvas.id));
  const canvasResult = await app.evaluate((_e, id) => global.__bg.find(id).routine.history.map((h) => h.result).join('\n'), canvas.id);
  check('it was offered the connector tool and its answer came after reading Canvas', await app.evaluate(() => global.__toolsSeen.CANVAS?.has('connector') === true) && /RESULT-CANVAS/.test(canvasResult) && fakes.seen.some((r) => r.service === 'canvas' && /calendar_events/.test(r.url)), JSON.stringify([...(await app.evaluate(() => [...global.__toolsSeen.CANVAS || []])), fakes.seen.map((r) => r.url)]));
  check('no password was asked for or sent (Canvas was read with the signed-in session only)', fakes.seen.filter((r) => r.service === 'canvas').every((r) => !r.auth), '');

  // ---- The full-page chat: the same phrase, the same store.
  await app.evaluate(() => global.__chatPage.open());
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  check('the full-page chat opens', await waitFor(async () => (await inPage("Boolean(document.getElementById('prompt') && window.assistant && window.assistant.routines)")) === true, 15000), await inPage("typeof window.assistant"));
  await inPage("(() => { const p = document.getElementById('prompt'); p.focus(); p.value = 'Every Sunday at 6pm ROUTINE-P1 plan my week'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  check('the same phrase there offers a routine', await waitFor(async () => (await inPage("(() => { const b = document.getElementById('rc-offer'); return Boolean(b) && !b.hidden && /Make this a routine/.test(b.textContent); })()")) === true), await inPage("document.getElementById('rc-offer')?.outerHTML"));
  await inPage("document.getElementById('rc-offer-yes').click(); true");
  check('Schedule it opens the dialog with the request and the schedule read from the phrase', await waitFor(async () => (await inPage("(() => { const d = document.getElementById('rc-dialog'); return Boolean(d) && d.offsetParent !== null && document.getElementById('rc-request').value === 'ROUTINE-P1 plan my week'; })()")) === true), await inPage("JSON.stringify([document.getElementById('rc-request')?.value, document.getElementById('rc-when')?.value, document.getElementById('rc-preview')?.textContent])"));
  check('…with a live preview of the next runs', await waitFor(async () => /Next runs/.test(await inPage("document.getElementById('rc-preview').textContent"))), await inPage("document.getElementById('rc-preview').textContent"));
  await inPage("(() => { const n = document.getElementById('rc-name'); n.value = 'Week plan'; n.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('rc-create').click(); return true; })()");
  const p1 = await waitFor(async () => (await view()).routines.find((r) => r.title === 'Week plan'));
  check('Save routine in the full-page chat makes the same kind of routine (Sundays at 18:00, on)', p1 && p1.enabled && p1.schedule.repeat === 'weekly' && JSON.stringify(p1.schedule.days) === '[0]' && p1.schedule.time === '18:00', JSON.stringify(p1));
  check('…and the dialog confirms where to find it', await waitFor(async () => /Routine saved/.test(await inPage("document.getElementById('rc-saved')?.textContent || ''"))), await inPage("document.getElementById('rc-saved')?.textContent"));
  check('an ordinary sentence starting with "every" gets no offer', await (async () => {
    await inPage("(() => { const p = document.getElementById('prompt'); p.value = 'Every time I try this it fails'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    await sleep(900);
    return (await inPage("document.getElementById('rc-offer').hidden")) === true;
  })(), '');

  // ---- Settings is the same store as the sidebar: switching a routine off there shows everywhere.
  const rid = (await view()).routines.find((r) => r.title === 'Email check').id;
  await inSettings(`document.getElementById('routine-enable-${rid}').click(); true`);
  check('switching it off in Settings turns it off in the store', await waitFor(async () => (await view()).routines.find((r) => r.id === rid).enabled === false), '');
  await ui.evaluate(() => document.getElementById('task-tab-tasks').click());
  await ui.evaluate(() => document.getElementById('task-tab-routines').click());
  check('…and in the sidebar’s Routines list', await waitFor(() => ui.evaluate((title) => { const li = [...document.querySelectorAll('.routine-item')].find((x) => x.textContent.includes(title)); return li && li.querySelector('.routine-toggle').checked === false; }, 'Email check')), '');
  await inSettings(`${rowOf('Email check')}.querySelector('.rt-edit').click(); true`);
  check('Edit in Settings opens the editor in the sidebar, filled in', await waitFor(() => ui.evaluate(() => /Email check/.test(document.querySelector('.routine-create input[type=text]')?.value || ''))), '');
  await ui.keyboard.press('Escape');
  await inSettings(`${rowOf('Email check')}.querySelector('.rt-delete').click(); true`);
  await inSettings(`${rowOf('Email check')}.querySelector('.rt-delete').click(); true`);
  check('Delete in Settings (two clicks) removes it from the store', await waitFor(async () => !(await view()).routines.some((r) => r.id === rid)), '');
  check('Settings has the quiet hours and the one-click templates', (await inSettings("document.querySelectorAll('#routines-templates .rt-template').length")) === 4 && (await inSettings("document.getElementById('routines-quiet-on') !== null")) === true, '');
  await inSettings("document.querySelector('#routines-templates .rt-template[data-template=news] .rt-template-add').click(); true");
  const sNews = await waitFor(async () => (await view()).routines.find((r) => r.template === 'news'));
  check('a template added in Settings is made switched off, like the sidebar’s', sNews && sNews.enabled === false && sNews.schedule.repeat === 'daily', JSON.stringify(sNews));


  // ---- 7. Deleting every routine leaves no timer.
  await app.evaluate(() => { for (const t of [...global.__bg.tasks()]) global.__bg.remove(t.id); });
  check('with every routine deleted, the routine timer is gone', await waitFor(() => app.evaluate(() => global.__bg.routineTimer() === null)), '');
  check('and the store holds no routine', (await view()).routines.length === 0, '');

  check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  void openSettingsTab;
  await app.close();
  server.close();
  await fakes.stop();
  cleanup();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
